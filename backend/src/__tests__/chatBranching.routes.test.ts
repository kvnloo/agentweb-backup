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
jest.mock('../controllers/guide', () => ({ getGuide: jest.fn() }));
jest.mock('../controllers/release', () => ({ getReleases: jest.fn() }));
jest.mock('../controllers/docsController', () => ({ getUserReleaseNotes: jest.fn() }));

import agentModeRoutes from '../routes/agentMode';
import { __resetBranchRateLimitCacheForTests } from '../controllers/chatBranchController';
import { __resetBranchIdempotencyForTests } from '../services/agentMode/chatBranching';

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
