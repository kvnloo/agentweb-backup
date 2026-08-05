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
  // ENG-889: updateWorkPlan was a whole-item put, so an ordinary plan save wrote
  // back whatever thumbnail the caller happened to hold. It is attribute-scoped
  // now and must never touch the thumbnail fields, which is what makes a
  // thumbnail-scoped revision trustworthy.
  describe('updateWorkPlan leaves the thumbnail alone', () => {
    const plan: any = {
      planId: 'p1', title: 'T', steps: [], visibility: 'system', isBuiltIn: true,
      createdAt: 'c', updatedAt: 'u', description: 'd',
      thumbnail_url: 'https://stale/old.png', thumbnail_source: 'ai', thumbnail_rev: 'rev-old',
    };

    it('actually emits every non-thumbnail field, not just lists them', async () => {
      // The source-scanning guard proves the LISTS are complete. This proves the
      // loop over them really reaches DynamoDB — a listed field that the code
      // failed to emit would still be silently lost.
      const full: any = {
        planId: 'p1', title: 'T', steps: [], visibility: 'system', isBuiltIn: true,
        createdAt: 'c', updatedAt: 'u',
        description: 'd', welcomeMessage: 'w', autocomplete: true, requireLogin: false,
        showLoginSignup: 'always', showInAgentMode: true, defaultModel: 'm',
        category: 'Strategy', ownerId: 'o', orgId: 'g', reviewFeedback: 'r',
      };
      await workPlanService.updateWorkPlan(full);

      const arg = mockUpdate.mock.calls[0][0];
      for (const field of [
        'title', 'steps', 'visibility', 'isBuiltIn', 'createdAt',
        'description', 'welcomeMessage', 'autocomplete', 'requireLogin', 'showLoginSignup',
        'showInAgentMode', 'defaultModel', 'category', 'ownerId', 'orgId', 'reviewFeedback',
      ]) {
        expect(arg.UpdateExpression).toContain(`#${field} = :${field}`);
        expect(arg.ExpressionAttributeValues[`:${field}`]).toEqual(full[field]);
      }
      expect(arg.UpdateExpression).toContain('#updatedAt = :updatedAt');
    });

    it('reports a plan deleted between read and write as not-found, not a crash', async () => {
      const err: any = new Error('The conditional request failed');
      err.code = 'ConditionalCheckFailedException';
      mockPromise.mockRejectedValueOnce(err);

      await expect(
        workPlanService.updateWorkPlan({
          planId: 'gone', title: 'T', steps: [], visibility: 'system', isBuiltIn: true,
          createdAt: 'c', updatedAt: 'u',
        } as any),
      ).rejects.toThrow('Work plan not found');
    });

    it('never writes any thumbnail attribute', async () => {
      await workPlanService.updateWorkPlan(plan);

      const arg = mockUpdate.mock.calls[0][0];
      for (const field of ['thumbnail_url', 'thumbnail_source', 'thumbnail_alt_text', 'thumbnail_rev']) {
        expect(arg.UpdateExpression).not.toContain(field);
      }
      expect(mockPut).not.toHaveBeenCalled();
    });

    it('still writes the plan fields, and removes ones the caller cleared', async () => {
      await workPlanService.updateWorkPlan({ ...plan, description: undefined });

      const arg = mockUpdate.mock.calls[0][0];
      expect(arg.UpdateExpression).toContain('#title = :title');
      expect(arg.UpdateExpression).toContain('#steps = :steps');
      expect(arg.UpdateExpression).toMatch(/REMOVE .*#description/);
    });
  });

  // ENG-890: the MCP tool guards a destructive step replace by reading the plan
  // and checking what the payload would remove. Read-then-write is not atomic,
  // so without a version the check can pass against a snapshot that a competing
  // write has already replaced — and the guard waves through the very deletion
  // it exists to stop.
  describe('updateWorkPlan step revision', () => {
    const plan: any = {
      planId: 'p1', title: 'T', steps: [{ stepCount: 1, title: 'S' }],
      visibility: 'system', isBuiltIn: true, createdAt: 'c', updatedAt: 'u',
    };

    it('bumps steps_rev on every write, so a reader always has something to order against', async () => {
      await workPlanService.updateWorkPlan(plan);

      const arg = mockUpdate.mock.calls[0][0];
      expect(arg.UpdateExpression).toContain('#steps_rev = :steps_rev');
      expect(arg.ExpressionAttributeValues[':steps_rev']).toBe('test-plan-id-789');
    });

    it('orders the write against the revision the caller observed', async () => {
      await workPlanService.updateWorkPlan(plan, { expectedStepsRev: 'rev-1' });

      const arg = mockUpdate.mock.calls[0][0];
      expect(arg.ConditionExpression).toContain('#steps_rev = :expectedStepsRev');
      expect(arg.ExpressionAttributeValues[':expectedStepsRev']).toBe('rev-1');
    });

    it('accepts a plan that predates the field, without matching one that has since been written', async () => {
      await workPlanService.updateWorkPlan(plan, { expectedStepsRev: null });

      const arg = mockUpdate.mock.calls[0][0];
      expect(arg.ConditionExpression).toContain('attribute_not_exists(#steps_rev)');
    });

    it('leaves a caller that did not observe a revision unconditioned', async () => {
      await workPlanService.updateWorkPlan(plan);

      const arg = mockUpdate.mock.calls[0][0];
      expect(arg.ConditionExpression).toBe('attribute_exists(planId)');
    });

    it('reports a lost race as a conflict, not as a missing plan', async () => {
      const err: any = new Error('The conditional request failed');
      err.code = 'ConditionalCheckFailedException';
      mockPromise.mockRejectedValueOnce(err);
      // The plan is still there — it was the revision that moved.
      mockPromise.mockResolvedValueOnce({ Item: { ...plan, steps_rev: 'rev-2' } });

      await expect(
        workPlanService.updateWorkPlan(plan, { expectedStepsRev: 'rev-1' }),
      ).rejects.toThrow('Work plan steps changed');
    });

    it('disambiguates on a consistent read, since a stale replica would invent a deletion', async () => {
      const err: any = new Error('The conditional request failed');
      err.code = 'ConditionalCheckFailedException';
      mockPromise.mockRejectedValueOnce(err);
      mockPromise.mockResolvedValueOnce({ Item: { ...plan, steps_rev: 'rev-2' } });

      await expect(
        workPlanService.updateWorkPlan(plan, { expectedStepsRev: 'rev-1' }),
      ).rejects.toThrow('Work plan steps changed');
      // An eventually-consistent read can miss a plan that exists, which would
      // report a live conflict to the caller as "your plan was deleted".
      expect(mockGet.mock.calls[0][0].ConsistentRead).toBe(true);
    });

    it('still reports a deleted plan as not-found even when a revision was supplied', async () => {
      const err: any = new Error('The conditional request failed');
      err.code = 'ConditionalCheckFailedException';
      mockPromise.mockRejectedValueOnce(err);
      mockPromise.mockResolvedValueOnce({});

      await expect(
        workPlanService.updateWorkPlan(plan, { expectedStepsRev: 'rev-1' }),
      ).rejects.toThrow('Work plan not found');
    });

    it('does not re-read when no revision was supplied — that failure can only be a deletion', async () => {
      const err: any = new Error('The conditional request failed');
      err.code = 'ConditionalCheckFailedException';
      mockPromise.mockRejectedValueOnce(err);

      await expect(workPlanService.updateWorkPlan(plan)).rejects.toThrow('Work plan not found');
      expect(mockGet).not.toHaveBeenCalled();
    });

    it('disambiguates with a consistent read, so a stale replica cannot call a live plan deleted', async () => {
      // A default DynamoDB read may serve a replica that has not caught up. On
      // this path that would report a plan we just failed to write as deleted —
      // a 404 for what is really a retryable conflict.
      const err: any = new Error('The conditional request failed');
      err.code = 'ConditionalCheckFailedException';
      mockPromise.mockRejectedValueOnce(err);
      mockPromise.mockResolvedValueOnce({ Item: { ...plan, steps_rev: 'rev-2' } });

      await expect(
        workPlanService.updateWorkPlan(plan, { expectedStepsRev: 'rev-1' }),
      ).rejects.toThrow('Work plan steps changed');
      expect(mockGet).toHaveBeenCalledWith(expect.objectContaining({ ConsistentRead: true }));
    });

    it('returns the revision it wrote, so a caller can chain a second staked write', async () => {
      // Without this the only revision a caller can obtain is the one it read,
      // which its own write has already superseded.
      const rev = await workPlanService.updateWorkPlan(plan);

      expect(rev).toBe('test-plan-id-789');
    });

    it('propagates a genuine write failure instead of dressing it as a conflict', async () => {
      // Only a failed precondition is interpreted. Anything else must surface
      // as-is, or a throughput or permissions error would reach the caller as
      // "someone else edited this" and send them into a pointless retry loop.
      mockPromise.mockRejectedValueOnce(new Error('ProvisionedThroughputExceededException'));

      await expect(
        workPlanService.updateWorkPlan(plan, { expectedStepsRev: 'rev-1' }),
      ).rejects.toThrow('ProvisionedThroughputExceededException');
      expect(mockGet).not.toHaveBeenCalled();
    });

    it('never REMOVEs steps_rev, which would strand every reader holding one', async () => {
      // It is minted here, not supplied by the caller, so it must not be treated
      // as an optional field the caller "cleared" by omitting it.
      await workPlanService.updateWorkPlan(plan);

      const arg = mockUpdate.mock.calls[0][0];
      expect(arg.UpdateExpression).not.toMatch(/REMOVE .*steps_rev/);
    });
  });

  // Raised by Greptile on PR #2269. Each of these reads the plan, mutates one
  // visibility field, then writes the WHOLE plan back — steps included. Without
  // a stake, approving a plan silently restores the steps as they were when the
  // approval started, undoing anything edited in between. Same read-then-write
  // race the update path just closed, in three methods that bypassed it.
  describe('review transitions stake the plan they read', () => {
    // A factory, not a shared object: these methods mutate the plan they are
    // handed (plan.visibility = 'public'), so a shared fixture would arrive at
    // the next test already approved.
    const pending = (over: any = {}): any => ({
      planId: 'p1', title: 'T', steps: [{ stepCount: 1, title: 'S' }],
      visibility: 'pending_review', isBuiltIn: false, ownerId: 'u1',
      createdAt: 'c', updatedAt: 'u', steps_rev: 'rev-1', ...over,
    });
    const stakeOf = () => mockUpdate.mock.calls[0][0].ExpressionAttributeValues[':expectedStepsRev'];

    // Every dynamo call shares one mockPromise, and clearAllMocks does not drain
    // a mockResolvedValueOnce queue — an unconsumed entry would surface as the
    // NEXT test's read. Reset the queue rather than leak across tests.
    beforeEach(() => {
      mockPromise.mockReset();
      mockPromise.mockResolvedValue({});
    });

    it('submitForReview stakes it', async () => {
      mockPromise.mockResolvedValueOnce({ Item: pending({ visibility: 'private' }) });
      await workPlanService.submitForReview('p1', 'u1');
      expect(stakeOf()).toBe('rev-1');
    });

    it('approveWorkPlan stakes it', async () => {
      mockPromise.mockResolvedValueOnce({ Item: pending() });
      await workPlanService.approveWorkPlan('p1');
      expect(stakeOf()).toBe('rev-1');
    });

    it('rejectWorkPlan stakes it', async () => {
      mockPromise.mockResolvedValueOnce({ Item: pending() });
      await workPlanService.rejectWorkPlan('p1', 'needs work');
      expect(stakeOf()).toBe('rev-1');
    });

    it('stakes attribute_not_exists for a plan that predates the field', async () => {
      const { steps_rev, ...legacy } = pending();
      mockPromise.mockResolvedValueOnce({ Item: legacy });
      await workPlanService.approveWorkPlan('p1');
      expect(mockUpdate.mock.calls[0][0].ConditionExpression).toContain('attribute_not_exists(#steps_rev)');
    });

    it('surfaces a lost race instead of silently restoring the old steps', async () => {
      mockPromise.mockResolvedValueOnce({ Item: pending() });
      const err: any = new Error('The conditional request failed');
      err.code = 'ConditionalCheckFailedException';
      mockPromise.mockRejectedValueOnce(err);
      mockPromise.mockResolvedValueOnce({ Item: pending({ steps_rev: 'rev-2' }) });

      await expect(workPlanService.approveWorkPlan('p1')).rejects.toThrow('Work plan steps changed');
    });
  });

  describe('syncWorkPlan', () => {
    it('mints a fresh steps_rev instead of importing the source plan\'s', async () => {
      // The put replaces the target's steps wholesale while bypassing
      // updateWorkPlan entirely. Copying the source revision across would let a
      // caller's staked write pass its precondition against steps the sync had
      // already replaced — the two tables' revisions can genuinely collide,
      // since dev is populated from prod (ENG-890).
      mockPromise.mockResolvedValueOnce({
        Item: { planId: 'p1', title: 'T', steps: [{ stepCount: 1, title: 'S' }], steps_rev: 'rev-source' },
      });

      await workPlanService.syncWorkPlan('p1', 'prod-to-dev');

      const written = mockPut.mock.calls[0][0].Item;
      expect(written.steps_rev).toBe('test-plan-id-789');
      expect(written.steps_rev).not.toBe('rev-source');
      expect(written.steps).toEqual([{ stepCount: 1, title: 'S' }]);
    });

    it('stamps one onto a source plan that predates the field', async () => {
      mockPromise.mockResolvedValueOnce({
        Item: { planId: 'p1', title: 'T', steps: [] },
      });

      await workPlanService.syncWorkPlan('p1', 'dev-to-prod');

      expect(mockPut.mock.calls[0][0].Item.steps_rev).toBe('test-plan-id-789');
    });

    it('returns null without writing when the source plan is missing', async () => {
      mockPromise.mockResolvedValueOnce({});

      await expect(workPlanService.syncWorkPlan('gone', 'prod-to-dev')).resolves.toBeNull();
      expect(mockPut).not.toHaveBeenCalled();
    });
  });

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
        { expectedRev: 'rev-1' },
      );

      const arg = mockUpdate.mock.calls[0][0];
      expect(arg.ConditionExpression).toContain('attribute_exists(planId)');
      expect(arg.ConditionExpression).toContain('#thumbnail_rev = :expectedRev');
      expect(arg.ExpressionAttributeValues[':expectedRev']).toBe('rev-1');
    });

    it('leaves user-initiated writes unordered so they always win', async () => {
      await workPlanService.updateThumbnail('p1', { thumbnail_source: 'upload' });

      expect(mockUpdate.mock.calls[0][0].ConditionExpression).toBe('attribute_exists(planId)');
    });

    it('returns the new revision so a follow-up job can order against it', async () => {
      const result = await workPlanService.updateThumbnail('p1', { thumbnail_source: 'none' });

      expect(result).toEqual(expect.any(String));
      expect(result).toBe(mockUpdate.mock.calls[0][0].ExpressionAttributeValues[':thumbnail_rev']);
    });

    it('bumps thumbnail_rev on every write so competing actions are ordered', async () => {
      await workPlanService.updateThumbnail('p1', { thumbnail_source: 'upload' });

      const arg = mockUpdate.mock.calls[0][0];
      expect(arg.UpdateExpression).toContain('#thumbnail_rev = :thumbnail_rev');
    });

    it('expects no revision at all when the plan never had a thumbnail', async () => {
      await workPlanService.updateThumbnail('p1', { thumbnail_source: 'ai' }, { expectedRev: null });

      expect(mockUpdate.mock.calls[0][0].ConditionExpression)
        .toContain('attribute_not_exists(#thumbnail_rev)');
    });

    it('returns null — not a throw, and not a false success — when a newer action won', async () => {
      const err: any = new Error('The conditional request failed');
      err.code = 'ConditionalCheckFailedException';
      mockPromise.mockRejectedValueOnce(err);

      await expect(
        workPlanService.updateThumbnail('p1', { thumbnail_source: 'ai' }, { expectedRev: 'stale' }),
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
