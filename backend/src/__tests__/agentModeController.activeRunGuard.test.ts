/**
 * ENG-110: cross-instance active-run guard wired into the real controller.
 *
 * This process plays instance B (the NEW instance of an Immutable deploy). Instance A (the OLD one, still draining) is a
 * second guard instance over the SAME in-memory DynamoDB, which really evaluates the conditional expressions.
 */
import { Request, Response } from 'express';
import { BranchFakeDynamo } from './helpers/branchFakeDynamo';
import { ACTIVE_RUN_STALE_AFTER_MS, createSessionActiveRunGuard } from '../services/agentMode/sessionActiveRunGuard';
import { __resetConcurrentGenerationCapForTests, __activeGenerationCountForTests } from '../services/agentMode/concurrentGenerationCap';
import { agentModeController, activeSessionGenerations, sessionGenerationOwners } from '../controllers/agentModeController';
import { chatbotDb } from '../services/chatbotService';
import { generateMarketingResponseWorkerService } from '../services/generateMarketingResponseWorkerService';

const mockGuardRef: { current: any } = { current: null };
jest.mock('../services/agentMode/sessionActiveRunGuardInstance', () => ({
  sessionActiveRunGuard: {
    claim: (...a: any[]) => mockGuardRef.current.claim(...a),
    isEnabled: (...a: any[]) => mockGuardRef.current.isEnabled(...a),
    hasLiveRunElsewhere: (...a: any[]) => mockGuardRef.current.hasLiveRunElsewhere(...a),
  },
}));

jest.mock('../services/settingsService', () => ({ settingsService: { getSetting: jest.fn().mockResolvedValue(null) } }));
jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getChatSession: jest.fn(),
    getChatSessionRecord: jest.fn(),
    addMessageToSession: jest.fn(),
    addMessagesToSession: jest.fn(),
    updateSessionTitle: jest.fn(),
    updateSessionLlmModel: jest.fn(),
    getMessagesFromMessagesTable: jest.fn(),
  },
  updateTaskExecutionStatus: jest.fn(),
}));
jest.mock('../services/emailService', () => ({ emailService: { sendOncallAlert: jest.fn().mockResolvedValue(undefined) } }));
jest.mock('../services/generateMarketingResponseWorkerService', () => ({
  generateMarketingResponseWorkerService: { runInWorker: jest.fn(), cancelSession: jest.fn() },
}));
jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    getDefaultModel: jest.fn().mockResolvedValue('gpt-5-chat-2'),
    generateSessionTitle: jest.fn().mockResolvedValue('t'),
    getMarketingSystemPrompt: jest.fn().mockResolvedValue('p'),
    generateDiagnosticMessage: jest.fn().mockResolvedValue(null),
    getSkillsForDisplay: jest.fn().mockResolvedValue([]),
  },
  AgentModeService: jest.fn(),
}));
jest.mock('../services/tokenUsageService', () => ({
  checkTokenUsage: jest.fn().mockResolvedValue({
    allowed: true, warning: false, used: 0, allowance: null, bonus: 0, effectiveAllowance: null, percentUsed: 0, month: '2026-10',
  }),
}));
jest.mock('../utils/sseProgress', () => ({
  progressStore: { delete: jest.fn() },
  emitProgress: jest.fn(),
  hasActiveProgress: jest.fn().mockReturnValue(false),
  requestCancel: jest.fn(),
  clearCancel: jest.fn(),
  isCancelled: jest.fn().mockReturnValue(false),
  registerProgressCallback: jest.fn().mockReturnValue(() => {}),
  getLatestProgress: jest.fn().mockReturnValue(null),
  cleanupProgress: jest.fn(),
  clearTerminalProgress: jest.fn(),
}));
jest.mock('../services/workPlanService', () => ({ workPlanService: { getWorkPlan: jest.fn().mockResolvedValue(null) } }));
jest.mock('../services/skillService', () => ({ skillService: { getInstalledSkills: jest.fn().mockResolvedValue([]) } }));
jest.mock('../services/subscriptionService', () => ({ getAllowedSkills: jest.fn().mockResolvedValue([]) }));
jest.mock('../utils/agentModeAlerts', () => ({ sendAgentModeOncallAlert: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../utils/agentModeErrors', () => ({
  ...jest.requireActual('../utils/agentModeErrors'),
  isContextLimitError: jest.fn().mockReturnValue(false),
  isSessionLimitError: jest.fn().mockReturnValue(false),
  isTransientLLMError: jest.fn().mockReturnValue(false),
  isWorkerShutdownError: jest.fn().mockReturnValue(false),
  isProviderNoEndpointsError: jest.fn().mockReturnValue(false),
}));

const db = chatbotDb as jest.Mocked<typeof chatbotDb>;
const worker = generateMarketingResponseWorkerService as jest.Mocked<typeof generateMarketingResponseWorkerService>;
const EMPTY = { content: 'ok', toolCalls: [], knowledgeBaseQueries: [], sources: [], responseMessages: [] };
const OWNER = 'owner-1';
const SID = 's1';

let fake: BranchFakeDynamo;
let settingValue: unknown;
let failUpdates: Error | null;
/** Intervals started by guards and not yet cleared: the leak detector. */
let liveTimers: Set<unknown>;

const flush = async () => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
};

function makeGuard(instanceId: string) {
  let n = 0;
  return createSessionActiveRunGuard({
    getSetting: async () => (settingValue === undefined ? null : { settingValue }),
    update: (p) => (failUpdates ? Promise.reject(failUpdates) : fake.client().update(p as any).promise()),
    tableName: () => 'AW-ChatSessions',
    now: () => Date.now(),
    log: () => undefined,
    instanceId,
    newRunId: () => `run-${instanceId}-${++n}`,
    setInterval: (fn, ms) => {
      const h = setInterval(fn, ms);
      liveTimers.add(h);
      return h;
    },
    clearInterval: (h) => {
      liveTimers.delete(h);
      clearInterval(h);
    },
  });
}

const sessionRow = (id = SID) => ({
  sessionId: id, userId: OWNER, title: 't', messages: [], createdAt: '2026-10-13T00:00:00.000Z',
  updatedAt: '2026-10-13T00:00:00.000Z', portalType: 'agent', pageIdentifier: 'agent-mode', llmModel: 'gpt-5-chat-2',
});

const makeReq = (sessionId = SID, userId = OWNER) => ({
  user: { userId, email: 'o@example.com' },
  body: { sessionId, userMessage: 'hello', llmModel: 'gpt-5-chat-2', attachments: [] },
  method: 'POST', path: '/api/agent-mode/generate', ip: '127.0.0.1', socket: { remoteAddress: '127.0.0.1' }, on: jest.fn(),
} as unknown as Request);
const makeRes = () => ({ json: jest.fn(), status: jest.fn().mockReturnThis(), setHeader: jest.fn() } as unknown as Response);
const bodyOf = (res: Response) => (res.json as jest.Mock).mock.calls[0][0];

let guardA: ReturnType<typeof makeGuard>;
let guardB: ReturnType<typeof makeGuard>;

/** A starts a run on the session (the old instance). */
const startRunOnA = async () => {
  const claim = await guardA.claim(SID);
  if (claim.status !== 'claimed') throw new Error('A could not claim');
  return claim;
};
const activeRun = () => fake.session(SID)?.activeRun;

beforeEach(() => {
  jest.clearAllMocks();
  // Only Date and setInterval/clearInterval are fake: the heartbeat is driven by advanceTimersByTime.
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'clearTimeout', 'queueMicrotask'] });
  jest.setSystemTime(new Date('2026-10-13T12:00:00.000Z'));
  activeSessionGenerations.clear();
  sessionGenerationOwners.clear();
  __resetConcurrentGenerationCapForTests();
  fake = new BranchFakeDynamo();
  fake.seedSession(sessionRow());
  settingValue = 'true';
  failUpdates = null;
  liveTimers = new Set();
  guardA = makeGuard('A');
  guardB = makeGuard('B');
  mockGuardRef.current = guardB;
  db.getChatSession.mockImplementation(async (id: string) => ({ ...(fake.session(id) ?? sessionRow(id)) }) as any);
  db.getChatSessionRecord.mockImplementation(async (id: string) => (fake.session(id) ?? null) as any);
  (db as any).getMessagesFromMessagesTable.mockResolvedValue([]);
  db.addMessageToSession.mockResolvedValue({} as any);
  db.addMessagesToSession.mockResolvedValue(undefined as any);
  db.updateSessionTitle.mockResolvedValue(undefined as any);
});
afterEach(() => {
  for (const h of liveTimers) clearInterval(h as any);
  jest.useRealTimers();
});

describe('POST /generate on instance B', () => {
  it('a live run on A => 409 SESSION_BUSY; B holds nothing (lock, owner, cap slot) and never starts the worker', async () => {
    const a = await startRunOnA();
    const before = activeRun();
    const res = makeRes();
    await agentModeController.generateResponse(makeReq(), res);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(bodyOf(res)).toEqual({
      error: 'Session is busy',
      message: 'A response is already being generated for this session. Please wait.',
      code: 'SESSION_BUSY',
    });
    expect(worker.runInWorker).not.toHaveBeenCalled();
    expect(activeSessionGenerations.size).toBe(0);
    expect(sessionGenerationOwners.size).toBe(0);
    expect(__activeGenerationCountForTests(OWNER)).toBe(0);
    expect(activeRun()).toEqual(before); // A's claim untouched
    expect(liveTimers.size).toBe(1); // only A's heartbeat

    // Once A's run ends, the very same request goes through on B.
    await a.release();
    worker.runInWorker.mockResolvedValueOnce(EMPTY as any);
    const retry = makeRes();
    await agentModeController.generateResponse(makeReq(), retry);
    expect(retry.status).not.toHaveBeenCalledWith(409);
    expect(worker.runInWorker).toHaveBeenCalledTimes(1);
  });

  it('a dead run on A (beats stopped, 91s pass) => B proceeds, owns the attribute during the run, and clears it after', async () => {
    await startRunOnA();
    for (const h of [...liveTimers]) { clearInterval(h as any); liveTimers.delete(h); } // A's process died
    jest.setSystemTime(Date.now() + ACTIVE_RUN_STALE_AFTER_MS + 1_000);

    let seen: any;
    worker.runInWorker.mockImplementationOnce(async () => {
      seen = activeRun();
      return EMPTY as any;
    });
    const res = makeRes();
    await agentModeController.generateResponse(makeReq(), res);
    await flush();
    expect(res.status).not.toHaveBeenCalledWith(409);
    expect(seen).toMatchObject({ instanceId: 'B' });
    expect(activeRun()).toBeUndefined();
    expect(liveTimers.size).toBe(0);
  });

  it('the heartbeat keeps a long chat live on the other instance past the staleness window', async () => {
    let finish!: (v: any) => void;
    worker.runInWorker.mockReturnValueOnce(new Promise((r) => { finish = r; }));
    const done = agentModeController.generateResponse(makeReq(), makeRes());
    for (let i = 0; i < 50 && !activeRun(); i++) await flush();
    expect(activeRun()?.instanceId).toBe('B');
    expect(liveTimers.size).toBe(1);
    const startedAt = activeRun().startedAt;
    // 4 minutes of run, 30s at a time, letting each beat's promise settle: far past the 90s staleness window.
    for (let i = 0; i < 8; i++) {
      jest.advanceTimersByTime(30_000);
      await flush();
    }
    expect(activeRun().heartbeatAt).toBe(startedAt + 8 * 30_000);
    expect((await guardA.claim(SID)).status).toBe('busy'); // still live for the other instance
    finish(EMPTY);
    await done;
    await flush();
    expect(activeRun()).toBeUndefined();
    expect(liveTimers.size).toBe(0);
  });

  describe.each([
    ['success', () => worker.runInWorker.mockResolvedValueOnce(EMPTY as any)],
    ['a worker throw', () => worker.runInWorker.mockRejectedValueOnce(new Error('boom'))],
    ['a wall-clock timeout', () => worker.runInWorker.mockRejectedValueOnce(Object.assign(new Error('Generation timed out'), { isGenerationTimeout: true }))],
    ['a step between the claim and the work', () => {
      require('../services/tokenUsageService').checkTokenUsage.mockRejectedValueOnce(new Error('usage lookup failed'));
    }],
  ])('exit via %s', (_name, arm) => {
    it('clears the attribute, the lock, the slot and the heartbeat timer', async () => {
      arm();
      await agentModeController.generateResponse(makeReq(), makeRes());
      await flush();
      expect(activeRun()).toBeUndefined();
      expect(liveTimers.size).toBe(0);
      expect(activeSessionGenerations.size).toBe(0);
      expect(__activeGenerationCountForTests(OWNER)).toBe(0);
    });
  });

  it('exit via Stop: the run ends after the stop and everything is cleared', async () => {
    let finish!: (v: any) => void;
    worker.runInWorker.mockReturnValueOnce(new Promise((r) => { finish = r; }));
    const done = agentModeController.generateResponse(makeReq(), makeRes());
    for (let i = 0; i < 50 && !activeRun(); i++) await flush();
    await agentModeController.stopGeneration({ params: { sessionId: SID }, user: { userId: OWNER } } as any, makeRes());
    finish(EMPTY);
    await done;
    await flush();
    expect(activeRun()).toBeUndefined();
    expect(liveTimers.size).toBe(0);
  });

  it('exit via the concurrent-run cap (429): the activeRun claim is given back too', async () => {
    const { getSetting } = require('../services/settingsService').settingsService;
    getSetting.mockResolvedValueOnce({ settingValue: '1' });
    const { acquireInteractiveGenerationSlot } = require('../services/agentMode/concurrentGenerationCap');
    const held = await acquireInteractiveGenerationSlot(OWNER, 'other-session');
    const res = makeRes();
    await agentModeController.generateResponse(makeReq(), res);
    await flush();
    expect(res.status).toHaveBeenCalledWith(429);
    expect(activeRun()).toBeUndefined();
    expect(liveTimers.size).toBe(0);
    expect(activeSessionGenerations.size).toBe(0);
    if (held.ok) held.release();
  });

  it("A's late finally does not clear B's newer claim", async () => {
    const a = await startRunOnA();
    jest.setSystemTime(Date.now() + ACTIVE_RUN_STALE_AFTER_MS + 1_000); // A stalled; B takes over
    let finish!: (v: any) => void;
    worker.runInWorker.mockReturnValueOnce(new Promise((r) => { finish = r; }));
    const done = agentModeController.generateResponse(makeReq(), makeRes());
    for (let i = 0; i < 50 && activeRun()?.instanceId !== 'B'; i++) await flush();
    const bRun = activeRun();
    expect(bRun.instanceId).toBe('B');
    await a.release();
    expect(activeRun()).toEqual(bRun);
    finish(EMPTY);
    await done;
    await flush();
    expect(activeRun()).toBeUndefined();
  });

  it('switch OFF: ZERO session-table calls, no timer, and the run behaves exactly as before', async () => {
    settingValue = 'false';
    await startRunOnA().catch(() => undefined); // A cannot claim either when off
    worker.runInWorker.mockResolvedValueOnce(EMPTY as any);
    const res = makeRes();
    await agentModeController.generateResponse(makeReq(), res);
    await flush();
    expect(fake.writeLog).toEqual([]);
    expect(liveTimers.size).toBe(0);
    expect(res.status).not.toHaveBeenCalled();
    expect(bodyOf(res)).toMatchObject({ content: 'ok' });
  });

  it('switch OFF: a leftover fresh attribute from an earlier "on" period does not block', async () => {
    const a = await startRunOnA();
    settingValue = 'false';
    mockGuardRef.current = makeGuard('B2'); // fresh cache that reads "off"
    worker.runInWorker.mockResolvedValueOnce(EMPTY as any);
    const res = makeRes();
    await agentModeController.generateResponse(makeReq(), res);
    expect(res.status).not.toHaveBeenCalledWith(409);
    expect(worker.runInWorker).toHaveBeenCalledTimes(1);
    await a.release();
  });

  it('FAILS OPEN on a non-condition DynamoDB error (throttle): the run proceeds without the guard', async () => {
    failUpdates = Object.assign(new Error('throttled'), { code: 'ProvisionedThroughputExceededException' });
    worker.runInWorker.mockResolvedValueOnce(EMPTY as any);
    const res = makeRes();
    await agentModeController.generateResponse(makeReq(), res);
    expect(res.status).not.toHaveBeenCalled();
    expect(worker.runInWorker).toHaveBeenCalledTimes(1);
    expect(liveTimers.size).toBe(0);
    expect(activeSessionGenerations.size).toBe(0);
  });

  it('FAILS OPEN even if the guard itself blows up unexpectedly', async () => {
    mockGuardRef.current = { claim: () => Promise.reject(new Error('guard bug')), isEnabled: jest.fn(), hasLiveRunElsewhere: jest.fn() };
    worker.runInWorker.mockResolvedValueOnce(EMPTY as any);
    const res = makeRes();
    await agentModeController.generateResponse(makeReq(), res);
    expect(res.status).not.toHaveBeenCalled();
    expect(worker.runInWorker).toHaveBeenCalledTimes(1);
  });

  it('a heartbeat failure mid-run does not stop the run', async () => {
    let finish!: (v: any) => void;
    worker.runInWorker.mockReturnValueOnce(new Promise((r) => { finish = r; }));
    const res = makeRes();
    const done = agentModeController.generateResponse(makeReq(), res);
    for (let i = 0; i < 50 && !activeRun(); i++) await flush();
    failUpdates = Object.assign(new Error('throttled'), { code: 'ThrottlingException' });
    jest.advanceTimersByTime(30_000);
    await flush();
    expect(liveTimers.size).toBe(1); // the timer keeps going
    failUpdates = null;
    finish(EMPTY);
    await done;
    await flush();
    expect(res.status).not.toHaveBeenCalled();
    expect(bodyOf(res)).toMatchObject({ content: 'ok' });
    expect(liveTimers.size).toBe(0);
  });
});

describe('GET /session/:id isGenerating across instances', () => {
  const get = async (user: any, extra: any = {}) => {
    const res = makeRes();
    await agentModeController.getSession({ params: { sessionId: SID }, user, ...extra } as unknown as Request, res);
    return res;
  };

  it('is true for the genuine owner on B while A\'s run is live, and nothing internal is serialised', async () => {
    await startRunOnA();
    const res = await get({ userId: OWNER });
    const body = bodyOf(res);
    expect(body.isGenerating).toBe(true);
    const text = JSON.stringify(body);
    expect(text).not.toMatch(/activeRun|runId|instanceId|heartbeatAt/);
    expect(body).not.toHaveProperty('activeRun');
  });

  it('is false once A\'s run is stale, after A clears, with the switch off, and when no run exists', async () => {
    const a = await startRunOnA();
    expect(bodyOf(await get({ userId: OWNER })).isGenerating).toBe(true);
    jest.setSystemTime(Date.now() + ACTIVE_RUN_STALE_AFTER_MS + 1);
    expect(bodyOf(await get({ userId: OWNER })).isGenerating).toBe(false); // stale heartbeat is not live
    jest.setSystemTime(Date.now() - ACTIVE_RUN_STALE_AFTER_MS - 1);
    await a.release();
    expect(bodyOf(await get({ userId: OWNER })).isGenerating).toBe(false);
  });

  it('switch off => the attribute is ignored', async () => {
    const a = await startRunOnA();
    settingValue = 'false';
    mockGuardRef.current = makeGuard('B');
    const body = bodyOf(await get({ userId: OWNER }));
    expect(body.isGenerating).toBe(false);
    expect(JSON.stringify(body)).not.toMatch(/runId|instanceId/);
    await a.release();
  });

  it('never for an admin or a delegate viewing the owner\'s session (and never serialised for them)', async () => {
    await startRunOnA();
    const admin = bodyOf(await get({ userId: 'admin', isAdmin: true }));
    expect(admin).not.toHaveProperty('isGenerating');
    const delegate = bodyOf(await get({ userId: OWNER }, { delegateInfo: { isDelegated: true } }));
    expect(delegate).not.toHaveProperty('isGenerating');
    for (const body of [admin, delegate]) expect(JSON.stringify(body)).not.toMatch(/activeRun|runId|instanceId/);
  });

  it('a non-owner gets 403 and no body', async () => {
    await startRunOnA();
    const res = await get({ userId: 'someone-else' });
    expect(res.status).toHaveBeenCalledWith(403);
    expect(JSON.stringify((res.json as jest.Mock).mock.calls)).not.toMatch(/runId|instanceId|isGenerating/);
  });

  it('B\'s own fresh attribute without B\'s in-memory lock is not "generating" (in-memory stays authoritative)', async () => {
    const claim = await guardB.claim(SID); // run just ended on B but its clear has not landed
    expect(claim.status).toBe('claimed');
    expect(bodyOf(await get({ userId: OWNER })).isGenerating).toBe(false);
    if (claim.status === 'claimed') await claim.release();
  });

  it('the public shared-conversation view never carries it', async () => {
    await startRunOnA();
    db.getChatSession.mockResolvedValue({ ...fake.session(SID), shareMetadata: { isShared: true } } as any);
    const res = makeRes();
    await agentModeController.getSharedConversation({ params: { shareId: SID }, query: {} } as unknown as Request, res);
    expect(JSON.stringify((res.json as jest.Mock).mock.calls)).not.toMatch(/activeRun|runId|instanceId|isGenerating/);
  });
});

describe('GET /generating?sessionId=', () => {
  const call = async (user: any, query: any = {}, extra: any = {}) => {
    const res = makeRes();
    await agentModeController.getGeneratingSessions({ user, query, ...extra } as any, res);
    return bodyOf(res);
  };

  it('without the param: unchanged, and no GetItem is issued', async () => {
    await startRunOnA();
    expect(await call({ userId: OWNER })).toEqual({ sessionIds: [] });
    expect(db.getChatSessionRecord).not.toHaveBeenCalled();
  });

  it('with the param: lists the owner\'s session when A\'s run is live (one record-only read)', async () => {
    await startRunOnA();
    expect(await call({ userId: OWNER }, { sessionId: SID })).toEqual({ sessionIds: [SID] });
    expect(db.getChatSessionRecord).toHaveBeenCalledTimes(1);
    expect(db.getChatSession).not.toHaveBeenCalled();
    expect(JSON.stringify(await call({ userId: OWNER }, { sessionId: SID }))).not.toMatch(/runId|instanceId/);
  });

  it('does not list a stale run, a session without a run, or anything when the switch is off', async () => {
    const a = await startRunOnA();
    jest.setSystemTime(Date.now() + ACTIVE_RUN_STALE_AFTER_MS + 1);
    expect(await call({ userId: OWNER }, { sessionId: SID })).toEqual({ sessionIds: [] });
    jest.setSystemTime(Date.now() - ACTIVE_RUN_STALE_AFTER_MS - 1);
    expect(await call({ userId: OWNER }, { sessionId: SID })).toEqual({ sessionIds: [SID] });
    settingValue = 'false';
    mockGuardRef.current = makeGuard('B');
    db.getChatSessionRecord.mockClear();
    expect(await call({ userId: OWNER }, { sessionId: SID })).toEqual({ sessionIds: [] });
    expect(db.getChatSessionRecord).not.toHaveBeenCalled(); // off => not even the read
    await a.release();
    settingValue = 'true';
    mockGuardRef.current = makeGuard('B');
    expect(await call({ userId: OWNER }, { sessionId: SID })).toEqual({ sessionIds: [] });
  });

  it("ownership isolation: another user's session is never listed, whoever asks", async () => {
    await startRunOnA();
    expect(await call({ userId: 'intruder' }, { sessionId: SID })).toEqual({ sessionIds: [] });
    expect(await call({ userId: 'admin', isAdmin: true }, { sessionId: SID })).toEqual({ sessionIds: [] });
    expect(await call({ userId: OWNER }, { sessionId: SID }, { delegateInfo: { isDelegated: true } })).toEqual({ sessionIds: [] });
  });

  it.each([
    ['unknown id', { sessionId: 'does-not-exist' }],
    ['array', { sessionId: [SID, 'x'] }],
    ['object', { sessionId: { $ne: 'x' } }],
    ['empty', { sessionId: '' }],
  ])('garbage input (%s) is ignored', async (_n, query) => {
    await startRunOnA();
    expect(await call({ userId: OWNER }, query)).toEqual({ sessionIds: [] });
  });

  it('an over-long id is rejected before any read', async () => {
    await startRunOnA();
    expect(await call({ userId: OWNER }, { sessionId: 'x'.repeat(201) })).toEqual({ sessionIds: [] });
    expect(db.getChatSessionRecord).not.toHaveBeenCalled();
  });

  it('an archived session with a live run follows the in-memory source (listed for its owner)', async () => {
    fake.sessions().get(SID)!.archived = true;
    await startRunOnA();
    expect(await call({ userId: OWNER }, { sessionId: SID })).toEqual({ sessionIds: [SID] });
  });

  it('a read failure is ignored and in-memory ids are still returned; a held lock is not duplicated', async () => {
    activeSessionGenerations.add('local');
    sessionGenerationOwners.set('local', OWNER);
    db.getChatSessionRecord.mockRejectedValueOnce(new Error('ddb down'));
    expect(await call({ userId: OWNER }, { sessionId: SID })).toEqual({ sessionIds: ['local'] });
    expect(await call({ userId: OWNER }, { sessionId: 'local' })).toEqual({ sessionIds: ['local'] });
  });
});
