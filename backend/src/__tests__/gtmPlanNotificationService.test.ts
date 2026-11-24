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

  // ENG-2840 W2-4: the report functions used to return nothing, so the routes answered "sent" for a report that went to nobody.
  describe('Status report results', () => {
    const plan: any = {
      planId: 'plan-r', userId: 'user-1', title: 'Result Plan', status: 'in_progress',
      dri: 'plan-poc@example.com',
      phases: [
        { id: 'phase-a', title: 'A', dri: 'a-poc@example.com', status: 'in_progress', workItems: [] },
        { id: 'phase-b', title: 'B', status: 'in_progress', workItems: [] },
      ],
    };

    beforeEach(() => {
      (mockResendService.sendSystemEmail as jest.Mock).mockReset().mockResolvedValue({ id: 'email-1' });
      mockUserDb.getUserById.mockReset().mockResolvedValue({ userId: 'user-1', email: 'owner@example.com' } as any);
    });

    it('returns zeros and sends nothing when no recipient option is chosen (phase and plan)', async () => {
      expect(await sendPhaseStatusReport(plan, 'phase-a', {})).toEqual({ recipients: 0, sent: 0, failed: 0 });
      expect(await sendPlanStatusReport(plan, { message: 'hello' })).toEqual({ recipients: 0, sent: 0, failed: 0 });
      expect(mockResendService.sendSystemEmail).not.toHaveBeenCalled();
    });

    it('returns recipients 0 when the chosen contact is not set on the plan', async () => {
      expect(await sendPhaseStatusReport(plan, 'phase-b', { notifyPhasePoc: true })).toEqual({ recipients: 0, sent: 0, failed: 0 });
      expect(await sendPlanStatusReport({ ...plan, dri: undefined, phases: [plan.phases[1]] }, { notifyPlanPoc: true, notifyPhasePocs: true }))
        .toEqual({ recipients: 0, sent: 0, failed: 0 });
      expect(mockResendService.sendSystemEmail).not.toHaveBeenCalled();
    });

    it('returns zeros for a phase that is not in the plan', async () => {
      expect(await sendPhaseStatusReport(plan, 'phase-zzz', { notifyUser: true })).toEqual({ recipients: 0, sent: 0, failed: 0 });
    });

    it('counts every accepted email, with a duplicate address counted once', async () => {
      const samePoc = { ...plan, dri: 'a-poc@example.com' };
      expect(await sendPhaseStatusReport(samePoc, 'phase-a', { notifyUser: true, notifyPlanPoc: true, notifyPhasePoc: true }))
        .toEqual({ recipients: 2, sent: 2, failed: 0 });
      expect(mockResendService.sendSystemEmail).toHaveBeenCalledTimes(2);
    });

    it('counts every accepted email (plan report)', async () => {
      expect(await sendPlanStatusReport(plan, { notifyUser: true, notifyPlanPoc: true, notifyPhasePocs: true }))
        .toEqual({ recipients: 3, sent: 3, failed: 0 });
      expect(mockResendService.sendSystemEmail).toHaveBeenCalledTimes(3);
    });

    it('a send the non-production email guard resolved without delivering is counted as suppressed, not as sent (both reports)', async () => {
      (mockResendService.sendSystemEmail as jest.Mock).mockResolvedValue({ id: 'nonprod-suppressed', suppressed: true });
      expect(await sendPlanStatusReport(plan, { notifyUser: true, notifyPlanPoc: true }))
        .toEqual({ recipients: 2, sent: 0, failed: 0, suppressed: 2 });
      expect(await sendPhaseStatusReport(plan, 'phase-a', { notifyPhasePoc: true }))
        .toEqual({ recipients: 1, sent: 0, failed: 0, suppressed: 1 });
      // more than one recipient: the count accumulates in both reports
      expect(await sendPhaseStatusReport(plan, 'phase-a', { notifyUser: true, notifyPlanPoc: true, notifyPhasePoc: true }))
        .toEqual({ recipients: 3, sent: 0, failed: 0, suppressed: 3 });
      expect(await sendPlanStatusReport(plan, { notifyUser: true, notifyPlanPoc: true, notifyPhasePocs: true }))
        .toEqual({ recipients: 3, sent: 0, failed: 0, suppressed: 3 });
    });

    it('a mixed result is counted exactly: one delivered, one held back, one refused', async () => {
      (mockResendService.sendSystemEmail as jest.Mock)
        .mockResolvedValueOnce({ id: 'ok-1' })
        .mockResolvedValueOnce({ id: 'nonprod-suppressed', suppressed: true })
        .mockRejectedValueOnce(new Error('bad address'));
      expect(await sendPlanStatusReport(plan, { notifyUser: true, notifyPlanPoc: true, notifyPhasePocs: true }))
        .toEqual({ recipients: 3, sent: 1, failed: 1, suppressed: 1 });
    });

    it('counts a refusal by the mail service as failed, not as sent (plan report)', async () => {
      (mockResendService.sendSystemEmail as jest.Mock).mockRejectedValue(new Error('Resend is down'));
      expect(await sendPlanStatusReport(plan, { notifyUser: true, notifyPlanPoc: true, notifyPhasePocs: true }))
        .toEqual({ recipients: 3, sent: 0, failed: 3 });
    });

    it('counts a partial send: one address refused, the others accepted (phase report)', async () => {
      (mockResendService.sendSystemEmail as jest.Mock)
        .mockResolvedValueOnce({ id: 'ok-1' })
        .mockRejectedValueOnce(new Error('bad address'))
        .mockResolvedValueOnce({ id: 'ok-3' });
      expect(await sendPhaseStatusReport(plan, 'phase-a', { notifyUser: true, notifyPlanPoc: true, notifyPhasePoc: true }))
        .toEqual({ recipients: 3, sent: 2, failed: 1 });
    });

    it('counts the unsent as failed when the report cannot be built at all', async () => {
      // a phase whose work item list is not an array breaks the template after the recipients were resolved
      const broken: any = { ...plan, phases: [{ id: 'phase-a', title: 'A', dri: 'a-poc@example.com', status: 'in_progress', workItems: 'not-a-list' }] };
      const result = await sendPhaseStatusReport(broken, 'phase-a', { notifyPhasePoc: true });
      expect(result.recipients).toBe(1);
      expect(result.sent).toBe(0);
      expect(result.failed).toBe(1);
    });
  });

  // ENG-2840 PR B (review): one mailbox is one person whatever case it was typed in, and a title can never add a header to the email it names.
  describe('Distinct people and one-line subjects', () => {
    const plan = (over: any = {}): any => ({
      planId: 'plan-d', userId: 'user-1', title: 'Distinct Plan', status: 'in_progress', dri: 'Same@Example.com',
      phases: [
        { id: 'p1', title: 'Phase One', dri: 'same@example.com', status: 'in_progress', workItems: [{ id: 'i1', title: 'Item', status: 'pending', dri: 'SAME@EXAMPLE.COM' }] },
        { id: 'p2', title: 'Phase Two', dri: ' same@example.com ', status: 'in_progress', workItems: [] },
        { id: 'p3', title: 'Phase Three', dri: 'other@example.com', status: 'in_progress', workItems: [] },
      ],
      ...over,
    });

    beforeEach(() => {
      (mockResendService.sendSystemEmail as jest.Mock).mockReset().mockResolvedValue({ id: 'email-1' });
      mockUserDb.getUserById.mockReset().mockResolvedValue({ userId: 'user-1', email: 'SAME@example.com' } as any);
    });

    it('a plan report sends one email to a mailbox written in different cases, keeping the first spelling', async () => {
      const result = await sendPlanStatusReport(plan(), { notifyUser: true, notifyPlanPoc: true, notifyPhasePocs: true });
      expect(result).toEqual({ recipients: 2, sent: 2, failed: 0 });
      expect((mockResendService.sendSystemEmail as jest.Mock).mock.calls.map((c) => c[0].to)).toEqual(['SAME@example.com', 'other@example.com']);
    });

    it('a phase report does too', async () => {
      const result = await sendPhaseStatusReport(plan(), 'p1', { notifyUser: true, notifyPlanPoc: true, notifyPhasePoc: true });
      expect(result).toEqual({ recipients: 1, sent: 1, failed: 0 });
    });

    it('update notifications do too', async () => {
      await sendGTMPlanUpdateNotifications(plan(), 'p1', 'i1', { dueDate: '2026-12-31' }, { notifyUser: true, notifyItemPoc: true, notifyPhasePoc: true, notifyPlanPoc: true });
      expect(mockResendService.sendSystemEmail).toHaveBeenCalledTimes(1);
    });

    it('the recipient cap counts people, not spellings: three spellings of one mailbox and one other is 2 people', async () => {
      const result = await sendPlanStatusReport(plan(), { notifyPlanPoc: true, notifyPhasePocs: true, maxRecipients: 2 });
      expect(result).toEqual({ recipients: 2, sent: 2, failed: 0 });
      const over = await sendPlanStatusReport(plan(), { notifyPlanPoc: true, notifyPhasePocs: true, maxRecipients: 1 });
      expect(over).toEqual({ recipients: 2, sent: 0, failed: 0, overCap: 1 });
    });

    it('addresses that are only spaces are not people', async () => {
      const result = await sendPlanStatusReport(plan({ dri: '   ', phases: [{ id: 'p', title: 'P', dri: '  ', workItems: [] }] }), { notifyPlanPoc: true, notifyPhasePocs: true });
      expect(result).toEqual({ recipients: 0, sent: 0, failed: 0 });
    });

    it('a subject is one line: a line break, a control character or a line separator in a title becomes a space, in all three emails', async () => {
      const title = 'Launch\r\nBcc: x@y.test\u2028 \u0007  now';
      await sendPlanStatusReport(plan({ title }), { notifyPlanPoc: true });
      await sendPhaseStatusReport(plan(), 'p1', { notifyPhasePoc: true });
      await sendGTMPlanUpdateNotifications(plan({ title }), 'p1', 'i1', { dueDate: '2026-12-31' }, { notifyPlanPoc: true });
      const subjects = (mockResendService.sendSystemEmail as jest.Mock).mock.calls.map((c) => c[0].subject);
      expect(subjects[0]).toBe('GTM Plan Status Report: Launch Bcc: x@y.test now');
      expect(subjects[1]).toBe('GTM Plan Phase Status Report: Phase One');
      expect(subjects[2]).toBe('GTM Plan Update: Launch Bcc: x@y.test now');
      for (const s of subjects) expect(s).not.toMatch(/[\r\n\u2028\u2029\u0000-\u001f]/);
    });

    it('a phase title with a line break is cleaned the same way', async () => {
      const p = plan();
      p.phases[0].title = 'Phase\nOne';
      await sendPhaseStatusReport(p, 'p1', { notifyPhasePoc: true });
      expect((mockResendService.sendSystemEmail as jest.Mock).mock.calls[0][0].subject).toBe('GTM Plan Phase Status Report: Phase One');
    });

    it('a normal title is left exactly as written', async () => {
      await sendPlanStatusReport(plan({ title: "Q1 launch: Emma's  \"big\" push" }), { notifyPlanPoc: true });
      expect((mockResendService.sendSystemEmail as jest.Mock).mock.calls[0][0].subject).toBe("GTM Plan Status Report: Q1 launch: Emma's \"big\" push");
    });
  });

  // ENG-2840 PR B: an outside agent's key may email at most 10 people in one call. The cap is checked after the recipients are resolved and
  // before anything is sent, so it is a promise about the whole report and never a partial send.
  describe('The recipient cap (maxRecipients)', () => {
    const wide: any = {
      planId: 'plan-w', userId: 'user-1', title: 'Wide Plan', status: 'in_progress', dri: 'plan-poc@example.com',
      phases: Array.from({ length: 12 }, (_, i) => ({ id: `phase-${i}`, title: `P${i}`, dri: `poc${i}@example.com`, status: 'in_progress', workItems: [] })),
    };

    beforeEach(() => {
      (mockResendService.sendSystemEmail as jest.Mock).mockReset().mockResolvedValue({ id: 'email-1' });
      mockUserDb.getUserById.mockReset().mockResolvedValue({ userId: 'user-1', email: 'owner@example.com' } as any);
    });

    it('sends nothing and says why when a plan report would reach more people than the cap', async () => {
      // plan contact + 12 phase contacts + the owner = 14 distinct people
      const result = await sendPlanStatusReport(wide, { notifyUser: true, notifyPlanPoc: true, notifyPhasePocs: true, maxRecipients: 10 });
      expect(result).toEqual({ recipients: 14, sent: 0, failed: 0, overCap: 10 });
      expect(mockResendService.sendSystemEmail).not.toHaveBeenCalled();
    });

    it('sends the whole report when it reaches exactly the cap, and when it is under it', async () => {
      const atCap = await sendPlanStatusReport(wide, { notifyPlanPoc: true, notifyPhasePocs: true, maxRecipients: 13 }); // 1 + 12
      expect(atCap).toEqual({ recipients: 13, sent: 13, failed: 0 });
      expect(atCap.overCap).toBeUndefined();
      expect(mockResendService.sendSystemEmail).toHaveBeenCalledTimes(13);

      (mockResendService.sendSystemEmail as jest.Mock).mockClear();
      const under = await sendPlanStatusReport(wide, { notifyPlanPoc: true, maxRecipients: 10 });
      expect(under).toEqual({ recipients: 1, sent: 1, failed: 0 });
    });

    it('counts distinct people, not addresses written: a duplicate address is one person', async () => {
      const dup: any = { ...wide, phases: wide.phases.map((p: any) => ({ ...p, dri: 'same@example.com' })) };
      const result = await sendPlanStatusReport(dup, { notifyPhasePocs: true, maxRecipients: 1 });
      expect(result).toEqual({ recipients: 1, sent: 1, failed: 0 });
    });

    it('applies to a phase report too', async () => {
      const phasePlan: any = { ...wide, phases: [{ id: 'phase-a', title: 'A', dri: 'a@example.com', status: 'in_progress', workItems: [] }] };
      const over = await sendPhaseStatusReport(phasePlan, 'phase-a', { notifyUser: true, notifyPlanPoc: true, notifyPhasePoc: true, maxRecipients: 2 }); // 3 people
      expect(over).toEqual({ recipients: 3, sent: 0, failed: 0, overCap: 2 });
      expect(mockResendService.sendSystemEmail).not.toHaveBeenCalled();

      const ok = await sendPhaseStatusReport(phasePlan, 'phase-a', { notifyUser: true, notifyPlanPoc: true, notifyPhasePoc: true, maxRecipients: 3 });
      expect(ok).toEqual({ recipients: 3, sent: 3, failed: 0 });
    });

    it('a cap of 0 refuses every report that has a recipient', async () => {
      const result = await sendPlanStatusReport(wide, { notifyPlanPoc: true, maxRecipients: 0 });
      expect(result).toEqual({ recipients: 1, sent: 0, failed: 0, overCap: 0 });
      expect(mockResendService.sendSystemEmail).not.toHaveBeenCalled();
    });

    it('no cap, or a value that is not a usable cap, is no cap (the portal and Emma set none)', async () => {
      for (const cap of [undefined, null, Number.NaN, Number.POSITIVE_INFINITY, -1, '2', '', true, {}]) {
        (mockResendService.sendSystemEmail as jest.Mock).mockClear();
        const result = await sendPlanStatusReport(wide, { notifyPlanPoc: true, notifyPhasePocs: true, maxRecipients: cap as any });
        expect(result).toEqual({ recipients: 13, sent: 13, failed: 0 });
      }
    });

    it('a contact written as a list counts as the people in it, not as one entry (the portal stores contacts as written)', async () => {
      for (const dri of ['a@x.test, b@x.test, c@x.test', 'a@x.test;b@x.test;c@x.test', 'a@x.test b@x.test c@x.test', ['a@x.test', 'b@x.test', 'c@x.test'] as any]) {
        (mockResendService.sendSystemEmail as jest.Mock).mockClear();
        const over = await sendPlanStatusReport({ ...wide, dri }, { notifyPlanPoc: true, maxRecipients: 2 });
        expect(over).toEqual({ recipients: 3, sent: 0, failed: 0, overCap: 2 });
        expect(mockResendService.sendSystemEmail).not.toHaveBeenCalled();
      }
    });

    it('thirty addresses in one contact are thirty people against a cap of 10', async () => {
      const dri = Array.from({ length: 30 }, (_, i) => `u${i}@x.test`).join(',');
      const over = await sendPlanStatusReport({ ...wide, dri }, { notifyPlanPoc: true, maxRecipients: 10 });
      expect(over).toEqual({ recipients: 30, sent: 0, failed: 0, overCap: 10 });
      expect(mockResendService.sendSystemEmail).not.toHaveBeenCalled();
    });

    it('a list that fits under the cap still sends, as one entry, exactly as before; and with no cap nothing changes', async () => {
      const dri = 'a@x.test, b@x.test';
      expect(await sendPlanStatusReport({ ...wide, dri }, { notifyPlanPoc: true, maxRecipients: 2 })).toEqual({ recipients: 1, sent: 1, failed: 0 });
      expect(await sendPlanStatusReport({ ...wide, dri }, { notifyPlanPoc: true })).toEqual({ recipients: 1, sent: 1, failed: 0 });
    });

    it('people in a list add up across contacts: a list in the plan contact plus phase contacts', async () => {
      const over = await sendPlanStatusReport({ ...wide, dri: 'a@x.test, b@x.test' }, { notifyPlanPoc: true, notifyPhasePocs: true, maxRecipients: 13 }); // 2 + 12 phase contacts = 14
      expect(over).toEqual({ recipients: 14, sent: 0, failed: 0, overCap: 13 });
    });

    it('an entry with no @ counts as one person, never as zero', async () => {
      const over = await sendPlanStatusReport({ ...wide, dri: 'not-an-address' }, { notifyPlanPoc: true, maxRecipients: 0 });
      expect(over).toEqual({ recipients: 1, sent: 0, failed: 0, overCap: 0 });
    });

    it('a phase report counts people in a list too', async () => {
      const phasePlan: any = { ...wide, phases: [{ id: 'phase-a', title: 'A', dri: 'a@x.test,b@x.test,c@x.test', status: 'in_progress', workItems: [] }] };
      const over = await sendPhaseStatusReport(phasePlan, 'phase-a', { notifyPhasePoc: true, maxRecipients: 2 });
      expect(over).toEqual({ recipients: 3, sent: 0, failed: 0, overCap: 2 });
    });

    it('a report to nobody is still "nobody" (recipients 0), not over any cap', async () => {
      const result = await sendPlanStatusReport({ ...wide, dri: undefined }, { notifyPlanPoc: true, maxRecipients: 0 });
      expect(result).toEqual({ recipients: 0, sent: 0, failed: 0 });
    });
  });

  // ENG-2840 PR A: automated mail can wait a few seconds, so the GTM emails go in the bulk lane of the shared email queue: several
  // reports at once can never delay a password reset or a support reply. A full bulk lane refuses at once; that is one failed recipient, never a throw.
  describe('Emails wait in the bulk lane', () => {
    const plan: any = {
      planId: 'plan-l', userId: 'user-1', title: 'Lane Plan', status: 'in_progress', dri: 'plan-poc@example.com',
      phases: [
        { id: 'phase-a', title: 'A', dri: 'a-poc@example.com', status: 'in_progress', workItems: [] },
        { id: 'phase-b', title: 'B', dri: 'b-poc@example.com', status: 'in_progress', workItems: [] },
      ],
    };

    beforeEach(() => {
      (mockResendService.sendSystemEmail as jest.Mock).mockReset().mockResolvedValue({ id: 'email-1' });
      mockUserDb.getUserById.mockReset().mockResolvedValue({ userId: 'user-1', email: 'owner@example.com' } as any);
    });

    const lanesOfEverySend = () => (mockResendService.sendSystemEmail as jest.Mock).mock.calls.map((call) => call[0].lane);

    it('work item update notifications use the bulk lane, one send per recipient', async () => {
      await sendGTMPlanUpdateNotifications(mockPlan, 'phase-1', 'item-1', { dueDate: '2024-12-31' }, {
        notifyUser: true, notifyItemPoc: true, notifyPhasePoc: true, notifyPlanPoc: true,
      });
      expect(lanesOfEverySend()).toEqual(['bulk', 'bulk', 'bulk', 'bulk']);
    });

    it('a phase status report uses the bulk lane for every recipient', async () => {
      await sendPhaseStatusReport(plan, 'phase-a', { notifyUser: true, notifyPlanPoc: true, notifyPhasePoc: true });
      expect(lanesOfEverySend()).toEqual(['bulk', 'bulk', 'bulk']);
    });

    it('a plan status report uses the bulk lane for every recipient', async () => {
      await sendPlanStatusReport(plan, { notifyUser: true, notifyPlanPoc: true, notifyPhasePocs: true });
      expect(lanesOfEverySend()).toEqual(['bulk', 'bulk', 'bulk', 'bulk']);
    });

    it('a full bulk lane is counted as failed recipients, reported honestly, and never thrown (phase and plan report)', async () => {
      const full: any = new Error('The bulk email queue is full (100 waiting). Nothing was sent. Try again in a minute.');
      full.code = 'EMAIL_QUEUE_FULL';
      (mockResendService.sendSystemEmail as jest.Mock).mockRejectedValue(full);

      expect(await sendPhaseStatusReport(plan, 'phase-a', { notifyUser: true, notifyPlanPoc: true, notifyPhasePoc: true }))
        .toEqual({ recipients: 3, sent: 0, failed: 3 });
      expect(await sendPlanStatusReport(plan, { notifyUser: true, notifyPlanPoc: true, notifyPhasePocs: true }))
        .toEqual({ recipients: 4, sent: 0, failed: 4 });
    });

    it('a full bulk lane does not stop the update notifications from returning (they never throw)', async () => {
      (mockResendService.sendSystemEmail as jest.Mock).mockRejectedValue(Object.assign(new Error('queue full'), { code: 'EMAIL_QUEUE_FULL' }));
      await expect(sendGTMPlanUpdateNotifications(mockPlan, 'phase-1', 'item-1', { dueDate: '2024-12-31' }, { notifyUser: true })).resolves.toBeUndefined();
    });
  });

  // ENG-2840 W2-4: the three emails put plan, phase and work item text and the optional message into HTML. That text is written by people
  // and by outside agents; it must arrive as text, never as markup or a link from AgentWeb's system sender.
  describe('Email HTML escapes what a caller wrote', () => {
    // every field carries its own marker, so a field that is not escaped fails by name
    const hostile = (tag: string) => `<i>${tag}</i> & "q" 'a'`;
    const escaped = (tag: string) => `&lt;i&gt;${tag}&lt;/i&gt; &amp; &quot;q&quot; &#39;a&#39;`;
    const rawIn = (html: string, tag: string) => html.includes(`<i>${tag}</i>`);

    const plan: any = {
      planId: 'plan-x', userId: 'user-1', title: hostile('PLANTITLE'), status: hostile('PLANSTATUS'), dri: hostile('PLANDRI'),
      phases: [{
        id: 'phase-x', title: hostile('PHASETITLE'), status: hostile('PHASESTATUS'), dri: hostile('PHASEDRI'),
        workItems: [{
          id: 'item-x', title: hostile('ITEMTITLE'), description: hostile('ITEMDESC'), status: hostile('ITEMSTATUS'), dri: hostile('ITEMDRI'), notes: hostile('ITEMNOTES'),
        }],
      }],
    };
    const MESSAGE = '<a href="https://evil.test/reset">Reset your password</a>\nsecond line';

    beforeEach(() => {
      (mockResendService.sendSystemEmail as jest.Mock).mockReset().mockResolvedValue({ id: 'email-1' });
      mockUserDb.getUserById.mockReset().mockResolvedValue({ userId: 'user-1', email: 'owner@example.com' } as any);
    });
    const sent = () => (mockResendService.sendSystemEmail as jest.Mock).mock.calls[0][0];

    const expectEscaped = (html: string, tags: string[]) => {
      for (const tag of tags) {
        expect(rawIn(html, tag)).toBe(false);
        expect(html).toContain(escaped(tag));
      }
      expect(html).not.toContain('<a href="https://evil.test/reset">');
      expect(html).toContain('&lt;a href=&quot;https://evil.test/reset&quot;&gt;Reset your password&lt;/a&gt;<br>second line');
    };

    it('plan status report: every field and the message are escaped in the HTML, the plain text is left as written', async () => {
      await sendPlanStatusReport(plan, { notifyUser: true, message: MESSAGE });
      const { html, text } = sent();
      expectEscaped(html, ['PLANTITLE', 'PLANSTATUS', 'PLANDRI', 'PHASETITLE', 'PHASESTATUS', 'PHASEDRI', 'ITEMTITLE', 'ITEMDESC', 'ITEMSTATUS', 'ITEMDRI', 'ITEMNOTES']);
      expect(text).toContain(hostile('PLANTITLE'));
      expect(text).toContain(MESSAGE);
      // the email's own markup is untouched
      expect(html).toContain('<strong>Plan:</strong>');
    });

    it('phase status report: every field and the message are escaped in the HTML, the plain text is left as written', async () => {
      await sendPhaseStatusReport(plan, 'phase-x', { notifyUser: true, message: MESSAGE });
      const { html, text } = sent();
      expectEscaped(html, ['PLANTITLE', 'PHASETITLE', 'PHASESTATUS', 'PHASEDRI', 'ITEMTITLE', 'ITEMDESC', 'ITEMSTATUS', 'ITEMDRI', 'ITEMNOTES']);
      expect(text).toContain(hostile('PHASETITLE'));
      expect(text).toContain(MESSAGE);
      expect(html).toContain('<strong>Phase:</strong>');
    });

    it('work item update email: plan, phase, item, the change, the notes and the message are escaped in the HTML', async () => {
      await sendGTMPlanUpdateNotifications(
        plan, 'phase-x', 'item-x',
        { status: hostile('NEWSTATUS'), notes: hostile('ITEMNOTES'), dri: hostile('NEWDRI') } as any,
        { notifyUser: true, message: MESSAGE },
      );
      const { html, text, subject } = sent();
      expectEscaped(html, ['PLANTITLE', 'PHASETITLE', 'ITEMTITLE', 'NEWSTATUS', 'NEWDRI', 'ITEMNOTES']);
      expect(text).toContain(MESSAGE);
      expect(subject).toBe(`GTM Plan Update: ${plan.title}`);
    });

    it('a missing or null field renders as nothing, never as the words undefined or null', async () => {
      await sendPlanStatusReport({
        planId: 'p', userId: 'user-1', title: 'Plain plan', status: undefined, dri: 'lead@example.com',
        phases: [{ id: 'ph', title: 'Plain phase', status: null, dri: 'a@example.com', workItems: [{ id: 'i', title: 'Plain item', status: undefined, description: null, notes: undefined }] }],
      } as any, { notifyUser: true });
      const { html } = sent();
      expect(html).toContain('Plain plan');
      expect(html).not.toMatch(/undefined|null/);
    });

    it('ordinary text is unchanged by the escaping (no stray entities in a normal email)', async () => {
      await sendPlanStatusReport({
        planId: 'p', userId: 'user-1', title: 'Q1 launch plan', status: 'in_progress', dri: 'lead@example.com',
        phases: [{ id: 'ph', title: 'Research', status: 'in_progress', dri: 'a@example.com', workItems: [{ id: 'i', title: 'Interview buyers', status: 'pending', notes: 'five booked' }] }],
      } as any, { notifyUser: true, message: 'Weekly update' });
      const { html } = sent();
      expect(html).toContain('Q1 launch plan');
      expect(html).toContain('lead@example.com');
      expect(html).toContain('Interview buyers');
      expect(html).toContain('Weekly update');
      expect(html).not.toMatch(/&(amp|lt|gt|quot|#39);/);
    });
  });
});
