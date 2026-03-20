/**
 * Tests for browser cookie persistence tools
 * (save_browser_cookies, load_browser_cookies, list_saved_domains, clear_browser_cookies)
 */

// Mock db before any imports
jest.mock('../services/db', () => ({
  browserCookieDb: {
    saveCookies: jest.fn().mockResolvedValue(undefined),
    getCookies: jest.fn().mockResolvedValue(null),
    listDomains: jest.fn().mockResolvedValue([]),
    deleteCookies: jest.fn().mockResolvedValue(undefined),
    deleteAllCookies: jest.fn().mockResolvedValue(undefined),
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
    expect(emmaToolRegistry.getTool('list_saved_domains')).toBeDefined();
    expect(emmaToolRegistry.getTool('clear_browser_cookies')).toBeDefined();
  });
});

describe('save_browser_cookies', () => {
  beforeEach(() => jest.clearAllMocks());

  it('should reject when no userId', async () => {
    await expect(executeTool('save_browser_cookies', { domain: 'google.com' }, {}))
      .rejects.toThrow('Authentication required');
  });

  it('should reject when no domain', async () => {
    const ctx = createMockContext();
    await expect(executeTool('save_browser_cookies', {}, ctx))
      .rejects.toThrow('Domain is required');
  });

  it('should reject when Playwright tools are not available', async () => {
    const ctx = createMockContext();
    ctx.service.toolRegistry.getAllTools = () => [];
    await expect(executeTool('save_browser_cookies', { domain: 'google.com' }, ctx))
      .rejects.toThrow('Playwright browser tools are not available');
  });

  it('should extract cookies from browser and save matching domain cookies', async () => {
    const ctx = createMockContext({ content: JSON.stringify(sampleCookies), raw: {} });
    const result = await executeTool('save_browser_cookies', { domain: 'google.com' }, ctx);

    expect(result.success).toBe(true);
    expect(result.cookieCount).toBe(2); // Only google.com cookies
    expect(result.domain).toBe('google.com');

    // Should have called browser_run_code to extract cookies
    expect(ctx.service.executeTool).toHaveBeenCalledWith(
      'gpt-4o',
      'playwright_browser_run_code',
      expect.objectContaining({ code: expect.stringContaining('cookies') }),
      'test-user-123',
      'session-456'
    );

    // Should have saved to DB
    expect(mockedDb.saveCookies).toHaveBeenCalledWith(
      'test-user-123',
      'google.com',
      expect.arrayContaining([
        expect.objectContaining({ name: 'session_id', domain: '.google.com' }),
      ])
    );
  });

  it('should return failure when no cookies match domain', async () => {
    const ctx = createMockContext({ content: JSON.stringify(sampleCookies), raw: {} });
    const result = await executeTool('save_browser_cookies', { domain: 'facebook.com' }, ctx);

    expect(result.success).toBe(false);
    expect(result.message).toContain('No cookies found');
    expect(mockedDb.saveCookies).not.toHaveBeenCalled();
  });

  it('should handle subdomain input by normalizing to root domain', async () => {
    const ctx = createMockContext({ content: JSON.stringify(sampleCookies), raw: {} });
    const result = await executeTool('save_browser_cookies', { domain: 'accounts.google.com' }, ctx);

    expect(result.success).toBe(true);
    expect(result.domain).toBe('google.com');
  });
});

describe('load_browser_cookies', () => {
  beforeEach(() => jest.clearAllMocks());

  it('should reject when no userId', async () => {
    await expect(executeTool('load_browser_cookies', { domain: 'google.com' }, {}))
      .rejects.toThrow('Authentication required');
  });

  it('should return failure when no saved cookies exist', async () => {
    mockedDb.getCookies.mockResolvedValue(null);
    const ctx = createMockContext();
    const result = await executeTool('load_browser_cookies', { domain: 'google.com' }, ctx);

    expect(result.success).toBe(false);
    expect(result.message).toContain('No saved cookies');
    expect(ctx.service.executeTool).not.toHaveBeenCalled();
  });

  it('should load cookies from DB and inject into browser', async () => {
    const savedCookies = sampleCookies.filter(c => c.domain === '.google.com');
    mockedDb.getCookies.mockResolvedValue(savedCookies);
    const ctx = createMockContext({ content: 'Loaded 2 cookies', raw: {} });

    const result = await executeTool('load_browser_cookies', { domain: 'google.com' }, ctx);

    expect(result.success).toBe(true);
    expect(result.cookieCount).toBe(2);

    // Should have called browser_run_code to inject cookies
    expect(ctx.service.executeTool).toHaveBeenCalledWith(
      'gpt-4o',
      'playwright_browser_run_code',
      expect.objectContaining({ code: expect.stringContaining('addCookies') }),
      'test-user-123',
      'session-456'
    );
  });

  it('should reject when Playwright tools are not available', async () => {
    mockedDb.getCookies.mockResolvedValue(sampleCookies);
    const ctx = createMockContext();
    ctx.service.toolRegistry.getAllTools = () => [];
    await expect(executeTool('load_browser_cookies', { domain: 'google.com' }, ctx))
      .rejects.toThrow('Playwright browser tools are not available');
  });
});

describe('list_saved_domains', () => {
  beforeEach(() => jest.clearAllMocks());

  it('should reject when no userId', async () => {
    await expect(executeTool('list_saved_domains', {}, {}))
      .rejects.toThrow('Authentication required');
  });

  it('should return empty list when no domains saved', async () => {
    mockedDb.listDomains.mockResolvedValue([]);
    const result = await executeTool('list_saved_domains', {}, { userId: 'test-user' });

    expect(result.success).toBe(true);
    expect(result.domains).toEqual([]);
    expect(result.message).toContain('No saved login cookies');
  });

  it('should return list of domains', async () => {
    mockedDb.listDomains.mockResolvedValue(['google.com', 'linkedin.com']);
    const result = await executeTool('list_saved_domains', {}, { userId: 'test-user' });

    expect(result.success).toBe(true);
    expect(result.domains).toEqual(['google.com', 'linkedin.com']);
    expect(result.message).toContain('google.com');
    expect(result.message).toContain('linkedin.com');
  });
});

describe('clear_browser_cookies', () => {
  beforeEach(() => jest.clearAllMocks());

  it('should reject when no userId', async () => {
    await expect(executeTool('clear_browser_cookies', {}, {}))
      .rejects.toThrow('Authentication required');
  });

  it('should clear cookies for specific domain', async () => {
    const result = await executeTool('clear_browser_cookies', { domain: 'google.com' }, { userId: 'test-user' });

    expect(result.success).toBe(true);
    expect(result.message).toContain('google.com');
    expect(mockedDb.deleteCookies).toHaveBeenCalledWith('test-user', 'google.com');
    expect(mockedDb.deleteAllCookies).not.toHaveBeenCalled();
  });

  it('should clear all cookies when no domain specified', async () => {
    const result = await executeTool('clear_browser_cookies', {}, { userId: 'test-user' });

    expect(result.success).toBe(true);
    expect(result.message).toContain('all saved cookies');
    expect(mockedDb.deleteAllCookies).toHaveBeenCalledWith('test-user');
    expect(mockedDb.deleteCookies).not.toHaveBeenCalled();
  });

  it('should normalize subdomain to root domain', async () => {
    await executeTool('clear_browser_cookies', { domain: 'www.google.com' }, { userId: 'test-user' });

    expect(mockedDb.deleteCookies).toHaveBeenCalledWith('test-user', 'google.com');
  });
});
