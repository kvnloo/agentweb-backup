/**
 * ENG-442 — numeric enrollment conditions (`gte` / `lte`).
 *
 * The heat-score targeting exposed by manage_crm_sequence emits
 * `{ field: 'heatScore', operator: 'gte', value: N }`. Before this operator
 * existed, evaluateCondition's `default: return false` would have exited every
 * lead on such a sequence — so these tests are what stop heat targeting from
 * silently mailing nobody.
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
    claimEnrollment: jest.fn(),
    releaseEnrollmentClaim: jest.fn(),
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

import { dripSequenceDb } from '../services/dripSequenceDb';
import { resendService } from '../services/resendService';
import { crmDb, userDb } from '../services/db';
import { emailEventsDb } from '../services/emailEventsDb';

const mockDripSequenceDb = dripSequenceDb as jest.Mocked<typeof dripSequenceDb>;
const mockResendService = resendService as jest.Mocked<typeof resendService>;
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

function sequenceWithCondition(condition: any) {
  return {
    sequenceId: 'seq-1',
    userId: 'user-1',
    name: 'Hot leads',
    status: 'active',
    campaignType: 'nurture',
    enrollmentTrigger: { type: 'list_membership', listId: 'list-1' },
    enrollmentCondition: condition,
    exitConditions: { onUnsubscribe: true },
    steps: [
      {
        stepId: 'step-1',
        stepNumber: 1,
        name: 'Step 1',
        delayDays: 0,
        channel: 'email',
        subject: 'Hi {{firstName}}',
        bodyHtml: '<p>hi</p>',
      },
    ],
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockUserDb.getUserById.mockResolvedValue(baseUser as any);
  mockEmailEventsDb.getEventsByEmailDomainAndLeadEmail.mockResolvedValue([]);
  (require('../services/settingsService').settingsService.getSetting as jest.Mock).mockResolvedValue(null);
  mockDripSequenceDb.claimEnrollment.mockResolvedValue(true);
  mockDripSequenceDb.releaseEnrollmentClaim.mockResolvedValue(undefined as any);
  mockDripSequenceDb.getAllDueEnrollments.mockResolvedValue([baseEnrollment as any]);
  mockResendService.sendEmail.mockResolvedValue({ id: 'email-1' } as any);
  mockDripSequenceDb.completeEnrollment.mockResolvedValue(undefined as any);
  mockDripSequenceDb.exitEnrollment.mockResolvedValue(undefined as any);
});

describe('dripSequenceWorker — numeric enrollment conditions', () => {
  async function runWithLead(condition: any, lead: Record<string, unknown>) {
    mockDripSequenceDb.getSequence.mockResolvedValue(sequenceWithCondition(condition) as any);
    mockCrmDb.getLeadById.mockResolvedValue({
      leadId: 'lead-1',
      email: 'lead@example.com',
      firstName: 'Pat',
      ...lead,
    } as any);
    return processDueEnrollments();
  }

  const gte60 = { field: 'heatScore', operator: 'gte', value: 60 };

  it('sends when heatScore is above the gte threshold', async () => {
    const stats = await runWithLead(gte60, { heatScore: 75 });
    expect(stats.sent).toBe(1);
    expect(mockResendService.sendEmail).toHaveBeenCalledTimes(1);
  });

  it('sends when heatScore is exactly on the gte boundary', async () => {
    const stats = await runWithLead(gte60, { heatScore: 60 });
    expect(stats.sent).toBe(1);
  });

  it('exits without sending when heatScore is below the threshold', async () => {
    const stats = await runWithLead(gte60, { heatScore: 59 });
    expect(stats.sent).toBe(0);
    expect(stats.exited).toBe(1);
    expect(mockResendService.sendEmail).not.toHaveBeenCalled();
  });

  it('exits without sending when the lead has no heatScore at all', async () => {
    const stats = await runWithLead(gte60, {});
    expect(stats.sent).toBe(0);
    expect(mockResendService.sendEmail).not.toHaveBeenCalled();
  });

  it('exits without sending when heatScore is non-numeric', async () => {
    const stats = await runWithLead(gte60, { heatScore: 'hot' });
    expect(stats.sent).toBe(0);
    expect(mockResendService.sendEmail).not.toHaveBeenCalled();
  });

  it('coerces a numeric string heatScore (DynamoDB round-trip tolerance)', async () => {
    const stats = await runWithLead(gte60, { heatScore: '80' });
    expect(stats.sent).toBe(1);
  });

  it('supports lte as the mirror operator', async () => {
    const lte50 = { field: 'heatScore', operator: 'lte', value: 50 };
    expect((await runWithLead(lte50, { heatScore: 20 })).sent).toBe(1);

    jest.clearAllMocks();
    mockUserDb.getUserById.mockResolvedValue(baseUser as any);
    mockEmailEventsDb.getEventsByEmailDomainAndLeadEmail.mockResolvedValue([]);
    mockDripSequenceDb.claimEnrollment.mockResolvedValue(true);
    mockDripSequenceDb.getAllDueEnrollments.mockResolvedValue([baseEnrollment as any]);
    mockDripSequenceDb.exitEnrollment.mockResolvedValue(undefined as any);
    mockResendService.sendEmail.mockResolvedValue({ id: 'email-1' } as any);

    expect((await runWithLead(lte50, { heatScore: 90 })).sent).toBe(0);
  });

  it('still rejects a genuinely unknown operator rather than sending', async () => {
    const stats = await runWithLead({ field: 'heatScore', operator: 'wat', value: 1 }, { heatScore: 99 });
    expect(stats.sent).toBe(0);
    expect(mockResendService.sendEmail).not.toHaveBeenCalled();
  });
});
