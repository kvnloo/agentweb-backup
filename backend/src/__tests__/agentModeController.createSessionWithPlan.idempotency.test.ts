import * as runStore from '../services/agentMode/runStore';
import { Request, Response } from 'express';
import { agentModeController } from '../controllers/agentModeController';
import { chatbotDb } from '../services/chatbotService';
import { workPlanService } from '../services/workPlanService';
import { agentModeService } from '../services/agentModeService';
import { getUserFromToken } from '../middleware/auth';
import { userDb } from '../services/db';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';

// Mock dependencies
jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    createChatSession: jest.fn(),
    updateSessionWorkPlan: jest.fn(),
    updateSessionInteractiveShareMetadata: jest.fn(),
    updateSessionWorkPlanInputRequest: jest.fn().mockResolvedValue(undefined),
    updateSessionLlmModel: jest.fn(),
    getChatSession: jest.fn(),
    addChatMessage: jest.fn(),
    addMessageToSession: jest.fn().mockResolvedValue({}),
    addAssociatedSkills: jest.fn().mockResolvedValue(undefined),
    createOrReuseInteractiveShare: jest.fn().mockResolvedValue('https://example.com/ishare'),
  }
}));

jest.mock('../services/workPlanService', () => ({
  workPlanService: {
    getWorkPlansByVisibility: jest.fn(),
    getWorkPlansByOwner: jest.fn(),
    getWorkPlansByOrg: jest.fn(),
  }
}));

jest.mock('../services/db', () => ({
  userDb: { getUserById: jest.fn() },
}));

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    getSupportedModels: jest.fn(),
    getDefaultModel: jest.fn(),
    // ENG-903: registry doubles - the plan pin is resolved with the shared pin rules.
    resolveGenerationModel: jest.fn(),
    isModelSelectableBy: jest.fn(),
    getModelDisplayName: jest.fn(),
  },
  // ENG-1802: the controller now imports the real title-normalization helper
  // directly (not through the agentModeService object above), so this module
  // mock must still provide it -- pull in the real implementation rather than
  // stubbing it, since it's a pure string helper the title-matching tests
  // below rely on behaving correctly.
  normalizeWorkPlanTitleForMatch: jest.requireActual('../services/agentModeService').normalizeWorkPlanTitleForMatch,
}));

jest.mock('../middleware/auth', () => ({
  getUserFromToken: jest.fn(),
  authenticateToken: jest.fn((req, res, next) => next())
}));

jest.mock('uuid', () => ({
  v4: jest.fn(() => 'mock-uuid-123')
}));

jest.mock('crypto', () => ({
  ...jest.requireActual('crypto'),
  randomBytes: jest.fn(() => ({
    toString: jest.fn(() => 'mock-conversable-token-123')
  }))
}));

jest.mock('../utils/agentModeAlerts', () => ({
  sendAgentModeOncallAlert: jest.fn().mockResolvedValue(undefined)
}));

jest.mock('../services/generateMarketingResponseWorkerService', () => ({
  generateMarketingResponseWorkerService: {
    restartWorker: jest.fn().mockResolvedValue(undefined),
    runInWorker: jest.fn(),
    cancelSession: jest.fn(),
    ensureWorkerReady: jest.fn().mockResolvedValue(undefined),
    isWorkerHealthy: jest.fn().mockResolvedValue(true),
  }
}));

const mockIdemStore = new Map<string, { sessionId?: string }>();
let mockRunStoreOn = true;
jest.mock('../services/agentMode/runStore', () => ({
  ...jest.requireActual('../services/agentMode/runStore'),
  isRunStoreEnabled: jest.fn(() => mockRunStoreOn),
  claimIdempotency: jest.fn(async (key: string) => {
    const row = mockIdemStore.get(key);
    if (row) return { claimed: false, sessionId: row.sessionId };
    mockIdemStore.set(key, {});
    return { claimed: true };
  }),
  recordIdempotencySessionId: jest.fn(async (key: string, sessionId: string) => {
    const row = mockIdemStore.get(key);
    if (row) row.sessionId = sessionId;
  }),
  releaseIdempotency: jest.fn(async (key: string) => { mockIdemStore.delete(key); }),
}));

const mockChatbotDb = chatbotDb as jest.Mocked<typeof chatbotDb>;
const mockWorkPlanService = workPlanService as jest.Mocked<typeof workPlanService>;
const mockAgentModeService = agentModeService as jest.Mocked<typeof agentModeService>;
const mockGetUserFromToken = getUserFromToken as jest.MockedFunction<typeof getUserFromToken>;
const mockUserDb = userDb as jest.Mocked<typeof userDb>;

const PLAN = {
  planId: 'plan-123', title: 'Onboarding', visibility: 'system' as const, isBuiltIn: true,
  steps: [{ stepCount: 1, title: 'Step 1', description: 'First step' }],
  createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z',
};

// A tiny session table so a replay can read back what the first launch wrote.
const sessions = new Map<string, any>();
let seq = 0;

const req = (userId: string | null, body: Record<string, any> = {}) => {
  mockGetUserFromToken.mockResolvedValue(userId ? { user: { userId, email: 'u@x.com', isAdmin: false, roles: ['customer'] } } as any : { user: null } as any);
  return { params: { planTitle: 'Onboarding' }, headers: {}, body } as unknown as Request;
};
const res = () => {
  const r: any = {};
  r.status = jest.fn().mockReturnValue(r);
  r.json = jest.fn().mockReturnValue(r);
  return r as Response & { status: jest.Mock; json: jest.Mock };
};

describe('ENG-2773 createSessionWithPlan idempotencyKey', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIdemStore.clear();
    sessions.clear();
    seq = 0;
    mockRunStoreOn = true;
    process.env.CUSTOMER_FRONTEND_URL = 'http://localhost:5174';
    mockWorkPlanService.getWorkPlansByVisibility.mockImplementation((v: string) => Promise.resolve(v === 'system' ? [PLAN] : []) as any);
    mockWorkPlanService.getWorkPlansByOwner.mockResolvedValue([]);
    mockWorkPlanService.getWorkPlansByOrg.mockResolvedValue([]);
    mockUserDb.getUserById.mockResolvedValue(undefined);
    mockAgentModeService.getDefaultModel.mockResolvedValue('gpt-5-chat');
    mockChatbotDb.createChatSession.mockImplementation(async (userId: string) => {
      const s = { sessionId: `s-${++seq}`, userId, messages: [] };
      sessions.set(s.sessionId, s);
      return s as any;
    });
    mockChatbotDb.updateSessionLlmModel.mockResolvedValue({} as any);
    mockChatbotDb.updateSessionWorkPlan.mockImplementation(async (id: string, wp: any) => { sessions.get(id).workPlan = wp; return {} as any; });
    mockChatbotDb.updateSessionInteractiveShareMetadata.mockImplementation(async (id: string, m: any) => { sessions.get(id).interactiveShareMetadata = m; return {} as any; });
    mockChatbotDb.getChatSession.mockImplementation(async (id: string) => sessions.get(id));
  });

  it('AC1: a second call with the same key (same user) returns the original session; one session created', async () => {
    const r1 = res();
    await agentModeController.createSessionWithPlan(req('user-a', { idempotencyKey: 'k1' }), r1);
    const r2 = res();
    await agentModeController.createSessionWithPlan(req('user-a', { idempotencyKey: 'k1' }), r2);

    expect(mockChatbotDb.createChatSession).toHaveBeenCalledTimes(1);
    const first = r1.json.mock.calls[0][0];
    const second = r2.json.mock.calls[0][0];
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.conversableToken).toBe(first.conversableToken);
    expect(second.redirectUrl).toBe(first.redirectUrl);
    expect(second.idempotentReplay).toBe(true);
  });

  it('AC1: a duplicate while the first launch is still in flight is a 409, not a second session', async () => {
    mockIdemStore.set('pending', {});
    (runStore.claimIdempotency as jest.Mock).mockResolvedValueOnce({ claimed: false });
    const r = res();
    await agentModeController.createSessionWithPlan(req('user-a', { idempotencyKey: 'k1' }), r);
    expect(r.status).toHaveBeenCalledWith(409);
    expect(mockChatbotDb.createChatSession).not.toHaveBeenCalled();
  });

  it('AC2: with AGENT_RUN_STORE off a key is ignored: two calls make two sessions, no lock touched', async () => {
    mockRunStoreOn = false;
    const r1 = res(); const r2 = res();
    await agentModeController.createSessionWithPlan(req('user-a', { idempotencyKey: 'k1' }), r1);
    await agentModeController.createSessionWithPlan(req('user-a', { idempotencyKey: 'k1' }), r2);
    expect(mockChatbotDb.createChatSession).toHaveBeenCalledTimes(2);
    expect(runStore.claimIdempotency).not.toHaveBeenCalled();
    expect(runStore.recordIdempotencySessionId).not.toHaveBeenCalled();
    // Byte-identical response shape to today (no replay marker).
    expect(Object.keys(r1.json.mock.calls[0][0]).sort()).toEqual(['conversableToken', 'redirectUrl', 'sessionId', 'userId', 'workPlan']);
  });

  it('AC3: different users with the same key never collide', async () => {
    const ra = res(); const rb = res();
    await agentModeController.createSessionWithPlan(req('user-a', { idempotencyKey: 'shared' }), ra);
    await agentModeController.createSessionWithPlan(req('user-b', { idempotencyKey: 'shared' }), rb);
    expect(mockChatbotDb.createChatSession).toHaveBeenCalledTimes(2);
    const a = ra.json.mock.calls[0][0]; const b = rb.json.mock.calls[0][0];
    expect(b.sessionId).not.toBe(a.sessionId);
    expect(b.userId).toBe('user-b');
    expect(b.idempotentReplay).toBeUndefined();
  });

  it('a replayed claim pointing at another user\'s session is refused (409), never returned', async () => {
    sessions.set('foreign', { sessionId: 'foreign', userId: 'user-b', workPlan: {}, interactiveShareMetadata: { token: 't' } });
    (runStore.claimIdempotency as jest.Mock).mockResolvedValueOnce({ claimed: false, sessionId: 'foreign' });
    const r = res();
    await agentModeController.createSessionWithPlan(req('user-a', { idempotencyKey: 'k1' }), r);
    expect(r.status).toHaveBeenCalledWith(409);
    expect(r.json.mock.calls[0][0].sessionId).toBeUndefined();
  });

  it('anonymous callers are never locked (their userId is per-call random)', async () => {
    await agentModeController.createSessionWithPlan(req(null, { idempotencyKey: 'k1' }), res());
    expect(runStore.claimIdempotency).not.toHaveBeenCalled();
  });

  it('a failed launch releases the claim so a retry can create the session', async () => {
    mockChatbotDb.updateSessionWorkPlan.mockRejectedValueOnce(new Error('ddb down'));
    const r1 = res();
    await agentModeController.createSessionWithPlan(req('user-a', { idempotencyKey: 'k1' }), r1);
    expect(r1.status).toHaveBeenCalledWith(500);
    expect(runStore.releaseIdempotency).toHaveBeenCalled();
    expect(mockIdemStore.size).toBe(0);
    const r2 = res();
    await agentModeController.createSessionWithPlan(req('user-a', { idempotencyKey: 'k1' }), r2);
    expect(mockChatbotDb.createChatSession).toHaveBeenCalledTimes(2);
    expect(r2.json.mock.calls[0][0].sessionId).toBe('s-2');
  });
});
