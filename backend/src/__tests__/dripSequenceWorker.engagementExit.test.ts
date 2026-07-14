/**
 * Regression test for ENG-298 — the drip email-engagement exit was dead code.
 *
 * checkExitConditions() queried AW-EmailEvents with an EMPTY STRING as the GSI partition
 * key (`getEventsByEmailDomainAndLeadEmail('', leadEmail)`). DynamoDB rejects empty key
 * values, and the `.catch(() => [])` swallowed it — so the query could never match, and
 * `onEmailEngagement` exits NEVER fired, for anyone, on any provider.
 *
 * Separately, 'replied' was a valid EmailEngagementEvent accepted by the API and then
 * never evaluated — only 'opened' and 'clicked' were checked. So a sequence configured to
 * stop when a lead REPLIES kept right on sending to leads who had replied.
 */

import { processDueEnrollments } from '../services/dripSequenceWorker';
import { dripSequenceDb } from '../services/dripSequenceDb';
import { crmDb, userDb } from '../services/db';
import { emailEventsDb } from '../services/emailEventsDb';
import { settingsService } from '../services/settingsService';

jest.mock('../services/dripSequenceDb', () => ({
  dripSequenceDb: {
    getAllDueEnrollments: jest.fn(),
    getSequence: jest.fn(),
    exitEnrollment: jest.fn(),
    completeEnrollment: jest.fn(),
    advanceEnrollment: jest.fn(),
    claimEnrollment: jest.fn(),
    releaseEnrollmentClaim: jest.fn(),
  },
}));
jest.mock('../services/resendService', () => ({ resendService: { sendEmail: jest.fn() } }));
jest.mock('../services/db', () => ({
  crmDb: { getLeadById: jest.fn() },
  userDb: { getUserById: jest.fn() },
}));
jest.mock('../services/emailEventsDb', () => ({
  emailEventsDb: { getEventsByEmailDomainAndLeadEmail: jest.fn() },
}));
jest.mock('../services/settingsService', () => ({ settingsService: { getSetting: jest.fn() } }));
jest.mock('../services/linkedInOutreachService', () => ({ linkedInOutreachService: {} }));
jest.mock('../utils/emailVariables', () => ({
  substituteVariables: jest.fn((s: string) => s),
  injectUnsubscribeUrl: jest.fn((s: string) => s),
  rewriteS3ImageUrls: jest.fn((s: string) => s),
  normalizeYoutubeUrls: jest.fn((s: string) => s),
}));

const USER_ID = 'user-1';
const EMAIL_DOMAIN = 'mail.baldwin.com';
const LEAD_EMAIL = 'lead@contractor.com';

const enrollment = {
  enrollmentId: 'e1',
  sequenceId: 'seq-1',
  userId: USER_ID,
  listId: 'list-1',
  leadId: 'lead-1',
  leadEmail: LEAD_EMAIL,
  currentStep: 0,
  status: 'active',
};

const sequenceWith = (onEmailEngagement: string[]) => ({
  sequenceId: 'seq-1',
  status: 'active',
  exitConditions: { onEmailEngagement, onUnsubscribe: false },
  steps: [{ stepNumber: 1, channel: 'email', subject: 'hi', bodyHtml: '<p>hi</p>' }],
});

const mockEvents = emailEventsDb.getEventsByEmailDomainAndLeadEmail as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  (dripSequenceDb.getAllDueEnrollments as jest.Mock).mockResolvedValue([enrollment]);
  (dripSequenceDb.claimEnrollment as jest.Mock).mockResolvedValue(true);
  (dripSequenceDb.exitEnrollment as jest.Mock).mockResolvedValue(undefined);
  (dripSequenceDb.advanceEnrollment as jest.Mock).mockResolvedValue(undefined);
  (dripSequenceDb.completeEnrollment as jest.Mock).mockResolvedValue(undefined);
  // Awaited with .catch() when an enrollment does NOT exit — a bare jest.fn() returns
  // undefined and blows up there, which only shows in the non-exiting cases.
  (dripSequenceDb.releaseEnrollmentClaim as jest.Mock).mockResolvedValue(undefined);
  (crmDb.getLeadById as jest.Mock).mockResolvedValue({ leadId: 'lead-1', email: LEAD_EMAIL });
  (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: USER_ID, emailDomain: EMAIL_DOMAIN });
  (settingsService.getSetting as jest.Mock).mockResolvedValue(null); // no senders -> send step throws, enrollment doesn't advance
  mockEvents.mockResolvedValue([]);
});

describe('drip engagement exit — the query must use a REAL partition key (ENG-298)', () => {
  it('never queries with an empty emailDomain', async () => {
    (dripSequenceDb.getSequence as jest.Mock).mockResolvedValue(sequenceWith(['opened']));

    await processDueEnrollments();

    expect(mockEvents).toHaveBeenCalled();
    const [emailDomain, leadEmail] = mockEvents.mock.calls[0];
    // This was '' before the fix, which DynamoDB rejects outright.
    expect(emailDomain).toBe(EMAIL_DOMAIN);
    expect(leadEmail).toBe(LEAD_EMAIL);
  });

  it('exits on an opened event', async () => {
    (dripSequenceDb.getSequence as jest.Mock).mockResolvedValue(sequenceWith(['opened']));
    mockEvents.mockResolvedValue([{ eventType: 'email.opened', leadEmail: LEAD_EMAIL }]);

    await processDueEnrollments();

    expect(dripSequenceDb.exitEnrollment).toHaveBeenCalledWith('e1', 'engagement');
  });

  it('exits on a clicked event', async () => {
    (dripSequenceDb.getSequence as jest.Mock).mockResolvedValue(sequenceWith(['clicked']));
    mockEvents.mockResolvedValue([{ eventType: 'email.clicked', leadEmail: LEAD_EMAIL }]);

    await processDueEnrollments();

    expect(dripSequenceDb.exitEnrollment).toHaveBeenCalledWith('e1', 'engagement');
  });

  // THE ONE THAT MATTERS: a lead who REPLIED kept receiving sequence emails.
  it('exits on a reply (email.received) — previously never evaluated at all', async () => {
    (dripSequenceDb.getSequence as jest.Mock).mockResolvedValue(sequenceWith(['replied']));
    mockEvents.mockResolvedValue([{ eventType: 'email.received', leadEmail: LEAD_EMAIL }]);

    await processDueEnrollments();

    expect(dripSequenceDb.exitEnrollment).toHaveBeenCalledWith('e1', 'engagement');
  });

  it('does NOT exit when the event type is not one the sequence asked for', async () => {
    (dripSequenceDb.getSequence as jest.Mock).mockResolvedValue(sequenceWith(['clicked']));
    mockEvents.mockResolvedValue([{ eventType: 'email.opened', leadEmail: LEAD_EMAIL }]);

    await processDueEnrollments();

    expect(dripSequenceDb.exitEnrollment).not.toHaveBeenCalledWith('e1', 'engagement');
  });

  it('does NOT exit when there are no events', async () => {
    (dripSequenceDb.getSequence as jest.Mock).mockResolvedValue(sequenceWith(['opened', 'replied']));
    mockEvents.mockResolvedValue([]);

    await processDueEnrollments();

    expect(dripSequenceDb.exitEnrollment).not.toHaveBeenCalledWith('e1', 'engagement');
  });

  // A mailbox-only user (Gmail/Outlook sender) has no Resend domain and therefore no events
  // at all. Don't query with a key we know is invalid — just skip the check.
  it('skips the engagement check entirely when the user has no emailDomain', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: USER_ID }); // no emailDomain
    (dripSequenceDb.getSequence as jest.Mock).mockResolvedValue(sequenceWith(['opened']));

    await processDueEnrollments();

    expect(mockEvents).not.toHaveBeenCalled();
    expect(dripSequenceDb.exitEnrollment).not.toHaveBeenCalledWith('e1', 'engagement');
  });

  it('does not query at all when the sequence has no engagement exit configured', async () => {
    (dripSequenceDb.getSequence as jest.Mock).mockResolvedValue(sequenceWith([]));

    await processDueEnrollments();

    expect(mockEvents).not.toHaveBeenCalled();
  });
});
