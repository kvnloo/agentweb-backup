import { AgentModeService } from '../services/agentModeService';
import { toolResultError } from '../utils/toolResultError';
import { classifyToolErrorClass } from '../utils/toolErrorClassifier';
import { classifyToolFailureType } from '../utils/toolFailureType';

jest.mock('@google-cloud/storage');
jest.mock('../utils/secretsManager');
jest.mock('axios');

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {},
  searchPlatformKnowledgeBase: jest.fn().mockResolvedValue([]),
}));

const mockSearch = jest.fn();
// ENG-1281: google_search_web is now served by You.com (Google CSE retired).
jest.mock('../search/youSearchProvider', () => ({
  YouSearchProvider: jest.fn().mockImplementation(() => ({
    search: (...args: any[]) => mockSearch(...args),
  })),
}));

jest.mock('../services/db', () => ({
  userDb: { getUserById: jest.fn(), updateUser: jest.fn() },
  taskDb: {
    getTasksWithKnowledgeBase: jest.fn().mockResolvedValue([]),
    getAllPublicKnowledgeBaseTasks: jest.fn().mockResolvedValue([]),
    getTaskById: jest.fn(),
  },
}));

jest.mock('../utils/crypto', () => ({
  encryptPassword: jest.fn(),
  decryptPassword: jest.fn(),
}));

describe('AgentModeService - googleSearchWeb', () => {
  let agentModeService: AgentModeService;

  beforeEach(async () => {
    jest.clearAllMocks();
    process.env.SEARCH_WEB_MAX_RETRIES = '1';
    agentModeService = new AgentModeService();
    await agentModeService.initialize();
  });

  it('should return results on success', async () => {
    mockSearch.mockResolvedValue({
      provider: 'google',
      query: 'test',
      results: [{ title: 'A', url: 'https://a.com', snippet: '...', sourceType: 'web' }],
      metadata: { provider: 'google', resultSource: 'web' },
    });

    const result = await agentModeService.googleSearchWeb('test', 5);
    expect(result.success).toBe(true);
    expect(result.totalResults).toBe(1);
  });

  it('ENG-1281: keeps the caller-facing shape and tool name, reports the real provider', async () => {
    mockSearch.mockResolvedValue({
      provider: 'you',
      query: 'acme',
      results: [{ title: 'A', url: 'https://a.com', snippet: '...', sourceType: 'web' }],
      metadata: { provider: 'you', resultSource: 'web' },
    });

    const viaGoogleAlias = await agentModeService.googleSearchWeb('acme', 5);
    const viaYou = await agentModeService.youSearchWeb('acme', 5);

    expect(viaGoogleAlias.toolName).toBe('google_search_web');
    expect(viaGoogleAlias.provider).toBe('you');
    expect(viaGoogleAlias.resultSource).toBe('web');
    const { toolName: _a, ...aliasRest } = viaGoogleAlias;
    const { toolName: _b, ...youRest } = viaYou;
    expect(aliasRest).toEqual(youRest);
    expect(mockSearch).toHaveBeenCalledWith(expect.objectContaining({ query: 'acme', resultSource: 'web' }));
  });

  it('ENG-1281: no source file can reach the Google Custom Search endpoint', () => {
    const fs = require('fs');
    const path = require('path');
    const srcDir = path.resolve(__dirname, '..');
    const pattern = /customsearch\(|googleapis\.com\/customsearch|search\/googleSearchProvider/;
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== '__tests__' && entry.name !== 'node_modules') walk(full);
        } else if (entry.name.endsWith('.ts') && !entry.name.includes('.test.') && pattern.test(fs.readFileSync(full, 'utf8'))) {
          hits.push(path.relative(srcDir, full));
        }
      }
    };
    walk(srcDir);
    expect(hits).toEqual([]);
  });

  // ENG-1300: googleapis' customsearch client throws a GaxiosError, whose .code
  // is genuinely the numeric HTTP status (unlike Meta's business-code .code) —
  // same convention already established for Drive/Calendar in this project.
  it('ENG-1300: a 403 (GaxiosError .code) classifies as auth/config end-to-end', async () => {
    const gaxiosError: any = new Error('Access Not Configured');
    gaxiosError.code = 403;
    mockSearch.mockRejectedValue(gaxiosError);

    const result = await agentModeService.googleSearchWeb('test', 5);

    expect(result.success).toBe(false);
    expect(result.code).toBe(403);
    const classified = toolResultError(result);
    expect(classifyToolErrorClass(classified)).toBe('auth');
    expect(classifyToolFailureType(classifyToolErrorClass(classified))).toBe('config');
  });

  it('ENG-1300: a 429 (axios response.status shape) classifies as rate_limit', async () => {
    const err: any = new Error('Quota exceeded');
    err.response = { status: 429 };
    mockSearch.mockRejectedValue(err);

    const result = await agentModeService.googleSearchWeb('test', 5);

    expect(result.success).toBe(false);
    expect(result.code).toBe(429);
    const classified = toolResultError(result);
    expect(classifyToolErrorClass(classified)).toBe('rate_limit');
  });

  // ENG-1300 (CodeRabbit): GaxiosError's own docs treat `.status` as the
  // canonical numeric HTTP status field (`.code` is a documented fallback,
  // not the primary one) — when a thrown error carries both, `.status` must
  // win so a stale/mismatched `.code` can't shadow the real status.
  it('ENG-1300: prefers GaxiosError .status over .code when both are present', async () => {
    const gaxiosError: any = new Error('Forbidden');
    gaxiosError.status = 403;
    gaxiosError.code = 500;
    mockSearch.mockRejectedValue(gaxiosError);

    const result = await agentModeService.googleSearchWeb('test', 5);

    expect(result.success).toBe(false);
    expect(result.code).toBe(403);
  });
});
