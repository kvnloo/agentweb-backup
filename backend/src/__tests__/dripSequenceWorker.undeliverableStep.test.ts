/**
 * A step the LEAD cannot receive is skipped, not failed.
 *
 * It used to throw, and the throw propagated out of processEnrollment, so the enrollment
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

  // Review 5, finding 13. db.ts keeps company/school URLs and free text verbatim in
  // `lead.linkedin`; sendMessage throws on those, and that throw is NOT a lead-data skip,
  // so it retried forever — the failure this whole change set out to kill, surviving in
  // the one case an emptiness check cannot catch.
  it.each([
    ['a company page', 'https://linkedin.com/company/acme'],
    ['a school page', 'https://linkedin.com/school/mit'],
    ['a bare handle', '@ada-lovelace'],
  ])('skips a LinkedIn step for %s instead of retrying forever', async (_label, value) => {
    mockDb.getAllDueEnrollments.mockResolvedValue([enrollmentAt(1, 'mail@x.com') as any]);
    mockCrmDb.getLeadById.mockResolvedValue({
      leadId: 'lead-1', email: 'mail@x.com', linkedin: value,
    } as any);

    const stats = await processDueEnrollments();

    expect(mockLinkedIn.sendMessage).not.toHaveBeenCalled();
    expect(stats.errors).toBe(0);
    expect(stats.skipped).toBe(1);
    expect(mockDb.completeEnrollment).toHaveBeenCalledTimes(1);
  });

  it('still sends to a real personal profile', async () => {
    mockDb.getAllDueEnrollments.mockResolvedValue([enrollmentAt(1, 'mail@x.com') as any]);
    mockCrmDb.getLeadById.mockResolvedValue({
      leadId: 'lead-1', email: 'mail@x.com', linkedin: 'https://www.linkedin.com/in/ada/',
    } as any);

    const stats = await processDueEnrollments();

    expect(mockLinkedIn.sendMessage).toHaveBeenCalledTimes(1);
    expect(stats.sent).toBe(1);
  });

  // Review 5, finding 10. advanceEnrollment/completeEnrollment stamp lastEmailSentAt /
  // lastLinkedInSentAt unconditionally, so a SKIPPED step recorded a send that never
  // happened. The `channel` argument was also completely untested in either direction.
  it('a skipped step does not record a send, and names the right channel', async () => {
    mockDb.getAllDueEnrollments.mockResolvedValue([enrollmentAt(1, 'mail@x.com') as any]);
    mockCrmDb.getLeadById.mockResolvedValue({ leadId: 'lead-1', email: 'mail@x.com' } as any);

    await processDueEnrollments();

    expect(mockDb.completeEnrollment).toHaveBeenCalledTimes(1);
    const [, , , channel, delivered] = mockDb.completeEnrollment.mock.calls[0] as any[];
    expect(channel).toBe('linkedin');
    expect(delivered).toBe(false);
  });

  it('a delivered step DOES record a send', async () => {
    mockDb.getAllDueEnrollments.mockResolvedValue([enrollmentAt(0, 'mail@x.com') as any]);
    mockCrmDb.getLeadById.mockResolvedValue({ leadId: 'lead-1', email: 'mail@x.com' } as any);

    await processDueEnrollments();

    expect(mockDb.advanceEnrollment).toHaveBeenCalledTimes(1);
    const [, , , channel, delivered] = mockDb.advanceEnrollment.mock.calls[0] as any[];
    expect(channel).toBe('email');
    expect(delivered).toBe(true);
  });

  // Review 5, finding 3. msgVars is shared by both channels and `email` was wired to
  // `enrollment.leadEmail` — which for an address-less lead IS the profile URL. A
  // {{email}} token in a DM rendered the recipient their own LinkedIn link.
  it('a {{email}} token in a LinkedIn DM never renders the profile URL', async () => {
    // The suite-wide mock is identity; render for real here so the assertion is about
    // the message a human would receive, not about the template.
    //
    // mockImplementationOnce, not mockImplementation: `clearMocks` resets calls but NOT
    // implementations, so a plain mockImplementation here leaked the real renderer into
    // every test declared after this one and silently changed what they exercise.
    const vars = require('../utils/emailVariables').substituteVariables as jest.Mock;
    const render = (tpl: string, v: Record<string, any>) =>
      String(tpl).replace(/\{\{(\w+)\}\}/g, (_m: string, k: string) => String(v?.[k] ?? ''));
    vars.mockImplementationOnce(render).mockImplementationOnce(render).mockImplementationOnce(render);
    mockDb.getSequence.mockResolvedValue({
      ...mixedSequence,
      steps: [{ stepId: 's2', stepNumber: 1, name: 'DM', channel: 'linkedin', delayDays: 0,
                messageText: 'Hi {{firstName}}, can I reach you at {{email}}?' }],
    } as any);
    mockDb.getAllDueEnrollments.mockResolvedValue([
      enrollmentAt(0, 'https://linkedin.com/in/li-only') as any,
    ]);
    mockCrmDb.getLeadById.mockResolvedValue({
      leadId: 'lead-1', firstName: 'Ada', linkedin: 'https://linkedin.com/in/li-only',
    } as any);

    await processDueEnrollments();

    expect(mockLinkedIn.sendMessage).toHaveBeenCalledTimes(1);
    const body = String(mockLinkedIn.sendMessage.mock.calls[0][3]);
    expect(body).not.toContain('linkedin.com/in/li-only');
    expect(body).toContain('Ada');
  });

  // Review 5, finding 4. db.ts stores `lead.linkedin` VERBATIM for anything that is not a
  // personal /in/ profile, so free text lands there — and `includes('@')` let a handle
  // through to the mail provider.
  it('a LinkedIn handle in the identity is not treated as an email address', async () => {
    mockDb.getAllDueEnrollments.mockResolvedValue([enrollmentAt(0, '@ada-lovelace') as any]);
    mockCrmDb.getLeadById.mockResolvedValue({ leadId: 'lead-1', linkedin: '@ada-lovelace' } as any);

    const stats = await processDueEnrollments();

    expect(mockSendAsSender).not.toHaveBeenCalled();
    expect(stats.skipped).toBe(1);
    expect(stats.sent).toBe(0);
  });

  // Review 5, finding 5. The identity is frozen at enrolment; the lead is not. A lead that
  // has GAINED an address must not have its email step skipped and consumed.
  it('uses the LIVE address when a lead gained one after enrolment', async () => {
    mockDb.getAllDueEnrollments.mockResolvedValue([
      enrollmentAt(0, 'https://linkedin.com/in/li-only') as any,
    ]);
    mockCrmDb.getLeadById.mockResolvedValue({
      leadId: 'lead-1', email: 'ada@x.com', linkedin: 'https://linkedin.com/in/li-only',
    } as any);

    const stats = await processDueEnrollments();

    expect(mockSendAsSender).toHaveBeenCalledTimes(1);
    expect(mockSendAsSender.mock.calls[0][2].to).toBe('ada@x.com');
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

/*
 * Finding 8 — an enrollment that sent NOTHING must be distinguishable, and must not
 * bar the lead forever.
 *
 * completeEnrollment was called with exitReason 'completed' regardless of whether a
 * single step had been delivered. getEnrollmentStats counts purely by status, so a lead
 * that skipped every step looked identical to one that received the whole sequence —
 * and getExistingEnrollment matches regardless of status, so bulkEnroll refused to
 * re-enrol it even after the user fixed the data. Combined with the channel and
 * reachability defects, that turned a loud jam into permanent silent loss.
 */
describe('an enrollment that delivered nothing', () => {
  // Derived from the harness fixture, not rebuilt: a hand-rolled object omitted
  // exitConditions and the worker threw on it, which reads as a code failure.
  const singleLinkedInStep = {
    ...mixedSequence,
    steps: [{ stepId: 's1', stepNumber: 1, name: 'invite', delayDays: 0, channel: 'linkedin', messageText: 'hi' }],
  };

  it('exits as completed_no_sends when no step ever landed', async () => {
    mockDb.getSequence.mockResolvedValue(singleLinkedInStep as any);
    mockDb.getAllDueEnrollments.mockResolvedValue([
      // No lastEmailSentAt / lastLinkedInSentAt: nothing was ever delivered.
      enrollmentAt(0, 'https://www.linkedin.com/in/ada/') as any,
    ]);
    // Free text, not a profile — db.ts stores it verbatim, so the step is skipped.
    mockCrmDb.getLeadById.mockResolvedValue({ leadId: 'lead-1', linkedin: 'Acme Corp' } as any);

    await processDueEnrollments();

    expect(mockDb.completeEnrollment).toHaveBeenCalledWith(
      'e1', 'completed_no_sends', 'completed', 'linkedin', false,
    );
  });

  it('still exits as plain completed when an EARLIER step did send', async () => {
    mockDb.getSequence.mockResolvedValue(singleLinkedInStep as any);
    mockDb.getAllDueEnrollments.mockResolvedValue([
      // The send timestamp is the evidence that something already landed.
      { ...enrollmentAt(0, 'https://www.linkedin.com/in/ada/'), lastEmailSentAt: '2026-01-01T00:00:00Z' } as any,
    ]);
    mockCrmDb.getLeadById.mockResolvedValue({ leadId: 'lead-1', linkedin: 'Acme Corp' } as any);

    await processDueEnrollments();

    expect(mockDb.completeEnrollment).toHaveBeenCalledWith(
      'e1', 'completed', 'completed', 'linkedin', false,
    );
  });
});

/*
 * The worker-side behaviours this PR introduced, none of which had coverage.
 *
 * Each is load-bearing and each was VACUOUS: the suite passed with the code reverted.
 */
describe('worker behaviours that had no coverage', () => {
  it('normalises a mis-cased channel, so a LinkedIn step is not sent as a blank email', async () => {
    // Authored as 'LinkedIn'. Without lower-casing here it fails `=== 'linkedin'` and
    // falls down the EMAIL branch — a blank email, counted as sent, and stamped into
    // lastEmailSentAt.
    mockDb.getSequence.mockResolvedValue({
      ...mixedSequence,
      steps: [{ stepId: 's1', stepNumber: 1, name: 'DM', channel: 'LinkedIn', delayDays: 0, messageText: 'hi' }],
    } as any);
    mockDb.getAllDueEnrollments.mockResolvedValue([
      enrollmentAt(0, 'https://www.linkedin.com/in/ada/') as any,
    ]);
    mockCrmDb.getLeadById.mockResolvedValue({
      leadId: 'lead-1', linkedin: 'https://www.linkedin.com/in/ada/',
    } as any);

    await processDueEnrollments();

    expect(mockLinkedIn.sendMessage).toHaveBeenCalled();
    expect(mockSendAsSender).not.toHaveBeenCalled();
  });

  it('stamps delivered=false when the sequence ends with no step left to send', async () => {
    // currentStep past the end: this branch sends nothing, so it must not claim a send.
    mockDb.getSequence.mockResolvedValue(mixedSequence as any);
    mockDb.getAllDueEnrollments.mockResolvedValue([enrollmentAt(9, 'a@example.org') as any]);
    mockCrmDb.getLeadById.mockResolvedValue({ leadId: 'lead-1', email: 'a@example.org' } as any);

    await processDueEnrollments();

    expect(mockDb.completeEnrollment).toHaveBeenCalledWith(
      'e1', expect.any(String), 'completed', 'email', false,
    );
  });

  it('looks up engagement by the LIVE lead address, not the dedup identity', async () => {
    // The identity of an address-less lead is its LinkedIn URL, which matches no Resend
    // event — so a sequence set to stop on 'replied' kept sending to someone who had
    // already replied.
    mockDb.getSequence.mockResolvedValue({
      ...mixedSequence,
      exitConditions: { onUnsubscribe: true, onEmailEngagement: ['replied'] },
    } as any);
    mockDb.getAllDueEnrollments.mockResolvedValue([
      enrollmentAt(0, 'https://www.linkedin.com/in/ada/') as any,
    ]);
    // The lead HAS gained an address since enrolment.
    mockCrmDb.getLeadById.mockResolvedValue({
      leadId: 'lead-1', email: 'ada@example.org', linkedin: 'https://www.linkedin.com/in/ada/',
    } as any);
    mockUserDb.getUserById.mockResolvedValue({
      userId: 'user-1', email: 'me@x.com', emailDomain: 'x.com',
    } as any);

    await processDueEnrollments();

    expect(mockEmailEventsDb.getEventsByEmailDomainAndLeadEmail)
      .toHaveBeenCalledWith('x.com', 'ada@example.org');
  });

  it('loads the lead when onEmailEngagement is the ONLY exit condition', async () => {
    // onEmailEngagement was missing from the load condition, so `lead` stayed null and
    // the engagement key fell back to the enrollment identity — the exit could never fire.
    mockDb.getSequence.mockResolvedValue({
      ...mixedSequence,
      exitConditions: { onEmailEngagement: ['replied'] },
    } as any);
    mockDb.getAllDueEnrollments.mockResolvedValue([enrollmentAt(0, 'a@example.org') as any]);
    mockCrmDb.getLeadById.mockResolvedValue({ leadId: 'lead-1', email: 'live@example.org' } as any);
    mockUserDb.getUserById.mockResolvedValue({
      userId: 'user-1', email: 'me@x.com', emailDomain: 'x.com',
    } as any);

    await processDueEnrollments();

    expect(mockCrmDb.getLeadById).toHaveBeenCalled();
    expect(mockEmailEventsDb.getEventsByEmailDomainAndLeadEmail)
      .toHaveBeenCalledWith('x.com', 'live@example.org');
  });
});

/*
 * Review round 2, finding 9. There are TWO completion sites, and only one used
 * everDelivered. The `!step` branch — reached when currentStep is already past the end,
 * e.g. the sequence was shortened under a live enrollment — wrote a flat 'completed'
 * even when nothing had ever been sent. That is the same pair of defects the exit
 * reason exists to separate: it reads as fully delivered, and it bars the lead from
 * ever being re-enrolled. The existing test used expect.any(String) here, so the
 * inconsistency was knowingly unpinned.
 */
describe('the no-steps-left branch agrees with the completion branch', () => {
  const emptySequence = { ...mixedSequence, steps: [] };

  it('records completed_no_sends when the enrollment never delivered anything', async () => {
    mockDb.getSequence.mockResolvedValue(emptySequence as any);
    mockDb.getAllDueEnrollments.mockResolvedValue([
      enrollmentAt(0, 'https://www.linkedin.com/in/ada/') as any,
    ]);
    mockCrmDb.getLeadById.mockResolvedValue({ leadId: 'lead-1', linkedin: 'https://www.linkedin.com/in/ada' } as any);

    await processDueEnrollments();

    expect(mockDb.completeEnrollment).toHaveBeenCalledWith(
      'e1', 'completed_no_sends', 'completed', 'email', false,
    );
  });

  it('records plain completed when an earlier step DID deliver', async () => {
    mockDb.getSequence.mockResolvedValue(emptySequence as any);
    mockDb.getAllDueEnrollments.mockResolvedValue([
      { ...enrollmentAt(0, 'https://www.linkedin.com/in/ada/'), lastLinkedInSentAt: '2026-01-01T00:00:00Z' } as any,
    ]);
    mockCrmDb.getLeadById.mockResolvedValue({ leadId: 'lead-1', linkedin: 'https://www.linkedin.com/in/ada' } as any);

    await processDueEnrollments();

    expect(mockDb.completeEnrollment).toHaveBeenCalledWith(
      'e1', 'completed', 'completed', 'email', false,
    );
  });
});
