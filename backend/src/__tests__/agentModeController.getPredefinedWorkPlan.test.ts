import { Request, Response } from 'express';
import { agentModeController } from '../controllers/agentModeController';
import { workPlanService } from '../services/workPlanService';
import { getUserFromToken } from '../middleware/auth';

// Mock dependencies
jest.mock('../services/workPlanService', () => ({
  workPlanService: {
    getWorkPlansByVisibility: jest.fn(),
    getWorkPlansByOwner: jest.fn(),
  },
}));

jest.mock('../middleware/auth', () => ({
  getUserFromToken: jest.fn(),
  authenticateToken: jest.fn(),
  isAdmin: jest.fn(),
}));

const mockWorkPlanService = workPlanService as jest.Mocked<typeof workPlanService>;
const mockGetUserFromToken = getUserFromToken as jest.MockedFunction<typeof getUserFromToken>;

describe('AgentModeController - getPredefinedWorkPlan (ENG-1469)', () => {
  const mockRequest = (planTitle: string) => ({ params: { planTitle } } as unknown as Request);

  const mockResponse = () => {
    const res: any = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res as Response;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetUserFromToken.mockResolvedValue({ user: null });
    mockWorkPlanService.getWorkPlansByVisibility.mockResolvedValue([]);
  });

  it('includes the canonical customer-facing display projection alongside legacy keys', async () => {
    const plan = {
      planId: 'plan-1',
      title: 'Onboarding',
      description: 'Get started with our platform',
      category: 'Paid Ads',
      steps: [{ stepCount: 1, title: 'Create campaign', description: 'internal-only prompt text' }],
      showInAgentMode: true,
      visibility: 'system' as const,
      isBuiltIn: true,
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
    };
    mockWorkPlanService.getWorkPlansByVisibility.mockImplementation(async (visibility: string) =>
      visibility === 'system' ? [plan] : [],
    );

    const req = mockRequest('Onboarding');
    const res = mockResponse();

    await agentModeController.getPredefinedWorkPlan(req, res);

    const result = (res.json as jest.Mock).mock.calls[0][0];
    // Legacy shape is untouched.
    expect(result.id).toBe('plan-1');
    expect(result.title).toBe('Onboarding');
    expect(result.steps).toEqual(plan.steps);
    // Canonical projection rides alongside it.
    expect(result.display).toEqual(
      expect.objectContaining({
        id: 'plan-1',
        title: 'Onboarding',
        categories: ['paid-ads'],
        steps: [{ position: 1, label: 'Create campaign' }],
        nextPlanIds: [],
      }),
    );
  });

  it('surfaces author-approved next-plan recommendations in the canonical projection', async () => {
    const plan = {
      planId: 'plan-1',
      title: 'Onboarding',
      steps: [{ stepCount: 1, title: 'Step 1' }],
      visibility: 'public' as const,
      isBuiltIn: true,
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
      display: { version: 1 as const, nextPlanIds: ['plan-2'] },
    };
    mockWorkPlanService.getWorkPlansByVisibility.mockImplementation(async (visibility: string) =>
      visibility === 'public' ? [plan] : [],
    );

    const req = mockRequest('Onboarding');
    const res = mockResponse();

    await agentModeController.getPredefinedWorkPlan(req, res);

    const result = (res.json as jest.Mock).mock.calls[0][0];
    expect(result.display.nextPlanIds).toEqual(['plan-2']);
  });

  // ENG-1802: the title match used to be `.toLowerCase()` only, so a plan
  // stored with underscore-joined title never resolved against the natural,
  // spaced phrasing a user/model would type. Switched to
  // normalizeWorkPlanTitleForMatch, the same separator/case normalization
  // applyPredefinedWorkPlan already uses (ENG-1794).
  it('resolves a stored underscore-joined title against a spaced, mixed-case lookup (ENG-1802)', async () => {
    const plan = {
      planId: 'plan-1',
      title: 'Founder_Linkedin_Sales_Readiness_Audit',
      description: 'Audit the founder profile',
      steps: [{ stepCount: 1, title: 'Step 1' }],
      showInAgentMode: true,
      visibility: 'system' as const,
      isBuiltIn: true,
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
    };
    mockWorkPlanService.getWorkPlansByVisibility.mockImplementation(async (visibility: string) =>
      visibility === 'system' ? [plan] : [],
    );

    const req = mockRequest('Founder LinkedIn Sales Readiness Audit');
    const res = mockResponse();

    await agentModeController.getPredefinedWorkPlan(req, res);

    expect(res.status).not.toHaveBeenCalledWith(404);
    const result = (res.json as jest.Mock).mock.calls[0][0];
    expect(result.id).toBe('plan-1');
  });

  it('returns 404 for an unknown plan title without throwing', async () => {
    const req = mockRequest('Does Not Exist');
    const res = mockResponse();

    await agentModeController.getPredefinedWorkPlan(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
  });
});
