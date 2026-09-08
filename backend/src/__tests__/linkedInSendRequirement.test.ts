// ENG-1720: a `linkedin_outreach` requirement must be satisfied by a SEND that
// happened. Counting by tool name let ONE successful `search-people` satisfy
// `min: 1` while every `send-invite` was refused — the false success ENG-1132
// AC #2 was filed to catch, and the shape all 8 production schedules that
// declare this requirement are defeated by.

import {
  LINKEDIN_SEND_ACTIONS,
  evaluateLinkedInSendRequirement,
  isLinkedInSendCall,
  linkedInOutreachArgs,
  normalizeLinkedInOutreachAction,
} from '../utils/linkedInSendRequirement';

const read = (action = 'search-people') => ({
  name: 'linkedin_outreach',
  arguments: { action },
  result: { success: true },
});
const sentOk = (action = 'send-invite') => ({
  name: 'linkedin_outreach',
  arguments: { action },
  result: { success: true },
});
const sendFailed = (error = 'Cannot resend yet — account-level invitation cooldown.') => ({
  name: 'linkedin_outreach',
  arguments: { action: 'send-invite' },
  result: { success: false, error },
});

describe('normalizeLinkedInOutreachAction / linkedInOutreachArgs', () => {
  it('folds case AND underscores, matching what the dispatcher routes on', () => {
    // agentModeService.linkedinOutreach opens with action.replace(/_/g, '-'), so
    // `send_invite` really does send. Comparing the raw argument credited one
    // spelling and not the other for the identical send.
    expect(normalizeLinkedInOutreachAction({ arguments: { action: 'send_invite' } })).toBe('send-invite');
    expect(normalizeLinkedInOutreachAction({ arguments: { action: 'SEND-INVITE' } })).toBe('send-invite');
    expect(normalizeLinkedInOutreachAction({ arguments: { action: '  Send_InMail ' } })).toBe('send-inmail');
  });

  it('reads a JSON-string arguments payload the same as a parsed object', () => {
    expect(normalizeLinkedInOutreachAction({ arguments: '{"action":"send-message"}' })).toBe('send-message');
    expect(linkedInOutreachArgs({ arguments: '{"account_id":"acc_1"}' })).toEqual({ account_id: 'acc_1' });
  });

  it('returns empty rather than throwing on missing/unparseable/non-string actions', () => {
    expect(normalizeLinkedInOutreachAction({})).toBe('');
    expect(normalizeLinkedInOutreachAction({ arguments: 'not json' })).toBe('');
    expect(normalizeLinkedInOutreachAction({ arguments: { action: 7 } })).toBe('');
    expect(normalizeLinkedInOutreachAction(null)).toBe('');
    expect(linkedInOutreachArgs({ arguments: 'not json' })).toBeNull();
    expect(linkedInOutreachArgs({ arguments: 42 })).toBeNull();
  });
});

describe('isLinkedInSendCall', () => {
  it('recognises exactly the three actions that contact a real person', () => {
    expect([...LINKEDIN_SEND_ACTIONS].sort()).toEqual(['send-inmail', 'send-invite', 'send-message']);
    ['send-invite', 'send-message', 'send-inmail', 'send_invite'].forEach((action) => {
      expect(isLinkedInSendCall({ name: 'linkedin_outreach', arguments: { action } })).toBe(true);
    });
  });

  it('excludes reads and the non-outreach writes', () => {
    // cancel/accept are writes, but withdrawing an invitation or accepting an
    // inbound request is not the run's own sending work.
    ['search-people', 'get-profile', 'list-connections', 'list-sent-invitations',
      'cancel-invitation', 'accept-invitation', 'set-daily-invite-cap', ''].forEach((action) => {
      expect(isLinkedInSendCall({ name: 'linkedin_outreach', arguments: { action } })).toBe(false);
    });
  });

  it('excludes a send-shaped call on a different tool', () => {
    expect(isLinkedInSendCall({ name: 'twitter_outreach', arguments: { action: 'send-invite' } })).toBe(false);
    expect(isLinkedInSendCall({ name: 'send_email', arguments: { action: 'send-invite' } })).toBe(false);
  });
});

describe('evaluateLinkedInSendRequirement', () => {
  it('THE BUG: a successful read does not satisfy a send requirement when every send failed', () => {
    const verdict = evaluateLinkedInSendRequirement([read(), sendFailed(), sendFailed()], 1);
    expect(verdict).toEqual({
      isSendRun: true,
      attemptedSends: 2,
      successfulSends: 0,
      requirementMissed: true,
      reportedActual: 0,
    });
  });

  it('fails for ANY send failure reason, not only a cooldown/pacing phrasing', () => {
    // ENG-1640 (2026-08-31): 8 leads failing every send across 3+ runs with
    // "recipient cannot be reached" — a class LINKEDIN_INVITE_CAP_BLOCK_RE never
    // matched, so the old path did not even consider it.
    ['This person cannot be reached.', 'provider_error: 502', 'Unknown failure'].forEach((error) => {
      expect(evaluateLinkedInSendRequirement([read(), sendFailed(error)], 1).requirementMissed).toBe(true);
    });
  });

  it('AC #3: a run that attempted NO send keeps the historical name-keyed count', () => {
    // A read-only LinkedIn schedule, and a mixed schedule that legitimately found
    // nobody worth inviting, must not be newly broken. reportedActual is null so
    // the caller leaves its own count in place.
    const verdict = evaluateLinkedInSendRequirement([read(), read('get-profile')], 1);
    expect(verdict).toEqual({
      isSendRun: false,
      attemptedSends: 0,
      successfulSends: 0,
      requirementMissed: false,
      reportedActual: null,
    });
    // Even when the reads themselves failed — a failed read is not a missed send.
    expect(
      evaluateLinkedInSendRequirement(
        [{ name: 'linkedin_outreach', arguments: { action: 'search-people' }, result: { success: false, error: 'Cannot resend yet' } }],
        1,
      ),
    ).toEqual(expect.objectContaining({ isSendRun: false, requirementMissed: false, reportedActual: null }));
  });

  it('is satisfied by a successful send, and reads never pad the count', () => {
    expect(evaluateLinkedInSendRequirement([read(), read(), sentOk()], 1)).toEqual({
      isSendRun: true,
      attemptedSends: 1,
      successfulSends: 1,
      requirementMissed: false,
      // NOT 3 — reporting the name count here is what produced
      // `{ actual: 7, required: 1 }` on a run that sent once.
      reportedActual: 1,
    });
  });

  it('counts partial success against a multi-send minimum', () => {
    const verdict = evaluateLinkedInSendRequirement([sentOk(), sendFailed(), sendFailed()], 2);
    expect(verdict).toEqual(expect.objectContaining({ successfulSends: 1, requirementMissed: true, reportedActual: 1 }));
    expect(evaluateLinkedInSendRequirement([sentOk(), sentOk(), sendFailed()], 2).requirementMissed).toBe(false);
  });

  it('counts message and InMail sends, not just invites', () => {
    expect(evaluateLinkedInSendRequirement([sentOk('send-message')], 1).requirementMissed).toBe(false);
    expect(evaluateLinkedInSendRequirement([sentOk('send-inmail')], 1).requirementMissed).toBe(false);
  });

  it('applies the same never-executed rules as every other evidence check', () => {
    // A suppressed same-turn duplicate and a budget-deferred call executed
    // nothing (toolCallOutcome.ts), so neither may back a "we sent it" claim.
    const duplicate = { ...sentOk(), duplicateOf: 'call_1' };
    const deferred = { name: 'linkedin_outreach', arguments: { action: 'send-invite' }, result: { deferred: true } };
    const errored = { name: 'linkedin_outreach', arguments: { action: 'send-invite' }, error: 'boom' };
    [duplicate, deferred, errored].forEach((entry) => {
      expect(evaluateLinkedInSendRequirement([entry], 1)).toEqual(
        expect.objectContaining({ isSendRun: true, successfulSends: 0, requirementMissed: true }),
      );
    });
  });

  it('treats a missing/invalid minimum as 1, matching the caller default', () => {
    [0, -3, NaN, undefined as any, null as any].forEach((min) => {
      expect(evaluateLinkedInSendRequirement([sendFailed()], min).requirementMissed).toBe(true);
      expect(evaluateLinkedInSendRequirement([sentOk()], min).requirementMissed).toBe(false);
    });
  });

  it('handles a missing/short ledger without throwing', () => {
    [null, undefined, [], [null, undefined]].forEach((calls) => {
      expect(evaluateLinkedInSendRequirement(calls as any, 1)).toEqual(
        expect.objectContaining({ isSendRun: false, requirementMissed: false, reportedActual: null }),
      );
    });
  });
});
