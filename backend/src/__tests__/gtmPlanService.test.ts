// Unit tests for gtmPlanService — Slack session GTM tracking

jest.mock('aws-sdk', () => {
  const mockQuery = jest.fn();
  const mockPut = jest.fn();
  const mockUpdate = jest.fn();

  return {
    DynamoDB: {
      DocumentClient: jest.fn(() => ({
        query: mockQuery,
        put: mockPut,
        update: mockUpdate,
      })),
    },
  };
});

describe('gtmPlanService', () => {
  let mockQuery: jest.Mock;
  let mockPut: jest.Mock;
  let mockUpdate: jest.Mock;
  let AWS: any;
  let ensureGtmWorkItemForSlackSession: typeof import('../services/gtmPlanService').ensureGtmWorkItemForSlackSession;

  const mockUserId = 'user-123';
  const mockSessionId = 'session-abc-456';

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    process.env.NODE_ENV = 'development';

    AWS = require('aws-sdk');

    mockQuery = jest.fn();
    mockPut = jest.fn();
    mockUpdate = jest.fn();

    (AWS.DynamoDB.DocumentClient as jest.Mock).mockImplementation(() => ({
      query: mockQuery,
      put: mockPut,
      update: mockUpdate,
    }));

    // Re-require after mocks are set up
    ({ ensureGtmWorkItemForSlackSession } = require('../services/gtmPlanService'));
  });

  describe('ensureGtmWorkItemForSlackSession', () => {
    it('should create a new plan, phase, and work item when none exist', async () => {
      // No existing plans
      mockQuery.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Items: [] }),
      });
      // Plan creation
      mockPut.mockReturnValue({
        promise: jest.fn().mockResolvedValue({}),
      });
      // Phase + work item creation (two update calls)
      mockUpdate.mockReturnValue({
        promise: jest.fn().mockResolvedValue({}),
      });

      const result = await ensureGtmWorkItemForSlackSession({
        userId: mockUserId,
        sessionId: mockSessionId,
        rawMessage: 'Help me create a social media post',
      });

      expect(result).not.toBeNull();
      expect(result!.planId).toMatch(/^plan-/);
      expect(result!.phaseId).toMatch(/^phase-/);
      expect(result!.workItemId).toMatch(/^item-/);

      // Should have queried for existing plans
      expect(mockQuery).toHaveBeenCalledTimes(1);
      expect(mockQuery.mock.calls[0][0]).toMatchObject({
        TableName: 'Dev-AW-GTMPlan',
        IndexName: 'UserIdIndex',
      });

      // Should have created the plan
      expect(mockPut).toHaveBeenCalledTimes(1);
      const putItem = mockPut.mock.calls[0][0].Item;
      expect(putItem.title).toBe('Slack Agent Sessions');
      expect(putItem.userId).toBe(mockUserId);
      expect(putItem.status).toBe('in_progress');

      // Two updates: one for phase creation, one for work item creation
      expect(mockUpdate).toHaveBeenCalledTimes(2);
    });

    it('should reuse existing plan and create phase + work item', async () => {
      const existingPlan = {
        planId: 'plan-existing-123',
        userId: mockUserId,
        title: 'Slack Agent Sessions',
        phases: [],
      };

      mockQuery.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Items: [existingPlan] }),
      });
      mockUpdate.mockReturnValue({
        promise: jest.fn().mockResolvedValue({}),
      });

      const result = await ensureGtmWorkItemForSlackSession({
        userId: mockUserId,
        sessionId: mockSessionId,
        rawMessage: 'Check my analytics',
      });

      expect(result).not.toBeNull();
      expect(result!.planId).toBe('plan-existing-123');

      // Should NOT have created a new plan
      expect(mockPut).not.toHaveBeenCalled();

      // Two updates: phase + work item
      expect(mockUpdate).toHaveBeenCalledTimes(2);
    });

    it('should reuse existing plan and phase when both exist for current week', async () => {
      // Calculate the current week's Monday to generate the right phase title
      const now = new Date();
      const day = now.getDay();
      const diff = day === 0 ? -6 : 1 - day;
      const monday = new Date(now);
      monday.setDate(now.getDate() + diff);
      monday.setHours(0, 0, 0, 0);
      const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      const phaseTitle = `Week of ${months[monday.getMonth()]} ${monday.getDate()}, ${monday.getFullYear()}`;

      const existingPlan = {
        planId: 'plan-existing-123',
        userId: mockUserId,
        title: 'Slack Agent Sessions',
        phases: [
          {
            id: 'phase-existing-456',
            title: phaseTitle,
            status: 'in_progress',
            workItems: [],
          },
        ],
      };

      mockQuery.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Items: [existingPlan] }),
      });
      mockUpdate.mockReturnValue({
        promise: jest.fn().mockResolvedValue({}),
      });

      const result = await ensureGtmWorkItemForSlackSession({
        userId: mockUserId,
        sessionId: mockSessionId,
        rawMessage: 'Draft an email campaign',
      });

      expect(result).not.toBeNull();
      expect(result!.planId).toBe('plan-existing-123');
      expect(result!.phaseId).toBe('phase-existing-456');

      // No plan creation, no phase creation — only work item update
      expect(mockPut).not.toHaveBeenCalled();
      expect(mockUpdate).toHaveBeenCalledTimes(1);
    });

    it('should truncate long messages for work item title', async () => {
      mockQuery.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Items: [] }),
      });
      mockPut.mockReturnValue({
        promise: jest.fn().mockResolvedValue({}),
      });

      let capturedPhases: any[] = [];
      mockUpdate.mockImplementation((params: any) => {
        if (params.ExpressionAttributeValues?.[':phases']) {
          capturedPhases = params.ExpressionAttributeValues[':phases'];
        }
        return { promise: jest.fn().mockResolvedValue({}) };
      });

      const longMessage = 'This is a very long message that should be truncated to fit within the title limit nicely';
      await ensureGtmWorkItemForSlackSession({
        userId: mockUserId,
        sessionId: mockSessionId,
        rawMessage: longMessage,
      });

      // The last update should contain the work item with truncated title
      const lastPhases = capturedPhases;
      expect(lastPhases.length).toBeGreaterThan(0);
      const workItems = lastPhases[lastPhases.length - 1].workItems || [];
      expect(workItems.length).toBeGreaterThan(0);
      const workItem = workItems[workItems.length - 1];
      expect(workItem.title.length).toBeLessThanOrEqual(50);
      expect(workItem.title).toMatch(/\.\.\.$/);
    });

    it('should set adminEmail as dri for delegated sessions', async () => {
      mockQuery.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Items: [] }),
      });
      mockPut.mockReturnValue({
        promise: jest.fn().mockResolvedValue({}),
      });

      let capturedPhases: any[] = [];
      mockUpdate.mockImplementation((params: any) => {
        if (params.ExpressionAttributeValues?.[':phases']) {
          capturedPhases = params.ExpressionAttributeValues[':phases'];
        }
        return { promise: jest.fn().mockResolvedValue({}) };
      });

      await ensureGtmWorkItemForSlackSession({
        userId: mockUserId,
        sessionId: mockSessionId,
        rawMessage: 'Admin-initiated task',
        adminEmail: 'admin@example.com',
      });

      const lastPhases = capturedPhases;
      const workItems = lastPhases[lastPhases.length - 1].workItems || [];
      const workItem = workItems[workItems.length - 1];
      expect(workItem.dri).toBe('admin@example.com');
      expect(workItem.status).toBe('agent_in_progress');
      expect(workItem.agentSessionId).toBe(mockSessionId);
    });

    it('should return null on DynamoDB failure without throwing', async () => {
      mockQuery.mockReturnValue({
        promise: jest.fn().mockRejectedValue(new Error('DynamoDB connection error')),
      });

      const result = await ensureGtmWorkItemForSlackSession({
        userId: mockUserId,
        sessionId: mockSessionId,
        rawMessage: 'Test message',
      });

      expect(result).toBeNull();
    });

    it('should set work item status to agent_in_progress', async () => {
      const now = new Date();
      const day = now.getDay();
      const diff = day === 0 ? -6 : 1 - day;
      const monday = new Date(now);
      monday.setDate(now.getDate() + diff);
      monday.setHours(0, 0, 0, 0);
      const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      const phaseTitle = `Week of ${months[monday.getMonth()]} ${monday.getDate()}, ${monday.getFullYear()}`;

      const existingPlan = {
        planId: 'plan-existing',
        userId: mockUserId,
        title: 'Slack Agent Sessions',
        phases: [{
          id: 'phase-existing',
          title: phaseTitle,
          status: 'in_progress',
          workItems: [
            { id: 'item-old', title: 'Previous session', status: 'completed' },
          ],
        }],
      };

      mockQuery.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Items: [existingPlan] }),
      });

      let capturedPhases: any[] = [];
      mockUpdate.mockImplementation((params: any) => {
        if (params.ExpressionAttributeValues?.[':phases']) {
          capturedPhases = params.ExpressionAttributeValues[':phases'];
        }
        return { promise: jest.fn().mockResolvedValue({}) };
      });

      const result = await ensureGtmWorkItemForSlackSession({
        userId: mockUserId,
        sessionId: mockSessionId,
        rawMessage: 'New task',
      });

      expect(result).not.toBeNull();

      // Should have appended to existing work items, not replaced
      const phase = capturedPhases.find((p: any) => p.id === 'phase-existing');
      expect(phase.workItems).toHaveLength(2);
      expect(phase.workItems[0].id).toBe('item-old');
      expect(phase.workItems[1].status).toBe('agent_in_progress');
      expect(phase.workItems[1].agentSessionId).toBe(mockSessionId);
    });
  });
});
