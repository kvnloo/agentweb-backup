import request from 'supertest';
import express from 'express';

class MockAuthError extends Error {
  status: number;
  retryAfterSeconds?: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}
class MockRefusal extends Error {}

const mockAuthenticate = jest.fn();
const mockHandle = jest.fn();
const mockManifest = jest.fn(() => [{ name: 'meta_get_insights', inputSchema: { type: 'object' } }]);

jest.mock('../mcp/metaToolkitGateway', () => ({
  authenticateMetaToolkitCaller: (...a: any[]) => mockAuthenticate(...a),
  handleMetaToolkitCall: (...a: any[]) => mockHandle(...a),
  MetaToolkitAuthError: MockAuthError,
}));
jest.mock('../mcp/metaToolkitManifest', () => ({
  getMetaToolkitManifest: () => mockManifest(),
  MetaToolkitRefusal: MockRefusal,
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const router = require('../routes/metaToolkit').default;

const app = express();
app.use(express.json());
app.use('/api/meta-toolkit', router);

const rpc = (body: any, auth?: string) => {
  const r = request(app).post('/api/meta-toolkit/mcp');
  if (auth) r.set('Authorization', auth);
  return r.send(body);
};

describe('ENG-2295 Meta Toolkit MCP endpoint', () => {
  beforeEach(() => jest.clearAllMocks());

  it('initialize returns server info and tools capability without auth', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }).expect(200);
    expect(res.body.id).toBe(1);
    expect(res.body.result.protocolVersion).toBe('2025-03-26');
    expect(res.body.result.capabilities.tools).toBeDefined();
    expect(res.body.result.serverInfo.name).toBe('agentweb-meta-toolkit');
  });

  it('notifications get 202 with no body', async () => {
    const res = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }).expect(202);
    expect(res.text).toBe('');
  });

  it('tools/list requires a valid bearer (401, manifest not exposed)', async () => {
    mockAuthenticate.mockRejectedValue(new MockAuthError('Missing access token.', 401));
    const res = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }).expect(401);
    expect(res.headers['www-authenticate']).toBe('Bearer');
    expect(res.body.error.message).toBe('Missing access token.');
    expect(mockManifest).not.toHaveBeenCalled();
  });

  it('tools/list returns only the manifest for an authenticated caller', async () => {
    mockAuthenticate.mockResolvedValue({ userId: 'u1' });
    const res = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, 'Bearer aw_x').expect(200);
    expect(mockAuthenticate).toHaveBeenCalledWith('Bearer aw_x');
    expect(res.body.result.tools).toEqual([{ name: 'meta_get_insights', inputSchema: { type: 'object' } }]);
  });

  it('tools/call routes through the gateway and wraps the result as text content', async () => {
    mockHandle.mockResolvedValue({ rows: [1] });
    const res = await request(app)
      .post('/api/meta-toolkit/mcp')
      .set('Authorization', 'Bearer aw_key')
      .set('User-Agent', 'claude-code/2')
      .set('Mcp-Session-Id', 's-9')
      .send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'meta_get_insights', arguments: { account_id: '1' } } })
      .expect(200);
    expect(mockHandle).toHaveBeenCalledWith({
      authorization: 'Bearer aw_key',
      toolName: 'meta_get_insights',
      args: { account_id: '1' },
      sessionId: 's-9',
      userAgent: 'claude-code/2',
    });
    expect(res.body.result).toEqual({ content: [{ type: 'text', text: '{"rows":[1]}' }], isError: false });
  });

  it('tools/call auth failures are HTTP 401/403, never executed past the gateway', async () => {
    mockHandle.mockRejectedValueOnce(new MockAuthError('Invalid access token.', 401));
    await rpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'meta_get_insights' } }).expect(401);
    mockHandle.mockRejectedValueOnce(new MockAuthError('That Meta ad account is not connected to this account.', 403));
    const res = await rpc({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'meta_get_insights' } }, 'Bearer x').expect(403);
    expect(res.body.error.message).toMatch(/not connected/);
  });

  it('tools/call refusal is an isError tool result', async () => {
    mockHandle.mockRejectedValue(new MockRefusal('Write blocked by anomaly gate.'));
    const res = await rpc({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'call_meta_marketing_api' } }, 'Bearer x').expect(200);
    expect(res.body.result).toEqual({ content: [{ type: 'text', text: 'Write blocked by anomaly gate.' }], isError: true });
  });

  it('unexpected errors are -32603 without leaking details', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockHandle.mockRejectedValue(new Error('graph.facebook.com secret internals'));
    const res = await rpc({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'meta_get_insights' } }, 'Bearer x').expect(200);
    expect(res.body.error).toEqual({ code: -32603, message: 'Meta Toolkit call failed.' });
  });

  it('missing tool name is -32602; unknown method is -32601; malformed body is -32600', async () => {
    let res = await rpc({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: {} }, 'Bearer x').expect(200);
    expect(res.body.error.code).toBe(-32602);
    expect(mockHandle).not.toHaveBeenCalled();
    res = await rpc({ jsonrpc: '2.0', id: 10, method: 'resources/list' }).expect(200);
    expect(res.body.error.code).toBe(-32601);
    res = await rpc({ id: 11, method: 'tools/list' }).expect(400);
    expect(res.body.error.code).toBe(-32600);
  });

  it('protocol negotiation, id validation, array arguments and GET follow the MCP spec', async () => {
    let res = await rpc({ jsonrpc: '2.0', id: 12, method: 'initialize', params: { protocolVersion: '2099-01-01' } }).expect(200);
    expect(res.body.result.protocolVersion).toBe('2025-06-18');
    res = await rpc({ jsonrpc: '2.0', id: null, method: 'initialize', params: {} }).expect(400);
    expect(res.body).toMatchObject({ id: null, error: { code: -32600 } });
    res = await rpc({ jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: 'meta_get_insights', arguments: [1] } }, 'Bearer x').expect(200);
    expect(res.body.error.code).toBe(-32602);
    expect(mockHandle).not.toHaveBeenCalled();
    await request(app).get('/api/meta-toolkit/mcp').expect(405);
  });
});
