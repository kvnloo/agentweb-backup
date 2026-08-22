import {
  getAccessiblePredefinedWorkPlanCandidates,
  resolveAccessiblePredefinedWorkPlan,
  resolveEligibleNextWorkPlans,
} from '../services/predefinedWorkPlanResolver';
import { workPlanService } from '../services/workPlanService';

jest.mock('aws-sdk');
jest.mock('../services/db', () => ({
  userDb: { getUserById: jest.fn().mockResolvedValue(null) },
}));
jest.mock('../services/workPlanService', () => ({
  workPlanService: {
    getWorkPlansByVisibility: jest.fn().mockResolvedValue([]),
    getWorkPlansByOwner: jest.fn().mockResolvedValue([]),
    getWorkPlansByOrg: jest.fn().mockResolvedValue([]),
  },
}));

const mockWorkPlanService = workPlanService as jest.Mocked<typeof workPlanService>;
const { userDb } = jest.requireMock('../services/db');

const systemPlan: any = {
  planId: 'plan-system-1',
  title: 'Client Onboarding',
  visibility: 'system',
  isBuiltIn: true,
  steps: [{ stepCount: 1, title: 'Step one' }],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const privatePlanOwnedByUser: any = {
  planId: 'plan-private-owned',
  title: 'My Private Plan',
  visibility: 'private',
  ownerId: 'user-1',
  isBuiltIn: false,
  steps: [{ stepCount: 1, title: 'Step one' }],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('predefinedWorkPlanResolver', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockWorkPlanService.getWorkPlansByVisibility.mockResolvedValue([]);
    mockWorkPlanService.getWorkPlansByOwner.mockResolvedValue([]);
    mockWorkPlanService.getWorkPlansByOrg.mockResolvedValue([]);
    userDb.getUserById.mockResolvedValue(null);
  });

  describe('getAccessiblePredefinedWorkPlanCandidates', () => {
    it('includes system/public plans for anonymous callers but never queries private plans', async () => {
      mockWorkPlanService.getWorkPlansByVisibility.mockImplementation(async (v: any) =>
        v === 'system' ? [systemPlan] : []
      );

      const candidates = await getAccessiblePredefinedWorkPlanCandidates(undefined);

      expect(candidates).toEqual([systemPlan]);
      expect(mockWorkPlanService.getWorkPlansByOwner).not.toHaveBeenCalled();
    });

    it('includes a user\'s own private plans plus system/public for an authenticated caller', async () => {
      mockWorkPlanService.getWorkPlansByOwner.mockResolvedValue([privatePlanOwnedByUser]);
      mockWorkPlanService.getWorkPlansByVisibility.mockImplementation(async (v: any) =>
        v === 'system' ? [systemPlan] : []
      );

      const candidates = await getAccessiblePredefinedWorkPlanCandidates('user-1');

      expect(candidates).toEqual(expect.arrayContaining([privatePlanOwnedByUser, systemPlan]));
    });

    it('still includes system/public plans when private-plan loading fails', async () => {
      mockWorkPlanService.getWorkPlansByOwner.mockRejectedValue(new Error('private lookup unavailable'));
      mockWorkPlanService.getWorkPlansByVisibility.mockImplementation(async (v: any) =>
        v === 'system' ? [systemPlan] : []
      );

      await expect(getAccessiblePredefinedWorkPlanCandidates('user-1')).resolves.toEqual([systemPlan]);
    });
  });

  describe('resolveAccessiblePredefinedWorkPlan', () => {
    it('resolves an accessible system plan by planId', async () => {
      mockWorkPlanService.getWorkPlansByVisibility.mockImplementation(async (v: any) =>
        v === 'system' ? [systemPlan] : []
      );

      const result = await resolveAccessiblePredefinedWorkPlan({ planId: 'plan-system-1', userId: 'user-1' });

      expect(result).toEqual(systemPlan);
    });

    it('returns null for a deleted/nonexistent planId', async () => {
      const result = await resolveAccessiblePredefinedWorkPlan({ planId: 'does-not-exist', userId: 'user-1' });
      expect(result).toBeNull();
    });

    it('returns null for a private plan owned by a different user (cross-user rejection)', async () => {
      // The candidate builder only ever returns a private plan for its owner/org, so
      // a plan private to someone else never appears in "user-2"'s candidate set —
      // proving the plan simply cannot be found, not merely denied.
      mockWorkPlanService.getWorkPlansByOwner.mockImplementation(async (ownerId: string) =>
        ownerId === 'user-1' ? [privatePlanOwnedByUser] : []
      );

      const result = await resolveAccessiblePredefinedWorkPlan({ planId: 'plan-private-owned', userId: 'user-2' });

      expect(result).toBeNull();
    });

    it('returns null for a pending_review plan (never published)', async () => {
      // pending_review plans are never returned by getWorkPlansByVisibility('system'|'public')
      // and are filtered out of the private owner/org query (visibility !== 'private'),
      // so they can never appear as a match.
      mockWorkPlanService.getWorkPlansByOwner.mockResolvedValue([
        { ...privatePlanOwnedByUser, planId: 'plan-pending', visibility: 'pending_review' },
      ]);

      const result = await resolveAccessiblePredefinedWorkPlan({ planId: 'plan-pending', userId: 'user-1' });

      expect(result).toBeNull();
    });

    it('returns null for a malformed record (steps not an array)', async () => {
      mockWorkPlanService.getWorkPlansByVisibility.mockImplementation(async (v: any) =>
        v === 'system' ? [{ ...systemPlan, planId: 'plan-malformed', steps: 'not-an-array' }] : []
      );

      const result = await resolveAccessiblePredefinedWorkPlan({ planId: 'plan-malformed', userId: 'user-1' });

      expect(result).toBeNull();
    });

    it('returns null for a wrong-type record (unrecognized visibility value)', async () => {
      mockWorkPlanService.getWorkPlansByOwner.mockResolvedValue([
        { ...privatePlanOwnedByUser, planId: 'plan-wrong-type', visibility: 'not-a-real-visibility' },
      ]);

      const result = await resolveAccessiblePredefinedWorkPlan({ planId: 'plan-wrong-type', userId: 'user-1' });

      expect(result).toBeNull();
    });

    it('returns null for anonymous callers even if a private plan is somehow in the candidate set', async () => {
      mockWorkPlanService.getWorkPlansByVisibility.mockImplementation(async (v: any) =>
        v === 'public' ? [{ ...privatePlanOwnedByUser, planId: 'plan-anon-guard' }] : []
      );

      const result = await resolveAccessiblePredefinedWorkPlan({ planId: 'plan-anon-guard', userId: 'anon_123' });

      expect(result).toBeNull();
    });

    it('never matches by title, only by planId', async () => {
      mockWorkPlanService.getWorkPlansByVisibility.mockImplementation(async (v: any) =>
        v === 'system' ? [systemPlan] : []
      );

      const result = await resolveAccessiblePredefinedWorkPlan({ planId: 'Client Onboarding', userId: 'user-1' });

      expect(result).toBeNull();
    });
  });

  describe('resolveEligibleNextWorkPlans', () => {
    const completedPlan: any = { planId: 'plan-completed', display: { nextPlanIds: ['plan-system-1', 'plan-missing', 'plan-completed'] } };

    it('resolves only the accessible, non-self-referential eligible next plans', async () => {
      mockWorkPlanService.getWorkPlansByVisibility.mockImplementation(async (v: any) =>
        v === 'system' ? [systemPlan] : []
      );

      const eligible = await resolveEligibleNextWorkPlans(completedPlan, 'user-1');

      expect(eligible).toEqual([systemPlan]);
    });

    it('returns an empty array when display.nextPlanIds is absent (pre-ENG-1469 shape)', async () => {
      const eligible = await resolveEligibleNextWorkPlans({ planId: 'plan-completed' }, 'user-1');
      expect(eligible).toEqual([]);
    });

    it('returns an empty array for a null/undefined completed plan without throwing', async () => {
      await expect(resolveEligibleNextWorkPlans(null, 'user-1')).resolves.toEqual([]);
      await expect(resolveEligibleNextWorkPlans(undefined, 'user-1')).resolves.toEqual([]);
    });

    it('silently drops malformed nextPlanIds entries', async () => {
      mockWorkPlanService.getWorkPlansByVisibility.mockImplementation(async (v: any) =>
        v === 'system' ? [systemPlan] : []
      );
      const malformed: any = { planId: 'plan-completed', display: { nextPlanIds: ['plan-system-1', 123, null, '   '] } };

      const eligible = await resolveEligibleNextWorkPlans(malformed, 'user-1');

      expect(eligible).toEqual([systemPlan]);
    });
  });
});
