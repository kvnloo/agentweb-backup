/**
 * The webhooks.ts copy of autoEnrollLeadInSequences is channel-aware too.
 *
 * Review round 2, finding 4. `autoEnrollLeadInSequences` exists TWICE — once in
 * routes/crm.ts and once here — and both carried the same `if (!leadEmail) return`
 * gate. The crm.ts copy was exported and guarded specifically because "testing the
 * predicates alone left both call sites unpinned"; this one was left private, so
 * reinstating its gate passed 219/219 webhooks tests. The fix was correct and entirely
 * unprotected.
 *
 * The reachable shape matters: /api/webhooks/forward-lead refuses a submission with
 * neither email nor phone BEFORE it reaches this function (verified live on env2), so
 * the lead this path actually has to serve is `{phone, linkedin}` — a lead with no
 * address at all, which is precisely what the old gate dropped.
 */
const mockGetSequencesByAutoEnrollList = jest.fn();
const mockBulkEnroll = jest.fn();

jest.mock('../services/dripSequenceDb', () => ({
  dripSequenceDb: {
    getSequencesByAutoEnrollList: (...a: any[]) => mockGetSequencesByAutoEnrollList(...a),
    bulkEnroll: (...a: any[]) => mockBulkEnroll(...a),
  },
}));

import { autoEnrollLeadInSequences } from '../routes/webhooks';

const linkedInSeq = {
  sequenceId: 'seq-li',
  steps: [{ stepNumber: 1, channel: 'linkedin', messageText: 'hi' }],
};
const emailSeq = {
  sequenceId: 'seq-em',
  steps: [{ stepNumber: 1, subject: 'Hi', bodyHtml: 'x' }],
};
const mixedSeq = {
  sequenceId: 'seq-mix',
  steps: [
    { stepNumber: 1, subject: 'Hi', bodyHtml: 'x' },
    { stepNumber: 2, channel: 'linkedin', messageText: 'hi' },
  ],
};

beforeEach(() => {
  mockGetSequencesByAutoEnrollList.mockReset().mockResolvedValue([]);
  mockBulkEnroll.mockReset().mockResolvedValue({ enrolled: 1, skipped: 0 });
});

const enrolledIdentity = () => mockBulkEnroll.mock.calls[0][0][0].leadEmail;

describe('webhook auto-enroll is channel-aware', () => {
  it('enrols a lead with a phone and a profile but NO email — the shape this route produces', async () => {
    mockGetSequencesByAutoEnrollList.mockResolvedValue([linkedInSeq]);

    await autoEnrollLeadInSequences('user-1', 'list-1', 'lead-1', {
      linkedin: 'https://www.linkedin.com/in/ada',
    } as any);

    expect(mockBulkEnroll).toHaveBeenCalledTimes(1);
    expect(enrolledIdentity()).toBe('https://www.linkedin.com/in/ada/');
  });

  it('keys the enrollment on the CANONICAL profile, so two spellings are one person', async () => {
    mockGetSequencesByAutoEnrollList.mockResolvedValue([linkedInSeq]);

    await autoEnrollLeadInSequences('user-1', 'list-1', 'lead-1', {
      linkedin: 'https://www.LinkedIn.com/IN/Ada/?trk=x',
    } as any);

    expect(enrolledIdentity()).toBe('https://www.linkedin.com/in/ada/');
  });

  it('offers both identities for dedup when the lead has an email and a profile', async () => {
    mockGetSequencesByAutoEnrollList.mockResolvedValue([mixedSeq]);

    await autoEnrollLeadInSequences('user-1', 'list-1', 'lead-1', {
      email: 'ada@acme.io', linkedin: 'https://www.linkedin.com/in/ada',
    } as any);

    const input = mockBulkEnroll.mock.calls[0][0][0];
    expect(input.leadEmail).toBe('ada@acme.io');
    expect(input.identityCandidates).toEqual(
      expect.arrayContaining(['ada@acme.io', 'https://www.linkedin.com/in/ada/']),
    );
  });

  it('refuses an email-only lead for a LinkedIn-only sequence', async () => {
    mockGetSequencesByAutoEnrollList.mockResolvedValue([linkedInSeq]);

    await autoEnrollLeadInSequences('user-1', 'list-1', 'lead-1', { email: 'ada@acme.io' } as any);

    expect(mockBulkEnroll).not.toHaveBeenCalled();
  });

  it('refuses a profile-only lead for an email-only sequence', async () => {
    mockGetSequencesByAutoEnrollList.mockResolvedValue([emailSeq]);

    await autoEnrollLeadInSequences('user-1', 'list-1', 'lead-1', {
      linkedin: 'https://www.linkedin.com/in/ada',
    } as any);

    expect(mockBulkEnroll).not.toHaveBeenCalled();
  });

  it('refuses free text in the linkedin field rather than enrolling and skipping forever', async () => {
    mockGetSequencesByAutoEnrollList.mockResolvedValue([linkedInSeq]);

    await autoEnrollLeadInSequences('user-1', 'list-1', 'lead-1', { linkedin: 'Acme Corp' } as any);

    expect(mockBulkEnroll).not.toHaveBeenCalled();
  });

  it('refuses a malformed address rather than enrolling and retrying forever', async () => {
    mockGetSequencesByAutoEnrollList.mockResolvedValue([emailSeq]);

    await autoEnrollLeadInSequences('user-1', 'list-1', 'lead-1', { email: 'a@x..com' } as any);

    expect(mockBulkEnroll).not.toHaveBeenCalled();
  });

  it('never enrols with an empty identity — that row is invisible to dedup', async () => {
    mockGetSequencesByAutoEnrollList.mockResolvedValue([linkedInSeq, emailSeq, mixedSeq]);

    await autoEnrollLeadInSequences('user-1', 'list-1', 'lead-1', {
      email: 'a@x..com', linkedin: 'Acme Corp',
    } as any);

    expect(mockBulkEnroll).not.toHaveBeenCalled();
  });

  it('still accepts the legacy bare-string call shape', async () => {
    mockGetSequencesByAutoEnrollList.mockResolvedValue([emailSeq]);

    await autoEnrollLeadInSequences('user-1', 'list-1', 'lead-1', 'ada@acme.io');

    expect(enrolledIdentity()).toBe('ada@acme.io');
  });

  it('swallows a downstream failure — auto-enroll is fire-and-forget', async () => {
    mockGetSequencesByAutoEnrollList.mockRejectedValue(new Error('dynamo down'));
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      autoEnrollLeadInSequences('user-1', 'list-1', 'lead-1', 'ada@acme.io'),
    ).resolves.toBeUndefined();

    spy.mockRestore();
  });
});
