/**
 * ENG-1111. Shared policy enforced at both the global `fetch` wrapper (setup.ts) and the
 * `node-fetch` module mock (__mocks__/node-fetch.ts) -- one list, so an allowlist entry
 * can't drift between the two call sites.
 */
import {
  assertLocalOrAllowed,
  RealNetworkEgressError,
  ALLOWED_HOSTNAMES,
} from './networkEgressGuard';

describe('networkEgressGuard', () => {
  afterEach(() => {
    ALLOWED_HOSTNAMES.delete('test-allowlisted.example.com');
  });

  it('blocks a request to a real non-local host', () => {
    expect(() => assertLocalOrAllowed('https://api.googleapis.com/v3/foo')).toThrow(
      RealNetworkEgressError
    );
  });

  it('names the blocked URL in the thrown error', () => {
    expect(() => assertLocalOrAllowed('https://api.resend.com/emails')).toThrow(
      /https:\/\/api\.resend\.com\/emails/
    );
  });

  it('names the currently-running test in the thrown error', () => {
    expect(() => assertLocalOrAllowed('https://api.stripe.com/v1/charges')).toThrow(
      /names the currently-running test in the thrown error/
    );
  });

  it('does not hang or swallow the block -- it always throws synchronously, never resolves', () => {
    let threw = false;
    try {
      assertLocalOrAllowed('https://graph.facebook.com/v19.0/act_1/campaigns');
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it('allows localhost', () => {
    expect(() => assertLocalOrAllowed('http://localhost:3001/api/health')).not.toThrow();
  });

  it('allows 127.0.0.1', () => {
    expect(() => assertLocalOrAllowed('http://127.0.0.1:5432/')).not.toThrow();
  });

  it('allows an explicitly allowlisted hostname', () => {
    ALLOWED_HOSTNAMES.add('test-allowlisted.example.com');
    expect(() => assertLocalOrAllowed('https://test-allowlisted.example.com/ping')).not.toThrow();
  });

  it('allows a non-absolute URL (in-process transports never leave the process)', () => {
    expect(() => assertLocalOrAllowed('/api/tasks/123')).not.toThrow();
  });
});

// Exercise the configured transports, not just the policy helper: requireActual
// can still resolve a moduleNameMapper entry and recursively load its own mock.
describe('configured fetch transports', () => {
  const nodeFetch = require('node-fetch');
  const http = require('node:http') as typeof import('node:http');
  let server: import('node:http').Server;
  let localUrl: string;

  beforeAll(async () => {
    server = http.createServer((_req, res) => res.end('local response'));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    localUrl = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/fixture`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });

  it('native fetch still delegates local requests', async () => {
    expect(await (await fetch(localUrl)).text()).toBe('local response');
  });

  it.each(['string', 'URL', 'Request'])('node-fetch delegates local %s inputs', async kind => {
    const input = kind === 'string' ? localUrl : kind === 'URL' ? new URL(localUrl) : new nodeFetch.Request(localUrl);
    expect(await (await nodeFetch(input)).text()).toBe('local response');
  });

  it('keeps the default export guarded and delegates local calls', async () => {
    expect(nodeFetch.default).toBe(nodeFetch);
    expect(await (await nodeFetch.default(localUrl)).text()).toBe('local response');
  });

  it.each(['native', 'node-fetch'])('%s rejects external requests with test and URL context', async kind => {
    const url = 'https://example.com/eng1111-transport-regression';
    const fetchFn = kind === 'native' ? fetch : nodeFetch;
    const testName = expect.getState().currentTestName;
    // Promise chaining also captures the synchronous throw made by the guard.
    await expect(Promise.resolve().then(() => fetchFn(url))).rejects.toMatchObject({
      name: 'RealNetworkEgressError',
      message: expect.stringContaining(`to ${url} from test "${testName}"`),
    });
  });
});
