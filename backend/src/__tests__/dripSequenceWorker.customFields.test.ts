/**
 * Tests that lead custom fields ({{customFields.xxx}}) are substituted into
 * sequence emails AND LinkedIn messages.
 *
 * NOTE: emailVariables is intentionally NOT mocked here — we use the real
 * substituteVariables so the test actually exercises variable replacement.
 */

import { processDueEnrollments } from '../services/dripSequenceWorker';

jest.mock('../services/dripSequenceDb', () => ({
  dripSequenceDb: {
    getAllDueEnrollments: jest.fn(),
    getSequence: jest.fn(),
    exitEnrollment: jest.fn(),
    completeEnrollment: jest.fn(),
    advanceEnrollment: jest.fn(),
    snoozeEnrollment: jest.fn(),
    setEnrollmentLinkedInProviderId: jest.fn(),
  },
}));

jest.mock('../services/resendService', () => ({
  resendService: { sendEmail: jest.fn() },
}));

jest.mock('../services/linkedInOutreachService', () => ({
  linkedInOutreachService: {
    resolveAccountId: jest.fn(),
    resolveProviderId: jest.fn(),
    sendMessage: jest.fn(),
    getMessagesWithContact: jest.fn(),
  },
}));

jest.mock('../services/db', () => ({
  crmDb: { getLeadById: jest.fn() },
  userDb: { getUserById: jest.fn() },
}));

jest.mock('../services/emailEventsDb', () => ({
  emailEventsDb: { getEventsByEmailDomainAndLeadEmail: jest.fn() },
}));

jest.mock('../services/settingsService', () => ({
  settingsService: { getSetting: jest.fn() },
}));

// emailVariables is NOT mocked — real substitution is the behavior under test.

import { dripSequenceDb } from '../services/dripSequenceDb';
import { resendService } from '../services/resendService';
import { linkedInOutreachService } from '../services/linkedInOutreachService';
import { crmDb, userDb } from '../services/db';
import { emailEventsDb } from '../services/emailEventsDb';

const mockDripSequenceDb = dripSequenceDb as jest.Mocked<typeof dripSequenceDb>;
const mockResendService = resendService as jest.Mocked<typeof resendService>;
const mockLinkedIn = linkedInOutreachService as jest.Mocked<typeof linkedInOutreachService>;
const mockCrmDb = crmDb as jest.Mocked<typeof crmDb>;
const mockUserDb = userDb as jest.Mocked<typeof userDb>;
const mockEmailEventsDb = emailEventsDb as jest.Mocked<typeof emailEventsDb>;

const baseEnrollment = {
  enrollmentId: 'enroll-1',
  sequenceId: 'seq-1',
  leadId: 'lead-1',
  listId: 'list-1',
  leadEmail: 'lead@example.com',
  userId: 'user-1',
  currentStep: 0,
  status: 'active',
  enrolledAt: '2026-01-01T00:00:00Z',
  nextSendAt: '2026-01-02T00:00:00Z',
};

const baseUser = {
  userId: 'user-1',
  email: 'sender@example.com',
  displayName: 'Sender',
  emailDomain: 'example.com',
  defaultSenderUsername: 'sender',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockUserDb.getUserById.mockResolvedValue(baseUser as any);
  mockEmailEventsDb.getEventsByEmailDomainAndLeadEmail.mockResolvedValue([]);
  (require('../services/settingsService').settingsService.getSetting as jest.Mock).mockResolvedValue(null);
});

describe('dripSequenceWorker - custom field substitution', () => {
  it('substitutes {{customFields.xxx}} into the email subject', async () => {
    const sequence = {
      sequenceId: 'seq-1',
      userId: 'user-1',
      name: 'Test Sequence',
      status: 'active',
      campaignType: 'custom',
      enrollmentTrigger: { type: 'manual' },
      exitConditions: { onUnsubscribe: true },
      steps: [
        {
          stepId: 'step-1',
          stepNumber: 1,
          name: 'Step 1',
          delayDays: 0,
          channel: 'email',
          subject: 'Hi {{firstName}} from {{customFields.region}}',
          bodyHtml: '<p>Region: {{customFields.region}}</p>',
        },
      ],
    };

    mockDripSequenceDb.getAllDueEnrollments.mockResolvedValue([baseEnrollment as any]);
    mockDripSequenceDb.getSequence.mockResolvedValue(sequence as any);
    mockCrmDb.getLeadById.mockResolvedValue({
      leadId: 'lead-1',
      email: 'lead@example.com',
      firstName: 'Pat',
      customFields: { region: 'EMEA' },
    } as any);
    mockResendService.sendEmail.mockResolvedValue({ id: 'email-1' } as any);
    mockDripSequenceDb.completeEnrollment.mockResolvedValue(undefined as any);

    const stats = await processDueEnrollments();

    expect(stats.sent).toBe(1);
    expect(mockResendService.sendEmail).toHaveBeenCalledTimes(1);
    const sendArg = mockResendService.sendEmail.mock.calls[0][0];
    expect(sendArg.subject).toBe('Hi Pat from EMEA');
    expect(sendArg.html).toContain('Region: EMEA');
  });

  it('substitutes {{customFields.xxx}} into the LinkedIn message text', async () => {
    const sequence = {
      sequenceId: 'seq-1',
      userId: 'user-1',
      name: 'Test Sequence',
      status: 'active',
      campaignType: 'custom',
      enrollmentTrigger: { type: 'manual' },
      exitConditions: { onUnsubscribe: true },
      steps: [
        {
          stepId: 'step-1',
          stepNumber: 1,
          name: 'Step 1',
          delayDays: 0,
          channel: 'linkedin',
          messageText: 'Hi {{firstName}}, saw you work in {{customFields.region}}',
        },
      ],
    };

    mockDripSequenceDb.getAllDueEnrollments.mockResolvedValue([baseEnrollment as any]);
    mockDripSequenceDb.getSequence.mockResolvedValue(sequence as any);
    mockCrmDb.getLeadById.mockResolvedValue({
      leadId: 'lead-1',
      email: 'lead@example.com',
      firstName: 'Pat',
      linkedin: 'https://linkedin.com/in/pat',
      customFields: { region: 'EMEA' },
    } as any);
    mockLinkedIn.resolveAccountId.mockResolvedValue('acc-1' as any);
    mockLinkedIn.resolveProviderId.mockResolvedValue('prov-1' as any);
    mockLinkedIn.sendMessage.mockResolvedValue(undefined as any);
    mockDripSequenceDb.completeEnrollment.mockResolvedValue(undefined as any);

    const stats = await processDueEnrollments();

    expect(stats.sent).toBe(1);
    expect(mockLinkedIn.sendMessage).toHaveBeenCalledTimes(1);
    const messageText = mockLinkedIn.sendMessage.mock.calls[0][3];
    expect(messageText).toBe('Hi Pat, saw you work in EMEA');
  });

  it('substitutes {{title}} (a standard field) into the email subject', async () => {
    const sequence = {
      sequenceId: 'seq-1', userId: 'user-1', name: 'Test Sequence', status: 'active',
      campaignType: 'custom', enrollmentTrigger: { type: 'manual' },
      exitConditions: { onUnsubscribe: true },
      steps: [{
        stepId: 'step-1', stepNumber: 1, name: 'Step 1', delayDays: 0, channel: 'email',
        subject: 'Hello {{title}} {{firstName}}', bodyHtml: '<p>hi</p>',
      }],
    };
    mockDripSequenceDb.getAllDueEnrollments.mockResolvedValue([baseEnrollment as any]);
    mockDripSequenceDb.getSequence.mockResolvedValue(sequence as any);
    mockCrmDb.getLeadById.mockResolvedValue({
      leadId: 'lead-1', email: 'lead@example.com', firstName: 'Pat', title: 'CTO',
    } as any);
    mockResendService.sendEmail.mockResolvedValue({ id: 'email-1' } as any);
    mockDripSequenceDb.completeEnrollment.mockResolvedValue(undefined as any);

    await processDueEnrollments();

    const sendArg = mockResendService.sendEmail.mock.calls[0][0];
    expect(sendArg.subject).toBe('Hello CTO Pat');
  });
});
