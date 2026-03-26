describe('WorkPlanService', () => {
  let workPlanService: any;
  let mockPut: jest.Mock;
  let mockGet: jest.Mock;
  let mockQuery: jest.Mock;
  let mockDelete: jest.Mock;
  let mockPromise: jest.Mock;

  const mockTimestamp = '2026-03-24T10:00:00.000Z';

  beforeAll(() => {
    jest.resetModules();

    mockPromise = jest.fn();
    mockPut = jest.fn(() => ({ promise: mockPromise }));
    mockGet = jest.fn(() => ({ promise: mockPromise }));
    mockQuery = jest.fn(() => ({ promise: mockPromise }));
    mockDelete = jest.fn(() => ({ promise: mockPromise }));

    jest.doMock('aws-sdk', () => ({
      DynamoDB: {
        DocumentClient: jest.fn(() => ({
          put: mockPut,
          get: mockGet,
          query: mockQuery,
          scan: jest.fn(() => ({ promise: mockPromise })),
          delete: mockDelete,
        })),
      },
    }));

    jest.doMock('uuid', () => ({
      v4: jest.fn(() => 'test-plan-id-789'),
    }));

    const module = require('../services/workPlanService');
    workPlanService = module.workPlanService;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Date.prototype, 'toISOString').mockReturnValue(mockTimestamp);
    mockPromise.mockResolvedValue({});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('createWorkPlan', () => {
    it('should create a work plan with generated planId', async () => {
      const result = await workPlanService.createWorkPlan({
        title: 'Test Plan',
        steps: [{ stepCount: 1, title: 'Step 1' }],
        visibility: 'private',
        isBuiltIn: false,
        ownerId: 'user1',
      });

      expect(result.planId).toBe('test-plan-id-789');
      expect(result.title).toBe('Test Plan');
      expect(result.visibility).toBe('private');
      expect(result.createdAt).toBe(mockTimestamp);
      expect(mockPut).toHaveBeenCalledWith(expect.objectContaining({
        TableName: expect.stringContaining('AW-WorkPlans'),
      }));
    });
  });

  describe('getWorkPlan', () => {
    it('should return plan by planId', async () => {
      const plan = { planId: 'p1', title: 'Plan', steps: [] };
      mockPromise.mockResolvedValueOnce({ Item: plan });

      const result = await workPlanService.getWorkPlan('p1');
      expect(result).toEqual(plan);
    });

    it('should return null if not found', async () => {
      mockPromise.mockResolvedValueOnce({ Item: undefined });
      const result = await workPlanService.getWorkPlan('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('getWorkPlansByOwner', () => {
    it('should query OwnerIndex', async () => {
      mockPromise.mockResolvedValueOnce({ Items: [
        { planId: 'p1', ownerId: 'user1', title: 'My Plan' },
      ]});

      const result = await workPlanService.getWorkPlansByOwner('user1');
      expect(result).toHaveLength(1);
      expect(mockQuery).toHaveBeenCalledWith(expect.objectContaining({
        IndexName: 'OwnerIndex',
      }));
    });
  });

  describe('submitForReview', () => {
    it('should change visibility to pending_review', async () => {
      const plan = {
        planId: 'p1', ownerId: 'user1', visibility: 'private', title: 'Plan',
        steps: [], isBuiltIn: false, createdAt: mockTimestamp, updatedAt: mockTimestamp,
      };
      mockGet.mockReturnValueOnce({ promise: jest.fn().mockResolvedValue({ Item: plan }) });
      mockPut.mockReturnValueOnce({ promise: jest.fn().mockResolvedValue({}) });

      const result = await workPlanService.submitForReview('p1', 'user1');
      expect(result.visibility).toBe('pending_review');
    });

    it('should reject if not owned by user', async () => {
      const plan = { planId: 'p1', ownerId: 'other', visibility: 'private' };
      mockGet.mockReturnValueOnce({ promise: jest.fn().mockResolvedValue({ Item: plan }) });

      await expect(workPlanService.submitForReview('p1', 'user1')).rejects.toThrow('Not authorized');
    });

    it('should reject if not private', async () => {
      const plan = { planId: 'p1', ownerId: 'user1', visibility: 'public' };
      mockGet.mockReturnValueOnce({ promise: jest.fn().mockResolvedValue({ Item: plan }) });

      await expect(workPlanService.submitForReview('p1', 'user1')).rejects.toThrow('Only private plans can be submitted for review');
    });

    it('should reject if plan not found', async () => {
      mockGet.mockReturnValueOnce({ promise: jest.fn().mockResolvedValue({ Item: null }) });

      await expect(workPlanService.submitForReview('nonexistent', 'user1')).rejects.toThrow('Work plan not found');
    });
  });

  describe('approveWorkPlan', () => {
    it('should set visibility to public', async () => {
      const plan = {
        planId: 'p1', visibility: 'pending_review', title: 'Plan',
        steps: [], isBuiltIn: false, createdAt: mockTimestamp, updatedAt: mockTimestamp,
      };
      mockGet.mockReturnValueOnce({ promise: jest.fn().mockResolvedValue({ Item: plan }) });
      mockPut.mockReturnValueOnce({ promise: jest.fn().mockResolvedValue({}) });

      const result = await workPlanService.approveWorkPlan('p1');
      expect(result.visibility).toBe('public');
      expect(result.showInAgentMode).toBe(true);
    });

    it('should reject if not pending review', async () => {
      const plan = { planId: 'p1', visibility: 'private' };
      mockGet.mockReturnValueOnce({ promise: jest.fn().mockResolvedValue({ Item: plan }) });

      await expect(workPlanService.approveWorkPlan('p1')).rejects.toThrow('Plan is not pending review');
    });
  });

  describe('rejectWorkPlan', () => {
    it('should revert to private with feedback', async () => {
      const plan = {
        planId: 'p1', visibility: 'pending_review', title: 'Plan',
        steps: [], isBuiltIn: false, createdAt: mockTimestamp, updatedAt: mockTimestamp,
      };
      mockGet.mockReturnValueOnce({ promise: jest.fn().mockResolvedValue({ Item: plan }) });
      mockPut.mockReturnValueOnce({ promise: jest.fn().mockResolvedValue({}) });

      const result = await workPlanService.rejectWorkPlan('p1', 'Needs work');
      expect(result.visibility).toBe('private');
      expect(result.reviewFeedback).toBe('Needs work');
    });

    it('should reject if not pending review', async () => {
      const plan = { planId: 'p1', visibility: 'public' };
      mockGet.mockReturnValueOnce({ promise: jest.fn().mockResolvedValue({ Item: plan }) });

      await expect(workPlanService.rejectWorkPlan('p1', 'feedback')).rejects.toThrow('Plan is not pending review');
    });
  });

  describe('deleteWorkPlan', () => {
    it('should delete by planId', async () => {
      await workPlanService.deleteWorkPlan('p1');
      expect(mockDelete).toHaveBeenCalledWith(expect.objectContaining({
        Key: { planId: 'p1' },
      }));
    });
  });
});
