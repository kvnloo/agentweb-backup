/**
 * ENG-1118: the Playwright MCP config files must not outlive their pool.
 *
 * Each browser client is launched with a generated `--config` file plus a stealth init
 * script, named after the pool key. Pooling per chat session (rather than per user) turned
 * that from one pair per user into one pair per session, written to a shared /tmp directory
 * that nothing ever cleaned. Files are now removed with their pool, and orphans left behind
 * by a hard kill are swept on startup.
 */
process.env.JWT_SECRET = 'test-jwt-secret-for-testing';

const mockGetSetting = jest.fn().mockResolvedValue(null);
jest.mock('../services/settingsService', () => ({
  settingsService: { getSetting: (...args: any[]) => mockGetSetting(...args) },
}));

jest.mock('../services/db', () => ({
  userDb: { getUserById: jest.fn() },
}));

jest.mock('../utils/crypto', () => ({
  decryptPassword: (value: string) => ({ password: value }),
}));

jest.mock('../mcp/client/mcp_config', () => ({ internalMcpServers: {} }));

const mockClientFactory = jest.fn();
jest.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: jest.fn().mockImplementation((...args: any[]) => mockClientFactory(...args)),
}));

jest.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: jest.fn().mockImplementation(() => ({ onclose: null, onerror: null })),
}));
jest.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: jest.fn().mockImplementation(() => ({ onclose: null, onerror: null })),
}));
jest.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: jest.fn().mockImplementation(() => ({ onclose: null, onerror: null })),
}));

import fs from 'fs';
import path from 'path';
import { McpClientService } from '../mcp/client/mcpClientService';

const CONFIG_DIR = '/tmp/playwright-mcp-configs';
// Unique per jest worker so parallel suites cannot delete each other's fixtures.
const NONCE = `eng1118-${process.pid}`;

function makeClient() {
  return {
    connect: jest.fn().mockResolvedValue(undefined),
    listTools: jest.fn().mockResolvedValue({ tools: [] }),
    callTool: jest.fn().mockResolvedValue({ content: [] }),
    close: jest.fn().mockResolvedValue(undefined),
  };
}

describe('Playwright MCP config file cleanup (ENG-1118)', () => {
  let service: McpClientService;
  const written: string[] = [];

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetSetting.mockResolvedValue(null);
    mockClientFactory.mockImplementation(() => makeClient());
    // Never shell out to `playwright install` from a unit test.
    (McpClientService as any).playwrightBrowsersInstall = Promise.resolve();
    service = new McpClientService();
    (service as any).serverConfigs.set('playwright', {
      config: { transport: 'stdio', command: 'npx', args: ['@playwright/mcp@0.0.70'] },
      toolPrefix: 'playwright',
    });
  });

  afterEach(async () => {
    await service.shutdown();
    for (const file of written.splice(0)) {
      try { fs.unlinkSync(file); } catch { /* already cleaned */ }
    }
  });

  function fixture(name: string, ageMs: number): string {
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
    const file = path.join(CONFIG_DIR, name);
    fs.writeFileSync(file, '{}');
    const when = new Date(Date.now() - ageMs);
    fs.utimesSync(file, when, when);
    written.push(file);
    return file;
  }

  it('removes a session\'s config and stealth script when its pool is released', async () => {
    const poolKey = `user-${NONCE}::session-a`;
    await (service as any).getSessionClient('playwright', 'session-a', `user-${NONCE}`);

    const files = Array.from((service as any).playwrightConfigFiles.get(poolKey) || []) as string[];
    expect(files).toHaveLength(2);
    files.forEach(file => expect(fs.existsSync(file)).toBe(true));

    await (service as any).releasePool(poolKey);

    files.forEach(file => expect(fs.existsSync(file)).toBe(false));
    expect((service as any).playwrightConfigFiles.has(poolKey)).toBe(false);
  });

  it('cleans up every session pool on shutdown', async () => {
    await (service as any).getSessionClient('playwright', 'session-a', `user-${NONCE}`);
    await (service as any).getSessionClient('playwright', 'session-b', `user-${NONCE}`);
    const all = Array.from((service as any).playwrightConfigFiles.values())
      .flatMap((set: any) => Array.from(set)) as string[];
    expect(all).toHaveLength(4);

    await service.shutdown();

    all.forEach(file => expect(fs.existsSync(file)).toBe(false));
  });

  it('sweeps orphans left by a hard kill but keeps files a starting process may still read', () => {
    const stale = fixture(`${NONCE}-stale.json`, 48 * 60 * 60 * 1000);
    const fresh = fixture(`${NONCE}-fresh.json`, 60 * 1000);

    (service as any).sweepStalePlaywrightConfigs();

    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it('does not throw when the config directory does not exist yet', () => {
    const original = (McpClientService as any).PLAYWRIGHT_CONFIG_DIR;
    Object.defineProperty(McpClientService, 'PLAYWRIGHT_CONFIG_DIR', {
      value: `/tmp/does-not-exist-${NONCE}`,
      configurable: true,
    });

    expect(() => (service as any).sweepStalePlaywrightConfigs()).not.toThrow();

    Object.defineProperty(McpClientService, 'PLAYWRIGHT_CONFIG_DIR', { value: original, configurable: true });
  });
});
