import {
  APPROVAL_KIND_RESERVED_PREFIX, APPROVAL_TTL_MS, APPROVE_OPTION_ID, DECLINE_OPTION_ID,
  approvalKindPrefix, buildApprovalQuestion, checkAttendedForApproval, computeApprovalDigest, consumedKeyOf,
  findApproval, newApprovalKind, type ApprovalDigestInput,
} from '../services/voice/hotLeadCallApprovalGate';
import { deckHalt, deckReply, type DeckMessage } from './helpers/approvalDeckHistory';

const NOW = Date.parse('2026-10-22T12:00:00.000Z');
const base: ApprovalDigestInput = {
  action: 'provision', orgId: 'org-a', userId: 'owner', sessionId: 's1', target: '415', rentText: '$1.15 per month', revision: 'rev1',
};
const digest = computeApprovalDigest(base);
const prefix = approvalKindPrefix('provision', digest);

type Msg = DeckMessage;
/** A halt message carrying one card, optionally followed by the reply message that answers it. */
function card(kind: string, deckId: string, answer?: { verdict: string; answeredBy?: 'user' | 'delegation'; at?: string }): Msg[] {
  const halt = deckHalt(kind, deckId);
  if (!answer) return [halt];
  return [halt, deckReply(deckId, answer.verdict, answer.answeredBy ?? 'user', answer.at ?? new Date(NOW - 60_000).toISOString())];
}
const find = (messages: Msg[], consumed: string[] = [], pre = prefix) => findApproval(messages, pre, NOW, new Set(consumed));

describe('computeApprovalDigest', () => {
  it('is stable for equal input', () => expect(computeApprovalDigest({ ...base })).toBe(digest));
  it.each<[string, Partial<ApprovalDigestInput>]>([
    ['action', { action: 'release' }],
    ['org', { orgId: 'org-b' }],
    ['user', { userId: 'other' }],
    ['session', { sessionId: 's2' }],
    ['area code', { target: '212' }],
    ['no area code', { target: null }],
    ['rent', { rentText: '$2.00 per month' }],
    ['settings revision', { revision: 'rev2' }],
  ])('changes with the %s', (_name, change) => expect(computeApprovalDigest({ ...base, ...change })).not.toBe(digest));
});

describe('approval card', () => {
  const kind = newApprovalKind('provision', digest);
  it('carries a fresh nonce under the digest prefix', () => {
    expect(kind.startsWith(prefix)).toBe(true);
    expect(kind.startsWith(APPROVAL_KIND_RESERVED_PREFIX)).toBe(true);
    expect(newApprovalKind('provision', digest)).not.toBe(kind);
  });
  it('lists the cautious option first, recommends only it, and cannot be delegated or auto-taken', () => {
    const q = buildApprovalQuestion({ action: 'provision', kind, rentText: '$1.15 per month', areaCode: '415' });
    expect(q.options.map(o => o.id)).toEqual([DECLINE_OPTION_ID, APPROVE_OPTION_ID]);
    expect(q.options.filter(o => o.recommended).map(o => o.id)).toEqual([DECLINE_OPTION_ID]);
    expect(q).toMatchObject({ allowEmmaDecide: false, immutable: true, kind });
  });
  it('states the rent and the area code to buy', () => {
    const q = buildApprovalQuestion({ action: 'provision', kind, rentText: '$1.15 per month', areaCode: '415' });
    expect(q.question).toContain('$1.15 per month');
    expect(q.question).toContain('area code 415');
  });
  it('names the number being released', () => {
    const q = buildApprovalQuestion({ action: 'release', kind, rentText: '$1.15 per month', number: '+1•••0111' });
    expect(q.question).toContain('+1•••0111');
    expect(q.question).toMatch(/cannot be recovered/);
  });
});

describe('findApproval', () => {
  const kind = `${prefix}n1`;
  it('has nothing without a card', () => expect(find([])).toEqual({ status: 'none', reason: 'no_card' }));
  it('does not approve an unanswered card', () => expect(find(card(kind, 'd1'))).toEqual({ status: 'none', reason: 'unanswered' }));
  it('approves the user clicking approve', () => expect(find(card(kind, 'd1', { verdict: 'approve' }))).toEqual({ status: 'approved', kind }));
  it('does not approve a decline', () => expect(find(card(kind, 'd1', { verdict: 'decline' }))).toEqual({ status: 'none', reason: 'declined' }));
  it('does not approve a delegated answer, even an approve', () =>
    expect(find(card(kind, 'd1', { verdict: 'approve', answeredBy: 'delegation' }))).toEqual({ status: 'none', reason: 'not_human' }));
  it('does not approve a comment verdict', () => expect(find(card(kind, 'd1', { verdict: 'comment' })).status).toBe('none'));
  it('expires after the time limit', () => {
    const at = (age: number) => new Date(NOW - age).toISOString();
    expect(find(card(kind, 'd1', { verdict: 'approve', at: at(APPROVAL_TTL_MS) })).status).toBe('approved');
    expect(find(card(kind, 'd1', { verdict: 'approve', at: at(APPROVAL_TTL_MS + 1) }))).toEqual({ status: 'none', reason: 'expired' });
  });
  it('rejects an answer without a usable timestamp', () => expect(find(card(kind, 'd1', { verdict: 'approve', at: 'garbage' }))).toEqual({ status: 'none', reason: 'expired' }));
  it('rejects an answer dated in the future', () =>
    expect(find(card(kind, 'd1', { verdict: 'approve', at: new Date(NOW + 10 * 60_000).toISOString() })).status).toBe('none'));
  it('does not approve a used card', () => expect(find(card(kind, 'd1', { verdict: 'approve' }), [kind])).toEqual({ status: 'none', reason: 'consumed' }));
  it('ignores approvals for another action or another digest', () => {
    const other = approvalKindPrefix('release', digest) + 'n1';
    const otherDigest = approvalKindPrefix('provision', computeApprovalDigest({ ...base, target: '212' })) + 'n1';
    expect(find([...card(other, 'd1', { verdict: 'approve' }), ...card(otherDigest, 'd2', { verdict: 'approve' })]).status).toBe('none');
  });
  it('lets the newest card win over an older approval', () => {
    const older = card(`${prefix}old`, 'd1', { verdict: 'approve' });
    expect(find([...older, ...card(`${prefix}new`, 'd2', { verdict: 'decline' })])).toEqual({ status: 'none', reason: 'declined' });
    expect(find([...older, ...card(`${prefix}new`, 'd2')])).toEqual({ status: 'none', reason: 'unanswered' });
  });
  it('lets a newer approval win over an older decline', () => {
    const older = card(`${prefix}old`, 'd1', { verdict: 'decline' });
    expect(find([...older, ...card(`${prefix}new`, 'd2', { verdict: 'approve' })])).toEqual({ status: 'approved', kind: `${prefix}new` });
  });
  it('builds the single-use key from the card kind', () => expect(consumedKeyOf(kind)).toBe(`hotlead:${kind}`));
});

describe('checkAttendedForApproval', () => {
  const ok = { sessionId: 's1', session: { sessionType: 'chat' } };
  it('allows an attended chat and returns the session', () => expect(checkAttendedForApproval(ok)).toEqual({ allowed: true, sessionId: 's1', session: ok.session }));
  it.each<[string, Parameters<typeof checkAttendedForApproval>[0]]>([
    ['unattended', { ...ok, unattended: true }],
    ['delegated', { ...ok, delegated: true }],
    ['no session id', { session: ok.session }],
    ['unreadable session', { sessionId: 's1', session: null }],
    ['scheduled session', { sessionId: 's1', session: { sessionType: 'scheduled' } }],
  ])('refuses %s', (_n, facts) => expect(checkAttendedForApproval(facts).allowed).toBe(false));
});
