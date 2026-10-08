/**
 * ENG-1974 — POST /api/agent-mode/session/:sessionId/work-plan-recommendations/:recommendationId/decline
 *
 * "Keep chatting" was, by ENG-1472's original design, a pure client-side no-op — it never
 * told the backend or Emma the recommendation was declined, so the recommendation's tool-call
 * result stayed live in Emma's context and an ordinary next message could get her to
 * self-launch it (live-confirmed on env1, twice). This is the server-side half of the fix:
 * owner-only, finds the persisted recommendation by recommendationId INSIDE the session (never
 * trusts a planId from the request body, same discipline as acceptWorkPlanRecommendation), and
 * ONLY records the decline — it must never call applyPredefinedWorkPlan.
 */
import { agentModeController } from '../controllers/agentModeController';
import { chatbotDb } from '../services/chatbotService';
import { agentModeService } from '../services/agentModeService';
import { AuthenticatedRequest } from '../middleware/auth';

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getChatSession: jest.fn(),
    recordDeclinedWorkPlanRecommendation: jest.fn(),
  },
}));

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    applyPredefinedWorkPlan: jest.fn(),
  },
  AgentModeService: class {},
}));

const mockChatbotDb = chatbotDb as jest.Mocked<typeof chatbotDb>;
const mockAgentModeService = agentModeService as jest.Mocked<typeof agentModeService>;

const persistedRecommendation = {
  type: 'workplan_recommendation' as const,
  version: 1 as const,
  recommendationId: 'reco-abc',
  plan: {
    id: 'plan-onboard',
    title: 'Client Onboarding',
    summary: 'Get a new client set up',
    steps: [{ position: 1, label: 'Analyze website' }],
  },
  reason: 'The user wants to onboard a new client.',
};

function sessionWith(overrides: Partial<{ userId: string; messages: any[] }>) {
  return {
    sessionId: 'sess-1',
    userId: 'user-1',
    messages: [
      {
        role: 'assistant',
        metadata: {
          timestamp: '2026-01-01T00:00:00.000Z',
          toolCalls: [{ id: 'tc-1', name: 'recommend_predefined_work_plan', arguments: {}, result: persistedRecommendation }],
        },
      },
    ],
    ...overrides,
  };
}

const mockRequest = (user: AuthenticatedRequest['user'] | undefined, params: Record<string, string>): AuthenticatedRequest => ({
  user,
  params,
} as unknown as AuthenticatedRequest);

const mockResponse = () => {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

const authedUser: AuthenticatedRequest['user'] = { userId: 'user-1', email: 'a@agentweb.pro', isAdmin: false, roles: ['customer'] } as any;

describe('agentModeController.declineWorkPlanRecommendation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 401 when unauthenticated', async () => {
    const req = mockRequest(undefined, { sessionId: 'sess-1', recommendationId: 'reco-abc' });
    const res = mockResponse();

    await agentModeController.declineWorkPlanRecommendation(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('returns 404 when the session does not exist', async () => {
    mockChatbotDb.getChatSession.mockResolvedValue(null as any);
    const req = mockRequest(authedUser, { sessionId: 'sess-1', recommendationId: 'reco-abc' });
    const res = mockResponse();

    await agentModeController.declineWorkPlanRecommendation(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('returns 403 for a non-owner', async () => {
    mockChatbotDb.getChatSession.mockResolvedValue(sessionWith({ userId: 'someone-else' }) as any);
    const req = mockRequest(authedUser, { sessionId: 'sess-1', recommendationId: 'reco-abc' });
    const res = mockResponse();

    await agentModeController.declineWorkPlanRecommendation(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockChatbotDb.recordDeclinedWorkPlanRecommendation).not.toHaveBeenCalled();
  });

  it('returns 404 RECOMMENDATION_NOT_FOUND when no recommendation with that id exists in the session', async () => {
    mockChatbotDb.getChatSession.mockResolvedValue(sessionWith({}) as any);
    const req = mockRequest(authedUser, { sessionId: 'sess-1', recommendationId: 'does-not-exist' });
    const res = mockResponse();

    await agentModeController.declineWorkPlanRecommendation(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'RECOMMENDATION_NOT_FOUND' }));
    expect(mockChatbotDb.recordDeclinedWorkPlanRecommendation).not.toHaveBeenCalled();
  });

  it('happy path: records the decline with planId/planTitle/declinedAt and returns 200', async () => {
    mockChatbotDb.getChatSession.mockResolvedValue(sessionWith({}) as any);
    mockChatbotDb.recordDeclinedWorkPlanRecommendation.mockResolvedValue(true);
    const req = mockRequest(authedUser, { sessionId: 'sess-1', recommendationId: 'reco-abc' });
    const res = mockResponse();

    await agentModeController.declineWorkPlanRecommendation(req, res);

    expect(mockChatbotDb.recordDeclinedWorkPlanRecommendation).toHaveBeenCalledWith(
      'sess-1',
      'reco-abc',
      expect.objectContaining({ planId: 'plan-onboard', planTitle: 'Client Onboarding', declinedAt: expect.any(String) }),
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ success: true });
  });

  // Independent review finding: the write's boolean result was previously discarded,
  // so this endpoint answered 200 even when the decline was never actually recorded
  // (the only path that returns false: the session was deleted/purged in the window
  // between the getChatSession check and this write) -- a silently-unrecorded decline
  // is exactly the "the model has no idea this was declined" defect this PR exists to
  // close. A false-positive 200 here would have gone completely undetected.
  it('returns 404 (not a false-positive 200) when the write does not actually record — the session vanished between the fetch and the write', async () => {
    mockChatbotDb.getChatSession.mockResolvedValue(sessionWith({}) as any);
    mockChatbotDb.recordDeclinedWorkPlanRecommendation.mockResolvedValue(false);
    const req = mockRequest(authedUser, { sessionId: 'sess-1', recommendationId: 'reco-abc' });
    const res = mockResponse();

    await agentModeController.declineWorkPlanRecommendation(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).not.toHaveBeenCalledWith({ success: true });
  });

  // ENG-1974's whole point: declining must only ever record the decline, never
  // touch session.workPlan — a decline that accidentally launched or mutated
  // anything would be strictly worse than the original bug.
  it('never calls applyPredefinedWorkPlan', async () => {
    mockChatbotDb.getChatSession.mockResolvedValue(sessionWith({}) as any);
    mockChatbotDb.recordDeclinedWorkPlanRecommendation.mockResolvedValue(true);
    const req = mockRequest(authedUser, { sessionId: 'sess-1', recommendationId: 'reco-abc' });
    const res = mockResponse();

    await agentModeController.declineWorkPlanRecommendation(req, res);

    expect(mockAgentModeService.applyPredefinedWorkPlan).not.toHaveBeenCalled();
  });
});
