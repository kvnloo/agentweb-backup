import { sendGTMPlanUpdateNotifications, sendPhaseStatusReport, sendPlanStatusReport } from '../services/gtmPlanNotificationService';
import { resendService } from '../services/resendService';
import { userDb } from '../services/db';

// Mock dependencies
jest.mock('../services/resendService', () => ({
  resendService: {
    sendSystemEmail: jest.fn(),
  },
}));

jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn(),
  },
}));

const mockResendService = resendService as jest.Mocked<typeof resendService>;
const mockUserDb = userDb as jest.Mocked<typeof userDb>;

describe('GTM Plan Notification Service', () => {
  const mockPlan = {
    planId: 'plan-1',
    userId: 'user-1',
    title: 'Test Plan',
    description: 'Test Description',
    dri: 'plan-poc@example.com',
    status: 'in_progress',
    phases: [
      {
        id: 'phase-1',
        title: 'Phase 1',
        dri: 'phase-poc@example.com',
        status: 'in_progress',
        workItems: [
          {
            id: 'item-1',
            title: 'Work Item 1',
            status: 'pending',
            dri: 'item-poc@example.com',
            notes: 'Test notes',
            dueDate: '2024-12-30',
          },
        ],
      },
    ],
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    
    mockResendService.sendSystemEmail = jest.fn().mockResolvedValue({ id: 'email-id' });
    mockUserDb.getUserById = jest.fn().mockResolvedValue({
      email: 'user1@example.com',
      name: 'User 1',
    } as any);
  });

  describe('Due Date Change Notifications', () => {
    it('should include due date change in notification when due date is set', async () => {
      const changes = {
        dueDate: '2024-12-31',
      };

      const notifications = {
        notifyUser: true,
      };

      await sendGTMPlanUpdateNotifications(
        mockPlan,
        'phase-1',
        'item-1',
        changes,
        notifications
      );

      expect(mockResendService.sendSystemEmail).toHaveBeenCalled();
      const callArgs = (mockResendService.sendSystemEmail as jest.Mock).mock.calls[0][0];
      
      // Check that the email body mentions due date change
      expect(callArgs.html).toContain('Due date set to');
      expect(callArgs.text).toContain('Due date set to');
      // Subject is "GTM Plan Update: [Plan Title]", change description is in body
      expect(callArgs.subject).toBe('GTM Plan Update: Test Plan');
    });

    it('should include due date removal in notification when due date is removed', async () => {
      const changes = {
        dueDate: null,
      };

      const notifications = {
        notifyUser: true,
      };

      await sendGTMPlanUpdateNotifications(
        mockPlan,
        'phase-1',
        'item-1',
        changes,
        notifications
      );

      expect(mockResendService.sendSystemEmail).toHaveBeenCalled();
      const callArgs = (mockResendService.sendSystemEmail as jest.Mock).mock.calls[0][0];
      
      // Check that the email body mentions due date removal
      expect(callArgs.html).toContain('Due date removed');
      expect(callArgs.text).toContain('Due date removed');
      // Subject is "GTM Plan Update: [Plan Title]", change description is in body
      expect(callArgs.subject).toBe('GTM Plan Update: Test Plan');
    });

    it('should format due date correctly in notification', async () => {
      const changes = {
        dueDate: '2024-12-31',
      };

      const notifications = {
        notifyUser: true,
      };

      await sendGTMPlanUpdateNotifications(
        mockPlan,
        'phase-1',
        'item-1',
        changes,
        notifications
      );

      expect(mockResendService.sendSystemEmail).toHaveBeenCalled();
      const callArgs = (mockResendService.sendSystemEmail as jest.Mock).mock.calls[0][0];
      
      // Check that the date is formatted as "December 31, 2024"
      expect(callArgs.html).toMatch(/December 31, 2024|Dec 31, 2024/i);
      expect(callArgs.text).toMatch(/December 31, 2024|Dec 31, 2024/i);
    });

    it('should combine due date change with other changes in notification', async () => {
      const changes = {
        status: 'completed',
        notes: 'Updated notes',
        dueDate: '2024-12-31',
      };

      const notifications = {
        notifyUser: true,
      };

      await sendGTMPlanUpdateNotifications(
        mockPlan,
        'phase-1',
        'item-1',
        changes,
        notifications
      );

      expect(mockResendService.sendSystemEmail).toHaveBeenCalled();
      const callArgs = (mockResendService.sendSystemEmail as jest.Mock).mock.calls[0][0];
      
      // Should mention all changes
      expect(callArgs.html).toContain('Status changed to: completed');
      expect(callArgs.html).toContain('Notes updated');
      expect(callArgs.html).toContain('Due date set to');
    });

    it('should not send notification if due date change is the only change but no notifications requested', async () => {
      const changes = {
        dueDate: '2024-12-31',
      };

      const notifications = {
        notifyUser: false,
        notifyItemPoc: false,
        notifyPhasePoc: false,
        notifyPlanPoc: false,
      };

      await sendGTMPlanUpdateNotifications(
        mockPlan,
        'phase-1',
        'item-1',
        changes,
        notifications
      );

      expect(mockResendService.sendSystemEmail).not.toHaveBeenCalled();
    });

    it('should send notification to all selected recipients when due date changes', async () => {
      const changes = {
        dueDate: '2024-12-31',
      };

      const notifications = {
        notifyUser: true,
        notifyItemPoc: true,
        notifyPhasePoc: true,
        notifyPlanPoc: true,
      };

      await sendGTMPlanUpdateNotifications(
        mockPlan,
        'phase-1',
        'item-1',
        changes,
        notifications
      );

      // Should send to user, plan PoC, phase PoC, and item PoC
      expect(mockResendService.sendSystemEmail).toHaveBeenCalledTimes(4);
      
      const emails = (mockResendService.sendSystemEmail as jest.Mock).mock.calls.map(
        (call) => call[0].to
      );
      
      expect(emails).toContain('user1@example.com');
      expect(emails).toContain('plan-poc@example.com');
      expect(emails).toContain('phase-poc@example.com');
      expect(emails).toContain('item-poc@example.com');
    });
  });

  describe('Phase Status Report - Description and Notes', () => {
    const mockPlanWithDetails = {
      planId: 'plan-1',
      userId: 'user-1',
      title: 'Test Plan',
      description: 'Test Description',
      dri: 'plan-poc@example.com',
      status: 'in_progress',
      phases: [
        {
          id: 'phase-1',
          title: 'Phase 1',
          dri: 'phase-poc@example.com',
          status: 'in_progress',
          workItems: [
            {
              id: 'item-1',
              title: 'Work Item 1',
              description: 'Detailed task description',
              status: 'pending',
              dri: 'item-poc@example.com',
              notes: 'Important progress notes',
              dueDate: '2024-12-30',
            },
            {
              id: 'item-2',
              title: 'Work Item 2',
              status: 'completed',
              dri: 'item-poc2@example.com',
              dueDate: '2024-12-31',
            },
          ],
        },
      ],
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    };

    it('should include work item description and notes in phase status report email', async () => {
      await sendPhaseStatusReport(
        mockPlanWithDetails,
        'phase-1',
        { notifyPhasePoc: true },
      );

      expect(mockResendService.sendSystemEmail).toHaveBeenCalled();
      const callArgs = (mockResendService.sendSystemEmail as jest.Mock).mock.calls[0][0];

      // HTML should contain description under title and notes column
      expect(callArgs.html).toContain('Detailed task description');
      expect(callArgs.html).toContain('Important progress notes');

      // Plain text should also contain them
      expect(callArgs.text).toContain('Detailed task description');
      expect(callArgs.text).toContain('Important progress notes');
    });

    it('should show dash for items without description or notes in phase status report', async () => {
      await sendPhaseStatusReport(
        mockPlanWithDetails,
        'phase-1',
        { notifyPhasePoc: true },
      );

      expect(mockResendService.sendSystemEmail).toHaveBeenCalled();
      const callArgs = (mockResendService.sendSystemEmail as jest.Mock).mock.calls[0][0];

      // Item 2 has no description or notes - HTML should have dashes in those cells
      // The notes column for item 2 should render '-'
      expect(callArgs.html).toContain('Work Item 2');
    });
  });

  describe('Plan Status Report - Description and Notes', () => {
    const mockPlanWithMultiplePhases = {
      planId: 'plan-1',
      userId: 'user-1',
      title: 'Test Plan',
      description: 'Test Description',
      dri: 'plan-poc@example.com',
      status: 'in_progress',
      phases: [
        {
          id: 'phase-1',
          title: 'Phase 1',
          dri: 'phase-poc@example.com',
          status: 'in_progress',
          workItems: [
            {
              id: 'item-1',
              title: 'Research Task',
              description: 'Research competitor landscape',
              status: 'completed',
              notes: 'Found 5 key competitors',
              dueDate: '2024-12-30',
            },
          ],
        },
        {
          id: 'phase-2',
          title: 'Phase 2',
          dri: 'phase2-poc@example.com',
          status: 'in_progress',
          workItems: [
            {
              id: 'item-2',
              title: 'Launch Campaign',
              description: 'Execute the marketing campaign',
              status: 'pending',
              dueDate: '2025-01-15',
            },
          ],
        },
      ],
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    };

    it('should include work item descriptions and notes in plan status report email', async () => {
      await sendPlanStatusReport(
        mockPlanWithMultiplePhases,
        { notifyPlanPoc: true },
      );

      expect(mockResendService.sendSystemEmail).toHaveBeenCalled();
      const callArgs = (mockResendService.sendSystemEmail as jest.Mock).mock.calls[0][0];

      // HTML should contain descriptions and notes from both phases
      expect(callArgs.html).toContain('Research competitor landscape');
      expect(callArgs.html).toContain('Found 5 key competitors');
      expect(callArgs.html).toContain('Execute the marketing campaign');

      // Plain text should also contain them
      expect(callArgs.text).toContain('Research competitor landscape');
      expect(callArgs.text).toContain('Found 5 key competitors');
      expect(callArgs.text).toContain('Execute the marketing campaign');
    });
  });

  describe('Combined Change Notifications', () => {
    it('should correctly describe multiple changes including due date', async () => {
      const changes = {
        status: 'completed',
        notes: 'New notes',
        dri: 'new-poc@example.com',
        dueDate: '2024-12-31',
      };

      const notifications = {
        notifyUser: true,
      };

      await sendGTMPlanUpdateNotifications(
        mockPlan,
        'phase-1',
        'item-1',
        changes,
        notifications
      );

      expect(mockResendService.sendSystemEmail).toHaveBeenCalled();
      const callArgs = (mockResendService.sendSystemEmail as jest.Mock).mock.calls[0][0];
      
      const changeDescription = callArgs.html;
      
      // Should mention all changes
      expect(changeDescription).toContain('Status changed to: completed');
      expect(changeDescription).toContain('Notes updated');
      expect(changeDescription).toContain('PoC assigned to: new-poc@example.com');
      expect(changeDescription).toContain('Due date set to');
    });

    it('should prioritize due date change description over generic "Work item updated"', async () => {
      const changes = {
        dueDate: '2024-12-31',
      };

      const notifications = {
        notifyUser: true,
      };

      await sendGTMPlanUpdateNotifications(
        mockPlan,
        'phase-1',
        'item-1',
        changes,
        notifications
      );

      expect(mockResendService.sendSystemEmail).toHaveBeenCalled();
      const callArgs = (mockResendService.sendSystemEmail as jest.Mock).mock.calls[0][0];
      
      // Should explicitly state due date change in body, not generic "Work item updated"
      expect(callArgs.html).not.toContain('Work item updated');
      expect(callArgs.html).toContain('Due date set to');
      expect(callArgs.text).toContain('Due date set to');
      // Subject is "GTM Plan Update: [Plan Title]"
      expect(callArgs.subject).toBe('GTM Plan Update: Test Plan');
    });
  });
});
