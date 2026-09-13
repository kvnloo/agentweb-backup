import { createMetaSimulator } from '../../services/sandbox/metaSimulator';
import { EMPTY_OVERLAY, SimRequest } from '../../services/sandbox/types';
import { buildFixtureDataset, FIXTURE_ACCOUNT_ID, FIXTURE_IDS } from './fixtures/fixtureDataset';

/** The simulator never throws, never touches the network, and answers in Graph's wire shape. */
const dataset = buildFixtureDataset();
const token = 'sbx.eval_fixture.0123456789abcdef01234567';
const now = () => new Date('2026-09-13T15:00:00Z');
const req = (path: string, query: Record<string, string> = {}, method: SimRequest['method'] = 'GET', extra: Partial<SimRequest> = {}): SimRequest =>
  ({ userId: 'eval_fixture', token, method, version: 'v24.0', path, query, ...extra });
const body = (res: any) => JSON.parse(res.body);
const deps = () => ({
  loadPolicy: jest.fn(async (userId: string) => (userId === 'eval_fixture' ? { datasetId: 'fixture-agentweb', datasetVersion: 1 } : null)),
  loadDataset: jest.fn(async () => dataset),
  loadOverlay: jest.fn(async () => EMPTY_OVERLAY),
  now,
});

describe('meta simulator router', () => {
  it('answers a read with headers Meta callers depend on', async () => {
    const d = deps();
    const sim = createMetaSimulator(d);
    const res = await sim.handle(req(`act_${FIXTURE_ACCOUNT_ID}/campaigns`, { fields: 'id,name' }));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/json');
    expect(JSON.parse(res.headers['x-business-use-case-usage'])).toEqual({ [FIXTURE_ACCOUNT_ID]: [expect.objectContaining({ type: 'ads_management', call_count: 1 })] });
    expect(body(res).data).toHaveLength(3);
    expect(d.loadDataset).toHaveBeenCalledWith('fixture-agentweb', 1);
    expect(d.loadOverlay).toHaveBeenCalledWith('eval_fixture');
  });
  it('a principal without an active policy gets an OAuth 190 error, never data', async () => {
    const sim = createMetaSimulator(deps());
    const res = await sim.handle(req('me', {}, 'GET', { userId: 'eval_revoked', token: 'sbx.eval_revoked.0123456789abcdef01234567' }));
    expect(res.status).toBe(400);
    expect(body(res).error).toMatchObject({ code: 190, type: 'OAuthException' });
  });
  it('writes are refused with a Graph code 100 until phase 3, except the token exchange', async () => {
    const sim = createMetaSimulator(deps());
    const write = await sim.handle(req(`act_${FIXTURE_ACCOUNT_ID}/campaigns`, {}, 'POST', { form: { name: 'x', objective: 'OUTCOME_LEADS', access_token: token } }));
    expect(write.status).toBe(400);
    expect(body(write).error).toMatchObject({ code: 100, type: 'SandboxNotAvailable' });
    const del = await sim.handle(req(FIXTURE_IDS.campaigns[0], {}, 'DELETE'));
    expect(body(del).error.code).toBe(100);
    const exchange = await sim.handle(req('oauth/access_token', { grant_type: 'fb_exchange_token', fb_exchange_token: token }, 'POST'));
    expect(body(exchange)).toEqual({ access_token: token, token_type: 'bearer', expires_in: 5184000 });
  });
  it('an unknown read path is a Graph 100 error and an internal failure is a Graph-shaped 500, never a throw', async () => {
    const sim = createMetaSimulator(deps());
    const unknown = await sim.handle(req('act_1207000000000001/nonexistent_edge'));
    expect(unknown.status).toBe(400);
    expect(body(unknown).error.code).toBe(100);
    const broken = createMetaSimulator({ ...deps(), loadDataset: jest.fn(async () => { throw new Error('dynamo down'); }) });
    const res = await broken.handle(req('me'));
    expect(res.status).toBe(500);
    expect(body(res).error).toMatchObject({ code: 1, type: 'OAuthException' });
    expect(res.headers['content-type']).toBe('application/json');
  });
  it('async insights: POST creates a report, GET status is complete, GET rows returns the envelope', async () => {
    const sim = createMetaSimulator(deps());
    const submit = await sim.handle(req(`act_${FIXTURE_ACCOUNT_ID}/insights`, {}, 'POST', { form: { fields: 'campaign_id,spend', level: 'campaign', date_preset: 'last_30d', limit: '5000', access_token: token } }));
    expect(submit.status).toBe(200);
    const rid = body(submit).report_run_id;
    expect(rid).toMatch(/^\d+$/);
    const status = await sim.handle(req(rid));
    expect(body(status)).toMatchObject({ id: rid, async_status: 'Job Completed', async_percent_completion: 100 });
    const rows = await sim.handle(req(`${rid}/insights`, { limit: '5000' }));
    expect(body(rows).data.length).toBeGreaterThan(0);
    expect(body(rows).data[0]).toMatchObject({ campaign_id: expect.any(String), spend: expect.stringMatching(/^\d+\.\d\d$/) });
    expect(body(rows).paging.next).toBeUndefined();
  });
  it('the SDK-pinned v24.0 and raw v25.0 paths behave identically', async () => {
    const sim = createMetaSimulator(deps());
    const a = await sim.handle({ ...req(`act_${FIXTURE_ACCOUNT_ID}/campaigns`, { fields: 'id' }), version: 'v24.0' });
    const b = await sim.handle({ ...req(`act_${FIXTURE_ACCOUNT_ID}/campaigns`, { fields: 'id' }), version: 'v25.0' });
    expect(body(a)).toEqual(body(b));
  });
});
