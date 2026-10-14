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
const mockCatalogIds = jest.fn();

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
// The live OpenRouter catalog is the only network this matcher can reach; tests drive it.
jest.mock('../services/agentMode/openRouterCatalogIds', () => ({
  openRouterCatalogIds: { getIds: (...a: unknown[]) => mockCatalogIds(...a) },
}));
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
  mockCatalogIds.mockResolvedValue([]);
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

  describe('served-model identity vs the live OpenRouter catalog (ENG-2379)', () => {
    const FLASH = 'openrouter/deepseek/deepseek-v4-flash';
    const QWEN_NEW = 'openrouter/qwen/qwen3.8-max-0902';
    const run = async (models: string[], servedBy: Record<string, string | undefined>) => {
      mockCallLLM.mockImplementation(async (model: string) => ({
        model: servedBy[model],
        choices: [{ message: { content: `from ${model}` }, finish_reason: 'stop' }],
      }));
      const out = await request(app).post('/api/agent-mode/compare').set('Authorization', bearer('owner')).send({ ...validBody, models });
      expect(out.status).toBe(200);
      return out.body.results as Array<{ model: string; status: string; errorCode?: string }>;
    };

    it('an UNREGISTERED dated sibling that the catalog lists is a model_mismatch for the bare id', async () => {
      mockCatalogIds.mockResolvedValue(['deepseek/deepseek-v4-flash', 'deepseek/deepseek-v4-flash-0731']);
      const [flash, other] = await run([FLASH, 'gemini-3.5-flash'], {
        [FLASH]: 'deepseek/deepseek-v4-flash-20260731',
        'gemini-3.5-flash': 'google/gemini-3.5-flash-20260301',
      });
      expect(flash).toMatchObject({ model: FLASH, status: 'error', errorCode: 'model_mismatch' });
      expect(other).toMatchObject({ status: 'ok' });
    });

    it('the bare id still passes: exact slug (no catalog lookup) and its own dated snapshot', async () => {
      mockCatalogIds.mockResolvedValue(['deepseek/deepseek-v4-flash', 'deepseek/deepseek-v4-flash-0731']);
      const exact = await run([FLASH, 'gemini-3.5-flash'], { [FLASH]: 'deepseek/deepseek-v4-flash', 'gemini-3.5-flash': 'google/gemini-3.5-flash' });
      expect(exact.map((r) => r.status)).toEqual(['ok', 'ok']);
      expect(mockCatalogIds).not.toHaveBeenCalled();
      const snapshot = await run([FLASH, 'gemini-3.5-flash'], { [FLASH]: 'deepseek/deepseek-v4-flash-20260612', 'gemini-3.5-flash': 'google/gemini-3.5-flash' });
      expect(snapshot[0]).toMatchObject({ status: 'ok' });
    });

    it('a renamed model with a legacy alias is unaffected: the current id accepts its dated slug even with the retired bare id listed', async () => {
      mockCatalogIds.mockResolvedValue(['qwen/qwen3.8-max', 'qwen/qwen3.8-max-0902', 'qwen/qwen3.8-max-prime']);
      const [qwen] = await run([QWEN_NEW, 'gemini-3.5-flash'], { [QWEN_NEW]: 'qwen/qwen3.8-max-20260902', 'gemini-3.5-flash': 'google/gemini-3.5-flash' });
      expect(qwen).toMatchObject({ model: QWEN_NEW, status: 'ok' });
    });

    it('catalog unreachable (empty list): falls back to the registered-id check, never looser or a crash', async () => {
      mockCatalogIds.mockResolvedValue([]);
      const [flash] = await run([FLASH, 'gemini-3.5-flash'], { [FLASH]: 'deepseek/deepseek-v4-flash-20260731', 'gemini-3.5-flash': 'google/gemini-3.5-flash' });
      expect(flash).toMatchObject({ status: 'ok' });
      // ...and the registered sibling protection is intact without the catalog.
      const pro = 'openrouter/deepseek/deepseek-v4-pro';
      const [guarded] = await run([pro, 'gemini-3.5-flash'], { [pro]: 'deepseek/deepseek-v4-pro-20260813', 'gemini-3.5-flash': 'google/gemini-3.5-flash' });
      expect(guarded).toMatchObject({ status: 'error', errorCode: 'model_mismatch' });
    });
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

describe('ENG-55 real controller wiring: data-collection switch reaches the model call', () => {
  let clock = Date.now();
  beforeEach(() => {
    clock += 10 * 60_000; // expire the controller's module-level 60s policy cache between tests
    jest.spyOn(Date, 'now').mockImplementation(() => clock);
  });
  const settingRow = (value: string | null) =>
    mockGetSetting.mockImplementation(async (name: string) =>
      name === 'model_compare_deny_data_collection' && value !== null ? { settingValue: value } : null);

  it("row 'true' => every callLLM receives providerPolicy {data_collection:'deny'}", async () => {
    settingRow('true');
    const out = await request(app).post('/api/agent-mode/compare').set('Authorization', bearer('owner')).send(validBody);
    expect(out.status).toBe(200);
    expect(mockCallLLM).toHaveBeenCalledTimes(2);
    for (const call of mockCallLLM.mock.calls) expect(call[2].providerPolicy).toEqual({ data_collection: 'deny' });
  });
  it.each([[null], ['false']])('row %j => providerPolicy is absent', async (value) => {
    settingRow(value);
    const out = await request(app).post('/api/agent-mode/compare').set('Authorization', bearer('owner')).send(validBody);
    expect(out.status).toBe(200);
    expect(mockCallLLM).toHaveBeenCalledTimes(2);
    for (const call of mockCallLLM.mock.calls) expect(call[2]).not.toHaveProperty('providerPolicy');
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

describe('ENG-113 real controller wiring: saved alternatives round trip over HTTP', () => {
  let clock = Date.now() + 100 * 60_000;
  beforeEach(() => {
    clock += 10 * 60_000; // expire the module-level 60s switch cache between tests
    jest.spyOn(Date, 'now').mockImplementation(() => clock);
    mockAddMessages.mockImplementation(async (_id: string, msgs: any[]) => ({
      messages: [...ownedSession.messages, ...msgs.map((m, i) => ({ ...m, messageIndex: 3 + i }))],
    }));
  });
  const switchRow = (value: string | null) =>
    mockGetSetting.mockImplementation(async (name: string) =>
      name === 'compare_save_alternatives' && value !== null ? { settingValue: value } : null);
  const select = async (value: string | null, mutate: (b: any) => any = (b) => b) => {
    switchRow(value);
    const compare = await request(app).post('/api/agent-mode/compare').set('Authorization', bearer('owner')).send(validBody);
    expect(typeof compare.body.alternativesToken).toBe('string');
    const [chosen, other] = compare.body.results;
    const body = mutate({
      sessionId: 's-1', compareId: compare.body.compareId, prompt: compare.body.prompt, model: chosen.model,
      content: chosen.content, issuedAt: compare.body.issuedAt, selectToken: chosen.selectToken,
      alternatives: [{ model: other.model, content: other.content, latencyMs: other.latencyMs }],
      alternativesToken: compare.body.alternativesToken,
    });
    const out = await request(app).post('/api/agent-mode/compare/select').set('Authorization', bearer('owner')).send(body);
    return { out, other, compare };
  };

  it("switch 'true': the unchosen answer is stored on the assistant row with registry name/provider; the response carries it for the owner", async () => {
    const { out, other } = await select('true');
    expect(out.status).toBe(200);
    const stored = mockAddMessages.mock.calls[0][1][1];
    expect(stored.metadata.compareAlternatives).toEqual([
      { model: other.model, name: other.model, provider: 'other', content: other.content, latencyMs: expect.any(Number) },
    ]);
    expect(stored.metadata.compareId).toBeDefined();
    expect(out.body.messages[1].metadata.compareAlternatives).toHaveLength(1);
  });
  it.each([[null], ['false'], ['TRUE']])("switch %j: nothing is stored, select succeeds", async (value) => {
    const { out } = await select(value);
    expect(out.status).toBe(200);
    expect(mockAddMessages.mock.calls[0][1][1].metadata).not.toHaveProperty('compareAlternatives');
    expect(mockAddMessages.mock.calls[0][1][1].metadata).not.toHaveProperty('compareId');
  });
  it('a tampered alternative over HTTP is ignored, the chosen answer still persists', async () => {
    const { out } = await select('true', (b) => ({ ...b, alternatives: [{ ...b.alternatives[0], content: 'forged' }] }));
    expect(out.status).toBe(200);
    expect(JSON.stringify(mockAddMessages.mock.calls[0][1])).not.toContain('forged');
  });
});
