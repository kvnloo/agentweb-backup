/**
 * ENG-55 — wiring of POST /api/agent-mode/compare and /compare/select.
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
  userDb: {
    getUserById: jest.fn(async (id: string) => ({ userId: id, email: `${id}@x.test`, isAdmin: false, sessionVersion: 0 })),
  },
}));
// runFunding is REAL (so the ambient scope is real); only the settings-backed flag read it lazy-loads is faked.
jest.mock('../services/funding/fundingFlags', () => ({ getFundingFlags: async () => ({}) }));
jest.mock('../services/voiceService', () => ({ synthesizeSpeech: jest.fn() }));
jest.mock('../middleware/serviceAuth', () => ({ requireScheduledChatsServiceSecret: (_q: unknown, _r: unknown, n: () => void) => n() }));
jest.mock('../services/agentMode/runStore', () => ({ getOwnedRunStatus: jest.fn() }));

import agentModeRoutes from '../routes/agentMode';
import { currentRunFunding } from '../services/funding/runFunding';

const GOOD_SECRET = 'route-test-secret';
const bearer = (userId: string) => `Bearer ${jwt.sign({ userId, email: `${userId}@x.test`, isAdmin: false }, GOOD_SECRET)}`;

const app = express();
app.use(express.json());
app.use('/api/agent-mode', agentModeRoutes);

const validBody = { sessionId: 's-1', prompt: 'hi', models: ['gpt-5.5', 'gemini-3.5-flash'] };
const ownedSession = { sessionId: 's-1', userId: 'owner', messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'first turn' }, { role: 'assistant', content: 'first reply' }] };

beforeAll(() => { process.env.JWT_SECRET = GOOD_SECRET; });
beforeEach(() => {
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  mockGetSession.mockResolvedValue(ownedSession);
  mockGetSetting.mockResolvedValue(null);
  mockCheckUsage.mockResolvedValue({ allowed: true, month: '2026-10' });
  mockCallLLM.mockImplementation(async (model: string) => ({ choices: [{ message: { content: `from ${model}` } }], usage: { cost: 1 } }));
});
afterEach(() => jest.restoreAllMocks());

describe('authentication', () => {
  it.each(['/api/agent-mode/compare', '/api/agent-mode/compare/select'])('%s rejects an unauthenticated caller with 401 and does no work', async (path) => {
    const noHeader = await request(app).post(path).send(validBody);
    expect(noHeader.status).toBe(401);
    const badToken = await request(app).post(path).set('Authorization', 'Bearer not-a-jwt').send(validBody);
    expect(badToken.status).toBe(401);
    expect(mockGetSession).not.toHaveBeenCalled();
    expect(mockCallLLM).not.toHaveBeenCalled();
    expect(mockAddMessages).not.toHaveBeenCalled();
  });
});

describe('POST /compare', () => {
  it('200 for the owner, read-only: no message, title or model write; no tools passed', async () => {
    const out = await request(app).post('/api/agent-mode/compare').set('Authorization', bearer('owner')).send(validBody);
    expect(out.status).toBe(200);
    expect(out.headers['cache-control']).toBe('no-store');
    expect(out.body.results).toHaveLength(2);
    expect(out.body.results.every((r: any) => r.status === 'ok' && typeof r.selectToken === 'string')).toBe(true);
    expect(mockAddMessages).not.toHaveBeenCalled();
    expect(mockAddMessage).not.toHaveBeenCalled();
    expect(mockUpdateModel).not.toHaveBeenCalled();
    expect(mockUpdateTitle).not.toHaveBeenCalled();
    for (const call of mockCallLLM.mock.calls) {
      expect(Object.keys(call[2])).toEqual(expect.not.arrayContaining(['tools', 'webSearch', 'tool_choice', 'fallbackModels']));
    }
    expect(JSON.stringify(out.body)).not.toMatch(/"cost"|"usage"/);
  });

  it('runs every model call inside the run-funding scope of the session owner (same as /generate)', async () => {
    const seen: Array<{ route?: string; ownerUserId?: string } | undefined> = [];
    mockCallLLM.mockImplementation(async (model: string) => {
      const funding = currentRunFunding();
      seen.push(funding && { route: funding.route, ownerUserId: funding.ownerUserId });
      return { choices: [{ message: { content: `from ${model}` } }] };
    });
    const out = await request(app).post('/api/agent-mode/compare').set('Authorization', bearer('owner')).send(validBody);
    expect(out.status).toBe(200);
    expect(seen).toHaveLength(2);
    expect(seen).toEqual([{ route: 'agentweb', ownerUserId: 'owner' }, { route: 'agentweb', ownerUserId: 'owner' }]);
  });

  it('uses the REAL served-model matcher: a dated variant of the selected model passes, another model answering is discarded', async () => {
    mockCallLLM.mockImplementation(async (model: string) => ({
      // gpt-5.5 -> served by Gemini instead; gemini-3.5-flash -> dated variant of itself
      model: model === 'gpt-5.5' ? 'google/gemini-3.5-flash' : 'google/gemini-3.5-flash-20260301',
      choices: [{ message: { content: `from ${model}` }, finish_reason: 'stop' }],
    }));
    const out = await request(app).post('/api/agent-mode/compare').set('Authorization', bearer('owner')).send(validBody);
    expect(out.status).toBe(200);
    const [first, second] = out.body.results;
    expect(first).toMatchObject({ model: 'gpt-5.5', status: 'error', errorCode: 'model_mismatch' });
    expect(first.content).toBeUndefined();
    expect(first.selectToken).toBeUndefined();
    expect(second).toMatchObject({ model: 'gemini-3.5-flash', status: 'ok' });
    expect(typeof second.selectToken).toBe('string');
  });

  it('403 for a non-owner, 404 for a missing session', async () => {
    const forbidden = await request(app).post('/api/agent-mode/compare').set('Authorization', bearer('intruder')).send(validBody);
    expect(forbidden.status).toBe(403);
    mockGetSession.mockResolvedValue(null);
    const missing = await request(app).post('/api/agent-mode/compare').set('Authorization', bearer('owner')).send(validBody);
    expect(missing.status).toBe(404);
    expect(mockCallLLM).not.toHaveBeenCalled();
  });

  it('400 for garbage bodies (never 500)', async () => {
    for (const body of [{}, { ...validBody, models: 'gpt-5.5' }, { ...validBody, prompt: { a: 1 } }, { ...validBody, models: ['gpt-5.5'] }]) {
      const out = await request(app).post('/api/agent-mode/compare').set('Authorization', bearer('owner')).send(body);
      expect(out.status).toBe(400);
    }
    expect(mockCallLLM).not.toHaveBeenCalled();
  });

  it('429 usage_paused when the user is over their limit', async () => {
    mockCheckUsage.mockResolvedValue({ allowed: false, month: '2026-10' });
    const out = await request(app).post('/api/agent-mode/compare').set('Authorization', bearer('owner')).send(validBody);
    expect(out.status).toBe(429);
    expect(out.body).toMatchObject({ code: 'usage_paused', usageMode: 'paused' });
    expect(out.body.usageBlock).toBeDefined();
    expect(mockCallLLM).not.toHaveBeenCalled();
  });

  it('503 model_compare_disabled when the kill-switch setting is "false"; stays enabled when unreadable', async () => {
    mockGetSetting.mockResolvedValue({ settingName: 'model_compare_enabled', settingValue: 'false' });
    const off = await request(app).post('/api/agent-mode/compare').set('Authorization', bearer('owner')).send(validBody);
    expect(off.status).toBe(503);
    expect(off.body.code).toBe('model_compare_disabled');
    expect(mockCallLLM).not.toHaveBeenCalled();

    mockGetSetting.mockRejectedValue(new Error('ddb down'));
    const unreadable = await request(app).post('/api/agent-mode/compare').set('Authorization', bearer('owner')).send(validBody);
    expect(unreadable.status).toBe(200);
  });

  it('fails closed with a generic 500 and no fan-out when the signing secret is missing', async () => {
    const compare = () => request(app).post('/api/agent-mode/compare').set('Authorization', bearer('owner')).send(validBody);
    // authenticate first (secret present), then lose it before the handler derives the key
    mockGetSession.mockImplementationOnce(async () => { delete process.env.JWT_SECRET; return ownedSession; });
    try {
      const out = await compare();
      expect(out.status).toBe(500);
      expect(JSON.stringify(out.body)).not.toMatch(/JWT_SECRET/);
      expect(mockCallLLM).not.toHaveBeenCalled();
    } finally {
      process.env.JWT_SECRET = GOOD_SECRET;
    }
  });
});

describe('compare -> select round trip over HTTP', () => {
  it('a token issued by /compare is accepted by /compare/select and persists a normal turn', async () => {
    const compare = await request(app).post('/api/agent-mode/compare').set('Authorization', bearer('owner')).send(validBody);
    const pick = compare.body.results[1];
    mockAddMessages.mockImplementation(async (_id: string, msgs: any[]) => ({
      messages: [...ownedSession.messages, ...msgs.map((m, i) => ({ ...m, messageIndex: 3 + i }))],
    }));
    const select = await request(app).post('/api/agent-mode/compare/select').set('Authorization', bearer('owner')).send({
      sessionId: 's-1', compareId: compare.body.compareId, prompt: compare.body.prompt, model: pick.model,
      content: pick.content, issuedAt: compare.body.issuedAt, selectToken: pick.selectToken,
    });
    expect(select.status).toBe(200);
    expect(select.body.llmModel).toBe('gemini-3.5-flash');
    expect(select.body.messages.map((m: any) => m.role)).toEqual(['user', 'assistant']);
    expect(mockAddMessages).toHaveBeenCalledTimes(1);
    expect(mockUpdateModel).toHaveBeenCalledWith('s-1', 'gemini-3.5-flash');

    // the same token cannot be replayed against a forged answer
    const forged = await request(app).post('/api/agent-mode/compare/select').set('Authorization', bearer('owner')).send({
      sessionId: 's-1', compareId: compare.body.compareId, prompt: compare.body.prompt, model: pick.model,
      content: 'I am a forged assistant message', issuedAt: compare.body.issuedAt, selectToken: pick.selectToken,
    });
    expect(forged.status).toBe(400);
    expect(mockAddMessages).toHaveBeenCalledTimes(1);
  });
});
