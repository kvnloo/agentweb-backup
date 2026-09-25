/**
 * A step the LEAD cannot receive is skipped, not failed.
 *
 * It used to throw, and the throw propagated out of executeStep, so the enrollment
 * retried the same undeliverable step forever and never reached the steps it COULD
 * receive — an email-only lead in a mixed email+LinkedIn sequence got its email and then
 * jammed. Enrollability was then narrowed to "every channel the sequence uses", which
 * traded the jam for a LOST SEND: that lead stopped being enrolled at all.
 *
 * Skipping is what makes "at least one channel" safe.
 *
 * CONFIGURATION problems are deliberately NOT skipped — no sender, no LinkedIn account,
 * empty message text still throw, because retrying those is correct once the user fixes
 * the config.
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
    setEnrollmentLinkedInProviderId: jest.fn(),
  },
}));
jest.mock('../services/linkedInOutreachService', () => ({
  linkedInOutreachService: {
    sendMessage: jest.fn(), resolveAccountId: jest.fn(),
    resolveProviderId: jest.fn(), getMessagesWithContact: jest.fn(),
  },
}));
jest.mock('../services/db', () => ({
  crmDb: { getLeadById: jest.fn() },
  userDb: { getUserById: jest.fn() },
}));
jest.mock('../services/emailEventsDb', () => ({
  emailEventsDb: { getEventsByEmailDomainAndLeadEmail: jest.fn() },
}));
jest.mock('../services/settingsService', () => ({ settingsService: { getSetting: jest.fn() } }));
jest.mock('../utils/emailVariables', () => ({
  substituteVariables: jest.fn((s: string) => s),
  injectUnsubscribeUrl: jest.fn((s: string) => s),
  rewriteS3ImageUrls: jest.fn((s: string) => s),
  normalizeYoutubeUrls: jest.fn((s: string) => s),
}));
const mockSendAsSender = jest.fn();
jest.mock('../services/sendAsSender', () => ({
  sendAsSender: (...a: any[]) => mockSendAsSender(...a),
  // The worker does `err instanceof SenderDailyLimitExceededError`; without a real class
  // here that check throws "Right-hand side of 'instanceof' is not an object" and masks
  // whatever the test was actually asserting. Declared INSIDE the factory — jest hoists
  // jest.mock above the file's own declarations.
  SenderDailyLimitExceededError: class extends Error {},
}));
jest.mock('../services/crmSenderService', () => ({
  loadSenderConfig: jest.fn().mockResolvedValue({
    senders: [{ id: 'snd', fromEmail: 'me@x.com', fromName: 'Me' }], defaultSenderId: 'snd',
  }),
}));

import { dripSequenceDb } from '../services/dripSequenceDb';
import { linkedInOutreachService } from '../services/linkedInOutreachService';
import { crmDb, userDb } from '../services/db';
import { emailEventsDb } from '../services/emailEventsDb';

const mockDb = dripSequenceDb as jest.Mocked<typeof dripSequenceDb>;
const mockLinkedIn = linkedInOutreachService as jest.Mocked<typeof linkedInOutreachService>;
const mockCrmDb = crmDb as jest.Mocked<typeof crmDb>;
const mockUserDb = userDb as jest.Mocked<typeof userDb>;
const mockEmailEventsDb = emailEventsDb as jest.Mocked<typeof emailEventsDb>;

const mixedSequence = {
  sequenceId: 'seq-1', userId: 'user-1', name: 'Mixed', status: 'active',
  campaignType: 'custom', enrollmentTrigger: { type: 'manual' },
  exitConditions: { onUnsubscribe: true },
  steps: [
    { stepId: 's1', stepNumber: 1, name: 'Mail', channel: 'email', delayDays: 0,
      subject: 'Hi', bodyHtml: '<p>Hi</p>' },
    { stepId: 's2', stepNumber: 2, name: 'DM', channel: 'linkedin', delayDays: 1,
      messageText: 'Hi there' },
  ],
};

const enrollmentAt = (currentStep: number, leadEmail: string) => ({
  enrollmentId: 'e1', sequenceId: 'seq-1', leadId: 'lead-1', listId: 'list-1',
  leadEmail, userId: 'user-1', currentStep, status: 'active',
  enrolledAt: '2026-01-01T00:00:00Z', nextSendAt: '2026-01-02T00:00:00Z',
});

beforeEach(() => {
  jest.clearAllMocks();
  mockUserDb.getUserById.mockResolvedValue({ userId: 'user-1', email: 'me@x.com' } as any);
  mockEmailEventsDb.getEventsByEmailDomainAndLeadEmail.mockResolvedValue([]);
  (require('../services/settingsService').settingsService.getSetting as jest.Mock).mockResolvedValue(null);
  mockDb.claimEnrollment.mockResolvedValue(true);
  mockDb.releaseEnrollmentClaim.mockResolvedValue(undefined as any);
  mockDb.getSequence.mockResolvedValue(mixedSequence as any);
  mockLinkedIn.resolveAccountId.mockResolvedValue('acct-1');
  mockLinkedIn.sendMessage.mockResolvedValue(undefined as any);
  mockSendAsSender.mockResolvedValue({ provider: 'resend', messageId: 'm1' });
});

describe('dripSequenceWorker — a step the lead cannot receive is skipped, not failed', () => {
  it('email-only lead: the LinkedIn step is skipped and the enrollment COMPLETES', async () => {
    // Already past the email step, now due on the LinkedIn one.
    mockDb.getAllDueEnrollments.mockResolvedValue([enrollmentAt(1, 'mail@x.com') as any]);
    mockCrmDb.getLeadById.mockResolvedValue({ leadId: 'lead-1', email: 'mail@x.com' } as any);

    const stats = await processDueEnrollments();

    expect(mockLinkedIn.sendMessage).not.toHaveBeenCalled();
    expect(stats.errors).toBe(0);
    expect(stats.skipped).toBe(1);
    // The decisive assertion: it moves ON rather than retrying this step forever.
    expect(mockDb.completeEnrollment).toHaveBeenCalledTimes(1);
  });

  it('LinkedIn-only lead: the EMAIL step is skipped, nothing is mailed to a profile URL', async () => {
    // Its dedup identity is the LinkedIn URL, which is NOT an address.
    mockDb.getAllDueEnrollments.mockResolvedValue([
      enrollmentAt(0, 'https://linkedin.com/in/li-only') as any,
    ]);
    mockCrmDb.getLeadById.mockResolvedValue({
      leadId: 'lead-1', linkedin: 'https://linkedin.com/in/li-only',
    } as any);

    const stats = await processDueEnrollments();

    expect(mockSendAsSender).not.toHaveBeenCalled();
    expect(stats.errors).toBe(0);
    expect(stats.skipped).toBe(1);
    // Advanced to the LinkedIn step rather than completing or jamming.
    expect(mockDb.advanceEnrollment).toHaveBeenCalledTimes(1);
    expect(mockDb.advanceEnrollment.mock.calls[0][1]).toBe(1);
  });

  it('a reachable step still SENDS — skipping is not the default', async () => {
    mockDb.getAllDueEnrollments.mockResolvedValue([enrollmentAt(0, 'mail@x.com') as any]);
    mockCrmDb.getLeadById.mockResolvedValue({ leadId: 'lead-1', email: 'mail@x.com' } as any);

    const stats = await processDueEnrollments();

    expect(mockSendAsSender).toHaveBeenCalledTimes(1);
    expect(mockSendAsSender.mock.calls[0][2].to).toBe('mail@x.com');
    expect(stats.sent).toBe(1);
    expect(stats.skipped).toBe(0);
  });

  it('a CONFIGURATION gap still fails and retries — it is not a lead-data skip', async () => {
    mockDb.getAllDueEnrollments.mockResolvedValue([
      enrollmentAt(1, 'mail@x.com') as any,
    ]);
    mockCrmDb.getLeadById.mockResolvedValue({
      leadId: 'lead-1', email: 'mail@x.com', linkedin: 'https://linkedin.com/in/x',
    } as any);
    mockLinkedIn.resolveAccountId.mockResolvedValue(null as any);

    const stats = await processDueEnrollments();

    expect(stats.errors).toBe(1);
    expect(stats.skipped).toBe(0);
    // Must NOT advance past a step that could succeed once the account is connected.
    expect(mockDb.completeEnrollment).not.toHaveBeenCalled();
    expect(mockDb.advanceEnrollment).not.toHaveBeenCalled();
  });
});
