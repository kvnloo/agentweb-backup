import request from 'supertest';
import express from 'express';

class MockAuthError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}
class MockRefusal extends Error {}

const mockAuthenticate = jest.fn();
const mockHandle = jest.fn();
const mockManifest = jest.fn(() => [{ name: 'meta_get_insights' }]);

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

describe('ENG-2288 Meta Toolkit HTTP routes', () => {
  beforeEach(() => jest.clearAllMocks());

  it('GET /tools returns 401 without a valid bearer and does not expose the manifest', async () => {
    mockAuthenticate.mockRejectedValue(new MockAuthError('Missing access token.', 401));
    const res = await request(app).get('/api/meta-toolkit/tools').expect(401);
    expect(res.body).toEqual({ error: 'Missing access token.' });
    expect(mockManifest).not.toHaveBeenCalled();
  });

  it('GET /tools returns the manifest for an authenticated caller', async () => {
    mockAuthenticate.mockResolvedValue({ userId: 'u1', authMethod: 'api_key' });
    const res = await request(app).get('/api/meta-toolkit/tools').set('Authorization', 'Bearer aw_x').expect(200);
    expect(mockAuthenticate).toHaveBeenCalledWith('Bearer aw_x');
    // ENG-2747: an unclassified tool is advertised with the conservative (destructive) annotations.
    expect(res.body.tools).toEqual([{ name: 'meta_get_insights', annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } }]);
  });

  it('GET /tools shows a Databricks-origin caller only the tools it may call (ENG-2747)', async () => {
    mockAuthenticate.mockResolvedValue({ userId: 'u1', authMethod: 'oauth', databricksOrigin: true });
    mockManifest.mockReturnValueOnce([{ name: 'list_meta_ads_campaigns' }, { name: 'zoma_custom_audiences' }] as unknown as [{ name: string }]);
    const res = await request(app).get('/api/meta-toolkit/tools').set('Authorization', 'Bearer t').expect(200);
    expect(res.body.tools.map((t: { name: string }) => t.name)).toEqual(['list_meta_ads_campaigns']);
  });

  it('POST call maps auth errors to their status (401/403)', async () => {
    mockHandle.mockRejectedValueOnce(new MockAuthError('Invalid access token.', 401));
    await request(app).post('/api/meta-toolkit/tools/meta_get_insights/call').send({}).expect(401);
    mockHandle.mockRejectedValueOnce(new MockAuthError('That Meta ad account is not connected to this account.', 403));
    const res = await request(app).post('/api/meta-toolkit/tools/meta_get_insights/call').send({}).expect(403);
    expect(res.body.error).toMatch(/not connected/);
  });

  it('POST call maps a refusal to 400 with its message', async () => {
    mockHandle.mockRejectedValue(new MockRefusal('Multiple Meta ad accounts are connected; pass account_id.'));
    const res = await request(app).post('/api/meta-toolkit/tools/meta_get_insights/call').send({}).expect(400);
    expect(res.body.error).toBe('Multiple Meta ad accounts are connected; pass account_id.');
  });

  it('POST call maps unknown errors to 500 without leaking details', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockHandle.mockRejectedValue(new Error('graph.facebook.com secret internals'));
    const res = await request(app).post('/api/meta-toolkit/tools/meta_get_insights/call').send({}).expect(500);
    expect(res.body.error).toMatch(/^Meta Toolkit call failed: internal error \(Error\)/);
    expect(JSON.stringify(res.body)).not.toMatch(/secret|stack/);
  });

  it('POST call forwards path tool name, auth header, args, session and user-agent; returns 200 result', async () => {
    mockHandle.mockResolvedValue({ rows: [1] });
    const res = await request(app)
      .post('/api/meta-toolkit/tools/meta_get_insights/call')
      .set('Authorization', 'Bearer aw_key')
      .set('User-Agent', 'claude-agent/1.0')
      .send({ args: { account_id: '123', toolName: 'evil' }, session_id: 's-1' })
      .expect(200);
    expect(res.body).toEqual({ result: { rows: [1] }, next_step: expect.stringMatching(/\S/) }); // ENG-3134
    expect(mockHandle).toHaveBeenCalledWith({
      authorization: 'Bearer aw_key',
      toolName: 'meta_get_insights',
      args: { account_id: '123', toolName: 'evil' },
      sessionId: 's-1',
      userAgent: 'claude-agent/1.0',
    });
  });

  it('POST call tolerates a missing body and non-object args', async () => {
    mockHandle.mockResolvedValue({});
    await request(app).post('/api/meta-toolkit/tools/t/call').send({ args: 'nope' }).expect(200);
    expect(mockHandle.mock.calls[0][0].args).toEqual({});
    expect(mockHandle.mock.calls[0][0].sessionId).toBeUndefined();
  });
});
