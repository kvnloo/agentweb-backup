/**
 * Tests for browser cookie persistence tools
 * (save_browser_cookies, load_browser_cookies, clear_browser_cookies)
 */

// Mock db before any imports
jest.mock('../services/db', () => ({
  browserCookieDb: {
    saveCookies: jest.fn().mockResolvedValue(undefined),
    getCookies: jest.fn().mockResolvedValue(null),
    deleteAllCookies: jest.fn().mockResolvedValue(undefined),
    getAllCookiesForUser: jest.fn().mockResolvedValue([]),
    markDomainCookiesFailed: jest.fn().mockResolvedValue(undefined),
  },
}));

import { emmaToolRegistry } from '../emma/registry';

// Import tools to register them
import '../emma/browserCookieTools';

import { browserCookieDb } from '../services/db';

const mockedDb = browserCookieDb as jest.Mocked<typeof browserCookieDb>;

// Helper to execute a registered tool
const executeTool = async (name: string, args: any, context: any = {}) => {
  const tool = emmaToolRegistry.getTool(name);
  if (!tool) throw new Error(`Tool "${name}" not found in registry`);
  return tool.execute(args, context);
};

// Mock context with a service that has a toolRegistry and executeTool
const createMockContext = (playwrightResult?: any) => {
  const mockExecuteTool = jest.fn().mockResolvedValue(
    playwrightResult ?? { content: '[]', raw: {} }
  );

  return {
    userId: 'test-user-123',
    sessionId: 'session-456',
    llmModel: 'gpt-4o',
    service: {
      toolRegistry: {
        getAllTools: () => [
          { name: 'playwright_browser_run_code', definition: {} },
          { name: 'playwright_browser_navigate', definition: {} },
        ],
      },
      executeTool: mockExecuteTool,
    },
  };
};

const sampleCookies = [
  { name: 'session_id', value: 'abc123', domain: '.google.com', path: '/', expires: 1999999999, httpOnly: true, secure: true, sameSite: 'Lax' },
  { name: 'pref', value: 'lang=en', domain: '.google.com', path: '/', expires: 1999999999, httpOnly: false, secure: false, sameSite: 'None' },
  { name: 'other', value: 'xyz', domain: '.linkedin.com', path: '/', expires: 1999999999, httpOnly: false, secure: true, sameSite: 'Lax' },
];

describe('browser cookie tools registration', () => {
  it('should register all four tools in emmaToolRegistry', () => {
    expect(emmaToolRegistry.getTool('save_browser_cookies')).toBeDefined();
    expect(emmaToolRegistry.getTool('load_browser_cookies')).toBeDefined();
    expect(emmaToolRegistry.getTool('clear_browser_cookies')).toBeDefined();
    expect(emmaToolRegistry.getTool('mark_browser_session_failed')).toBeDefined();
  });

  it('should not register list_saved_domains (removed)', () => {
    expect(emmaToolRegistry.getTool('list_saved_domains')).toBeUndefined();
  });
});

describe('save_browser_cookies', () => {
  beforeEach(() => jest.clearAllMocks());

  it('should reject when no userId', async () => {
    await expect(executeTool('save_browser_cookies', {}, {}))
      .rejects.toThrow('Authentication required');
  });

  it('should reject when Playwright tools are not available', async () => {
    const ctx = createMockContext();
    ctx.service.toolRegistry.getAllTools = () => [];
    await expect(executeTool('save_browser_cookies', {}, ctx))
      .rejects.toThrow('Playwright browser tools are not available');
  });

  it('should extract all cookies from browser and save them', async () => {
    const ctx = createMockContext({ content: JSON.stringify(sampleCookies), raw: {} });
    const result = await executeTool('save_browser_cookies', {}, ctx);

    expect(result.success).toBe(true);
    expect(result.cookieCount).toBe(3); // All cookies saved

    // Should have called browser_run_code to extract cookies
    expect(ctx.service.executeTool).toHaveBeenCalledWith(
      'gpt-4o',
      'playwright_browser_run_code',
      expect.objectContaining({ code: expect.stringContaining('cookies') }),
      'test-user-123',
      'session-456'
    );

    // Should have saved all cookies to DB (no domain filtering)
    expect(mockedDb.saveCookies).toHaveBeenCalledWith(
      'test-user-123',
      sampleCookies
    );
  });

  it('should return failure when no cookies in browser', async () => {
    const ctx = createMockContext({ content: '[]', raw: {} });
    const result = await executeTool('save_browser_cookies', {}, ctx);

    expect(result.success).toBe(false);
    expect(result.message).toContain('No cookies found');
    expect(mockedDb.saveCookies).not.toHaveBeenCalled();
  });

  it('should handle MCP markdown-formatted result', async () => {
    const mcpResult = {
      raw: {
        content: [{
          type: 'text',
          text: `### Result\n"${JSON.stringify(sampleCookies).replace(/"/g, '\\"')}"\n### Ran Playwright code\nawait page...`
        }]
      }
    };
    const ctx = createMockContext(mcpResult);
    const result = await executeTool('save_browser_cookies', {}, ctx);

    expect(result.success).toBe(true);
    expect(result.cookieCount).toBe(3);
  });
});

describe('load_browser_cookies', () => {
  beforeEach(() => jest.clearAllMocks());

  it('should reject when no userId', async () => {
    await expect(executeTool('load_browser_cookies', {}, {}))
      .rejects.toThrow('Authentication required');
  });

  it('should return failure when no saved cookies exist (both "__all__" and per-domain empty)', async () => {
    mockedDb.getAllCookiesForUser.mockResolvedValue([]);
    const ctx = createMockContext();
    const result = await executeTool('load_browser_cookies', {}, ctx);

    expect(result.success).toBe(false);
    expect(result.message).toContain('No saved cookies');
    expect(ctx.service.executeTool).not.toHaveBeenCalled();
  });

  it('should load all cookies (via getAllCookiesForUser) and inject into browser', async () => {
    mockedDb.getAllCookiesForUser.mockResolvedValue(sampleCookies);
    const ctx = createMockContext({ content: 'Loaded 3 cookies', raw: {} });

    const result = await executeTool('load_browser_cookies', {}, ctx);

    expect(result.success).toBe(true);
    expect(result.cookieCount).toBe(3);
    expect(mockedDb.getAllCookiesForUser).toHaveBeenCalledWith('test-user-123');

    // Should have called browser_run_code to inject cookies
    expect(ctx.service.executeTool).toHaveBeenCalledWith(
      'gpt-4o',
      'playwright_browser_run_code',
      expect.objectContaining({ code: expect.stringContaining('addCookies') }),
      'test-user-123',
      'session-456'
    );
  });

  it('should succeed when only manually-imported per-domain cookies exist (no "__all__" ever saved)', async () => {
    const manualOnly = [sampleCookies[2]];
    mockedDb.getAllCookiesForUser.mockResolvedValue(manualOnly);
    const ctx = createMockContext({ content: 'Loaded 1 cookies', raw: {} });

    const result = await executeTool('load_browser_cookies', {}, ctx);

    expect(result.success).toBe(true);
    expect(result.cookieCount).toBe(1);
  });

  it('should reject when Playwright tools are not available', async () => {
    mockedDb.getAllCookiesForUser.mockResolvedValue(sampleCookies);
    const ctx = createMockContext();
    ctx.service.toolRegistry.getAllTools = () => [];
    await expect(executeTool('load_browser_cookies', {}, ctx))
      .rejects.toThrow('Playwright browser tools are not available');
  });
});

describe('clear_browser_cookies', () => {
  beforeEach(() => jest.clearAllMocks());

  it('should reject when no userId', async () => {
    await expect(executeTool('clear_browser_cookies', {}, {}))
      .rejects.toThrow('Authentication required');
  });

  it('should clear all saved cookies', async () => {
    const result = await executeTool('clear_browser_cookies', {}, { userId: 'test-user' });

    expect(result.success).toBe(true);
    expect(result.message).toContain('all saved cookies');
    expect(mockedDb.deleteAllCookies).toHaveBeenCalledWith('test-user');
  });
});

describe('mark_browser_session_failed', () => {
  beforeEach(() => jest.clearAllMocks());

  it('is registered in emmaToolRegistry', () => {
    expect(emmaToolRegistry.getTool('mark_browser_session_failed')).toBeDefined();
  });

  it('should reject when no userId', async () => {
    await expect(executeTool('mark_browser_session_failed', { domain: 'rankai.ai' }, {}))
      .rejects.toThrow('Authentication required');
  });

  it('should reject when domain is missing', async () => {
    const result = await executeTool('mark_browser_session_failed', {}, { userId: 'test-user' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/domain/i);
    expect(mockedDb.markDomainCookiesFailed).not.toHaveBeenCalled();
  });

  it('marks the domain as failed and lowercases it', async () => {
    const result = await executeTool('mark_browser_session_failed', { domain: 'RankAI.AI' }, { userId: 'test-user' });

    expect(result.success).toBe(true);
    expect(mockedDb.markDomainCookiesFailed).toHaveBeenCalledWith('test-user', 'rankai.ai');
  });
});
