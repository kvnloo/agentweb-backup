describe('WorkPlanService', () => {
  let workPlanService: any;
  let mockPut: jest.Mock;
  let mockGet: jest.Mock;
  let mockQuery: jest.Mock;
  let mockDelete: jest.Mock;
  let mockUpdate: jest.Mock;
  let mockPromise: jest.Mock;

  const mockTimestamp = '2026-03-24T10:00:00.000Z';

  beforeAll(() => {
    jest.resetModules();

    mockPromise = jest.fn();
    mockPut = jest.fn(() => ({ promise: mockPromise }));
    mockGet = jest.fn(() => ({ promise: mockPromise }));
    mockQuery = jest.fn(() => ({ promise: mockPromise }));
    mockDelete = jest.fn(() => ({ promise: mockPromise }));
    mockUpdate = jest.fn(() => ({ promise: mockPromise }));

    jest.doMock('aws-sdk', () => ({
      DynamoDB: {
        DocumentClient: jest.fn(() => ({
          put: mockPut,
          get: mockGet,
          query: mockQuery,
          scan: jest.fn(() => ({ promise: mockPromise })),
          delete: mockDelete,
          update: mockUpdate,
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

  describe('createWorkPlan — userInstructions validation', () => {
    it('rejects when a step.userInstructions exceeds 500 characters', async () => {
      const tooLong = 'a'.repeat(501);
      await expect(workPlanService.createWorkPlan({
        title: 'Test Plan',
        steps: [{ stepCount: 1, title: 'Step 1', userInstructions: tooLong }],
        visibility: 'private',
        isBuiltIn: false,
        ownerId: 'user1',
      })).rejects.toThrow(/userInstructions.*500/i);
      expect(mockPut).not.toHaveBeenCalled();
    });

    it('rejects when step.userInstructions is not a string', async () => {
      await expect(workPlanService.createWorkPlan({
        title: 'Test Plan',
        steps: [{ stepCount: 1, title: 'Step 1', userInstructions: 42 as any }],
        visibility: 'private',
        isBuiltIn: false,
        ownerId: 'user1',
      })).rejects.toThrow(/userInstructions.*string/i);
      expect(mockPut).not.toHaveBeenCalled();
    });

    it('rejects when ANY one of multiple steps has invalid userInstructions', async () => {
      await expect(workPlanService.createWorkPlan({
        title: 'Test Plan',
        steps: [
          { stepCount: 1, title: 'Step 1', userInstructions: 'short and fine' },
          { stepCount: 2, title: 'Step 2', userInstructions: 'b'.repeat(600) },
          { stepCount: 3, title: 'Step 3' },
        ],
        visibility: 'private',
        isBuiltIn: false,
        ownerId: 'user1',
      })).rejects.toThrow(/step 2.*userInstructions.*500/i);
      expect(mockPut).not.toHaveBeenCalled();
    });

    it('persists step.userInstructions when valid (≤500 chars)', async () => {
      const text = 'Click "Generate" then upload the result. Expect a CSV.';
      const result = await workPlanService.createWorkPlan({
        title: 'Test Plan',
        steps: [{ stepCount: 1, title: 'Step 1', userInstructions: text }],
        visibility: 'private',
        isBuiltIn: false,
        ownerId: 'user1',
      });
      expect(result.steps[0].userInstructions).toBe(text);
      expect(mockPut).toHaveBeenCalledWith(expect.objectContaining({
        Item: expect.objectContaining({
          steps: expect.arrayContaining([
            expect.objectContaining({ userInstructions: text }),
          ]),
        }),
      }));
    });
  });

  describe('updateWorkPlan — userInstructions validation', () => {
    it('rejects update when a step.userInstructions exceeds 500 characters', async () => {
      await expect(workPlanService.updateWorkPlan({
        planId: 'p1',
        title: 'Test Plan',
        steps: [{ stepCount: 1, title: 'Step 1', userInstructions: 'x'.repeat(501) }],
        visibility: 'private',
        isBuiltIn: false,
        createdAt: mockTimestamp,
        updatedAt: mockTimestamp,
      })).rejects.toThrow(/userInstructions.*500/i);
      expect(mockPut).not.toHaveBeenCalled();
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

  // ENG-889. The AI thumbnail job holds the plan as it looked at create (or at a
  // clear) and lands ~40s later; a whole-item put of that snapshot reverted any
  // edit made meanwhile, silently. Ordering is ONE conditional write on
  // updatedAt — not a claim-then-write token, because the claim is itself an
  // unconditioned write that races the actions it is meant to order.
  describe('updateThumbnail', () => {
    it('writes only the thumbnail attributes, never a whole-item put', async () => {
      await workPlanService.updateThumbnail('p1', { thumbnail_url: 'https://x/y.png', thumbnail_source: 'ai' });

      expect(mockPut).not.toHaveBeenCalled();
      const arg = mockUpdate.mock.calls[0][0];
      expect(arg.Key).toEqual({ planId: 'p1' });
      expect(arg.UpdateExpression).toContain('#thumbnail_url = :thumbnail_url');
      expect(arg.ExpressionAttributeValues[':thumbnail_url']).toBe('https://x/y.png');
    });

    it('leaves fields the caller did not supply alone', async () => {
      await workPlanService.updateThumbnail('p1', { thumbnail_source: 'none' });

      const arg = mockUpdate.mock.calls[0][0];
      expect(arg.UpdateExpression).not.toContain('thumbnail_url');
      expect(arg.UpdateExpression).not.toContain('thumbnail_alt_text');
    });

    it('REMOVEs an attribute explicitly set to undefined', async () => {
      await workPlanService.updateThumbnail('p1', {
        thumbnail_url: undefined,
        thumbnail_source: 'none',
        thumbnail_alt_text: undefined,
      });

      const arg = mockUpdate.mock.calls[0][0];
      expect(arg.UpdateExpression).toMatch(/REMOVE .*#thumbnail_url/);
      expect(arg.UpdateExpression).toMatch(/REMOVE .*#thumbnail_alt_text/);
    });

    it('never resurrects a deleted plan as a stub item', async () => {
      // update is an upsert; a plan deleted mid-generation would otherwise come
      // back holding only planId and thumbnail fields, which crashes every
      // consumer that maps over plan.steps.
      await workPlanService.updateThumbnail('p1', { thumbnail_source: 'ai' });

      expect(mockUpdate.mock.calls[0][0].ConditionExpression).toBe('attribute_exists(planId)');
    });

    it('orders a generation against the plan it observed', async () => {
      await workPlanService.updateThumbnail(
        'p1',
        { thumbnail_url: 'https://x/ai.png', thumbnail_source: 'ai' },
        { expectedUpdatedAt: '2026-08-04T10:00:00.000Z' },
      );

      const arg = mockUpdate.mock.calls[0][0];
      expect(arg.ConditionExpression).toContain('attribute_exists(planId)');
      expect(arg.ConditionExpression).toContain('#updatedAt = :expectedUpdatedAt');
      expect(arg.ExpressionAttributeValues[':expectedUpdatedAt']).toBe('2026-08-04T10:00:00.000Z');
    });

    it('leaves user-initiated writes unordered so they always win', async () => {
      await workPlanService.updateThumbnail('p1', { thumbnail_source: 'upload' });

      expect(mockUpdate.mock.calls[0][0].ConditionExpression).toBe('attribute_exists(planId)');
    });

    it('returns the new updatedAt so a follow-up job can order against it', async () => {
      const result = await workPlanService.updateThumbnail('p1', { thumbnail_source: 'none' });

      expect(result).toEqual(expect.any(String));
      expect(result).toBe(mockUpdate.mock.calls[0][0].ExpressionAttributeValues[':updatedAt']);
    });

    it('returns null — not a throw, and not a false success — when a newer action won', async () => {
      const err: any = new Error('The conditional request failed');
      err.code = 'ConditionalCheckFailedException';
      mockPromise.mockRejectedValueOnce(err);

      await expect(
        workPlanService.updateThumbnail('p1', { thumbnail_source: 'ai' }, { expectedUpdatedAt: 'stale' }),
      ).resolves.toBeNull();
    });

    it('still surfaces any other write failure', async () => {
      mockPromise.mockRejectedValueOnce(new Error('ProvisionedThroughputExceeded'));

      await expect(
        workPlanService.updateThumbnail('p1', { thumbnail_source: 'ai' }),
      ).rejects.toThrow('ProvisionedThroughputExceeded');
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

  describe('deleteWorkPlan', () => {
    it('should delete by planId', async () => {
      await workPlanService.deleteWorkPlan('p1');
      expect(mockDelete).toHaveBeenCalledWith(expect.objectContaining({
        Key: { planId: 'p1' },
      }));
    });
  });
});
