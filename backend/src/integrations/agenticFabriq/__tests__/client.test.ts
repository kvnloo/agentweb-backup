/**
 * REST client tests — mocked fetch, no network. Protects: correct app-scoped
 * headers, the documented 409-on-create tolerance, and the REQUIRED `?tool=`
 * param on delete (AF 422s without it because connection_id defaults to
 * "default" for every provider — omitting it is genuinely ambiguous).
 */
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
  return jest.fn(async (_url: string, _init: any) => ({
    ok: status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
  }));
}

describe('AgenticFabriqClient', () => {
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

  it('initiateOAuth defaults connection_id to "default" when not supplied', async () => {
    const fetchImpl = fakeFetch(200, { oauth_url: 'https://provider/authorize', state: 's1', connection_id: 'default' });
    const client = new AgenticFabriqClient({ fetchImpl: fetchImpl as any });
    await client.initiateOAuth('app_1', 'user_8412', 'gmail');
    const [, init] = fetchImpl.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ connection_id: 'default' });
  });

  it('initiateOAuth passes a custom connection_id through unchanged', async () => {
    const fetchImpl = fakeFetch(200, { oauth_url: 'https://provider/authorize', state: 's1', connection_id: 'work' });
    const client = new AgenticFabriqClient({ fetchImpl: fetchImpl as any });
    await client.initiateOAuth('app_1', 'user_8412', 'gmail', { connectionId: 'work' });
    const [, init] = fetchImpl.mock.calls[0];
    expect(JSON.parse(init.body).connection_id).toBe('work');
  });

  it('a non-2xx response throws AgenticFabriqApiError with the status and endpoint, never a generic Error', async () => {
    const fetchImpl = fakeFetch(403, { error: 'forbidden' });
    const client = new AgenticFabriqClient({ fetchImpl: fetchImpl as any });
    await expect(client.getProviderCapabilities('app_1')).rejects.toMatchObject({
      status: 403,
      endpoint: expect.stringContaining('/providers/capabilities'),
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
