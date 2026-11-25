/**
 * ENG-3187: how McpClientService starts the Playwright browser server and what a browser tool call may carry.
 *
 * The browser server used to start with a copy of the backend's whole environment and in the backend's own working folder. These tests pin the
 * transport it is started with (environment, working folder, flags), that each server's folder goes away with exactly that server, that an abandoned
 * folder is swept but a live one never is, that the navigate tool is checked and `_meta` is dropped on every path a tool is called by.
 */
process.env.JWT_SECRET = 'test-jwt-secret-for-testing';

const mockStdio = jest.fn().mockImplementation(() => ({ onclose: null, onerror: null }));
const mockAssertPublic = jest.fn();
const mockCallTool = jest.fn();
const mockListTools = jest.fn();
const mockGetServerConfig = jest.fn();
// 'die' = the child process exits while the client is connecting: the SDK forgets the transport and connect rejects.
let mockConnectMode: 'ok' | 'die' = 'ok';
// true = the browser server exits by itself during the call, so the client has already forgotten its transport when the caller closes it.
let mockForgetTransportDuringCall = false;

jest.mock('../services/settingsService', () => ({ settingsService: { getSetting: jest.fn().mockResolvedValue(null) } }));
jest.mock('../services/db', () => ({ userDb: { getUserById: jest.fn() } }));
jest.mock('../utils/crypto', () => ({ decryptPassword: (value: string) => ({ password: value }) }));
jest.mock('../mcp/client/mcp_config', () => ({ internalMcpServers: {} }));
jest.mock('axios', () => {
  const m = jest.fn();
  (m as any).isAxiosError = jest.fn().mockReturnValue(false);
  return m;
});
jest.mock('../mcp/client/mcpOAuthClientProvider', () => ({
  ...jest.requireActual('../mcp/client/mcpOAuthClientProvider'),
  getServerConfig: (...args: any[]) => mockGetServerConfig(...args),
}));
jest.mock('../utils/ssrfGuard', () => {
  const actual = jest.requireActual('../utils/ssrfGuard');
  return { ...actual, assertPublicHostname: (...args: any[]) => mockAssertPublic(...args) };
});
// Like the SDK's Client: it holds its transport once connected and forgets it when it closes.
jest.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: jest.fn().mockImplementation(() => {
    const client: any = {
      _transport: undefined,
      connect: jest.fn().mockImplementation(async (transport: any) => {
        client._transport = transport;
        if (mockConnectMode === 'die') {
          client._transport = undefined;
          throw new Error('Connection closed');
        }
      }),
      listTools: (...args: any[]) => mockListTools(...args),
      callTool: (...args: any[]) => {
        if (mockForgetTransportDuringCall) client._transport = undefined;
        return mockCallTool(...args);
      },
      close: jest.fn().mockImplementation(async () => { client._transport = undefined; }),
    };
    return client;
  }),
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

import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { McpClientService } from '../mcp/client/mcpClientService';
import { internalMcpServers } from '../mcp/client/mcp_config';
import { PLAYWRIGHT_INHERIT_ENV_FLAG, PLAYWRIGHT_WORK_ROOT } from '../mcp/client/playwrightContainment';

const NONCE = `eng3187-${process.pid}`;
const DAY = 24 * 60 * 60 * 1000;
const PLAYWRIGHT_CONFIG = { transport: 'stdio' as const, command: 'npx', args: ['@playwright/mcp@0.0.70'] };
const SECRETS = { JWT_SECRET: 'jwt-value', STRIPE_SECRET_KEY: 'sk-value', AWS_SECRET_ACCESS_KEY: 'aws-value', SLACK_BOT_TOKEN: 'xoxb-value' };

describe('Playwright MCP containment (ENG-3187)', () => {
  let service: McpClientService;
  const savedEnv = { ...process.env };
  const extraFolders: string[] = [];

  beforeEach(() => {
    jest.clearAllMocks();
    mockAssertPublic.mockResolvedValue(undefined);
    mockConnectMode = 'ok';
    mockForgetTransportDuringCall = false;
    mockGetServerConfig.mockReset();
    mockStdio.mockImplementation(() => ({ onclose: null, onerror: null }));
    Object.assign(process.env, SECRETS);
    delete process.env[PLAYWRIGHT_INHERIT_ENV_FLAG];
    (McpClientService as any).playwrightBrowsersInstall = Promise.resolve();
    service = new McpClientService();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await service.shutdown();
    for (const dir of extraFolders.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  });

  const transportOptions = () => mockStdio.mock.calls[mockStdio.mock.calls.length - 1][0];
  const makeTransport = (name: string, config: any, poolKey?: string) => (service as any).createStdioTransport(name, config, poolKey);
  const liveFolders = (): string[] => Array.from((service as any).playwrightLiveWorkDirs) as string[];

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

    it('runs the server in its own fresh, empty, owner-only working folder that is also its output folder', () => {
      makeTransport('playwright', PLAYWRIGHT_CONFIG, `user-${NONCE}::c`);
      const options = transportOptions();
      expect(path.dirname(options.cwd)).toBe(PLAYWRIGHT_WORK_ROOT);
      expect(path.basename(options.cwd).startsWith(`${process.pid}-`)).toBe(true);
      expect(options.cwd).not.toBe(process.cwd());
      expect(fs.readdirSync(options.cwd)).toEqual([]);
      expect(fs.statSync(options.cwd).mode & 0o777).toBe(0o700);
      expect(options.args[options.args.indexOf('--output-dir') + 1]).toBe(options.cwd);
    });

    it('does not start the browser with --blocked-origins (it switches request interception, and with it cache-less loading, on for every session)', () => {
      makeTransport('playwright', PLAYWRIGHT_CONFIG, `user-${NONCE}::d`);
      expect(transportOptions().args.some((arg: string) => arg.startsWith('--blocked-origins'))).toBe(false);
    });

    it('does not add an output folder the server\'s configuration already names', () => {
      makeTransport('playwright', { ...PLAYWRIGHT_CONFIG, args: ['@playwright/mcp@0.0.70', '--output-dir=/srv/out'] }, `user-${NONCE}::e`);
      const { args } = transportOptions();
      expect(args.filter((arg: string) => arg === '--output-dir' || arg.startsWith('--output-dir='))).toEqual(['--output-dir=/srv/out']);
    });

    it('gives every browser server a folder of its own, even for the same pool key and the same name', () => {
      const first = makeTransport('playwright', PLAYWRIGHT_CONFIG, `user-${NONCE}::f`);
      const firstDir = transportOptions().cwd;
      const second = makeTransport('playwright', PLAYWRIGHT_CONFIG, `user-${NONCE}::f`);
      const secondDir = transportOptions().cwd;
      const third = makeTransport('playwright', PLAYWRIGHT_CONFIG, `user-${NONCE}::f2`);
      const thirdDir = transportOptions().cwd;
      expect(new Set([firstDir, secondDir, thirdDir]).size).toBe(3);
      expect(first).not.toBe(second);
      expect(third).toBeDefined();
    });

    it('gives pool keys that clean up to the same folder-safe name different folders', () => {
      makeTransport('playwright', PLAYWRIGHT_CONFIG, `user-${NONCE}::g`);
      const a = transportOptions().cwd;
      makeTransport('playwright', PLAYWRIGHT_CONFIG, `user-${NONCE}__g`);
      expect(transportOptions().cwd).not.toBe(a);
    });

    it('also gives a server started without a pool key a folder of its own', () => {
      makeTransport('playwright', PLAYWRIGHT_CONFIG);
      const { cwd, env } = transportOptions();
      expect(path.basename(cwd).startsWith(`${process.pid}-playwright-`)).toBe(true);
      expect(env).not.toHaveProperty('JWT_SECRET');
    });

    it('returns the whole environment only when the rollback switch is exactly "true"', () => {
      process.env[PLAYWRIGHT_INHERIT_ENV_FLAG] = '1';
      makeTransport('playwright', PLAYWRIGHT_CONFIG, `user-${NONCE}::h1`);
      expect(transportOptions().env).not.toHaveProperty('JWT_SECRET');
      process.env[PLAYWRIGHT_INHERIT_ENV_FLAG] = 'true';
      makeTransport('playwright', PLAYWRIGHT_CONFIG, `user-${NONCE}::h2`);
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

    it('refuses to start in a working root that is not a folder this process owns', () => {
      const real = fs.lstatSync;
      jest.spyOn(fs, 'lstatSync').mockImplementation(((p: any, ...rest: any[]) => (p === PLAYWRIGHT_WORK_ROOT
        ? { isDirectory: () => false, uid: process.getuid?.() }
        : (real as any)(p, ...rest))) as any);
      expect(() => makeTransport('playwright', PLAYWRIGHT_CONFIG, `user-${NONCE}::i1`)).toThrow(/not a folder owned by this process/);
      jest.restoreAllMocks();
      jest.spyOn(fs, 'lstatSync').mockImplementation(((p: any, ...rest: any[]) => (p === PLAYWRIGHT_WORK_ROOT
        ? { isDirectory: () => true, uid: (process.getuid?.() ?? 0) + 1 }
        : (real as any)(p, ...rest))) as any);
      expect(() => makeTransport('playwright', PLAYWRIGHT_CONFIG, `user-${NONCE}::i2`)).toThrow(/not a folder owned by this process/);
    });
  });

  describe('the working folder\'s life', () => {
    beforeEach(() => {
      (service as any).serverConfigs.set('playwright', { config: PLAYWRIGHT_CONFIG, toolPrefix: 'playwright' });
    });

    const folderOf = (poolKey: string): string => {
      const client = (service as any).sessionClientPools.get(poolKey).clients.get('playwright');
      const dir = (service as any).playwrightTransportDirs.get(client._transport);
      expect(dir).toBeTruthy();
      return dir;
    };

    it('is removed with everything in it when its pool is released', async () => {
      const poolKey = `user-${NONCE}::life-a`;
      await (service as any).getSessionClient('playwright', 'life-a', `user-${NONCE}`);
      const dir = folderOf(poolKey);
      fs.mkdirSync(path.join(dir, 'sub', 'deeper'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'sub', 'deeper', 'shot.png'), 'x');
      fs.writeFileSync(path.join(dir, 'page.yml'), 'x');
      await (service as any).releasePool(poolKey);
      expect(fs.existsSync(dir)).toBe(false);
      expect(liveFolders()).not.toContain(dir);
    });

    it('leaves another live pool\'s folder alone when one pool is released', async () => {
      await (service as any).getSessionClient('playwright', 'life-b1', `user-${NONCE}`);
      await (service as any).getSessionClient('playwright', 'life-b2', `user-${NONCE}`);
      const first = folderOf(`user-${NONCE}::life-b1`);
      const second = folderOf(`user-${NONCE}::life-b2`);
      await (service as any).releasePool(`user-${NONCE}::life-b1`);
      expect(fs.existsSync(first)).toBe(false);
      expect(fs.existsSync(second)).toBe(true);
    });

    it('is removed only for the browser server that made it, never for a newer one under the same pool key', () => {
      const poolKey = `user-${NONCE}::life-c`;
      const old = makeTransport('playwright', PLAYWRIGHT_CONFIG, poolKey);
      const oldDir = transportOptions().cwd;
      const fresh = makeTransport('playwright', PLAYWRIGHT_CONFIG, poolKey);
      const freshDir = transportOptions().cwd;
      (service as any).removePlaywrightWorkDirOf(old);
      expect(fs.existsSync(oldDir)).toBe(false);
      expect(fs.existsSync(freshDir)).toBe(true);
      (service as any).removePlaywrightWorkDirOf(fresh);
      expect(fs.existsSync(freshDir)).toBe(false);
    });

    it('is removed when a client is closed because it failed to connect or was evicted', async () => {
      const failed = makeTransport('playwright', PLAYWRIGHT_CONFIG, `user-${NONCE}::life-d1`);
      const failedDir = transportOptions().cwd;
      await (service as any).closeClient({ _transport: failed, close: jest.fn().mockRejectedValue(new Error('already closed')) });
      expect(fs.existsSync(failedDir)).toBe(false);

      await (service as any).getSessionClient('playwright', 'life-d2', `user-${NONCE}`);
      const evictedDir = folderOf(`user-${NONCE}::life-d2`);
      await (service as any).evictSessionClient(`user-${NONCE}::life-d2`, 'playwright');
      expect(fs.existsSync(evictedDir)).toBe(false);
    });

    it('is removed for every pool, and for a server without a pool, on shutdown', async () => {
      await (service as any).getSessionClient('playwright', 'life-e1', `user-${NONCE}`);
      await (service as any).getSessionClient('playwright', 'life-e2', `user-${NONCE}`);
      makeTransport('playwright', PLAYWRIGHT_CONFIG);
      const unpooled = transportOptions().cwd;
      const dirs = [...liveFolders()];
      expect(dirs.length).toBeGreaterThanOrEqual(3);
      expect(dirs).toContain(unpooled);
      await service.shutdown();
      dirs.forEach((dir) => expect(fs.existsSync(dir)).toBe(false));
      expect(liveFolders()).toEqual([]);
    });

    it('is removed when the browser server exits by itself, which is when the client forgets its transport', async () => {
      const poolKey = `user-${NONCE}::life-f`;
      await (service as any).getSessionClient('playwright', 'life-f', `user-${NONCE}`);
      const client = (service as any).sessionClientPools.get(poolKey).clients.get('playwright');
      const dir = folderOf(poolKey);
      const transport = client._transport;
      client._transport = undefined; // the worst order: the SDK client has already forgotten its transport when our handler runs
      transport.onclose();
      expect(fs.existsSync(dir)).toBe(false);
      expect((service as any).sessionClientPools.get(poolKey).clients.has('playwright')).toBe(false);
    });

    it('is removed when the browser server dies while the client is connecting', async () => {
      mockConnectMode = 'die';
      await expect((service as any).getSessionClient('playwright', 'life-g', `user-${NONCE}`)).rejects.toThrow(/Connection closed/);
      expect(liveFolders()).toEqual([]);
    });

    it('is removed by the caller\'s own transport when the client has already forgotten it', async () => {
      const transport = makeTransport('playwright', PLAYWRIGHT_CONFIG, `user-${NONCE}::life-h`);
      const dir = transportOptions().cwd;
      await (service as any).closeClient({ _transport: undefined, close: jest.fn().mockResolvedValue(undefined) }, transport);
      expect(fs.existsSync(dir)).toBe(false);
    });

    it('stays on the list when it could not be removed, so a shutdown tries again', () => {
      makeTransport('playwright', PLAYWRIGHT_CONFIG, `user-${NONCE}::life-i`);
      const dir = transportOptions().cwd;
      const realRm = fs.rmSync;
      const rm = jest.spyOn(fs, 'rmSync').mockImplementation((() => { throw new Error('EBUSY'); }) as any);
      (service as any).removeAllPlaywrightWorkDirs();
      expect(liveFolders()).toContain(dir);
      rm.mockImplementation(realRm as any);
      (service as any).removeAllPlaywrightWorkDirs();
      expect(liveFolders()).not.toContain(dir);
      expect(fs.existsSync(dir)).toBe(false);
    });

    describe('the sweep of what a hard kill left behind', () => {
      const deadPid = (): number => spawnSync(process.execPath, ['-e', '0']).pid as number;
      const folder = (name: string, ageMs = 0): string => {
        const dir = path.join(PLAYWRIGHT_WORK_ROOT, name);
        fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'sub', 'shot.png'), 'x');
        const when = new Date(Date.now() - ageMs);
        fs.utimesSync(dir, when, when);
        extraFolders.push(dir);
        return dir;
      };

      it('removes a folder whose owning process is gone, with its contents, even when it is new', () => {
        const abandoned = folder(`${deadPid()}-${NONCE}-a-xyz`);
        (service as any).sweepStalePlaywrightWorkDirs();
        expect(fs.existsSync(abandoned)).toBe(false);
      });

      it('never removes a folder this process knows, or a live process\'s, however old', () => {
        const own = folder(`${process.pid}-${NONCE}-own-xyz`, 40 * DAY);
        (service as any).playwrightLiveWorkDirs.add(own);
        const live = folder(`${process.ppid}-${NONCE}-live-xyz`, 40 * DAY);
        (service as any).sweepStalePlaywrightWorkDirs();
        expect(fs.existsSync(own)).toBe(true);
        expect(fs.existsSync(live)).toBe(true);
        (service as any).playwrightLiveWorkDirs.delete(own);
      });

      it('never removes a folder this process made after it started, even one it does not know', () => {
        const recent = folder(`${process.pid}-${NONCE}-recent-xyz`);
        (service as any).sweepStalePlaywrightWorkDirs();
        expect(fs.existsSync(recent)).toBe(true);
      });

      it('removes a folder named for this process id that an earlier run left (a restart in a container reuses the id)', () => {
        const earlierRun = folder(`${process.pid}-${NONCE}-earlier-xyz`, process.uptime() * 1000 + 10 * 60 * 1000);
        (service as any).sweepStalePlaywrightWorkDirs();
        expect(fs.existsSync(earlierRun)).toBe(false);
      });

      it('removes a folder with no owner in its name only when it is a week old', () => {
        const young = folder(`${NONCE}-young`, DAY);
        const old = folder(`${NONCE}-old`, 8 * DAY);
        (service as any).sweepStalePlaywrightWorkDirs();
        expect(fs.existsSync(young)).toBe(true);
        expect(fs.existsSync(old)).toBe(false);
      });

      it('runs at startup', async () => {
        const abandoned = folder(`${deadPid()}-${NONCE}-startup-xyz`);
        mockStdio.mockClear();
        await service.initialize();
        expect(fs.existsSync(abandoned)).toBe(false);
      });

      it('reads nothing when the working root does not exist yet', () => {
        const realExists = fs.existsSync;
        jest.spyOn(fs, 'existsSync').mockImplementation(((p: any) => (p === PLAYWRIGHT_WORK_ROOT ? false : realExists(p))) as any);
        const readdir = jest.spyOn(fs, 'readdirSync');
        (service as any).sweepStalePlaywrightWorkDirs();
        expect(readdir).not.toHaveBeenCalledWith(PLAYWRIGHT_WORK_ROOT);
      });
    });
  });

  describe('a browser tool call', () => {
    const CONTEXT = { userId: 'user1', sessionId: 'sess1', llmModel: 'gpt-4' };
    const BROWSER_TOOLS = [
      { name: 'browser_navigate', description: 'Navigate', inputSchema: { type: 'object', properties: { url: { type: 'string' } } } },
      { name: 'browser_file_upload', description: 'Upload', inputSchema: { type: 'object', properties: { paths: { type: 'array' } } } },
      { name: 'some_other_tool', description: 'Other', inputSchema: { type: 'object', properties: {} } },
    ];

    async function tools(): Promise<Record<string, any>> {
      mockListTools.mockResolvedValue({ tools: BROWSER_TOOLS });
      mockCallTool.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
      (internalMcpServers as any)['playwright-server'] = { transport: 'sse', url: 'http://localhost:3100/sse', isInternal: false };
      await service.initialize();
      const byName: Record<string, any> = {};
      for (const tool of (service as any).mcpTools) byName[tool.definition.function.name] = tool;
      return byName;
    }

    afterEach(() => {
      for (const key of Object.keys(internalMcpServers)) delete (internalMcpServers as any)[key];
    });

    it('refuses a navigate to an address that is not a public web page, and never calls the browser or retries', async () => {
      const { browser_navigate } = await tools();
      await expect(browser_navigate.execute({ url: 'file:///etc/passwd' }, CONTEXT)).rejects.toThrow(/only open public web pages \(http or https\)/);
      await expect(browser_navigate.execute({ url: 'view-source:file:///etc/hostname' }, CONTEXT)).rejects.toThrow(/only open public web pages/);
      mockAssertPublic.mockRejectedValueOnce(new Error('URL resolves to a private/internal address'));
      await expect(browser_navigate.execute({ url: 'https://metadata.example/latest/meta-data/' }, CONTEXT)).rejects.toThrow(/cannot open internal/);
      expect(mockCallTool).not.toHaveBeenCalled();
    });

    it('opens a public page', async () => {
      const { browser_navigate } = await tools();
      await expect(browser_navigate.execute({ url: 'https://example.com/' }, CONTEXT)).resolves.toBeDefined();
      expect(mockAssertPublic).toHaveBeenCalledWith('https://example.com/');
      expect(mockCallTool).toHaveBeenCalledTimes(1);
    });

    it('is sent without `_meta`, which would move the folder Playwright checks upload paths against', async () => {
      const { browser_file_upload, browser_navigate } = await tools();
      await browser_file_upload.execute({ paths: ['../../../../etc/passwd'], _meta: { cwd: '/tmp/playwright-mcp-work/x/a/b/c/d' } }, CONTEXT);
      expect(mockCallTool.mock.calls[0][0]).toEqual({ name: 'browser_file_upload', arguments: { paths: ['../../../../etc/passwd'] } });
      await browser_navigate.execute({ url: 'https://example.com/', _meta: { cwd: '/' } }, CONTEXT);
      expect(mockCallTool.mock.calls[1][0]).toEqual({ name: 'browser_navigate', arguments: { url: 'https://example.com/' } });
    });

    it('leaves the arguments of a tool that is not a browser tool unchanged', async () => {
      const { some_other_tool } = await tools();
      await some_other_tool.execute({ a: 1, _meta: { progressToken: 't' } }, CONTEXT);
      expect(mockCallTool.mock.calls[0][0]).toEqual({ name: 'some_other_tool', arguments: { a: 1, _meta: { progressToken: 't' } } });
    });
  });

  describe('the direct call paths (callToolDirect and withServerSession)', () => {
    const SSE = { transport: 'sse', url: 'http://localhost:3100/sse', isInternal: false };

    beforeEach(() => {
      mockCallTool.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
    });

    it('callToolDirect refuses an address that is not a public web page before it starts anything', async () => {
      mockGetServerConfig.mockResolvedValue(SSE);
      const create = jest.spyOn(service, 'createTransport');
      await expect(service.callToolDirect('srv', 'browser_navigate', { url: 'file:///etc/passwd' })).rejects.toThrow(/only open public web pages \(http or https\)/);
      expect(create).not.toHaveBeenCalled();
      expect(mockCallTool).not.toHaveBeenCalled();
    });

    it('callToolDirect sends a browser call without _meta, and any other tool\'s arguments as they are', async () => {
      mockGetServerConfig.mockResolvedValue(SSE);
      await service.callToolDirect('srv', 'browser_file_upload', { paths: ['x'], _meta: { cwd: '/' } });
      expect(mockCallTool.mock.calls[0][0]).toEqual({ name: 'browser_file_upload', arguments: { paths: ['x'] } });
      await service.callToolDirect('srv', 'generate_video', { prompt: 'p', _meta: { progressToken: 't' } });
      expect(mockCallTool.mock.calls[1][0]).toEqual({ name: 'generate_video', arguments: { prompt: 'p', _meta: { progressToken: 't' } } });
    });

    it('callToolDirect removes the browser server\'s folder when it is done, although the client forgot its transport', async () => {
      mockForgetTransportDuringCall = true;
      mockGetServerConfig.mockResolvedValue(PLAYWRIGHT_CONFIG);
      await service.callToolDirect('playwright', 'browser_snapshot', {});
      expect(liveFolders()).toEqual([]);
    });

    it('withServerSession refuses an address that is not a public web page, and sends a browser call without _meta', async () => {
      mockGetServerConfig.mockResolvedValue(SSE);
      await service.withServerSession('srv', async (callTool) => {
        await expect(callTool('browser_navigate', { url: 'view-source:file:///etc/hostname' })).rejects.toThrow(/only open public web pages/);
        expect(mockCallTool).not.toHaveBeenCalled();
        await callTool('browser_file_upload', { paths: ['x'], _meta: { cwd: '/' } });
      });
      expect(mockCallTool.mock.calls[0][0]).toEqual({ name: 'browser_file_upload', arguments: { paths: ['x'] } });
    });

    it('withServerSession removes the browser server\'s folder when the session ends, although the client forgot its transport', async () => {
      mockForgetTransportDuringCall = true;
      mockGetServerConfig.mockResolvedValue(PLAYWRIGHT_CONFIG);
      await service.withServerSession('playwright', async (callTool) => { await callTool('browser_snapshot', {}); });
      expect(liveFolders()).toEqual([]);
    });
  });

  describe('who is named in the refusal log', () => {
    it('is the user and session of the call', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      await expect((service as any).prepareBrowserCall('browser_navigate', { url: 'file:///etc/passwd' }, { userId: 'user-77', sessionId: 'session-88' })).rejects.toThrow();
      const line = warn.mock.calls.map((call) => String(call[0])).find((text) => text.includes('browser_navigation_refused'));
      expect(JSON.parse(line as string)).toMatchObject({ event: 'browser_navigation_refused', userId: 'user-77', sessionId: 'session-88' });
      expect(line).not.toContain('passwd');
    });
  });

  describe('wiring (every place a tool is registered or called)', () => {
    const source = fs.readFileSync(path.join(__dirname, '../mcp/client/mcpClientService.ts'), 'utf8');
    const count = (pattern: RegExp): number => (source.match(pattern) || []).length;

    it('prepares the call before the retry loop in every registered tool\'s execute, and sends only the prepared arguments', () => {
      const registrations = count(/^\s*execute: async \(args: any, context: ToolContext\) => \{$/gm);
      const guarded = count(
        /^\s*execute: async \(args: any, context: ToolContext\) => \{\n\s*\/\/ ENG-3187:[^\n]*\n\s*const callArgs = await this\.prepareBrowserCall\(originalToolName, args, context\);\n\s*const maxAttempts = /gm,
      );
      expect(registrations).toBeGreaterThanOrEqual(2);
      expect(guarded).toBe(registrations);
      expect(count(/const toolArgs = \{ \.\.\.callArgs \};/g)).toBe(registrations);
      expect(count(/const toolArgs = \{ \.\.\.args \};/g)).toBe(0);
    });

    it('prepares the call in the two direct paths too', () => {
      expect(count(/const preparedArgs = await this\.prepareBrowserCall\(toolName, args\);/g)).toBe(2);
      expect(count(/arguments: preparedArgs/g)).toBe(2);
      expect(count(/this\.closeClient\(client, transport\)/g)).toBe(6);
    });

    it('starts the browser server from the contained environment, in its own folder, and remembers the folder by transport', () => {
      expect(source).toMatch(/env: isPlaywrightMcp\n\s*\? playwrightChildEnv\(process\.env, resolvedEnv, \{ inheritFullEnv: process\.env\[PLAYWRIGHT_INHERIT_ENV_FLAG\] === 'true' \}\)\n\s*: \{ \.\.\.process\.env, \.\.\.resolvedEnv \} as Record<string, string>,\n\s*\.\.\.\(playwrightWorkDir \? \{ cwd: playwrightWorkDir \} : \{\}\),/);
      expect(source).toMatch(/if \(playwrightWorkDir\) this\.playwrightTransportDirs\.set\(transport, playwrightWorkDir\);\n\s*return transport;/);
    });

    it('removes a client\'s own folder wherever a client is closed, and every folder on shutdown, and sweeps at startup', () => {
      expect(count(/this\.removePlaywrightWorkDirOf\(transport\);/g)).toBe(5);
      expect(count(/this\.removePlaywrightWorkDirOf\(ownTransport\);/g)).toBe(1);
      expect(source).toMatch(/this\.removeAllPlaywrightWorkDirs\(\);/);
      expect(source).toMatch(/this\.sweepStalePlaywrightConfigs\(\);\n\s*this\.sweepStalePlaywrightWorkDirs\(\);/);
    });
  });
});
