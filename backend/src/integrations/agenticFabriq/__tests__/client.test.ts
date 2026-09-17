/**
 * REST client tests — mocked fetch, no network. Protects: correct app-scoped
 * headers, the documented 409-on-create tolerance, and the REQUIRED `?tool=`
 * param on delete (AF 422s without it because connection_id defaults to
 * "default" for every provider — omitting it is genuinely ambiguous).
 */
jest.mock('dns/promises', () => ({ lookup: jest.fn(async () => [{ address: '93.184.216.34', family: 4 }]) }));
import { AgenticFabriqClient } from '../client';
import { AgenticFabriqApiError } from '../errors';
import * as config from '../config';

beforeEach(() => {
  jest.spyOn(config, 'getAgenticFabriqApiBaseUrl').mockReturnValue('https://api.example.com');
  jest.spyOn(config, 'getAgenticFabriqAppCredentials').mockResolvedValue({ appId: 'app_1', appSecret: 'secret_1' });
  jest.spyOn(config, 'getAgenticFabriqPrivateKeyPem').mockResolvedValue(undefined);
});

afterEach(() => jest.restoreAllMocks());

function fakeFetch(status: number, body: unknown): jest.Mock<Promise<any>, [string, any]> {
  return jest.fn(async (_url: string, _init: any) => Response.json(body, {status}));
}

describe('AgenticFabriqClient', () => {
  it('accepts live HTTP 200 vendor ticket state without treating it as caller CSRF', async () => {
    const connectionId = 'b'.repeat(32);
    const response = { oauth_url: 'https://provider.example/authorize?state=afct_fixture', state: 'afct_fixture', connection_id: connectionId, credential_source: 'af_app' };
    const fetchImpl = fakeFetch(200, response);
    await expect(new AgenticFabriqClient({ fetchImpl: fetchImpl as any }).initiateOAuth('app_1', 'user_8412', 'gmail', { connectionId, state: 'a'.repeat(64) })).resolves.toEqual(response);
  });

  it.each([101, 1000])('reads %i connections including abandoned attempts without mutation', async count => {
    const rows = Array.from({ length: count }, (_, i) => ({
      tool: 'gmail', connection_id: i.toString(16).padStart(32, '0'),
      status: i === count - 1 ? 'connected' : 'configured',
    }));
    const fetchImpl = fakeFetch(200, count === 101 ? rows : { connections: rows });
    const client = new AgenticFabriqClient({ fetchImpl: fetchImpl as any });
    await expect(client.listConnections('app_1', 'user_8412')).resolves.toEqual(rows);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][1].method).toBe('GET');
  });

  it('rejects more than 1000 connections instead of truncating verification data', async () => {
    const rows = Array.from({ length: 1001 }, (_, i) => ({ tool: 'gmail', connection_id: String(i), status: 'configured' }));
    const client = new AgenticFabriqClient({ fetchImpl: fakeFetch(200, rows) as any });
    await expect(client.listConnections('app', 'user')).rejects.toThrow();
  });

  it.each([null, { tool: 'gmail', connection_id: 'bad', status: 'connected', granted_scopes: [true] }])(
    'validates rows beyond the old 100-row boundary: %j', async malformed => {
      const rows = Array.from({ length: 100 }, (_, i) => ({ tool: 'gmail', connection_id: String(i), status: 'configured' }));
      const client = new AgenticFabriqClient({ fetchImpl: fakeFetch(200, [...rows, malformed]) as any });
      await expect(client.listConnections('app', 'user')).rejects.toThrow();
    },
  );

  it('sends X-App-Id and X-App-Secret headers on every app-scoped call', async () => {
    const fetchImpl = fakeFetch(200, { connections: [] });
    const client = new AgenticFabriqClient({ fetchImpl: fetchImpl as any });
    await client.listConnections('app_1', 'user_8412');
    const [, init] = fetchImpl.mock.calls[0];
    expect(init.headers['X-App-Id']).toBe('app_1');
    expect(init.headers['X-App-Secret']).toBe('secret_1');
    expect(init.headers['X-App-Assertion']).toBeUndefined(); // no private key configured
  });

  it('ensureExternalUser tolerates a 409 (documented "exists, fine") as success', async () => {
    const fetchImpl = fakeFetch(409, { error: 'already exists' });
    const client = new AgenticFabriqClient({ fetchImpl: fetchImpl as any });
    await expect(client.ensureExternalUser('app_1', 'user_8412')).resolves.toBeUndefined();
  });

  it('ensureExternalUser surfaces a non-409 failure', async () => {
    const fetchImpl = fakeFetch(500, { error: 'internal' });
    const client = new AgenticFabriqClient({ fetchImpl: fetchImpl as any });
    await expect(client.ensureExternalUser('app_1', 'user_8412')).rejects.toThrow(AgenticFabriqApiError);
  });

  it('deleteConnection ALWAYS includes ?tool= in the URL', async () => {
    const fetchImpl = fakeFetch(200, {});
    const client = new AgenticFabriqClient({ fetchImpl: fetchImpl as any });
    await client.deleteConnection('app_1', 'user_8412', 'default', 'gmail');
    const [url] = fetchImpl.mock.calls[0];
    expect(url).toContain('?tool=gmail');
  });

  it('deleteConnection throws a TypeError at the call site if tool is falsy (compile-time enforced, runtime-guarded too)', async () => {
    const fetchImpl = fakeFetch(200, {});
    const client = new AgenticFabriqClient({ fetchImpl: fetchImpl as any });
    await expect((client.deleteConnection as any)('app_1', 'user_8412', 'default', '')).rejects.toThrow(TypeError);
  });

  it('rejects missing connection challenges before contacting the vendor', async () => {
    const fetchImpl = fakeFetch(200, {});
    await expect(new AgenticFabriqClient({ fetchImpl: fetchImpl as any }).initiateOAuth('app_1', 'user_8412', 'gmail')).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('sends the local connection challenge, not a caller state the vendor cannot echo', async () => {
    const connectionId = 'b'.repeat(32);
    const fetchImpl = fakeFetch(200, { oauth_url: 'https://provider.example/authorize', state: 'afct_fixture', connection_id: connectionId });
    await new AgenticFabriqClient({ fetchImpl: fetchImpl as any }).initiateOAuth('app_1', 'user_8412', 'gmail', { connectionId });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ connection_id: connectionId });
  });
  it.each([undefined, null, {}, [], '', 'x'.repeat(513)])('rejects malformed vendor ticket state %j', async state => {
    const connectionId = 'b'.repeat(32);
    const fetchImpl = fakeFetch(200, { oauth_url: 'https://provider.example/authorize', state, connection_id: connectionId });
    await expect(new AgenticFabriqClient({ fetchImpl: fetchImpl as any }).initiateOAuth('app', 'user', 'gmail', { connectionId })).rejects.toThrow();
  });
  it.each([undefined, null, {}, [], 'c'.repeat(32)])('rejects substituted or malformed vendor connection_id %j', async connection_id => {
    const fetchImpl = fakeFetch(200, { oauth_url: 'https://provider.example/authorize', state: 'afct_fixture', connection_id });
    await expect(new AgenticFabriqClient({ fetchImpl: fetchImpl as any }).initiateOAuth('app', 'user', 'gmail', { connectionId: 'b'.repeat(32) })).rejects.toThrow();
  });

  it('a non-2xx response throws AgenticFabriqApiError with the status and endpoint, never a generic Error', async () => {
    const fetchImpl = fakeFetch(403, { error: 'forbidden' });
    const client = new AgenticFabriqClient({ fetchImpl: fetchImpl as any });
    await expect(client.getProviderCapabilities('app_1')).rejects.toMatchObject({
      status: 403,
      endpoint: 'rest',
    });
  });

  it('does not expose a vendor response body in the thrown error', async () => {
    const fetchImpl = fakeFetch(403, { access_token: 'secret-token', email: 'private@example.com' });
    const client = new AgenticFabriqClient({ fetchImpl: fetchImpl as any });
    await expect(client.getProviderCapabilities('app_1')).rejects.not.toThrow(/secret-token|private@example/);
  });

  it('aborts a stalled request at the configured deadline', async () => {
    const fetchImpl = jest.fn((_url: string, init: any) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    const client = new AgenticFabriqClient({ fetchImpl: fetchImpl as any, timeoutMs: 5 });
    await expect(client.getProviderCapabilities('app_1')).rejects.toMatchObject({ name: 'AgenticFabriqTimeoutError' });
  });

  it('rejects responses larger than the configured byte cap', async () => {
    const fetchImpl = fakeFetch(200, { value: 'x'.repeat(100) });
    const client = new AgenticFabriqClient({ fetchImpl: fetchImpl as any, maxResponseBytes: 20 });
    await expect(client.getProviderCapabilities('app_1')).rejects.toMatchObject({ name: 'AgenticFabriqResponseTooLargeError' });
  });
});
