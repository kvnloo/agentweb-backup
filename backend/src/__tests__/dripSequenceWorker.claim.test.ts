/**
 * Tests that processDueEnrollments() claims an enrollment before sending its
 * step (skipping it if another instance/a recent crash still holds the
 * claim), and releases the claim on a generic processing error so normal
 * retry-next-tick behavior is preserved for transient failures.
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

jest.mock('../utils/emailVariables', () => ({
  substituteVariables: jest.fn((s: string) => s),
  injectUnsubscribeUrl: jest.fn((s: string) => s),
  rewriteS3ImageUrls: jest.fn((s: string) => s),
  normalizeYoutubeUrls: jest.fn((s: string) => s),
}));

import { dripSequenceDb } from '../services/dripSequenceDb';
import { resendService } from '../services/resendService';
import { crmDb, userDb } from '../services/db';
import { emailEventsDb } from '../services/emailEventsDb';

const mockDb = dripSequenceDb as jest.Mocked<typeof dripSequenceDb>;
const mockResend = resendService as jest.Mocked<typeof resendService>;
const mockCrmDb = crmDb as jest.Mocked<typeof crmDb>;
const mockUserDb = userDb as jest.Mocked<typeof userDb>;
const mockEmailEventsDb = emailEventsDb as jest.Mocked<typeof emailEventsDb>;

const enrollment = {
  enrollmentId: 'enroll-1',
  sequenceId: 'seq-1',
  leadId: 'lead-1',
  listId: 'list-1',
  leadEmail: 'prospect@example.com',
  userId: 'user-1',
  currentStep: 0,
  status: 'active',
  enrolledAt: '2026-01-01T00:00:00Z',
  nextSendAt: '2026-01-02T00:00:00Z',
};

const sequence = {
  sequenceId: 'seq-1',
  userId: 'user-1',
  name: 'Email Drip',
  status: 'active',
  campaignType: 'custom',
  enrollmentTrigger: { type: 'manual' },
  exitConditions: { onUnsubscribe: true },
  steps: [
    {
      stepId: 'step-1',
      stepNumber: 1,
      name: 'Step 1',
      channel: 'email',
      delayDays: 0,
      subject: 'Hello',
      bodyHtml: '<p>Hi</p>',
    },
  ],
};

beforeEach(() => {
  jest.clearAllMocks();
  mockUserDb.getUserById.mockResolvedValue({
    userId: 'user-1',
    email: 'sender@example.com',
    emailDomain: 'example.com',
    defaultSenderUsername: 'sender',
  } as any);
  mockCrmDb.getLeadById.mockResolvedValue({ leadId: 'lead-1', email: 'prospect@example.com' } as any);
  mockEmailEventsDb.getEventsByEmailDomainAndLeadEmail.mockResolvedValue([]);
  (require('../services/settingsService').settingsService.getSetting as jest.Mock).mockResolvedValue(null);
  mockDb.getAllDueEnrollments.mockResolvedValue([enrollment as any]);
  mockDb.getSequence.mockResolvedValue(sequence as any);
  mockDb.claimEnrollment.mockResolvedValue(true);
  mockDb.releaseEnrollmentClaim.mockResolvedValue(undefined as any);
  mockDb.completeEnrollment.mockResolvedValue(undefined as any);
  mockResend.sendEmail.mockResolvedValue({ id: 'msg-1' } as any);
});

describe('dripSequenceWorker - enrollment claim/release', () => {
  it('claims the enrollment before sending', async () => {
    await processDueEnrollments();

    expect(mockDb.claimEnrollment).toHaveBeenCalledWith('enroll-1', expect.any(String));
    expect(mockResend.sendEmail).toHaveBeenCalledTimes(1);
  });

  it('skips the enrollment entirely when the claim fails (another instance/recent crash holds it)', async () => {
    mockDb.claimEnrollment.mockResolvedValue(false);

    const stats = await processDueEnrollments();

    expect(mockResend.sendEmail).not.toHaveBeenCalled();
    expect(mockDb.completeEnrollment).not.toHaveBeenCalled();
    expect(stats.processed).toBe(0);
    expect(stats.errors).toBe(0);
  });

  it('releases the claim on a generic processing error so the next tick can retry', async () => {
    mockResend.sendEmail.mockRejectedValue(new Error('Resend API down'));

    const stats = await processDueEnrollments();

    expect(stats.errors).toBe(1);
    expect(mockDb.releaseEnrollmentClaim).toHaveBeenCalledWith('enroll-1');
  });

  it('does NOT release the claim on success — the advance/complete write already clears it', async () => {
    const stats = await processDueEnrollments();

    expect(stats.sent).toBe(1);
    expect(mockDb.releaseEnrollmentClaim).not.toHaveBeenCalled();
  });
});
