/**
 * ENG-3187: how McpClientService starts the Playwright browser server and what its navigate tool may open.
 *
 * The browser server used to start with a copy of the backend's whole environment and in the backend's own working folder. These tests
 * pin the transport it is started with (environment, working folder, flags), that the folder goes away with its pool, and that the
 * navigate tool is checked on both places a tool is registered.
 */
process.env.JWT_SECRET = 'test-jwt-secret-for-testing';

const mockStdio = jest.fn().mockImplementation(() => ({ onclose: null, onerror: null }));
const mockAssertPublic = jest.fn();
const mockCallTool = jest.fn();
const mockListTools = jest.fn();

jest.mock('../services/settingsService', () => ({ settingsService: { getSetting: jest.fn().mockResolvedValue(null) } }));
jest.mock('../services/db', () => ({ userDb: { getUserById: jest.fn() } }));
jest.mock('../utils/crypto', () => ({ decryptPassword: (value: string) => ({ password: value }) }));
jest.mock('../mcp/client/mcp_config', () => ({ internalMcpServers: {} }));
jest.mock('axios', () => {
  const m = jest.fn();
  (m as any).isAxiosError = jest.fn().mockReturnValue(false);
  return m;
});
jest.mock('../utils/ssrfGuard', () => ({ assertPublicHostname: (...args: any[]) => mockAssertPublic(...args) }));
jest.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: jest.fn().mockImplementation(() => ({
    connect: jest.fn().mockResolvedValue(undefined),
    listTools: (...args: any[]) => mockListTools(...args),
    callTool: (...args: any[]) => mockCallTool(...args),
    close: jest.fn().mockResolvedValue(undefined),
  })),
}));
jest.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: jest.fn().mockImplementation(() => ({ onclose: null, onerror: null })),
}));
jest.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: jest.fn().mockImplementation((...args: any[]) => mockStdio(...args)),
}));
jest.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: jest.fn().mockImplementation(() => ({ onclose: null, onerror: null })),
}));

import fs from 'fs';
import path from 'path';
import { McpClientService } from '../mcp/client/mcpClientService';
import { internalMcpServers } from '../mcp/client/mcp_config';
import { PLAYWRIGHT_BLOCKED_ORIGINS, PLAYWRIGHT_INHERIT_ENV_FLAG, PLAYWRIGHT_WORK_ROOT } from '../mcp/client/playwrightContainment';

const NONCE = `eng3187-${process.pid}`;
const PLAYWRIGHT_CONFIG = { transport: 'stdio' as const, command: 'npx', args: ['@playwright/mcp@0.0.70'] };
const SECRETS = { JWT_SECRET: 'jwt-value', STRIPE_SECRET_KEY: 'sk-value', AWS_SECRET_ACCESS_KEY: 'aws-value', SLACK_BOT_TOKEN: 'xoxb-value' };

describe('Playwright MCP containment (ENG-3187)', () => {
  let service: McpClientService;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    mockAssertPublic.mockResolvedValue(undefined);
    mockStdio.mockImplementation(() => ({ onclose: null, onerror: null }));
    Object.assign(process.env, SECRETS);
    delete process.env[PLAYWRIGHT_INHERIT_ENV_FLAG];
    (McpClientService as any).playwrightBrowsersInstall = Promise.resolve();
    service = new McpClientService();
  });

  afterEach(async () => {
    await service.shutdown();
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  });

  const transportOptions = () => mockStdio.mock.calls[mockStdio.mock.calls.length - 1][0];
  const makeTransport = (name: string, config: any, poolKey?: string) => (service as any).createStdioTransport(name, config, poolKey);

  describe('the browser server\'s transport', () => {
    it('starts without the backend\'s secrets in its environment, and with what a headless browser needs', () => {
      makeTransport('playwright', PLAYWRIGHT_CONFIG, `user-${NONCE}::a`);
      const { env } = transportOptions();
      for (const name of Object.keys(SECRETS)) expect(env).not.toHaveProperty(name);
      expect(env.PATH).toBe(process.env.PATH);
    });

    it('passes on a variable the server\'s own configuration sets on purpose', () => {
      makeTransport('playwright', { ...PLAYWRIGHT_CONFIG, env: { PLAYWRIGHT_BROWSERS_PATH: '/opt/browsers' } }, `user-${NONCE}::b`);
      expect(transportOptions().env.PLAYWRIGHT_BROWSERS_PATH).toBe('/opt/browsers');
    });

    it('runs the server in its own empty, owner-only working folder that is also its output folder', () => {
      const poolKey = `user-${NONCE}::c`;
      makeTransport('playwright', PLAYWRIGHT_CONFIG, poolKey);
      const options = transportOptions();
      expect(options.cwd.startsWith(`${PLAYWRIGHT_WORK_ROOT}${path.sep}`)).toBe(true);
      expect(options.cwd).not.toBe(process.cwd());
      expect(fs.readdirSync(options.cwd)).toEqual([]);
      expect(fs.statSync(options.cwd).mode & 0o777).toBe(0o700);
      expect(options.args[options.args.indexOf('--output-dir') + 1]).toBe(options.cwd);
    });

    it('blocks the cloud metadata origins at the browser', () => {
      makeTransport('playwright', PLAYWRIGHT_CONFIG, `user-${NONCE}::d`);
      const { args } = transportOptions();
      expect(args[args.indexOf('--blocked-origins') + 1]).toBe(PLAYWRIGHT_BLOCKED_ORIGINS);
      expect(PLAYWRIGHT_BLOCKED_ORIGINS).toContain('http://169.254.169.254');
    });

    it('does not add an output folder or blocked origins the server\'s configuration already names', () => {
      makeTransport('playwright', { ...PLAYWRIGHT_CONFIG, args: ['@playwright/mcp@0.0.70', '--output-dir=/srv/out', '--blocked-origins', 'https://x.test'] }, `user-${NONCE}::e`);
      const { args } = transportOptions();
      expect(args.filter((arg: string) => arg === '--output-dir' || arg.startsWith('--output-dir='))).toEqual(['--output-dir=/srv/out']);
      expect(args.filter((arg: string) => arg === '--blocked-origins')).toHaveLength(1);
      expect(args[args.indexOf('--blocked-origins') + 1]).toBe('https://x.test');
    });

    it('gives each pool its own folder', () => {
      makeTransport('playwright', PLAYWRIGHT_CONFIG, `user-${NONCE}::f1`);
      const first = transportOptions().cwd;
      makeTransport('playwright', PLAYWRIGHT_CONFIG, `user-${NONCE}::f2`);
      expect(transportOptions().cwd).not.toBe(first);
    });

    it('returns the whole environment only when the rollback switch is set', () => {
      process.env[PLAYWRIGHT_INHERIT_ENV_FLAG] = 'true';
      makeTransport('playwright', PLAYWRIGHT_CONFIG, `user-${NONCE}::g`);
      const { env, cwd } = transportOptions();
      expect(env.JWT_SECRET).toBe('jwt-value');
      expect(cwd).toBeTruthy();
    });

    it('leaves every other stdio server exactly as it was: the whole environment and no working folder', () => {
      makeTransport('other-server', { transport: 'stdio', command: 'node', args: ['server.js'], env: { EXTRA: '1' } });
      const options = transportOptions();
      expect(options.env.JWT_SECRET).toBe('jwt-value');
      expect(options.env.EXTRA).toBe('1');
      expect(options).not.toHaveProperty('cwd');
      expect(options.args).toEqual(['server.js']);
    });
  });

  describe('the working folder\'s life', () => {
    beforeEach(() => {
      (service as any).serverConfigs.set('playwright', { config: PLAYWRIGHT_CONFIG, toolPrefix: 'playwright' });
    });

    it('is removed when its pool is released', async () => {
      const poolKey = `user-${NONCE}::life-a`;
      await (service as any).getSessionClient('playwright', 'life-a', `user-${NONCE}`);
      const dir = (service as any).playwrightWorkDirs.get(poolKey);
      expect(dir).toBeTruthy();
      expect(fs.existsSync(dir)).toBe(true);
      await (service as any).releasePool(poolKey);
      expect(fs.existsSync(dir)).toBe(false);
      expect((service as any).playwrightWorkDirs.has(poolKey)).toBe(false);
    });

    it('is removed for every pool on shutdown', async () => {
      await (service as any).getSessionClient('playwright', 'life-b', `user-${NONCE}`);
      await (service as any).getSessionClient('playwright', 'life-c', `user-${NONCE}`);
      const dirs = Array.from((service as any).playwrightWorkDirs.values()) as string[];
      expect(dirs).toHaveLength(2);
      await service.shutdown();
      dirs.forEach((dir) => expect(fs.existsSync(dir)).toBe(false));
    });

    it('is swept when a hard kill left it behind, but not while a starting process may still use it', () => {
      const stale = path.join(PLAYWRIGHT_WORK_ROOT, `${NONCE}-stale`);
      const fresh = path.join(PLAYWRIGHT_WORK_ROOT, `${NONCE}-fresh`);
      for (const dir of [stale, fresh]) {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'shot.png'), 'x');
      }
      const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
      fs.utimesSync(stale, old, old);
      (service as any).sweepStalePlaywrightWorkDirs();
      expect(fs.existsSync(stale)).toBe(false);
      expect(fs.existsSync(fresh)).toBe(true);
      fs.rmSync(fresh, { recursive: true, force: true });
    });

    it('does not throw when the working root does not exist yet', () => {
      const original = fs.existsSync;
      jest.spyOn(fs, 'existsSync').mockImplementation((p: any) => (p === PLAYWRIGHT_WORK_ROOT ? false : original(p)));
      expect(() => (service as any).sweepStalePlaywrightWorkDirs()).not.toThrow();
      jest.restoreAllMocks();
    });
  });

  describe('the navigate tool', () => {
    const CONTEXT = { userId: 'user1', sessionId: 'sess1', llmModel: 'gpt-4' };

    async function navigateTool(): Promise<any> {
      mockListTools.mockResolvedValue({
        tools: [
          { name: 'browser_navigate', description: 'Navigate', inputSchema: { type: 'object', properties: { url: { type: 'string' } } } },
          { name: 'browser_snapshot', description: 'Snapshot', inputSchema: { type: 'object', properties: {} } },
        ],
      });
      mockCallTool.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
      (internalMcpServers as any)['playwright-server'] = { transport: 'sse', url: 'http://localhost:3100/sse', isInternal: false };
      await service.initialize();
      return (service as any).mcpTools.find((t: any) => t.definition.function.name === 'browser_navigate');
    }

    afterEach(() => {
      for (const key of Object.keys(internalMcpServers)) delete (internalMcpServers as any)[key];
    });

    it('refuses an address that is not a public web page, and never calls the browser or retries', async () => {
      const tool = await navigateTool();
      await expect(tool.execute({ url: 'file:///etc/passwd' }, CONTEXT)).rejects.toThrow(/only open public web pages \(http or https\)/);
      await expect(tool.execute({ url: 'view-source:file:///etc/hostname' }, CONTEXT)).rejects.toThrow(/only open public web pages/);
      mockAssertPublic.mockRejectedValueOnce(new Error('URL resolves to a private/internal address'));
      await expect(tool.execute({ url: 'http://169.254.169.254/latest/meta-data/' }, CONTEXT)).rejects.toThrow(/cannot open internal/);
      expect(mockCallTool).not.toHaveBeenCalled();
    });

    it('still opens a public page', async () => {
      const tool = await navigateTool();
      await expect(tool.execute({ url: 'https://example.com/' }, CONTEXT)).resolves.toBeDefined();
      expect(mockAssertPublic).toHaveBeenCalledWith('https://example.com/');
      expect(mockCallTool).toHaveBeenCalledTimes(1);
    });
  });

  describe('wiring (both places a tool is registered)', () => {
    const source = fs.readFileSync(path.join(__dirname, '../mcp/client/mcpClientService.ts'), 'utf8');

    it('checks the address before the retry loop in every registered tool\'s execute', () => {
      const registrations = source.match(/^\s*execute: async \(args: any, context: ToolContext\) => \{$/gm) || [];
      const guarded = source.match(
        /^\s*execute: async \(args: any, context: ToolContext\) => \{\n\s*\/\/ ENG-3187:[^\n]*\n\s*const navigationRefusal = await browserNavigationRefusal\(originalToolName, args\);\n\s*if \(navigationRefusal\) throw new Error\(navigationRefusal\);\n\s*const maxAttempts = /gm,
      ) || [];
      expect(registrations.length).toBeGreaterThanOrEqual(2);
      expect(guarded).toHaveLength(registrations.length);
    });

    it('starts the browser server from the contained environment, in its own folder', () => {
      expect(source).toMatch(/env: isPlaywrightMcp\n\s*\? playwrightChildEnv\(process\.env, resolvedEnv, \{ inheritFullEnv: process\.env\[PLAYWRIGHT_INHERIT_ENV_FLAG\] === 'true' \}\)\n\s*: \{ \.\.\.process\.env, \.\.\.resolvedEnv \} as Record<string, string>,\n\s*\.\.\.\(playwrightWorkDir \? \{ cwd: playwrightWorkDir \} : \{\}\),/);
      expect(source).toMatch(/this\.removePlaywrightConfigFiles\(poolKey\);\n\s*this\.removePlaywrightWorkDir\(poolKey\);/);
      expect(source).toMatch(/this\.sweepStalePlaywrightConfigs\(\);\n\s*this\.sweepStalePlaywrightWorkDirs\(\);/);
    });
  });
});
