/**
 * ENG-1472 — POST /api/agent-mode/session/:sessionId/work-plan-recommendations/:recommendationId/accept
 *
 * Owner-only. Finds the persisted recommendation by recommendationId INSIDE the
 * session (never trusts a planId from the request body), re-resolves access at
 * click time, and instantiates via the existing applyPredefinedWorkPlan path.
 */
import { agentModeController } from '../controllers/agentModeController';
import { chatbotDb } from '../services/chatbotService';
import { agentModeService } from '../services/agentModeService';
import * as predefinedWorkPlanResolver from '../services/predefinedWorkPlanResolver';
import { AuthenticatedRequest } from '../middleware/auth';

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getChatSession: jest.fn(),
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

const resolvedPlan: any = {
  planId: 'plan-onboard',
  title: 'Client Onboarding',
  visibility: 'system',
  steps: [{ stepCount: 1, title: 'Analyze website' }],
};

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

function sessionWith(overrides: Partial<{ userId: string; workPlan: any; messages: any[] }>) {
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

describe('agentModeController.acceptWorkPlanRecommendation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(predefinedWorkPlanResolver, 'resolveAccessiblePredefinedWorkPlan').mockResolvedValue(resolvedPlan);
  });

  it('returns 401 when unauthenticated', async () => {
    const req = mockRequest(undefined, { sessionId: 'sess-1', recommendationId: 'reco-abc' });
    const res = mockResponse();

    await agentModeController.acceptWorkPlanRecommendation(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('returns 404 when the session does not exist', async () => {
    mockChatbotDb.getChatSession.mockResolvedValue(null as any);
    const req = mockRequest(authedUser, { sessionId: 'sess-1', recommendationId: 'reco-abc' });
    const res = mockResponse();

    await agentModeController.acceptWorkPlanRecommendation(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('returns 403 for a non-owner (interactive/view-only shares cannot call it)', async () => {
    mockChatbotDb.getChatSession.mockResolvedValue(sessionWith({ userId: 'someone-else' }) as any);
    const req = mockRequest(authedUser, { sessionId: 'sess-1', recommendationId: 'reco-abc' });
    const res = mockResponse();

    await agentModeController.acceptWorkPlanRecommendation(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockAgentModeService.applyPredefinedWorkPlan).not.toHaveBeenCalled();
  });

  it('returns 404 WORKPLAN_UNAVAILABLE when no recommendation with that id exists in the session', async () => {
    mockChatbotDb.getChatSession.mockResolvedValue(sessionWith({}) as any);
    const req = mockRequest(authedUser, { sessionId: 'sess-1', recommendationId: 'does-not-exist' });
    const res = mockResponse();

    await agentModeController.acceptWorkPlanRecommendation(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'WORKPLAN_UNAVAILABLE' }));
  });

  it('happy path: applies the plan and returns 200 with the resulting work plan', async () => {
    mockChatbotDb.getChatSession.mockResolvedValue(sessionWith({}) as any);
    mockAgentModeService.applyPredefinedWorkPlan.mockResolvedValue({
      success: true,
      workPlan: { title: 'Client Onboarding', steps: [{ stepCount: 1, title: 'Analyze website', status: 'pending' }], templatePlanId: 'plan-onboard' },
    });
    const req = mockRequest(authedUser, { sessionId: 'sess-1', recommendationId: 'reco-abc' });
    const res = mockResponse();

    await agentModeController.acceptWorkPlanRecommendation(req, res);

    // Never trusts a planId from the request body — only what the persisted
    // recommendation itself named.
    expect(mockAgentModeService.applyPredefinedWorkPlan).toHaveBeenCalledWith('plan-onboard', 'sess-1', 'user-1');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      alreadyApplied: false,
      workPlan: expect.objectContaining({ templatePlanId: 'plan-onboard' }),
    }));
  });

  it('is idempotent: double accept (same templatePlanId already active) returns 200 alreadyApplied without re-applying', async () => {
    const existingWorkPlan = { title: 'Client Onboarding', steps: [{ stepCount: 1, title: 'Analyze website', status: 'pending' }], templatePlanId: 'plan-onboard' };
    mockChatbotDb.getChatSession.mockResolvedValue(sessionWith({ workPlan: existingWorkPlan }) as any);
    const req = mockRequest(authedUser, { sessionId: 'sess-1', recommendationId: 'reco-abc' });
    const res = mockResponse();

    await agentModeController.acceptWorkPlanRecommendation(req, res);

    expect(mockAgentModeService.applyPredefinedWorkPlan).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ success: true, alreadyApplied: true, workPlan: existingWorkPlan });
  });

  it('returns conflict for a legacy same-title active plan without template identity', async () => {
    const legacyWorkPlan = { title: 'Client Onboarding', steps: [{ stepCount: 1, title: 'Analyze website', status: 'pending' }] };
    mockChatbotDb.getChatSession.mockResolvedValue(sessionWith({ workPlan: legacyWorkPlan }) as any);
    const req = mockRequest(authedUser, { sessionId: 'sess-1', recommendationId: 'reco-abc' });
    const res = mockResponse();

    await agentModeController.acceptWorkPlanRecommendation(req, res);

    expect(mockAgentModeService.applyPredefinedWorkPlan).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'ACTIVE_WORK_PLAN' }));
  });

  it('returns 409 ACTIVE_WORK_PLAN when a DIFFERENT plan is active, and never calls force', async () => {
    const differentWorkPlan = { title: 'Some Other Plan', steps: [{ stepCount: 1, title: 'x', status: 'pending' }] };
    mockChatbotDb.getChatSession.mockResolvedValue(sessionWith({ workPlan: differentWorkPlan }) as any);
    const req = mockRequest(authedUser, { sessionId: 'sess-1', recommendationId: 'reco-abc' });
    const res = mockResponse();

    await agentModeController.acceptWorkPlanRecommendation(req, res);

    expect(mockAgentModeService.applyPredefinedWorkPlan).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'ACTIVE_WORK_PLAN' }));
  });

  it('returns 404 WORKPLAN_UNAVAILABLE when the plan was removed/access changed since recommendation', async () => {
    jest.spyOn(predefinedWorkPlanResolver, 'resolveAccessiblePredefinedWorkPlan').mockResolvedValue(null);
    mockChatbotDb.getChatSession.mockResolvedValue(sessionWith({}) as any);
    const req = mockRequest(authedUser, { sessionId: 'sess-1', recommendationId: 'reco-abc' });
    const res = mockResponse();

    await agentModeController.acceptWorkPlanRecommendation(req, res);

    expect(mockAgentModeService.applyPredefinedWorkPlan).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'WORKPLAN_UNAVAILABLE' }));
  });

  it('leaves session state unchanged (never mutates workPlan) when the plan is unavailable', async () => {
    jest.spyOn(predefinedWorkPlanResolver, 'resolveAccessiblePredefinedWorkPlan').mockResolvedValue(null);
    mockChatbotDb.getChatSession.mockResolvedValue(sessionWith({}) as any);
    const req = mockRequest(authedUser, { sessionId: 'sess-1', recommendationId: 'reco-abc' });
    const res = mockResponse();

    await agentModeController.acceptWorkPlanRecommendation(req, res);

    expect(mockAgentModeService.applyPredefinedWorkPlan).not.toHaveBeenCalled();
  });
});
