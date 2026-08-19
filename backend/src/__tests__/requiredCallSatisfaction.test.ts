// ENG-1045: the required-function checker must be satisfied by the mandated publish
// OUTCOME, not by the literal function name a schedule spells. A 2+ tweet thread can
// only go out through twitter_manage_post/post_thread, so a name-keyed check on
// post_on_connected_account could never be satisfied after one — and the only way to
// "clear" it was a second, irreversible duplicate post to a live customer timeline.

import {
  callSatisfiesRequirement,
  countCallsSatisfyingRequirement,
} from '../utils/requiredCallSatisfaction';

const successfulThread = {
  name: 'twitter_manage_post',
  arguments: { action: 'post_thread', tweets: ['one', 'two'] },
  result: {},
};

describe('callSatisfiesRequirement', () => {
  it('credits a successful thread publish toward a post_on_connected_account requirement', () => {
    // The reported run: the thread published (tool returned tweet ids), yet the
    // checker kept the requirement at 0 and re-pressed for a duplicate post.
    expect(callSatisfiesRequirement('post_on_connected_account', successfulThread)).toBe(true);
    // Both spellings of the action reach the same dispatcher branch.
    expect(
      callSatisfiesRequirement('post_on_connected_account', {
        ...successfulThread,
        arguments: { action: 'post-thread', tweets: ['one', 'two'] },
      })
    ).toBe(true);
  });

  // ENG-1276 follow-up: reply/quote_tweet are responses TO someone else's
  // tweet, not the schedule's own standalone content going out — crediting one
  // toward "publish tonight's content" would mask a run that replied to an
  // unrelated tweet instead of posting what was actually mandated.
  it('does NOT credit a reply or quote-tweet — those respond to someone else\'s content, not the schedule\'s own', () => {
    ['reply', 'quote_tweet'].forEach((action) => {
      expect(
        callSatisfiesRequirement('post_on_connected_account', { name: 'twitter_manage_post', arguments: { action }, result: { success: true } })
      ).toBe(false);
    });
  });

  it('credits a thread publish toward a post_thread requirement (no tool is named post_thread)', () => {
    expect(callSatisfiesRequirement('post_thread', successfulThread)).toBe(true);
  });

  it('does NOT credit a publish that failed, was rejected, or never executed', () => {
    const fails = [
      { ...successfulThread, error: 'Twitter action failed' },
      { ...successfulThread, result: { success: false } },
      { ...successfulThread, duplicateOf: 'call_1' },
      { ...successfulThread, result: { deferred: true } },
    ];
    fails.forEach((entry) => expect(callSatisfiesRequirement('post_on_connected_account', entry)).toBe(false));
  });

  it('does NOT credit a non-publishing action of the same multiplexing tool', () => {
    ['get_tweet_metrics', 'list_replies', 'delete_tweet', 'like', ''].forEach((action) => {
      expect(
        callSatisfiesRequirement('post_on_connected_account', { name: 'twitter_manage_post', arguments: { action } })
      ).toBe(false);
    });
    // No action at all is not a publish either.
    expect(callSatisfiesRequirement('post_on_connected_account', { name: 'twitter_manage_post' })).toBe(false);
  });

  it('keeps exact-name matching unchanged for every other requirement', () => {
    expect(callSatisfiesRequirement('get_marketing_tips', { name: 'get_marketing_tips' })).toBe(true);
    // A failed same-name call still counts exactly as it did before this change —
    // the equivalence rule is additive, it never removes a match.
    expect(callSatisfiesRequirement('get_marketing_tips', { name: 'get_marketing_tips', error: 'boom' })).toBe(true);
    // Unrelated publishers are NOT interchangeable.
    expect(callSatisfiesRequirement('publish_blog_article', successfulThread)).toBe(false);
    expect(callSatisfiesRequirement('post_on_connected_account', { name: 'publish_blog_article' })).toBe(false);
    // The equivalence is one-directional: a standalone post does not satisfy a
    // schedule that specifically mandates a thread.
    expect(callSatisfiesRequirement('post_thread', { name: 'post_on_connected_account' })).toBe(false);
    expect(callSatisfiesRequirement('get_marketing_tips', null)).toBe(false);
    expect(callSatisfiesRequirement('get_marketing_tips', { name: '' })).toBe(false);
  });
});

describe('countCallsSatisfyingRequirement', () => {
  it('counts name matches and equivalent successful publishes together', () => {
    const ledger = [
      { name: 'you_search_web' },
      { name: 'post_on_connected_account' },
      successfulThread,
      { ...successfulThread, error: 'Twitter action failed' },
    ];
    expect(countCallsSatisfyingRequirement('post_on_connected_account', ledger)).toBe(2);
    expect(countCallsSatisfyingRequirement('you_search_web', ledger)).toBe(1);
    expect(countCallsSatisfyingRequirement('post_on_connected_account', null)).toBe(0);
    expect(countCallsSatisfyingRequirement('post_on_connected_account', [])).toBe(0);
  });
});

// ENG-1276 follow-up — handles a JSON-string `arguments` payload the same as a
// parsed object. A request-only ledger entry can carry `arguments` as the raw
// JSON string the provider sent rather than an already-parsed object; reading
// `.action` off a string directly returns undefined, which would silently fail
// an equivalent-route match for a call that DID name a qualifying action.
describe('callSatisfiesRequirement — JSON-string arguments (ENG-1276 follow-up)', () => {
  it('handles a JSON-string arguments payload the same as a parsed object', () => {
    const entry = {
      name: 'twitter_manage_post',
      arguments: JSON.stringify({ action: 'post_thread', tweets: ['one', 'two'] }),
      result: { success: true },
    };
    expect(callSatisfiesRequirement('post_on_connected_account', entry)).toBe(true);
  });

  it('treats unparseable JSON as no action, not a crash', () => {
    const entry = { name: 'twitter_manage_post', arguments: '{not json', result: { success: true } };
    expect(callSatisfiesRequirement('post_on_connected_account', entry)).toBe(false);
  });
});

/**
 * ENG-1276 follow-up #3 — a full audit of every "use tool X instead" redirect in
 * the tool registry turned up one more verified, genuine analog to
 * twitter_manage_post/post_on_connected_account:
 *
 *   email(action='send') <-> send_email_from_sender
 *
 * Both send a REAL email to a recipient — which one a run actually calls
 * depends on whether the user has a connected mailbox or a configured CRM
 * sender, account state the schedule owner has no way to predict when they set
 * up requiredFunctionCalls. Unlike twitter_manage_post/post_on_connected_account
 * (one-directional), this pair is genuinely BIDIRECTIONAL: whichever tool the
 * account state routes through should credit the OTHER one too.
 */
describe('callSatisfiesRequirement — email/send_email_from_sender (ENG-1276 follow-up #3)', () => {
  it('credits a SUCCEEDED email(action=send) call toward send_email_from_sender', () => {
    const entry = { name: 'email', arguments: { action: 'send', to: 'x@y.com' }, result: { success: true } };
    expect(callSatisfiesRequirement('send_email_from_sender', entry)).toBe(true);
  });

  it('credits a SUCCEEDED send_email_from_sender call toward email (the reverse direction)', () => {
    const entry = { name: 'send_email_from_sender', arguments: { to: 'x@y.com' }, result: { success: true } };
    expect(callSatisfiesRequirement('email', entry)).toBe(true);
  });

  it('does NOT credit any non-send email action', () => {
    ['search', 'list', 'get'].forEach((action) => {
      expect(
        callSatisfiesRequirement('send_email_from_sender', { name: 'email', arguments: { action }, result: { success: true } })
      ).toBe(false);
    });
  });

  it('does NOT credit a FAILED call in either direction', () => {
    expect(
      callSatisfiesRequirement('send_email_from_sender', { name: 'email', arguments: { action: 'send' }, error: 'rate limited' })
    ).toBe(false);
    expect(
      callSatisfiesRequirement('email', { name: 'send_email_from_sender', arguments: {}, error: 'no sender configured' })
    ).toBe(false);
  });
});

/**
 * ENG-1276 follow-up #2 — a schedule that requires BOTH names of an equivalence
 * pair as SEPARATE line items (e.g. both post_on_connected_account AND
 * twitter_manage_post, or both email and send_email_from_sender) wants two
 * distinct actions, not one call silently satisfying both. No evidenced
 * schedule does this today, but the equivalence credit must not blindly
 * double-credit if one ever does.
 */
describe('callSatisfiesRequirement — suppresses the equivalence credit when both names are separately required (ENG-1276 follow-up #2)', () => {
  it('still credits when the caller passes NO requirement list (legacy callers keep today\'s fix)', () => {
    expect(callSatisfiesRequirement('post_on_connected_account', successfulThread)).toBe(true);
  });

  it('still credits when the schedule requires ONLY post_on_connected_account (the evidenced production case)', () => {
    const required = ['post_on_connected_account', 'generate_image'];
    expect(callSatisfiesRequirement('post_on_connected_account', successfulThread, required)).toBe(true);
  });

  it('still credits when the schedule requires ONLY twitter_manage_post (nothing to double-credit against)', () => {
    expect(callSatisfiesRequirement('post_on_connected_account', successfulThread, ['twitter_manage_post'])).toBe(true);
  });

  it('SUPPRESSES the equivalence credit when the schedule requires BOTH names as separate line items', () => {
    const required = ['post_on_connected_account', 'twitter_manage_post'];
    expect(callSatisfiesRequirement('post_on_connected_account', successfulThread, required)).toBe(false);
    // The exact-name match toward twitter_manage_post's OWN requirement is unaffected.
    expect(callSatisfiesRequirement('twitter_manage_post', successfulThread, required)).toBe(true);
  });

  it('accepts a Set as well as an array/iterable for the requirement list', () => {
    const required = new Set(['post_on_connected_account', 'twitter_manage_post']);
    expect(callSatisfiesRequirement('post_on_connected_account', successfulThread, required)).toBe(false);
  });

  it('suppresses the email alias when a schedule requires BOTH email and send_email_from_sender', () => {
    const required = ['email', 'send_email_from_sender'];
    const emailSend = { name: 'email', arguments: { action: 'send' }, result: { success: true } };
    expect(callSatisfiesRequirement('send_email_from_sender', emailSend, required)).toBe(false);

    const senderSend = { name: 'send_email_from_sender', arguments: {}, result: { success: true } };
    expect(callSatisfiesRequirement('email', senderSend, required)).toBe(false);
  });

  it('still credits the email alias when only ONE of the pair is required (the realistic case)', () => {
    const emailSend = { name: 'email', arguments: { action: 'send' }, result: { success: true } };
    expect(callSatisfiesRequirement('send_email_from_sender', emailSend, ['send_email_from_sender'])).toBe(true);
  });

  it('countCallsSatisfyingRequirement threads the requirement list through too', () => {
    const required = ['post_on_connected_account', 'twitter_manage_post'];
    const ledger = [successfulThread, { name: 'post_on_connected_account', result: { success: true } }];
    expect(countCallsSatisfyingRequirement('post_on_connected_account', ledger, required)).toBe(1);
    expect(countCallsSatisfyingRequirement('twitter_manage_post', ledger, required)).toBe(1);
  });
});
