import { Request, Response } from 'express';
import { agentModeController } from '../controllers/agentModeController';
import { workPlanService } from '../services/workPlanService';
import { userDb } from '../services/db';
import { getUserFromToken } from '../middleware/auth';

// ENG-2655: a private work plan is readable/launchable only by its owner or an org member; "signed in" is not enough.
jest.mock('../services/workPlanService', () => ({
  workPlanService: {
    getWorkPlansByVisibility: jest.fn(),
    getWorkPlansByOwner: jest.fn(),
    getWorkPlansByOrg: jest.fn(),
    getPublicPlansForAgentMode: jest.fn(),
  },
}));
jest.mock('../middleware/auth', () => ({
  getUserFromToken: jest.fn(),
  authenticateToken: jest.fn(),
  isAdmin: jest.fn(),
}));

const wps = workPlanService as jest.Mocked<typeof workPlanService>;
const mockGetUser = getUserFromToken as jest.MockedFunction<typeof getUserFromToken>;

const plan = (over: Record<string, unknown>) => ({
  planId: 'p', title: 'Secret Plan', steps: [{ stepCount: 1, title: 'customer prompt: ACME margins' }],
  isBuiltIn: false, createdAt: '2026-01-01', updatedAt: '2026-01-01', ...over,
}) as any;

const res = () => {
  const r: any = {};
  r.status = jest.fn().mockReturnValue(r);
  r.json = jest.fn().mockReturnValue(r);
  return r as Response;
};
const req = (planTitle: string) => ({ params: { planTitle }, body: {}, query: {} } as unknown as Request);

describe('private work plan access (ENG-2655)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetUser.mockResolvedValue({ user: { userId: 'viewer' } } as any);
    jest.spyOn(userDb, 'getUserById').mockResolvedValue({ userId: 'viewer', orgId: undefined } as any);
    wps.getWorkPlansByOwner.mockResolvedValue([]);
    wps.getWorkPlansByOrg.mockResolvedValue([]);
    wps.getWorkPlansByVisibility.mockResolvedValue([]);
    wps.getPublicPlansForAgentMode.mockResolvedValue([]);
  });

  // createSessionWithPlan's equivalent cases live in agentModeController.createSessionWithPlan.test.ts.
  describe('getPredefinedWorkPlan', () => {
    const call = (r: Request, s: Response) => agentModeController.getPredefinedWorkPlan(r, s);

    it("does not resolve another account's private plan for a signed-in non-owner", async () => {
      // The owner's plan exists but belongs to someone else: the viewer's own/org queries never return it.
      const r = res();
      await call(req('Secret Plan'), r);
      expect(r.status).toHaveBeenCalledWith(404);
      expect(JSON.stringify((r.json as jest.Mock).mock.calls)).not.toContain('ACME');
    });

    it('defence in depth: refuses with 403 a private plan (ownerless or not) that is in the system/public lists, even when signed in', async () => {
      wps.getWorkPlansByVisibility.mockImplementation(async (v: string) =>
        v === 'public' ? [plan({ planId: 'leak', visibility: 'private', ownerId: 'someone-else' })] : []);
      const r = res();
      await call(req('Secret Plan'), r);
      expect(r.status).toHaveBeenCalledWith(403);
      expect(JSON.stringify((r.json as jest.Mock).mock.calls)).not.toContain('ACME');
    });

    it('still resolves the caller\'s own private plan', async () => {
      wps.getWorkPlansByOwner.mockResolvedValue([plan({ planId: 'mine', visibility: 'private', ownerId: 'viewer' })]);
      const r = res();
      await call(req('Secret Plan'), r);
      expect(r.status).not.toHaveBeenCalled();
      expect(r.json).toHaveBeenCalledWith(expect.objectContaining({ id: 'mine', visibility: 'private' }));
    });

    it("still resolves an org member's private plan for a member of that org", async () => {
      jest.spyOn(userDb, 'getUserById').mockResolvedValue({ userId: 'viewer', orgId: 'org-1' } as any);
      wps.getWorkPlansByOrg.mockResolvedValue([plan({ planId: 'orgmate', visibility: 'private', ownerId: 'mate' })]);
      const r = res();
      await call(req('Secret Plan'), r);
      expect(r.status).not.toHaveBeenCalled();
      expect(r.json).toHaveBeenCalledWith(expect.objectContaining({ id: 'orgmate' }));
    });

    it('resolves system plans for an anonymous caller but never a private one', async () => {
      mockGetUser.mockResolvedValue({ user: null } as any);
      wps.getWorkPlansByVisibility.mockImplementation(async (v: string) =>
        v === 'system' ? [plan({ planId: 'sys', title: 'Sys Plan', visibility: 'system' })]
        : v === 'public' ? [plan({ planId: 'leak', visibility: 'private' })] : []);
      const r1 = res();
      await call(req('Secret Plan'), r1);
      expect(r1.status).toHaveBeenCalledWith(403);
      const r2 = res();
      await call(req('Sys Plan'), r2);
      expect(r2.status).not.toHaveBeenCalled();
      expect(r2.json).toHaveBeenCalledWith(expect.objectContaining({ id: 'sys' }));
    });
  });
});
