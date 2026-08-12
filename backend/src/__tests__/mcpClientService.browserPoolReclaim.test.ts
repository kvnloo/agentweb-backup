/**
 * ENG-1118 follow-up: bounding the browser client pools created by per-session isolation.
 *
 * Browser MCP servers pool per chat session, so every concurrent session holds its own
 * Playwright subprocess (a real Chromium, ~hundreds of MB). Those pools live in the single
 * long-lived generateMarketingResponse worker, and nothing in production calls
 * releaseSessionClients() — so without a bound they accumulate until the idle sweep at the
 * generic 1h TTL. Three guarantees are pinned here:
 *
 *   1. Browser pools get their own, much shorter idle TTL than ordinary per-user pools.
 *   2. The number of live browser pools is capped, evicting the least-recently-used one.
 *   3. Reclaim NEVER touches a pool with an in-flight tool call, nor one still inside the
 *      eviction grace window — losing a browser mid-run is the failure class this whole
 *      ticket is about. Over the cap with nothing safely evictable, we overshoot loudly
 *      rather than kill live work.
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

import { McpClientService } from '../mcp/client/mcpClientService';

function makeClient(overrides: Record<string, unknown> = {}) {
  return {
    connect: jest.fn().mockResolvedValue(undefined),
    listTools: jest.fn().mockResolvedValue({ tools: [] }),
    callTool: jest.fn().mockResolvedValue({ content: [] }),
    close: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const BROWSER_CONFIG = { transport: 'stdio', command: 'npx', args: ['@playwright/mcp@0.0.70'] };
const PLAIN_CONFIG = { transport: 'sse', url: 'http://tools.example.com/sse' };

describe('McpClientService browser pool reclaim (ENG-1118)', () => {
  let service: McpClientService;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetSetting.mockResolvedValue(null);
    mockClientFactory.mockImplementation(() => makeClient());
  });

  afterEach(async () => {
    if (service) await service.shutdown();
    process.env = { ...originalEnv };
  });

  /** Builds a service with the reclaim knobs pinned, then registers both server kinds. */
  function buildService(env: Record<string, string> = {}) {
    Object.assign(process.env, env);
    service = new McpClientService();
    (service as any).serverConfigs.set('playwright', { config: BROWSER_CONFIG, toolPrefix: 'playwright' });
    (service as any).serverConfigs.set('agentweb-tools', { config: PLAIN_CONFIG, toolPrefix: 'agentweb' });
    return service;
  }

  /** Ages a pool so it sits outside the eviction grace window. */
  function agePool(poolKey: string, ageMs: number) {
    const pool = (service as any).sessionClientPools.get(poolKey);
    pool.lastActivity = Date.now() - ageMs;
    return pool;
  }

  function poolKeys(): string[] {
    return Array.from((service as any).sessionClientPools.keys());
  }

  describe('browser-specific idle TTL', () => {
    // The cap bounds how many browsers exist at once, so the TTL is only garbage
    // collection and has no reason to be stricter than any other pool's. Shortening it
    // would narrow an existing guarantee: a user who steps away mid-chat and comes back
    // must still find the page their session left behind.
    it('defaults to the same idle TTL as ordinary pools — no narrowing versus main', async () => {
      buildService();
      await (service as any).getSessionClient('playwright', 'session-a', 'user-1');
      agePool('user-1::session-a', 45 * 60 * 1000);

      await (service as any).cleanupStaleSessions();

      expect(poolKeys()).toContain('user-1::session-a');
    });

    it('still reaps a browser pool once it passes that TTL', async () => {
      buildService();
      await (service as any).getSessionClient('playwright', 'session-a', 'user-1');
      agePool('user-1::session-a', 61 * 60 * 1000);

      await (service as any).cleanupStaleSessions();

      expect(poolKeys()).not.toContain('user-1::session-a');
    });

    it('reaps an idle browser pool well before the generic session TTL', async () => {
      buildService({ MCP_BROWSER_IDLE_TIMEOUT_MS: '600000', MCP_CLIENT_SESSION_TIMEOUT_MS: '3600000' });
      await (service as any).getSessionClient('playwright', 'session-a', 'user-1');
      agePool('user-1::session-a', 11 * 60 * 1000);

      await (service as any).cleanupStaleSessions();

      expect(poolKeys()).not.toContain('user-1::session-a');
    });

    it('keeps an ordinary per-user pool that is idle past the browser TTL but inside its own', async () => {
      buildService({ MCP_BROWSER_IDLE_TIMEOUT_MS: '600000', MCP_CLIENT_SESSION_TIMEOUT_MS: '3600000' });
      await (service as any).getSessionClient('agentweb-tools', 'session-a', 'user-1');
      agePool('user-1', 11 * 60 * 1000);

      await (service as any).cleanupStaleSessions();

      expect(poolKeys()).toContain('user-1');
    });

    it('never reaps a browser pool with an in-flight tool call, however idle it looks', async () => {
      buildService({ MCP_BROWSER_IDLE_TIMEOUT_MS: '600000' });
      await (service as any).getSessionClient('playwright', 'session-a', 'user-1');
      (service as any).markPoolBusy('user-1::session-a', 1);
      agePool('user-1::session-a', 2 * 60 * 60 * 1000);

      await (service as any).cleanupStaleSessions();

      expect(poolKeys()).toContain('user-1::session-a');
    });
  });

  describe('live browser client cap', () => {
    it('evicts the least-recently-used idle browser pool when the cap is exceeded', async () => {
      buildService({ MCP_MAX_BROWSER_CLIENTS: '2', MCP_BROWSER_EVICTION_GRACE_MS: '60000' });
      await (service as any).getSessionClient('playwright', 'session-a', 'user-1');
      await (service as any).getSessionClient('playwright', 'session-b', 'user-1');
      agePool('user-1::session-a', 10 * 60 * 1000);
      agePool('user-1::session-b', 5 * 60 * 1000);

      await (service as any).getSessionClient('playwright', 'session-c', 'user-1');

      expect(poolKeys()).not.toContain('user-1::session-a');
      expect(poolKeys()).toContain('user-1::session-b');
      expect(poolKeys()).toContain('user-1::session-c');
    });

    it('closes the evicted browser client so the Chromium process is actually reclaimed', async () => {
      buildService({ MCP_MAX_BROWSER_CLIENTS: '1', MCP_BROWSER_EVICTION_GRACE_MS: '60000' });
      const victim = await (service as any).getSessionClient('playwright', 'session-a', 'user-1');
      agePool('user-1::session-a', 10 * 60 * 1000);

      await (service as any).getSessionClient('playwright', 'session-b', 'user-1');

      expect((victim as any).close).toHaveBeenCalled();
    });

    it('skips a busy pool and evicts the next-coldest idle one instead', async () => {
      buildService({ MCP_MAX_BROWSER_CLIENTS: '2', MCP_BROWSER_EVICTION_GRACE_MS: '60000' });
      await (service as any).getSessionClient('playwright', 'session-a', 'user-1');
      await (service as any).getSessionClient('playwright', 'session-b', 'user-1');
      agePool('user-1::session-a', 30 * 60 * 1000);
      agePool('user-1::session-b', 5 * 60 * 1000);
      (service as any).markPoolBusy('user-1::session-a', 1);
      agePool('user-1::session-a', 30 * 60 * 1000);

      await (service as any).getSessionClient('playwright', 'session-c', 'user-1');

      expect(poolKeys()).toContain('user-1::session-a');
      expect(poolKeys()).not.toContain('user-1::session-b');
    });

    // Preferring to wait means a cron burst costs a little latency instead of an extra
    // Chromium per session. The wait is bounded and then we proceed, so a genuinely stuck
    // fleet degrades to the old overshoot rather than deadlocking a run.
    it('waits for a busy pool to free up instead of overshooting the cap', async () => {
      buildService({
        MCP_MAX_BROWSER_CLIENTS: '1',
        MCP_BROWSER_EVICTION_GRACE_MS: '60000',
        MCP_BROWSER_SLOT_WAIT_MS: '5000',
        MCP_BROWSER_SLOT_POLL_MS: '20',
      });
      await (service as any).getSessionClient('playwright', 'session-a', 'user-1');
      agePool('user-1::session-a', 10 * 60 * 1000);
      (service as any).markPoolBusy('user-1::session-a', 1);
      agePool('user-1::session-a', 10 * 60 * 1000);

      // The call in flight settles shortly after the second session asks for a browser.
      setTimeout(() => {
        (service as any).markPoolBusy('user-1::session-a', -1);
        agePool('user-1::session-a', 10 * 60 * 1000);
      }, 100);

      await (service as any).getSessionClient('playwright', 'session-b', 'user-1');

      expect(poolKeys()).not.toContain('user-1::session-a');
      expect(poolKeys()).toEqual(['user-1::session-b']);
    });

    // The burst case the cap exists for. Sessions that all ask at once each check capacity
    // before any of them has registered a client, so counting only live pools lets every
    // one of them through — the admission gate has to count reservations too.
    it('holds the cap when several sessions ask for a browser simultaneously', async () => {
      buildService({
        MCP_MAX_BROWSER_CLIENTS: '2',
        MCP_BROWSER_EVICTION_GRACE_MS: '0',
        MCP_BROWSER_SLOT_WAIT_MS: '2000',
        MCP_BROWSER_SLOT_POLL_MS: '10',
      });

      await Promise.all([
        (service as any).getSessionClient('playwright', 'session-a', 'user-1'),
        (service as any).getSessionClient('playwright', 'session-b', 'user-1'),
        (service as any).getSessionClient('playwright', 'session-c', 'user-1'),
      ]);

      expect((service as any).countBrowserPools()).toBeLessThanOrEqual(2);
    });

    it('gives up waiting and proceeds rather than blocking a run forever', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      buildService({
        MCP_MAX_BROWSER_CLIENTS: '1',
        MCP_BROWSER_EVICTION_GRACE_MS: '60000',
        MCP_BROWSER_SLOT_WAIT_MS: '100',
        MCP_BROWSER_SLOT_POLL_MS: '20',
      });
      await (service as any).getSessionClient('playwright', 'session-a', 'user-1');
      (service as any).markPoolBusy('user-1::session-a', 1);

      await (service as any).getSessionClient('playwright', 'session-b', 'user-1');

      expect(poolKeys()).toContain('user-1::session-a');
      expect(poolKeys()).toContain('user-1::session-b');
      expect(warn.mock.calls.some(c => String(c[0]).includes('over the browser client cap'))).toBe(true);
      warn.mockRestore();
    });

    it('overshoots loudly rather than evicting a pool still inside the grace window', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      buildService({ MCP_MAX_BROWSER_CLIENTS: '1', MCP_BROWSER_EVICTION_GRACE_MS: '60000', MCP_BROWSER_SLOT_WAIT_MS: '0' });
      await (service as any).getSessionClient('playwright', 'session-a', 'user-1');

      await (service as any).getSessionClient('playwright', 'session-b', 'user-1');

      expect(poolKeys()).toContain('user-1::session-a');
      expect(poolKeys()).toContain('user-1::session-b');
      expect(warn.mock.calls.some(c => String(c[0]).includes('over the browser client cap'))).toBe(true);
      warn.mockRestore();
    });

    it('never counts or evicts ordinary per-user pools', async () => {
      buildService({ MCP_MAX_BROWSER_CLIENTS: '1', MCP_BROWSER_EVICTION_GRACE_MS: '60000' });
      await (service as any).getSessionClient('agentweb-tools', 'session-a', 'user-1');
      await (service as any).getSessionClient('agentweb-tools', 'session-a', 'user-2');
      agePool('user-1', 60 * 60 * 1000);
      agePool('user-2', 60 * 60 * 1000);

      await (service as any).getSessionClient('playwright', 'session-b', 'user-3');

      expect(poolKeys()).toContain('user-1');
      expect(poolKeys()).toContain('user-2');
      expect(poolKeys()).toContain('user-3::session-b');
    });

    it('keeps a single active session on its own browser across repeated calls', async () => {
      buildService({ MCP_MAX_BROWSER_CLIENTS: '1', MCP_BROWSER_EVICTION_GRACE_MS: '60000' });
      const first = await (service as any).getSessionClient('playwright', 'session-a', 'user-1');
      agePool('user-1::session-a', 10 * 60 * 1000);

      const second = await (service as any).getSessionClient('playwright', 'session-a', 'user-1');

      expect(second).toBe(first);
      expect(poolKeys()).toEqual(['user-1::session-a']);
    });
  });

  describe('explicit session release', () => {
    it('leaves a pool alone while a tool call is still running against it', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      buildService();
      const client = await (service as any).getSessionClient('playwright', 'session-a', 'user-1');
      (service as any).markPoolBusy('user-1::session-a', 1);

      await service.releaseSessionClients('session-a');

      expect(poolKeys()).toContain('user-1::session-a');
      expect((client as any).close).not.toHaveBeenCalled();
      expect(warn.mock.calls.some(c => String(c[0]).includes('still in flight'))).toBe(true);
      warn.mockRestore();
    });

    it('releases the pool normally once nothing is in flight', async () => {
      buildService();
      const client = await (service as any).getSessionClient('playwright', 'session-a', 'user-1');
      (service as any).markPoolBusy('user-1::session-a', 1);
      (service as any).markPoolBusy('user-1::session-a', -1);

      await service.releaseSessionClients('session-a');

      expect(poolKeys()).not.toContain('user-1::session-a');
      expect((client as any).close).toHaveBeenCalled();
    });
  });

  describe('in-flight accounting', () => {
    it('clears the busy marker and refreshes activity when a call settles', async () => {
      buildService();
      await (service as any).getSessionClient('playwright', 'session-a', 'user-1');
      agePool('user-1::session-a', 10 * 60 * 1000);

      (service as any).markPoolBusy('user-1::session-a', 1);
      (service as any).markPoolBusy('user-1::session-a', -1);

      const pool = (service as any).sessionClientPools.get('user-1::session-a');
      expect(pool.inFlight).toBe(0);
      expect(Date.now() - pool.lastActivity).toBeLessThan(1000);
    });

    it('never lets the busy counter go negative on an unbalanced settle', async () => {
      buildService();
      await (service as any).getSessionClient('playwright', 'session-a', 'user-1');

      (service as any).markPoolBusy('user-1::session-a', -1);
      (service as any).markPoolBusy('user-1::session-a', -1);

      expect((service as any).sessionClientPools.get('user-1::session-a').inFlight).toBe(0);
    });
  });
});
