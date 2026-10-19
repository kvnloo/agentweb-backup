/**
 * The LinkedIn send path must use the CANONICAL profile URL, not the raw lead field.
 *
 * Review round 2, finding 1. Widening the reachability predicate to normalise rather
 * than refuse (so `?originalSubdomain=uk`, `#fragment` and `/IN/Ada` stop costing real
 * sends) admitted a class of URLs the SENDER cannot parse. The worker gated on the
 * normalised value and then handed `lead.linkedin` over verbatim, so every newly
 * admitted URL reached linkedInOutreachService — whose `getLinkedInProfile` does a plain
 * case-sensitive `split('/in/')` and passes the tail to Unipile as-is:
 *
 *   .../in/ada?originalSubdomain=uk  ->  identifier "ada?originalSubdomain=uk"  (404)
 *   .../in/ada#about                 ->  identifier "ada#about"                 (404)
 *   .../IN/Ada                       ->  parts.length < 2 -> throws outright
 *
 * A throw here escapes processEnrollment, hits the generic branch, releases the claim
 * and retries on the very next tick with nextSendAt unchanged — the exact retry-forever
 * jam this change set exists to remove, reopened on the rows it newly admitted. And the
 * population is real: leadLinkedinCanonicalizer exists precisely because pre-ENG-787
 * leads were stored under whatever the user pasted.
 *
 * These tests fail if the worker goes back to sending `lead.linkedin`.
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

jest.mock('../services/resendService', () => ({ resendService: { sendEmail: jest.fn() } }));
const mockResolveLinkedInAccountForWrite = jest.fn();
jest.mock('../services/agentMode/linkedInDailyVolumeGate', () => ({
  resolveLinkedInAccountForWrite: (...args: any[]) => mockResolveLinkedInAccountForWrite(...args),
  // ENG-2529: the send path is paced; this suite is about URLs, so the gate always allows.
  paceLinkedInWrite: jest.fn(async () => ({ refusal: null })),
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

jest.mock('../services/settingsService', () => ({ settingsService: { getSetting: jest.fn() } }));

jest.mock('../utils/emailVariables', () => ({
  substituteVariables: jest.fn((s: string) => s),
  injectUnsubscribeUrl: jest.fn((s: string) => s),
  rewriteS3ImageUrls: jest.fn((s: string) => s),
  normalizeYoutubeUrls: jest.fn((s: string) => s),
}));

import { dripSequenceDb } from '../services/dripSequenceDb';
import { linkedInOutreachService } from '../services/linkedInOutreachService';
import { crmDb, userDb } from '../services/db';
import { emailEventsDb } from '../services/emailEventsDb';

const mockDb = dripSequenceDb as jest.Mocked<typeof dripSequenceDb>;
const mockLi = linkedInOutreachService as jest.Mocked<typeof linkedInOutreachService>;
const mockCrmDb = crmDb as jest.Mocked<typeof crmDb>;
const mockUserDb = userDb as jest.Mocked<typeof userDb>;

/**
 * The real parse, copied from linkedInOutreachService.getLinkedInProfile. Tests assert
 * against THIS rather than a hand-written expectation, so the guard tracks the consumer
 * instead of a snapshot of it.
 */
function unipileIdentifier(profileUrl: string): string {
  let identifier = profileUrl.trim();
  if (identifier.endsWith('/')) identifier = identifier.substring(0, identifier.length - 1);
  const parts = identifier.split('/in/');
  if (parts.length < 2) throw new Error('Invalid LinkedIn profile URL. Must contain /in/{identifier}');
  return parts[parts.length - 1];
}

const enrollment = {
  enrollmentId: 'enroll-1',
  sequenceId: 'seq-1',
  leadId: 'lead-1',
  listId: 'list-1',
  leadEmail: 'https://www.linkedin.com/in/ada/',
  userId: 'user-1',
  currentStep: 0,
  status: 'active',
  enrolledAt: '2026-01-01T00:00:00Z',
  nextSendAt: '2026-01-02T00:00:00Z',
};

const linkedInSequence = {
  sequenceId: 'seq-1',
  userId: 'user-1',
  name: 'LinkedIn Drip',
  status: 'active',
  campaignType: 'custom',
  enrollmentTrigger: { type: 'manual' },
  exitConditions: { onUnsubscribe: true },
  steps: [
    { stepId: 'step-1', stepNumber: 1, name: 'DM', channel: 'linkedin', delayDays: 0, messageText: 'hi' },
  ],
};

beforeEach(() => {
  jest.clearAllMocks();
  mockUserDb.getUserById.mockResolvedValue({ userId: 'user-1', email: 'sender@acme.io' } as any);
  (emailEventsDb.getEventsByEmailDomainAndLeadEmail as jest.Mock).mockResolvedValue([]);
  (require('../services/settingsService').settingsService.getSetting as jest.Mock).mockResolvedValue(null);
  mockDb.getAllDueEnrollments.mockResolvedValue([enrollment as any]);
  mockDb.getSequence.mockResolvedValue(linkedInSequence as any);
  mockDb.claimEnrollment.mockResolvedValue(true);
  mockDb.releaseEnrollmentClaim.mockResolvedValue(undefined as any);
  mockDb.completeEnrollment.mockResolvedValue(undefined as any);
  mockLi.resolveAccountId.mockResolvedValue('acct-1' as any);
  mockLi.resolveProviderId.mockResolvedValue('prov-1' as any);
  mockLi.sendMessage.mockResolvedValue(undefined as any);
  mockResolveLinkedInAccountForWrite.mockReset();
  mockResolveLinkedInAccountForWrite.mockResolvedValue({ ownerUserId: 'user-1' });
  mockDb.snoozeEnrollment.mockResolvedValue(undefined as any);
});

describe('the LinkedIn send path uses the canonical URL the predicate validated', () => {
  it.each([
    ['a non-US profile (?originalSubdomain=)', 'https://www.linkedin.com/in/ada-lovelace?originalSubdomain=uk', 'ada-lovelace'],
    ['a browser-copied URL (?trk=)', 'https://www.linkedin.com/in/ada?trk=public_profile', 'ada'],
    ['a fragment', 'https://www.linkedin.com/in/ada#about', 'ada'],
    ['mixed case /IN/', 'https://www.LinkedIn.com/IN/Ada', 'ada'],
    ['http:// with no www', 'http://linkedin.com/in/ada', 'ada'],
    ['a trailing slash', 'https://www.linkedin.com/in/ada/', 'ada'],
  ])('sends %s as an identifier the service can actually parse', async (_label, stored, expectedSlug) => {
    mockCrmDb.getLeadById.mockResolvedValue({ leadId: 'lead-1', linkedin: stored } as any);

    const stats = await processDueEnrollments();

    expect(stats.errors).toBe(0);
    expect(mockLi.sendMessage).toHaveBeenCalledTimes(1);
    const sentUrl = mockLi.sendMessage.mock.calls[0][1];
    // The value the sender receives must survive the service's own parse...
    expect(() => unipileIdentifier(sentUrl)).not.toThrow();
    // ...and resolve to the profile slug, not the slug plus query/fragment noise.
    expect(unipileIdentifier(sentUrl)).toBe(expectedSlug);
  });

  it('resolves the provider id from the canonical URL too, not the raw field', async () => {
    mockCrmDb.getLeadById.mockResolvedValue({
      leadId: 'lead-1',
      linkedin: 'https://www.linkedin.com/in/ada?originalSubdomain=uk',
    } as any);

    await processDueEnrollments();

    expect(mockLi.resolveProviderId).toHaveBeenCalled();
    expect(unipileIdentifier(mockLi.resolveProviderId.mock.calls[0][0])).toBe('ada');
  });

  it('still SKIPS — never throws — for a lead with no personal profile', async () => {
    mockCrmDb.getLeadById.mockResolvedValue({ leadId: 'lead-1', linkedin: 'Acme Corp' } as any);

    const stats = await processDueEnrollments();

    expect(stats.errors).toBe(0);
    expect(stats.skipped).toBe(1);
    expect(mockLi.sendMessage).not.toHaveBeenCalled();
  });

  it('logs the RAW value when it skips, so the lead can be found and fixed', async () => {
    const logs: string[] = [];
    const spy = jest.spyOn(console, 'log').mockImplementation((...a) => { logs.push(a.join(' ')); });
    mockCrmDb.getLeadById.mockResolvedValue({ leadId: 'lead-1', linkedin: 'Acme Corp' } as any);

    await processDueEnrollments();
    spy.mockRestore();

    // Reporting the canonical value here would print 'empty' for every skip and make the
    // log useless for finding the offending row.
    expect(logs.some((l) => l.includes('Acme Corp'))).toBe(true);
  });
});

describe('the LinkedIn reply-exit resolves the same canonical URL', () => {
  const replySequence = {
    ...linkedInSequence,
    exitConditions: { onUnsubscribe: true, onLinkedInReply: true },
  };

  beforeEach(() => {
    mockDb.getSequence.mockResolvedValue(replySequence as any);
    mockDb.exitEnrollment.mockResolvedValue(undefined as any);
    mockLi.getMessagesWithContact.mockResolvedValue([
      { is_sender: 0, timestamp: '2026-06-01T00:00:00Z' },
    ] as any);
  });

  it('fires for a profile carrying a query string', async () => {
    // Pre-fix this took `lead.linkedin` raw into resolveProviderId, which is
    // `.catch(() => null)`-wrapped — so it failed silently and the exit NEVER fired.
    // The sequence kept DMing someone who had already replied.
    mockCrmDb.getLeadById.mockResolvedValue({
      leadId: 'lead-1',
      linkedin: 'https://www.linkedin.com/in/ada?originalSubdomain=uk',
    } as any);

    const stats = await processDueEnrollments();

    expect(unipileIdentifier(mockLi.resolveProviderId.mock.calls[0][0])).toBe('ada');
    expect(mockDb.exitEnrollment).toHaveBeenCalledWith('enroll-1', 'engagement');
    expect(stats.exited).toBe(1);
    expect(mockLi.sendMessage).not.toHaveBeenCalled();
  });

  it('falls back to the enrollment identity when the lead row is gone', async () => {
    // For an address-less lead `leadEmail` IS the canonical profile URL.
    mockCrmDb.getLeadById.mockResolvedValue(null as any);

    await processDueEnrollments();

    expect(mockDb.exitEnrollment).toHaveBeenCalledWith('enroll-1', 'engagement');
  });

  it('does not attempt a reply-check for a lead with no profile at all', async () => {
    mockCrmDb.getLeadById.mockResolvedValue({ leadId: 'lead-1', linkedin: 'Acme Corp' } as any);
    // An email identity must not be mistaken for a profile URL.
    mockDb.getAllDueEnrollments.mockResolvedValue([
      { ...enrollment, leadEmail: 'ada@acme.io' } as any,
    ]);

    await processDueEnrollments();

    expect(mockLi.getMessagesWithContact).not.toHaveBeenCalled();
    expect(mockDb.exitEnrollment).not.toHaveBeenCalled();
  });
});


// ENG-2205: a step's pinned linkedInAccountId arrives from the request body when a sequence is saved,
// and sequences stored before that was validated may name any account (including the shared pool).
describe('a pinned LinkedIn account must belong to the sequence owner (ENG-2205)', () => {
  const pinned = (id: string) => ({
    ...linkedInSequence,
    steps: [{ ...linkedInSequence.steps[0], linkedInAccountId: id }],
  });
  beforeEach(() => {
    mockCrmDb.getLeadById.mockResolvedValue({ leadId: 'lead-1', linkedin: 'https://www.linkedin.com/in/ada/' } as any);
  });

  it('sends from the pinned account when the owner owns or shares it', async () => {
    mockDb.getSequence.mockResolvedValue(pinned('owned-acct') as any);
    const stats = await processDueEnrollments();
    expect(mockResolveLinkedInAccountForWrite).toHaveBeenCalledWith('user-1', 'owned-acct');
    expect(stats.errors).toBe(0);
    expect(mockLi.sendMessage).toHaveBeenCalledWith('owned-acct', expect.any(String), true, expect.any(String));
  });

  it('refuses to send, and SNOOZES (not retry every tick) when the pinned account is not theirs', async () => {
    mockResolveLinkedInAccountForWrite.mockResolvedValue(null);
    mockDb.getSequence.mockResolvedValue(pinned('pool-or-foreign-acct') as any);
    const stats = await processDueEnrollments();
    expect(mockLi.sendMessage).not.toHaveBeenCalled();
    expect(stats.errors).toBe(1);
    expect(mockDb.snoozeEnrollment).toHaveBeenCalledTimes(1);
    const retryAt = new Date(mockDb.snoozeEnrollment.mock.calls[0][1]).getTime();
    // Backed off (well past the next 5-minute tick) but short, so a fixed step resumes soon: editing a
    // sequence does not reset nextSendAt.
    expect(retryAt - Date.now()).toBeGreaterThan(20 * 60 * 1000);
    expect(retryAt - Date.now()).toBeLessThan(40 * 60 * 1000);
    expect(mockDb.releaseEnrollmentClaim).not.toHaveBeenCalled();
  });

  it('a transient failure of the ownership LOOKUP itself is not treated as "not connected" (keeps the normal retry)', async () => {
    mockResolveLinkedInAccountForWrite.mockRejectedValue(new Error('DynamoDB throttled'));
    mockDb.getSequence.mockResolvedValue(pinned('owned-acct') as any);
    await processDueEnrollments();
    expect(mockLi.sendMessage).not.toHaveBeenCalled();
    expect(mockDb.snoozeEnrollment).not.toHaveBeenCalled();
    expect(mockDb.releaseEnrollmentClaim).toHaveBeenCalled();
  });

  it('does not run the check when no account is pinned (auto-resolve path unchanged)', async () => {
    const stats = await processDueEnrollments();
    // ENG-2529: the only lookup is the write gate's, against the AUTO-resolved account (made after
    // resolveAccountId) — the pinned-ownership pre-check never runs.
    expect(mockResolveLinkedInAccountForWrite).toHaveBeenCalledTimes(1);
    expect(mockResolveLinkedInAccountForWrite.mock.invocationCallOrder[0])
      .toBeGreaterThan((mockLi.resolveAccountId as jest.Mock).mock.invocationCallOrder[0]);
    expect(mockLi.resolveAccountId).toHaveBeenCalledWith('user-1');
    expect(stats.errors).toBe(0);
    expect(mockLi.sendMessage).toHaveBeenCalledTimes(1);
  });
});
