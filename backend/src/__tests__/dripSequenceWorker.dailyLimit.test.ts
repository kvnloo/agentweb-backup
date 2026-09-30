/**
 * ENG-265: a sender hitting its daily send limit should snooze the enrollment
 * until the next UTC day (when the counter resets) instead of retrying every
 * 5 minutes for the rest of the day — same retry-storm prevention as the
 * LinkedIn "not a 1st-degree connection" case in
 * dripSequenceWorker.notConnected.test.ts.
 */

import { processDueEnrollments } from '../services/dripSequenceWorker';
import { SenderDailyLimitExceededError } from '../services/senderUsageTracker';

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

jest.mock('../services/linkedInOutreachService', () => ({
  linkedInOutreachService: {
    sendMessage: jest.fn(),
    resolveAccountId: jest.fn(),
    resolveProviderId: jest.fn(),
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

const mockSendAsSender = jest.fn();
jest.mock('../services/sendAsSender', () => {
  const actual = jest.requireActual('../services/senderUsageTracker');
  return {
    sendAsSender: (...args: any[]) => mockSendAsSender(...args),
    SenderDailyLimitExceededError: actual.SenderDailyLimitExceededError,
  };
});

import { dripSequenceDb } from '../services/dripSequenceDb';
import { crmDb, userDb } from '../services/db';
import { emailEventsDb } from '../services/emailEventsDb';
import { settingsService } from '../services/settingsService';

const mockDb = dripSequenceDb as jest.Mocked<typeof dripSequenceDb>;
const mockCrmDb = crmDb as jest.Mocked<typeof crmDb>;
const mockUserDb = userDb as jest.Mocked<typeof userDb>;
const mockEmailEventsDb = emailEventsDb as jest.Mocked<typeof emailEventsDb>;

const emailEnrollment = {
  enrollmentId: 'enroll-email-1',
  sequenceId: 'seq-1',
  leadId: 'lead-1',
  listId: 'list-1',
  leadEmail: 'prospect@acme.io',
  userId: 'user-1',
  currentStep: 0,
  status: 'active',
  enrolledAt: '2026-01-01T00:00:00Z',
  nextSendAt: '2026-01-02T00:00:00Z',
};

const emailSequence = {
  sequenceId: 'seq-1',
  userId: 'user-1',
  name: 'Email Drip',
  status: 'active',
  campaignType: 'custom',
  enrollmentTrigger: { type: 'manual' },
  exitConditions: {},
  steps: [
    { stepId: 'step-1', stepNumber: 1, name: 'Opener', channel: 'email', delayDays: 0, subject: 'Hi', bodyHtml: '<p>Hi</p>' },
  ],
};

const activeLead = { leadId: 'lead-1', email: 'prospect@acme.io', firstName: 'John', contactStatus: 'active' };

const senderConfigSetting = {
  settingValue: JSON.stringify({
    senders: [{ id: 's-1', email: 'me@acme.com', fromName: 'Me' }],
    defaultSenderId: 's-1',
  }),
};

beforeEach(() => {
  jest.clearAllMocks();
  mockUserDb.getUserById.mockResolvedValue({ userId: 'user-1', email: 'sender@acme.io' } as any);
  mockEmailEventsDb.getEventsByEmailDomainAndLeadEmail.mockResolvedValue([]);
  (settingsService.getSetting as jest.Mock).mockResolvedValue(senderConfigSetting);
  mockDb.snoozeEnrollment.mockResolvedValue(undefined as any);
  mockDb.claimEnrollment.mockResolvedValue(true);
  mockDb.releaseEnrollmentClaim.mockResolvedValue(undefined as any);
});

describe('dripSequenceWorker - sender daily-limit handling (ENG-265)', () => {
  it('snoozes the enrollment until the next UTC day when the sender hits its daily limit', async () => {
    mockDb.getAllDueEnrollments.mockResolvedValue([emailEnrollment as any]);
    mockDb.getSequence.mockResolvedValue(emailSequence as any);
    mockCrmDb.getLeadById.mockResolvedValue(activeLead as any);
    mockSendAsSender.mockRejectedValue(new SenderDailyLimitExceededError('s-1', 50));

    const stats = await processDueEnrollments();

    expect(stats.errors).toBe(1);
    expect(stats.sent).toBe(0);
    expect(mockDb.releaseEnrollmentClaim).not.toHaveBeenCalled();

    expect(mockDb.snoozeEnrollment).toHaveBeenCalledTimes(1);
    const [enrollmentId, retryAt] = mockDb.snoozeEnrollment.mock.calls[0];
    expect(enrollmentId).toBe('enroll-email-1');

    const retryDate = new Date(retryAt);
    expect(retryDate.getUTCHours()).toBe(0);
    expect(retryDate.getUTCMinutes()).toBe(0);
    expect(retryDate.getTime()).toBeGreaterThan(Date.now());
  });

  it('releases the claim (immediate retry) for an unrelated send failure', async () => {
    mockDb.getAllDueEnrollments.mockResolvedValue([emailEnrollment as any]);
    mockDb.getSequence.mockResolvedValue(emailSequence as any);
    mockCrmDb.getLeadById.mockResolvedValue(activeLead as any);
    mockSendAsSender.mockRejectedValue(new Error('Resend API down'));

    const stats = await processDueEnrollments();

    expect(stats.errors).toBe(1);
    expect(mockDb.snoozeEnrollment).not.toHaveBeenCalled();
    expect(mockDb.releaseEnrollmentClaim).toHaveBeenCalledWith('enroll-email-1');
  });

  it('does not snooze on a successful send — advances normally', async () => {
    mockDb.getAllDueEnrollments.mockResolvedValue([emailEnrollment as any]);
    mockDb.getSequence.mockResolvedValue(emailSequence as any);
    mockCrmDb.getLeadById.mockResolvedValue(activeLead as any);
    mockSendAsSender.mockResolvedValue({ provider: 'resend', messageId: 'msg-1' });
    mockDb.completeEnrollment.mockResolvedValue(undefined as any);

    const stats = await processDueEnrollments();

    expect(stats.sent).toBe(1);
    expect(stats.errors).toBe(0);
    expect(mockDb.snoozeEnrollment).not.toHaveBeenCalled();
  });
});
