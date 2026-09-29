/**
 * Auto-enroll must use the same channel rules as the enrol routes.
 *
 * Both copies of autoEnrollLeadInSequences (crm.ts and webhooks.ts — the function is
 * duplicated) gated on `if (!leadEmail) return`. Once enrolling a LinkedIn-only list
 * into a LinkedIn sequence became possible, sequences.ts added that list to
 * autoEnrollListIds — switching auto-enroll ON for a list whose future leads were then
 * silently dropped here for having no address. The capability worked exactly once, for
 * the leads present at the time.
 *
 * Tested through the shared predicates rather than the route handlers: the two copies
 * now call requiredChannels/leadIsReachable/enrollmentIdentity, so this pins the
 * decision they both make.
 */
import {
  requiredChannels, leadIsReachable, enrollmentIdentity,
} from '../utils/leadReachability';

const linkedInSeq = { steps: [{ channel: 'linkedin', messageText: 'hi' }] };
const emailSeq = { steps: [{ subject: 'Hi', bodyHtml: 'y' }] };
const mixedSeq = { steps: [{ subject: 'Hi', bodyHtml: 'y' }, { channel: 'linkedin', messageText: 'z' }] };

const decide = (seq: any, lead: any) => {
  const channels = requiredChannels(seq);
  if (!leadIsReachable(lead, channels)) return null;
  const identity = enrollmentIdentity(lead);
  return identity || null;
};

describe('auto-enroll decides the same way the enrol routes do', () => {
  it('enrols a LinkedIn-only lead into a LinkedIn sequence — the case the email gate dropped', () => {
    expect(decide(linkedInSeq, { linkedin: 'https://linkedin.com/in/ada' }))
      .toBe('https://www.linkedin.com/in/ada/');
  });

  it('enrols an email-only lead into a mixed sequence', () => {
    expect(decide(mixedSeq, { email: 'ada@example.org' })).toBe('ada@example.org');
  });

  it('refuses an email-only lead for a LinkedIn-only sequence', () => {
    expect(decide(linkedInSeq, { email: 'ada@example.org' })).toBeNull();
  });

  it('refuses a lead reachable on no channel at all', () => {
    expect(decide(mixedSeq, { phone: '2125550000' })).toBeNull();
  });

  it('refuses a malformed address rather than enrolling and retrying forever', () => {
    expect(decide(emailSeq, { email: 'a@x..com' })).toBeNull();
  });

  it('refuses free text in the linkedin field', () => {
    expect(decide(linkedInSeq, { linkedin: 'Acme Corp' })).toBeNull();
  });

  it('never returns an empty identity — that row would be invisible to dedup', () => {
    for (const lead of [{}, { email: '' }, { linkedin: '' }, { email: '   ' }]) {
      expect(decide(mixedSeq, lead)).toBeNull();
    }
  });

  it('gives one identity for two spellings of the same profile', () => {
    const a = decide(linkedInSeq, { linkedin: 'https://www.linkedin.com/in/ada/' });
    const b = decide(linkedInSeq, { linkedin: 'https://linkedin.com/in/ada' });
    expect(a).toBe(b);
  });
});
