/**
 * ENG-112 — wiring of POST /api/agent-mode/session/:sessionId/branch.
 *
 * Mounts the REAL routes/agentMode.ts router with the REAL authenticateToken and the REAL
 * chatBranchController + ChatbotDB (over an in-memory DocumentClient). Only the 15k-line
 * controller object, the user table and the settings row are faked, so these prove: the route sits
 * behind authentication, the flag defaults OFF (absent row, "false", unreadable) and flips with
 * the exact value "true", ownership yields 403/404, delegation is recorded, the model policy is
 * the owner's, and a generation in flight on the source yields 409.
 */
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { BranchFakeDynamo } from './helpers/branchFakeDynamo';

const mockFake = new BranchFakeDynamo();
const mockGetSetting = jest.fn();
const mockClaimed = new Set<string>();
const mockResolve = jest.fn();

jest.mock('aws-sdk', () => ({
  DynamoDB: { DocumentClient: jest.fn(() => mockFake.client()) },
  S3: jest.fn(() => ({})),
  SecretsManager: jest.fn(() => ({})),
  config: { update: jest.fn() },
}));
jest.mock('../controllers/agentModeController', () => ({
  agentModeController: new Proxy({}, { get: () => jest.fn() }),
  tryClaimSessionGeneration: (id: string) => (mockClaimed.has(id) ? false : (mockClaimed.add(id), true)),
  releaseSessionGeneration: (id: string) => { mockClaimed.delete(id); },
  resolveEffectiveModelForUser: (...a: unknown[]) => mockResolve(...a),
  toStoredModelPolicyDecision: (d: any) => ({ requestedModel: d.requestedModel, effectiveModel: d.effectiveModel, backupModel: null, backupSource: null, modelSelection: d.modelSelection, modelSelectionReason: 'r', usageMode: 'full_choice', usagePolicyVersion: null, recordedAt: 'x' }),
  modelUnavailableBody: () => ({ code: 'model_unavailable' }),
}));
jest.mock('../services/agentModeService', () => ({
  ADMIN_SKILL_TOOL_NAMES: ['get_pr_digest'],
  agentModeService: {
    getDefaultModel: async () => 'gpt-5.5',
    normalizeModelId: (m: string) => m,
    getModelCompareInfo: (m: string) => ({ name: m, provider: 'other', isLive: false, internalOnly: false }),
    callLLM: jest.fn(),
  },
}));
jest.mock('../services/settingsService', () => ({
  settingsService: { getSetting: (...a: unknown[]) => mockGetSetting(...a) },
}));
jest.mock('../services/tokenUsageService', () => ({ checkTokenUsage: jest.fn(), resolveBillingUserId: async (u: string) => u }));
jest.mock('../utils/llmPricing', () => ({ getModelPrice: () => ({ input: 1, output: 1 }) }));
jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn(async (id: string) => ({ userId: id, email: `${id}@x.test`, isAdmin: id.startsWith('admin'), sessionVersion: 0 })),
    updateUser: jest.fn().mockResolvedValue(undefined),
  },
  taskDb: {},
}));
jest.mock('../services/funding/fundingFlags', () => ({ getFundingFlags: async () => ({}) }));
jest.mock('../services/voiceService', () => ({ synthesizeSpeech: jest.fn() }));
jest.mock('../middleware/serviceAuth', () => ({ requireScheduledChatsServiceSecret: (_q: unknown, _r: unknown, n: () => void) => n() }));
jest.mock('../services/agentMode/runStore', () => ({
  getOwnedRunStatus: jest.fn(),
  isRunStoreEnabled: () => false,
  IDEM_TTL_INTERACTIVE_S: 600,
  createSessionIdempotencyKey: (u: string, k: string) => `${u}|${k}`,
  claimIdempotency: jest.fn(),
  recordIdempotencySessionId: jest.fn(),
  releaseIdempotency: jest.fn(),
}));
jest.mock('../utils/secretsManager', () => ({ getGCSPPrivateKey: jest.fn().mockResolvedValue('k') }));
// ENG-669: the legacy plan-pin rule reads the source plan's template (storedBindingSource -> legacyPlanPinSource).
const mockGetWorkPlan = jest.fn();
jest.mock('../services/workPlanService', () => ({ workPlanService: { getWorkPlan: (...a: unknown[]) => mockGetWorkPlan(...a) } }));
jest.mock('../controllers/guide', () => ({ getGuide: jest.fn() }));
jest.mock('../controllers/release', () => ({ getReleases: jest.fn() }));
jest.mock('../controllers/docsController', () => ({ getUserReleaseNotes: jest.fn() }));

import agentModeRoutes from '../routes/agentMode';
import { __resetBranchRateLimitCacheForTests, __resetBranchLookupCacheForTests } from '../controllers/chatBranchController';
import { __resetBranchIdempotencyForTests, __lookupWindowUsersForTests } from '../services/agentMode/chatBranching';

const SECRET = 'route-test-secret';
const bearer = (userId: string, extra: Record<string, unknown> = {}) =>
  `Bearer ${jwt.sign({ userId, email: `${userId}@x.test`, isAdmin: userId.startsWith('admin'), ...extra }, SECRET)}`;

const app = express();
app.use(express.json());
app.use('/api/agent-mode', agentModeRoutes);

const msg = (role: string, content: string, extra: Record<string, unknown> = {}) => ({ role, content, timestamp: 't', metadata: { timestamp: 't' }, ...extra });
const ROWS = [msg('system', 'SYS'), msg('user', 'hi'), msg('assistant', 'hello', { llm: 'gpt-5.5' }), msg('user', 'more'), msg('assistant', 'again')];
const URL = '/api/agent-mode/session/s-1/branch';

beforeAll(() => { process.env.JWT_SECRET = SECRET; });
beforeEach(() => {
  mockFake.tables.clear();
  mockClaimed.clear();
  __resetBranchRateLimitCacheForTests();
  __resetBranchLookupCacheForTests();
  __resetBranchIdempotencyForTests();
  mockGetSetting.mockReset();
  mockGetSetting.mockImplementation(async (name: string) => (name === 'chat_branching_enabled' ? { settingName: name, settingValue: 'true' } : null));
  mockResolve.mockReset();
  mockResolve.mockImplementation(async ({ requestedModel }: any) => ({ requestedModel, effectiveModel: requestedModel ?? 'gpt-5.5', modelSelection: 'honored' }));
  mockFake.seedSession({
    sessionId: 's-1', userId: 'owner', title: 'Hello', portalType: 'agent', sessionType: 'regular', llmModel: 'gpt-5.5',
    interactiveShareMetadata: { isActive: true, token: 'TOK' }, shareMetadata: { isShared: true }, messageCount: ROWS.length, messages: [],
  });
  mockFake.seedMessages('s-1', ROWS);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

const others = () => mockFake.sessionIds().filter((id) => id !== 's-1');

describe('authentication', () => {
  it('rejects an unauthenticated caller with 401 and does no work', async () => {
    expect((await request(app).post(URL).send({ messageIndex: 2 })).status).toBe(401);
    expect((await request(app).post(URL).set('Authorization', 'Bearer nope').send({ messageIndex: 2 })).status).toBe(401);
    expect(mockGetSetting).not.toHaveBeenCalled();
    expect(others()).toEqual([]);
  });
});

describe('feature flag', () => {
  it.each([[null], [{ settingValue: 'false' }], [{ settingValue: '' }], [{ settingValue: 'TRUEISH' }], [{ settingValue: '1' }]])('default OFF: setting %j -> 404 chat_branching_disabled, nothing created', async (row) => {
    mockGetSetting.mockResolvedValue(row);
    const out = await request(app).post(URL).set('Authorization', bearer('owner')).send({ messageIndex: 2 });
    expect(out.status).toBe(404);
    expect(out.body.code).toBe('chat_branching_disabled');
    expect(others()).toEqual([]);
  });

  it('an unreadable settings row also means OFF (the feature writes data: fail closed)', async () => {
    mockGetSetting.mockRejectedValue(new Error('ddb down'));
    const out = await request(app).post(URL).set('Authorization', bearer('owner')).send({ messageIndex: 2 });
    expect(out.status).toBe(404);
    expect(others()).toEqual([]);
  });

  it.each([[' True '], ['TRUE'], ['True'], [' true ']])('only the exact value "true" enables it: %j stays OFF', async (v) => {
    mockGetSetting.mockResolvedValue({ settingValue: v });
    expect((await request(app).post(URL).set('Authorization', bearer('owner')).send({ messageIndex: 2 })).status).toBe(404);
  });
});

describe('POST /session/:id/branch', () => {
  it('201 for the owner; no-store; the branch is private (no share tokens) and ordinary', async () => {
    const out = await request(app).post(URL).set('Authorization', bearer('owner')).send({ messageIndex: 2, idempotencyKey: 'k1' });
    expect(out.status).toBe(201);
    expect(out.headers['cache-control']).toBe('no-store');
    expect(out.body).toMatchObject({ title: 'Hello (branch)', llmModel: 'gpt-5.5', messageCount: 3, sourceSessionId: 's-1' });
    const item = mockFake.session(out.body.sessionId)!;
    expect(item.interactiveShareMetadata).toBeUndefined();
    expect(item.shareMetadata).toBeUndefined();
    expect(item.sessionType).toBe('regular');
    expect(mockFake.rows(out.body.sessionId)).toHaveLength(3);
  });

  it('the idempotent retry over HTTP attaches to the same branch (200, idempotentReplay)', async () => {
    const a = await request(app).post(URL).set('Authorization', bearer('owner')).send({ messageIndex: 2, idempotencyKey: 'k1' });
    const b = await request(app).post(URL).set('Authorization', bearer('owner')).send({ messageIndex: 2, idempotencyKey: 'k1' });
    expect(b.status).toBe(200);
    expect(b.body.sessionId).toBe(a.body.sessionId);
    expect(b.body.idempotentReplay).toBe(true);
    expect(others()).toHaveLength(1);
  });

  it('403 for a stranger, 404 for a missing session; nothing created', async () => {
    expect((await request(app).post(URL).set('Authorization', bearer('stranger')).send({ messageIndex: 2 })).status).toBe(403);
    expect((await request(app).post('/api/agent-mode/session/nope/branch').set('Authorization', bearer('owner')).send({ messageIndex: 2 })).status).toBe(404);
    expect(others()).toEqual([]);
  });

  it('a delegated admin branches as the customer: owner stays the customer, delegateInfo is THIS request\'s', async () => {
    const token = jwt.sign({
      userId: 'admin-1', email: 'admin-1@x.test', isAdmin: true,
      delegateAccess: { adminUserId: 'admin-1', adminEmail: 'admin-1@x.test', targetUserId: 'owner', targetEmail: 'owner@x.test' },
    }, SECRET);
    const out = await request(app).post(URL).set('Authorization', `Bearer ${token}`).send({ messageIndex: 2 });
    expect(out.status).toBe(201);
    const item = mockFake.session(out.body.sessionId)!;
    expect(item.userId).toBe('owner');
    expect(item.delegateInfo).toMatchObject({ adminUserId: 'admin-1', adminEmail: 'admin-1@x.test', isDelegated: true });
  });

  it('a NON-delegated admin cannot branch a customer\'s session: 403 and nothing is written', async () => {
    const out = await request(app).post(URL).set('Authorization', bearer('admin-1')).send({ messageIndex: 2 });
    expect(out.status).toBe(403);
    expect(others()).toEqual([]);
  });

  it('the model is resolved for the OWNER as an explicit selection; an unavailable model is 422 with nothing created', async () => {
    const ok = await request(app).post(URL).set('Authorization', bearer('owner')).send({ messageIndex: 2, llmModel: 'claude-opus-4-8' });
    expect(ok.status).toBe(201);
    expect(mockResolve).toHaveBeenCalledWith(expect.objectContaining({ userId: 'owner', requestedModel: 'claude-opus-4-8', allowSilentSwap: false }));
    expect(mockFake.session(ok.body.sessionId)!.llmModel).toBe('claude-opus-4-8');

    const { ModelUnavailableError } = jest.requireActual('../services/agentMode/modelUnavailable');
    mockResolve.mockRejectedValueOnce(new ModelUnavailableError('nope', 'not_served'));
    const before = others().length;
    const bad = await request(app).post(URL).set('Authorization', bearer('owner')).send({ messageIndex: 2, llmModel: 'nope' });
    expect(bad.status).toBe(422);
    expect(others()).toHaveLength(before);
  });

  it('ENG-669: a branch INHERITING a stored model outside the owner\'s plan is a 422 at branch time; nothing is created', async () => {
    const { ModelUnavailableError } = jest.requireActual('../services/agentMode/modelUnavailable');
    mockResolve.mockRejectedValueOnce(new ModelUnavailableError('gpt-5.5', 'not_in_plan', {
      model: 'gpt-5.5', tier: 'Free', allowedModels: ['gemini-3.5-flash'], upgradeRequired: ['Pro'],
    }));
    const out = await request(app).post(URL).set('Authorization', bearer('owner')).send({ messageIndex: 2 });
    expect(out.status).toBe(422);
    expect(out.body.code).toBe('model_unavailable');
    // The inherited (stored) model is resolved as a non-explicit selection for the OWNER; the resolver's tier check
    // applies to it anyway (proven in agentModeController.failLoudSelectedModel.test.ts), so it is never swapped.
    expect(mockResolve).toHaveBeenCalledWith(expect.objectContaining({ userId: 'owner', requestedModel: 'gpt-5.5', allowSilentSwap: true }));
    expect(others()).toEqual([]);
    expect(mockClaimed.has('s-1')).toBe(false);
  });

  it('ENG-669 PR-C: a branch keeps the AgentWeb Model SELECTION, never the model it routed to', async () => {
    mockResolve.mockImplementationOnce(async () => ({
      requestedModel: 'agentweb-model', effectiveModel: 'gemini-3.5-flash', modelSelection: 'honored',
      routedVia: 'agentweb-model', routingReason: 'chat task: table default', tableVersion: 't1',
    }));
    const out = await request(app).post(URL).set('Authorization', bearer('owner')).send({ messageIndex: 2, llmModel: 'agentweb-model' });
    expect(out.status).toBe(201);
    expect(mockFake.session(out.body.sessionId)!.llmModel).toBe('agentweb-model');
  });

  describe('#3607 follow-up 2: a branch inherits who chose the source\'s model', () => {
    const LEGACY_URL = '/api/agent-mode/session/s-legacy/branch';
    const seedLegacyPlanSession = (extra: Record<string, unknown> = {}) => {
      // A plan launched before planAuthor existed; the engine stamped its step pin with no llmModelSource.
      mockFake.seedSession({
        sessionId: 's-legacy', userId: 'owner', title: 'Plan', portalType: 'agent', sessionType: 'regular', llmModel: 'claude-step-pin',
        llmUsagePolicyDecision: { requestedModel: 'claude-step-pin', effectiveModel: 'claude-step-pin', modelSelection: 'honored' },
        workPlan: { title: 'P', templatePlanId: 't1', createdAt: 'x', updatedAt: 'x', steps: [{ stepCount: 1, title: 'S1', status: 'completed', model: 'claude-step-pin' }] },
        messageCount: ROWS.length, messages: [], ...extra,
      });
      mockFake.seedMessages('s-legacy', ROWS);
    };

    it('the inherited pin of a LEGACY admin-authored plan stays AgentWeb\'s choice on the branch (system), so it is not refused later', async () => {
      mockGetWorkPlan.mockResolvedValue({ planId: 't1', visibility: 'system', isBuiltIn: true });
      seedLegacyPlanSession();
      const out = await request(app).post(LEGACY_URL).set('Authorization', bearer('owner')).send({ messageIndex: 2 });
      expect(out.status).toBe(201);
      expect(mockGetWorkPlan).toHaveBeenCalledWith('t1');
      expect(mockFake.session(out.body.sessionId)).toMatchObject({ llmModel: 'claude-step-pin', llmModelSource: 'system' });
    });

    it('a legacy USER plan\'s pin, a recorded source, and an explicit pick keep their own provenance', async () => {
      mockGetWorkPlan.mockResolvedValue({ planId: 't1', visibility: 'private', isBuiltIn: false });
      seedLegacyPlanSession();
      const userPlan = await request(app).post(LEGACY_URL).set('Authorization', bearer('owner')).send({ messageIndex: 2, idempotencyKey: 'a' });
      expect(mockFake.session(userPlan.body.sessionId)!.llmModelSource).toBe('user');

      mockGetWorkPlan.mockReset();
      seedLegacyPlanSession({ sessionId: 's-legacy', llmModelSource: 'system' });
      const recorded = await request(app).post(LEGACY_URL).set('Authorization', bearer('owner')).send({ messageIndex: 2, idempotencyKey: 'b' });
      expect(mockFake.session(recorded.body.sessionId)!.llmModelSource).toBe('system');
      expect(mockGetWorkPlan).not.toHaveBeenCalled();

      const picked = await request(app).post(LEGACY_URL).set('Authorization', bearer('owner')).send({ messageIndex: 2, llmModel: 'gpt-5.5', idempotencyKey: 'c' });
      expect(mockFake.session(picked.body.sessionId)!.llmModelSource).toBe('user');
    });
  });

  it('409 SESSION_BUSY while the source is generating, and that lock is not released by the refused branch', async () => {
    mockClaimed.add('s-1');
    const out = await request(app).post(URL).set('Authorization', bearer('owner')).send({ messageIndex: 2 });
    expect(out.status).toBe(409);
    expect(out.body.code).toBe('SESSION_BUSY');
    expect(mockClaimed.has('s-1')).toBe(true);
    expect(others()).toEqual([]);
  });

  it('400 for a bad index, and the source lock is free afterwards', async () => {
    const out = await request(app).post(URL).set('Authorization', bearer('owner')).send({ messageIndex: 50 });
    expect(out.status).toBe(400);
    expect(out.body.code).toBe('message_index_out_of_range');
    expect(mockClaimed.size).toBe(0);
  });
});

describe('per-user cap (AW-Settings chat_branching_max_per_hour)', () => {
  const setCap = (value: unknown) =>
    mockGetSetting.mockImplementation(async (name: string) =>
      name === 'chat_branching_enabled' ? { settingValue: 'true' } : name === 'chat_branching_max_per_hour' ? (value === null ? null : { settingValue: value }) : null);
  const post = () => request(app).post(URL).set('Authorization', bearer('owner')).send({ messageIndex: 2 });

  it('429 TOO_MANY_BRANCHES with a neutral message once the configured cap is reached', async () => {
    setCap('2');
    expect((await post()).status).toBe(201);
    expect((await post()).status).toBe(201);
    const out = await post();
    expect(out.status).toBe(429);
    expect(out.body.code).toBe('TOO_MANY_BRANCHES');
    expect(out.body.message).toMatch(/try again/i);
    expect(others()).toHaveLength(2);
    expect(mockClaimed.size).toBe(0);
  });

  it('"0" is unlimited; an absent row defaults to 30; garbage defaults to 30', async () => {
    setCap('0');
    for (let i = 0; i < 4; i++) expect((await post()).status).toBe(201);
    __resetBranchRateLimitCacheForTests();
    __resetBranchIdempotencyForTests();
    setCap('banana');
    for (let i = 0; i < 30; i++) expect((await post()).status).toBe(201);
    expect((await post()).status).toBe(429);
  }, 30000);

  it('the setting is cached; an unreadable row serves the last known value', async () => {
    setCap('1');
    expect((await post()).status).toBe(201);
    mockGetSetting.mockImplementation(async (name: string) => {
      if (name === 'chat_branching_enabled') return { settingValue: 'true' };
      throw new Error('settings down');
    });
    expect((await post()).status).toBe(429);
    const reads = mockGetSetting.mock.calls.filter((c) => c[0] === 'chat_branching_max_per_hour').length;
    expect(reads).toBe(1); // second request served from the ~60s cache
  });
});

describe('GET /session/:id/branches (ENG-112 family listing)', () => {
  const LIST = (id: string) => `/api/agent-mode/session/${id}/branches`;
  const get = (id: string, user = 'owner') => request(app).get(LIST(id)).set('Authorization', bearer(user));
  const at = (n: number) => `2026-10-${String(10 + Math.floor(n / 100)).padStart(2, '0')}T00:${String(Math.floor(n / 60) % 60).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}.000Z`;
  const link = (sessionId: string, rootSessionId: string, branchedAt = at(1)) => ({ sessionId, rootSessionId, messageIndex: 2, branchedAt });
  const seed = (sessionId: string, over: Record<string, unknown> = {}) =>
    mockFake.seedSession({
      sessionId, userId: 'owner', title: `T-${sessionId}`, llmModel: 'gpt-5.5', messageCount: 3, portalType: 'agent',
      createdAt: at(1), updatedAt: at(1), messages: [], ...over,
    });

  beforeEach(() => {
    mockFake.indexPageSize = undefined;
    mockFake.indexLeaksOtherUsers = false;
    mockFake.indexQueries.length = 0;
    mockFake.messageQueries.length = 0;
  });

  it('listing authorises on the session RECORD only: never reads (or migrates) messages, even for a foreign session', async () => {
    seed('s-rec', { messageCount: 7 });
    expect((await get('s-rec', 'stranger')).status).toBe(403);
    expect(mockFake.messageQueries).toHaveLength(0);
    const own = await get('s-rec');
    expect(own.status).toBe(200);
    expect(own.body.sessions[0].messageCount).toBe(7);
    expect(mockFake.messageQueries).toHaveLength(0);
  });

  it('401 without a token, and no work is done', async () => {
    expect((await request(app).get(LIST('s-1'))).status).toBe(401);
    expect(mockGetSetting).not.toHaveBeenCalled();
    expect(mockFake.indexQueries).toHaveLength(0);
  });

  it.each([[null], [{ settingValue: 'false' }], [{ settingValue: 'TRUE' }]])('flag off (%j) -> 404 chat_branching_disabled, nothing queried', async (row) => {
    mockGetSetting.mockResolvedValue(row);
    const out = await get('s-1');
    expect(out.status).toBe(404);
    expect(out.body.code).toBe('chat_branching_disabled');
    expect(mockFake.indexQueries).toHaveLength(0);
  });

  it('403 for a non-owner (nothing queried), 404 for a missing or archived session, 400 for a garbage id', async () => {
    expect((await get('s-1', 'stranger')).status).toBe(403);
    expect((await get('nope')).status).toBe(404);
    seed('arch', { archived: true });
    expect((await get('arch')).status).toBe(404);
    expect((await get('a%20b')).status).toBe(400);
    expect(mockFake.indexQueries).toHaveLength(0);
  });

  it('resolves the family from the ROOT and from a LEAF, createdAt ascending, with the documented shape', async () => {
    seed('R', { createdAt: at(1), updatedAt: at(90) });
    seed('B1', { createdAt: at(5), updatedAt: at(10), branchedFrom: link('R', 'R', at(5)) });
    seed('B2', { createdAt: at(3), updatedAt: at(99), branchedFrom: link('B1', 'R', at(3)) });
    seed('OTHER-ROOT', { createdAt: at(2) });
    seed('OTHER-BRANCH', { createdAt: at(4), branchedFrom: link('OTHER-ROOT', 'OTHER-ROOT') });
    for (const id of ['R', 'B1', 'B2']) {
      const out = await get(id);
      expect(out.status).toBe(200);
      expect(out.headers['cache-control']).toBe('no-store');
      expect(out.body.rootSessionId).toBe('R');
      expect(out.body.sessions.map((s: any) => s.sessionId)).toEqual(['R', 'B2', 'B1']);
      expect(out.body.truncated).toBeUndefined();
    }
    const out = await get('R');
    expect(out.body.sessions[0]).toEqual({ sessionId: 'R', title: 'T-R', llmModel: 'gpt-5.5', messageCount: 3, updatedAt: at(90), createdAt: at(1) });
    expect(out.body.sessions[1].branchedFrom).toEqual(link('B1', 'R', at(3)));
    expect(Object.keys(out.body.sessions[1]).sort()).toEqual(['branchedFrom', 'createdAt', 'llmModel', 'messageCount', 'sessionId', 'title', 'updatedAt']);
  });

  it('a chat with no branches answers with just itself', async () => {
    seed('solo');
    const out = await get('solo');
    expect(out.body).toEqual({ rootSessionId: 'solo', sessions: [expect.objectContaining({ sessionId: 'solo' })] });
  });

  it('uses ONE projected UserIdIndex query walk, never a scan', async () => {
    seed('R');
    seed('B1', { branchedFrom: link('R', 'R') });
    await get('R');
    expect(mockFake.indexQueries).toHaveLength(1);
    expect(mockFake.indexQueries[0]).toMatchObject({ IndexName: 'UserIdIndex', KeyConditionExpression: 'userId = :userId' });
    expect(mockFake.indexQueries[0].ProjectionExpression).toContain('branchedFrom');
    expect(mockFake.indexQueries[0].ProjectionExpression).not.toContain('messages');
  });

  it('excludes archived orphans (a branch born archived and never revealed) and an archived root', async () => {
    seed('R');
    seed('B1', { branchedFrom: link('R', 'R') });
    seed('ORPHAN', { archived: true, branchedFrom: link('R', 'R') });
    expect((await get('R')).body.sessions.map((s: any) => s.sessionId)).toEqual(['R', 'B1']);
    mockFake.session('R');
    seed('R', { archived: true });
    const fromLeaf = await get('B1');
    expect(fromLeaf.status).toBe(200);
    expect(fromLeaf.body.rootSessionId).toBe('R');
    expect(fromLeaf.body.sessions.map((s: any) => s.sessionId)).toEqual(['B1']);
    expect((await get('R')).status).toBe(404);
  });

  it("never leaks another user's sessions, even sharing the root id (and even if the index returned them)", async () => {
    seed('R');
    seed('MINE', { branchedFrom: link('R', 'R') });
    seed('THEIRS', { userId: 'someone-else', branchedFrom: link('R', 'R') });
    expect((await get('R')).body.sessions.map((s: any) => s.sessionId)).toEqual(['R', 'MINE']);
    mockFake.indexLeaksOtherUsers = true;
    const leaky = await get('R');
    expect(leaky.body.sessions.map((s: any) => s.sessionId)).toEqual(['R', 'MINE']);
    expect(JSON.stringify(leaky.body)).not.toContain('THEIRS');
  });

  it('legacy branches (row-0 branchOrigin only, no branchedFrom) are not grouped', async () => {
    seed('R');
    seed('LEGACY');
    mockFake.seedMessages('LEGACY', [{ role: 'system', content: 's', metadata: { branchOrigin: { sourceSessionId: 'R', sourceMessageIndex: 2, branchedAt: 'x' } } }]);
    expect((await get('R')).body.sessions.map((s: any) => s.sessionId)).toEqual(['R']);
  });

  it('follows LastEvaluatedKey across index pages', async () => {
    seed('R', { updatedAt: at(1) });
    for (let i = 0; i < 7; i++) seed(`B${i}`, { createdAt: at(10 + i), updatedAt: at(10 + i), branchedFrom: link('R', 'R') });
    for (let i = 0; i < 5; i++) seed(`N${i}`, { updatedAt: at(30 + i) });
    mockFake.indexPageSize = 3;
    const out = await get('R');
    expect(out.body.sessions.map((s: any) => s.sessionId)).toEqual(['R', ...Array.from({ length: 7 }, (_, i) => `B${i}`)]);
    expect(out.body.truncated).toBeUndefined();
    expect(mockFake.indexQueries).toHaveLength(5); // 13 sessions / 3 per page
    expect(mockFake.indexQueries[1].ExclusiveStartKey).toBeDefined();
  });

  it('caps at 50 sessions (root + 49) and stops walking early with truncated:true', async () => {
    seed('R', { createdAt: at(1), updatedAt: at(1) });
    for (let i = 0; i < 60; i++) seed(`B${String(i).padStart(2, '0')}`, { createdAt: at(10 + i), updatedAt: at(10 + i), branchedFrom: link('R', 'R') });
    mockFake.indexPageSize = 10;
    const out = await get('R');
    expect(out.body.sessions).toHaveLength(50);
    expect(out.body.sessions[0].sessionId).toBe('R');
    expect(out.body.truncated).toBe(true);
    expect(mockFake.indexQueries.length).toBeLessThan(7); // 61 rows / 10 per page: stopped at the cap
  });

  it('exactly 49 branches fit without truncation', async () => {
    seed('R');
    for (let i = 0; i < 49; i++) seed(`B${i}`, { createdAt: at(10 + i), branchedFrom: link('R', 'R') });
    const out = await get('R');
    expect(out.body.sessions).toHaveLength(50);
    expect(out.body.truncated).toBeUndefined();
  });

  it('stops after 20 index pages and reports truncated:true', async () => {
    seed('R');
    for (let i = 0; i < 30; i++) seed(`N${i}`, { updatedAt: at(10 + i) });
    mockFake.indexPageSize = 1;
    const out = await get('R');
    expect(mockFake.indexQueries).toHaveLength(20);
    expect(out.body.truncated).toBe(true);
    expect(out.body.sessions.map((s: any) => s.sessionId)).toEqual(['R']);
  });

  it('queries the index newest-first (ScanIndexForward=false) so truncation drops the OLDEST sessions, and still returns createdAt ascending', async () => {
    seed('R', { createdAt: at(1), updatedAt: at(1) });
    for (let i = 0; i < 30; i++) seed(`N${i}`, { createdAt: at(10 + i), updatedAt: at(10 + i) });
    seed('NEWEST', { createdAt: at(200), updatedAt: at(200), branchedFrom: link('R', 'R', at(200)) });
    seed('MID', { createdAt: at(100), updatedAt: at(100), branchedFrom: link('R', 'R', at(100)) });
    mockFake.indexPageSize = 1;
    const out = await get('R');
    expect(mockFake.indexQueries[0].ScanIndexForward).toBe(false);
    expect(out.body.truncated).toBe(true); // 20-page cap hit with more index left
    expect(out.body.sessions.map((s: any) => s.sessionId)).toEqual(['R', 'MID', 'NEWEST']);
  });

  it('exactly 49 branches with more (non-matching) pages left is NOT truncated; 50 branches is', async () => {
    seed('R');
    for (let i = 0; i < 49; i++) seed(`B${String(i).padStart(2, '0')}`, { createdAt: at(10 + i), updatedAt: at(100 + i), branchedFrom: link('R', 'R') });
    for (let i = 0; i < 25; i++) seed(`N${i}`, { updatedAt: at(300 + i) });
    mockFake.indexPageSize = 7;
    const exact = await get('R');
    expect(exact.body.sessions).toHaveLength(50);
    expect(exact.body.truncated).toBeUndefined();
    seed('B49', { createdAt: at(60), updatedAt: at(160), branchedFrom: link('R', 'R') });
    const over = await get('R');
    expect(over.body.sessions).toHaveLength(50);
    expect(over.body.truncated).toBe(true);
  });

  describe('per-user lookup rate limit', () => {
    const lookupReads = () => mockGetSetting.mock.calls.filter((c) => c[0] === 'branch_family_max_per_minute').length;
    beforeEach(() => {
      seed('R');
      seed('Rb', { userId: 'other' });
    });

    it('allows 20 per minute, 429 TOO_MANY_BRANCH_LOOKUPS on the 21st with a neutral message, and does no index work for it', async () => {
      for (let i = 0; i < 20; i++) expect((await get('R')).status).toBe(200);
      const queriesBefore = mockFake.indexQueries.length;
      const out = await get('R');
      expect(out.status).toBe(429);
      expect(out.body.code).toBe('TOO_MANY_BRANCH_LOOKUPS');
      expect(out.body.message).toBe('Too many requests. Please try again in a moment.');
      expect(mockFake.indexQueries.length).toBe(queriesBefore);
    });

    it('the window slides: allowed again a minute later', async () => {
      const spy = jest.spyOn(Date, 'now');
      try {
        const t0 = 1_800_000_000_000;
        spy.mockReturnValue(t0);
        for (let i = 0; i < 20; i++) await get('R');
        expect((await get('R')).status).toBe(429);
        spy.mockReturnValue(t0 + 60_001);
        expect((await get('R')).status).toBe(200);
      } finally {
        spy.mockRestore();
      }
    });

    it('is per user: one user exhausting the limit does not affect another', async () => {
      seed('S2', { userId: 'other' });
      for (let i = 0; i < 21; i++) await get('R');
      expect((await get('R')).status).toBe(429);
      expect((await get('S2', 'other')).status).toBe(200);
    });

    it('setting 0 = unlimited; a custom value is honoured; settings are cached ~60s', async () => {
      mockGetSetting.mockImplementation(async (name: string) =>
        name === 'chat_branching_enabled' ? { settingValue: 'true' } : name === 'branch_family_max_per_minute' ? { settingValue: '0' } : null);
      for (let i = 0; i < 30; i++) expect((await get('R')).status).toBe(200);
      expect(lookupReads()).toBe(1);
      __resetBranchLookupCacheForTests();
      mockGetSetting.mockImplementation(async (name: string) =>
        name === 'chat_branching_enabled' ? { settingValue: 'true' } : name === 'branch_family_max_per_minute' ? { settingValue: '2' } : null);
      expect((await get('R')).status).toBe(200);
      expect((await get('R')).status).toBe(200);
      expect((await get('R')).status).toBe(429);
    });

    it.each(['abc', '-1', '1.5', ''])('garbage setting %j falls back to the default of 20', async (garbage) => {
      mockGetSetting.mockImplementation(async (name: string) =>
        name === 'chat_branching_enabled' ? { settingValue: 'true' } : name === 'branch_family_max_per_minute' ? { settingValue: garbage } : null);
      for (let i = 0; i < 20; i++) expect((await get('R')).status).toBe(200);
      expect((await get('R')).status).toBe(429);
    });

    it('an unreadable setting row uses the default (never blocks reads)', async () => {
      mockGetSetting.mockImplementation(async (name: string) => {
        if (name === 'branch_family_max_per_minute') throw new Error('settings down');
        return { settingValue: 'true' };
      });
      const err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        expect((await get('R')).status).toBe(200);
      } finally {
        err.mockRestore();
      }
    });

    it('leaks no memory: expired windows are swept', async () => {
      const spy = jest.spyOn(Date, 'now');
      try {
        spy.mockReturnValue(1_800_000_000_000);
        for (let u = 0; u < 10; u++) { seed(`X${u}`, { userId: `u${u}` }); await get(`X${u}`, `u${u}`); }
        expect(__lookupWindowUsersForTests()).toBe(10);
        spy.mockReturnValue(1_800_000_000_000 + 120_000);
        for (let i = 0; i < 60; i++) await get('R'); // crosses a sweep boundary
        expect(__lookupWindowUsersForTests()).toBeLessThanOrEqual(1);
      } finally {
        spy.mockRestore();
      }
    });
  });
});
