import request from 'supertest';
import express from 'express';
import axios from 'axios';

// Mock dependencies BEFORE importing the route
jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      query: jest.fn().mockReturnThis(),
      promise: jest.fn(),
    })),
  },
}));

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, res: any, next: any) => {
    req.user = { userId: 'test-user-id', email: 'test@example.com', isAdmin: false };
    next();
  },
  AuthenticatedRequest: {},
}));

jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn(),
  },
}));

jest.mock('../utils/crypto', () => ({
  decryptPassword: jest.fn(),
}));

jest.mock('axios');
import landingPagesRouter, { extractProductionUrls } from '../routes/landingPages';
import { userDb } from '../services/db';
import { decryptPassword } from '../utils/crypto';

const mockedUserDb = userDb as jest.Mocked<typeof userDb>;
const mockedDecrypt = decryptPassword as jest.MockedFunction<typeof decryptPassword>;
const mockedAxios = axios as jest.Mocked<typeof axios>;

const app = express();
app.use(express.json());
app.use('/api/landing-pages', landingPagesRouter);

// Use unique tokens per test to avoid in-memory cache collisions
let tokenCounter = 0;
function uniqueToken() {
  return `ghp_unique_${++tokenCounter}`;
}

describe('extractProductionUrls', () => {
  it('returns empty array when no URLs in markdown', () => {
    expect(extractProductionUrls('# Just a heading')).toEqual([]);
  });

  it('filters out GitHub URLs', () => {
    const md = `
      Check https://github.com/AgentWebPro/repo-1 and
      also https://mysite.github.io/docs for more info.
    `;
    expect(extractProductionUrls(md)).toEqual([]);
  });

  it('filters out Vercel preview URLs', () => {
    const md = 'Preview at https://mysite-git-feature-branch.vercel.app';
    expect(extractProductionUrls(md)).toEqual([]);
  });

  it('deduplicates URLs', () => {
    const md = `
      Visit https://start.waldium.com and also https://start.waldium.com/
      and https://start.waldium.com again.
    `;
    const result = extractProductionUrls(md);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe('https://start.waldium.com');
  });

  it('extracts production URLs from realistic AGENT.md', () => {
    const md = `
# Waldium Landing Page

- Repo: https://github.com/AgentWebPro/waldium-landing
- Production: https://start.waldium.com
- V2: https://start.waldium.com/v2
- Preview: https://waldium-landing-git-dev.vercel.app
    `;
    expect(extractProductionUrls(md)).toEqual([
      'https://start.waldium.com',
      'https://start.waldium.com/v2',
    ]);
  });
});

describe('Landing Pages Route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns noToken: true when user has no secrets', async () => {
    mockedUserDb.getUserById.mockResolvedValueOnce({ userId: 'test-user-id' } as any);

    const res = await request(app).get('/api/landing-pages');

    expect(res.status).toBe(200);
    expect(res.body.noToken).toBe(true);
    expect(res.body.repos).toEqual([]);
  });

  it('returns noToken: true when user has no GitHub token in secrets', async () => {
    mockedUserDb.getUserById.mockResolvedValueOnce({
      userId: 'test-user-id',
      secrets: { some_other_key: 'encrypted-value' },
    } as any);

    const res = await request(app).get('/api/landing-pages');

    expect(res.status).toBe(200);
    expect(res.body.noToken).toBe(true);
    expect(res.body.repos).toEqual([]);
  });

  it('fetches repos with GITHUB_PERSONAL_ACCESS_TOKEN', async () => {
    const token = uniqueToken();
    mockedUserDb.getUserById.mockResolvedValueOnce({
      userId: 'test-user-id',
      secrets: { GITHUB_PERSONAL_ACCESS_TOKEN: 'encrypted-token' },
    } as any);
    mockedDecrypt.mockReturnValueOnce({ password: token, userId: 'test-user-id' });

    const agentMdContent = '# Hello World\n\nProduction: https://example.com\nRepo: https://github.com/AgentWebPro/repo-1';
    mockedAxios.get.mockImplementation(((url: string) => {
      if (url.includes('/orgs/AgentWebPro/repos')) {
        return Promise.resolve({
          data: [
            { name: 'repo-1', html_url: 'https://github.com/AgentWebPro/repo-1' },
          ],
        });
      }
      if (url.includes('/contents/AGENT.md')) {
        return Promise.resolve({
          data: { content: Buffer.from(agentMdContent).toString('base64') },
        });
      }
      return Promise.reject(new Error('Not found'));
    }) as any);

    const res = await request(app).get('/api/landing-pages');

    expect(res.status).toBe(200);
    expect(res.body.noToken).toBeUndefined();
    expect(res.body.repos).toHaveLength(1);
    expect(res.body.repos[0]).toEqual({
      name: 'repo-1',
      htmlUrl: 'https://github.com/AgentWebPro/repo-1',
      agentMd: agentMdContent,
      deployedUrls: ['https://example.com'],
    });

    // Verify Authorization header was used
    expect(mockedAxios.get).toHaveBeenCalledWith(
      expect.stringContaining('/orgs/AgentWebPro/repos'),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: `Bearer ${token}`,
        }),
      })
    );
  });

  it('fetches repos with github_access_token fallback key', async () => {
    const token = uniqueToken();
    mockedUserDb.getUserById.mockResolvedValueOnce({
      userId: 'test-user-id',
      secrets: { github_access_token: 'encrypted-token' },
    } as any);
    mockedDecrypt.mockReturnValueOnce({ password: token, userId: 'test-user-id' });

    mockedAxios.get.mockImplementation(((url: string) => {
      if (url.includes('/orgs/AgentWebPro/repos')) {
        return Promise.resolve({ data: [] });
      }
      return Promise.reject(new Error('Not found'));
    }) as any);

    const res = await request(app).get('/api/landing-pages');

    expect(res.status).toBe(200);
    expect(res.body.repos).toEqual([]);
    expect(res.body.noToken).toBeUndefined();
  });

  it('skips repos without AGENT.md or agent.md', async () => {
    const token = uniqueToken();
    mockedUserDb.getUserById.mockResolvedValueOnce({
      userId: 'test-user-id',
      secrets: { github_access_token: 'encrypted-token' },
    } as any);
    mockedDecrypt.mockReturnValueOnce({ password: token, userId: 'test-user-id' });

    mockedAxios.get.mockImplementation(((url: string) => {
      if (url.includes('/orgs/AgentWebPro/repos')) {
        return Promise.resolve({
          data: [
            { name: 'no-agent-md', html_url: 'https://github.com/AgentWebPro/no-agent-md' },
          ],
        });
      }
      // Both AGENT.md and agent.md fail
      return Promise.reject(new Error('404 Not Found'));
    }) as any);

    const res = await request(app).get('/api/landing-pages');

    expect(res.status).toBe(200);
    expect(res.body.repos).toEqual([]);
  });

  it('falls back to agent.md when AGENT.md is not found', async () => {
    const token = uniqueToken();
    mockedUserDb.getUserById.mockResolvedValueOnce({
      userId: 'test-user-id',
      secrets: { github_access_token: 'encrypted-token' },
    } as any);
    mockedDecrypt.mockReturnValueOnce({ password: token, userId: 'test-user-id' });

    mockedAxios.get.mockImplementation(((url: string) => {
      if (url.includes('/orgs/AgentWebPro/repos')) {
        return Promise.resolve({
          data: [
            { name: 'repo-lower', html_url: 'https://github.com/AgentWebPro/repo-lower' },
          ],
        });
      }
      if (url.includes('/contents/AGENT.md')) {
        return Promise.reject(new Error('404'));
      }
      if (url.includes('/contents/agent.md')) {
        return Promise.resolve({
          data: { content: Buffer.from('# lowercase agent').toString('base64') },
        });
      }
      return Promise.reject(new Error('Not found'));
    }) as any);

    const res = await request(app).get('/api/landing-pages');

    expect(res.status).toBe(200);
    expect(res.body.repos).toHaveLength(1);
    expect(res.body.repos[0].agentMd).toBe('# lowercase agent');
  });

  it('returns deployedUrls: [] when AGENT.md has no production URLs', async () => {
    const token = uniqueToken();
    mockedUserDb.getUserById.mockResolvedValueOnce({
      userId: 'test-user-id',
      secrets: { GITHUB_PERSONAL_ACCESS_TOKEN: 'encrypted-token' },
    } as any);
    mockedDecrypt.mockReturnValueOnce({ password: token, userId: 'test-user-id' });

    mockedAxios.get.mockImplementation(((url: string) => {
      if (url.includes('/orgs/AgentWebPro/repos')) {
        return Promise.resolve({
          data: [
            { name: 'repo-no-urls', html_url: 'https://github.com/AgentWebPro/repo-no-urls' },
          ],
        });
      }
      if (url.includes('/contents/AGENT.md')) {
        return Promise.resolve({
          data: { content: Buffer.from('# Just docs, no URLs').toString('base64') },
        });
      }
      return Promise.reject(new Error('Not found'));
    }) as any);

    const res = await request(app).get('/api/landing-pages');

    expect(res.status).toBe(200);
    expect(res.body.repos).toHaveLength(1);
    expect(res.body.repos[0].deployedUrls).toEqual([]);
  });

  it('returns 500 when GitHub API throws on repo list', async () => {
    const token = uniqueToken();
    mockedUserDb.getUserById.mockResolvedValueOnce({
      userId: 'test-user-id',
      secrets: { github_access_token: 'encrypted-token' },
    } as any);
    mockedDecrypt.mockReturnValueOnce({ password: token, userId: 'test-user-id' });

    // The repos list call itself throws — this is not caught by Promise.allSettled
    mockedAxios.get.mockRejectedValue(new Error('GitHub API error'));

    const res = await request(app).get('/api/landing-pages');

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to fetch landing pages');
  });
});
