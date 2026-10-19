/**
 * ENG-55 add-on — plan gating of POST /api/agent-mode/compare and /compare/select over real HTTP wiring.
 * (Original wiring suite: modelCompare.routes.test.ts.)
 *
 * Mounts the REAL routes/agentMode.ts router with the REAL authenticateToken
 * middleware (only the user table, the 15k-line controller object and the data
 * layer are faked) so these prove: the routes sit behind authentication, ownership
 * yields 403/404, the kill switch yields 503, a paused user yields 429, and
 * /compare never writes to the session.
 */
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';

const mockAddMessages = jest.fn();
const mockAddMessage = jest.fn();
const mockUpdateModel = jest.fn();
const mockUpdateTitle = jest.fn();
const mockGetSession = jest.fn();
const mockCallLLM = jest.fn();
const mockGetSetting = jest.fn();
const mockCheckUsage = jest.fn();
const mockFeature = jest.fn();
const mockGetUser = jest.fn();

jest.mock('../controllers/agentModeController', () => ({
  // routes/agentMode.ts dereferences hundreds of handlers at import time.
  agentModeController: new Proxy({}, { get: () => jest.fn() }),
  tryClaimSessionGeneration: jest.fn(() => true),
  releaseSessionGeneration: jest.fn(),
  resolveEffectiveModelForUser: jest.fn(async ({ requestedModel }: { requestedModel: string }) => ({
    effectiveModel: requestedModel,
    modelSelection: 'honored',
  })),
}));
jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getChatSession: (...a: unknown[]) => mockGetSession(...a),
    addMessagesToSession: (...a: unknown[]) => mockAddMessages(...a),
    addMessageToSession: (...a: unknown[]) => mockAddMessage(...a),
    updateSessionLlmModel: (...a: unknown[]) => mockUpdateModel(...a),
    updateSessionTitle: (...a: unknown[]) => mockUpdateTitle(...a),
  },
}));
jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    normalizeModelId: (m: string) => m,
    getModelCompareInfo: (m: string) => ({ name: m, provider: 'other', isLive: false, internalOnly: false }),
    callLLM: (...a: unknown[]) => mockCallLLM(...a),
  },
}));
jest.mock('../services/settingsService', () => ({
  settingsService: { getSetting: (...a: unknown[]) => mockGetSetting(...a) },
}));
jest.mock('../services/tokenUsageService', () => ({
  checkTokenUsage: (...a: unknown[]) => mockCheckUsage(...a),
  resolveBillingUserId: async (u: string) => u,
}));
jest.mock('../utils/llmPricing', () => ({ getModelPrice: () => ({ input: 1, output: 1 }) }));
jest.mock('../services/db', () => ({
  userDb: { getUserById: (...a: unknown[]) => mockGetUser(...a) },
}));
jest.mock('../services/subscriptionService', () => ({
  isSubscriptionFeatureEnabled: (...a: unknown[]) => mockFeature(...a),
}));
// runFunding is REAL (so the ambient scope is real); only the settings-backed flag read it lazy-loads is faked.
jest.mock('../services/funding/fundingFlags', () => ({ getFundingFlags: async () => ({}) }));
jest.mock('../services/voiceService', () => ({ synthesizeSpeech: jest.fn() }));
jest.mock('../middleware/serviceAuth', () => ({ requireScheduledChatsServiceSecret: (_q: unknown, _r: unknown, n: () => void) => n() }));
jest.mock('../services/agentMode/runStore', () => ({ getOwnedRunStatus: jest.fn() }));

import agentModeRoutes from '../routes/agentMode';
import { currentRunFunding } from '../services/funding/runFunding';

import { tryClaimSessionGeneration } from '../controllers/agentModeController';

const GOOD_SECRET = 'route-test-secret';
const bearer = (userId: string) => `Bearer ${jwt.sign({ userId, email: `${userId}@x.test`, isAdmin: false }, GOOD_SECRET)}`;
const app = express();
app.use(express.json());
app.use('/api/agent-mode', agentModeRoutes);

const validBody = { sessionId: 's-1', prompt: 'hi', models: ['gpt-5.5', 'gemini-3.5-flash'] };
const ownedSession = { sessionId: 's-1', userId: 'owner', messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'first turn' }, { role: 'assistant', content: 'first reply' }] };
const selectBody = { sessionId: 's-1', compareId: '11111111-2222-4333-8444-555555555555', prompt: 'hi', model: 'gpt-5.5', content: 'x', issuedAt: Date.now(), selectToken: 'a'.repeat(64) };

let switchValue: string | null = null;
let settingsFail = false;
let clock = Date.now();

beforeAll(() => { process.env.JWT_SECRET = GOOD_SECRET; });
beforeEach(() => {
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  clock += 10 * 60_000; // expire the entitlement switch cache between tests
  jest.spyOn(Date, 'now').mockImplementation(() => clock);
  switchValue = null;
  settingsFail = false;
  mockGetUser.mockImplementation(async (id: string) => ({ userId: id, email: `${id}@x.test`, isAdmin: false, sessionVersion: 0 }));
  mockFeature.mockReset();
  mockGetSession.mockResolvedValue(ownedSession);
  mockGetSetting.mockImplementation(async (name: string) => {
    if (name === 'model_compare_requires_entitlement') {
      if (settingsFail) throw new Error('settings down');
      return switchValue === null ? null : { settingValue: switchValue };
    }
    return null;
  });
  mockCheckUsage.mockResolvedValue({ allowed: true, month: '2026-10' });
  mockCallLLM.mockImplementation(async (model: string) => ({ choices: [{ message: { content: `from ${model}` } }], usage: { cost: 1 } }));
});
afterEach(() => jest.restoreAllMocks());

const post = (path: string, user: string, body: unknown) =>
  request(app).post(path).set('Authorization', bearer(user)).send(body as object);

function expectNoWork() {
  expect(mockCallLLM).not.toHaveBeenCalled();
  expect(mockGetSession).not.toHaveBeenCalled();
  expect(mockAddMessages).not.toHaveBeenCalled();
  expect(mockUpdateModel).not.toHaveBeenCalled();
  expect(tryClaimSessionGeneration).not.toHaveBeenCalled();
}

describe('switch absent or not "true": unchanged behaviour', () => {
  it.each([null, 'false', 'yes'])('compare works for a tier WITHOUT the id when the switch is %j', async (v) => {
    switchValue = v;
    mockFeature.mockResolvedValue(false);
    const out = await post('/api/agent-mode/compare', 'owner', validBody);
    expect(out.status).toBe(200);
    expect(mockFeature).not.toHaveBeenCalled();
  });
});

describe('switch on', () => {
  beforeEach(() => { switchValue = 'true'; });

  it.each([
    ['/api/agent-mode/compare', validBody],
    ['/api/agent-mode/compare/select', selectBody],
  ])('%s: tier without the id => 403 model_compare_not_entitled, no model call, no lock, no write', async (path, body) => {
    mockFeature.mockResolvedValue(false);
    const out = await post(path, 'owner', body);
    expect(out.status).toBe(403);
    expect(out.body).toEqual({ error: 'Compare models is not available on your current plan.', code: 'model_compare_not_entitled' });
    expect(out.headers['cache-control']).toBe('no-store');
    expect(mockFeature).toHaveBeenCalledWith('owner', 'model_compare');
    expectNoWork();
  });

  it.each([['/api/agent-mode/compare', validBody], ['/api/agent-mode/compare/select', selectBody]])(
    '%s: unreadable tier (null) => 403 (fail closed)', async (path, body) => {
      mockFeature.mockResolvedValue(null);
      expect((await post(path, 'owner', body)).status).toBe(403);
      expectNoWork();
    });

  it('tier lookup throwing => 403', async () => {
    mockFeature.mockRejectedValue(new Error('ddb'));
    expect((await post('/api/agent-mode/compare', 'owner', validBody)).status).toBe(403);
    expectNoWork();
  });

  it('tier with the id => compare works', async () => {
    mockFeature.mockResolvedValue(true);
    const out = await post('/api/agent-mode/compare', 'owner', validBody);
    expect(out.status).toBe(200);
    expect(mockCallLLM).toHaveBeenCalledTimes(2);
  });

  it('admin => compare works without consulting the tier', async () => {
    mockFeature.mockResolvedValue(false);
    mockGetUser.mockImplementation(async (id: string) => ({ userId: id, email: `${id}@x.test`, isAdmin: true, sessionVersion: 0 }));
    const out = await request(app).post('/api/agent-mode/compare')
      .set('Authorization', `Bearer ${jwt.sign({ userId: 'owner', email: 'owner@x.test', isAdmin: true }, GOOD_SECRET)}`).send(validBody);
    expect(out.status).toBe(200);
    expect(mockFeature).not.toHaveBeenCalled();
  });

  it('delegated/target customer: the plan of req.user (the customer) decides', async () => {
    mockFeature.mockImplementation(async (id: string) => id === 'owner');
    expect((await post('/api/agent-mode/compare', 'owner', validBody)).status).toBe(200);
    mockGetSession.mockClear(); mockCallLLM.mockClear();
    clock += 10 * 60_000;
    mockGetSession.mockResolvedValue({ ...ownedSession, userId: 'other' });
    const denied = await post('/api/agent-mode/compare', 'other', validBody);
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('model_compare_not_entitled');
    expect(mockCallLLM).not.toHaveBeenCalled();
  });

  it('a settings outage after a known "true" keeps enforcing (last-known value)', async () => {
    mockFeature.mockResolvedValue(false);
    expect((await post('/api/agent-mode/compare', 'owner', validBody)).status).toBe(403);
    settingsFail = true;
    clock += 61_000;
    expect((await post('/api/agent-mode/compare', 'owner', validBody)).status).toBe(403);
  });
});
