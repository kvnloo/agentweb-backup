/**
 * ENG-947 — an irreversible publish that FAILED must not satisfy a schedule's
 * `requiredFunctionCalls`.
 *
 * Verified live on the preview environment 2026-08-11: a scheduled run whose
 * `post_on_connected_account` call returned
 *   "Tool Error: Multiple twitter accounts connected"
 * published nothing, and was still stored as `status: success`, `passed: true`,
 * `functionCallMatches: ['post_on_connected_account']`. runVerifiedChat builds its
 * requirement ledger from `toolCalls.map(c => c.name)`, so an ATTEMPT counts the
 * same as a SEND.
 *
 * ENG-803 already wrote the correct predicate for this (`toolCallSucceeded`) and
 * wired it into the session-title summary only — its own tests name
 * `post_on_connected_account` explicitly while the gate that decides pass/fail
 * never consults it. This is that same false-success, one layer down.
 *
 * SCOPED TO PUBLISH TOOLS ON PURPOSE. Requiring success for every tool would
 * change pass/fail for every scheduled run with `requiredFunctionCalls` — many
 * would start failing and retrying — which is a product decision, not a bug fix.
 * An irreversible external publish is the case where "it was attempted" and "it
 * happened" are genuinely different facts to the schedule's owner, so only that
 * family is tightened here. The non-publish behaviour is pinned below so a later
 * change cannot widen it by accident.
 */

import { countsTowardRequirement, requirementEvidenceNames } from '../utils/toolCallOutcome';

describe('countsTowardRequirement (ENG-947)', () => {
  it('rejects a publish that reported a top-level error', () => {
    // The exact shape the preview run persisted.
    expect(countsTowardRequirement({
      name: 'post_on_connected_account',
      result: {},
      error: 'Multiple twitter accounts connected. Call list_connected_accounts…',
    })).toBe(false);
  });

  it('rejects a publish whose preflight came back success:false', () => {
    expect(countsTowardRequirement({ name: 'publish_blog_post', result: { success: false } })).toBe(false);
  });

  it('rejects a publish that never executed at all', () => {
    expect(countsTowardRequirement({ name: 'post_on_connected_account', result: { deferred: true } })).toBe(false);
    expect(countsTowardRequirement({ name: 'post_on_connected_account', duplicateOf: 'call_1' })).toBe(false);
  });

  it('rejects malformed entries rather than reading them as a publish', () => {
    expect(countsTowardRequirement(null)).toBe(false);
    expect(countsTowardRequirement(undefined)).toBe(false);
    expect(countsTowardRequirement('post_on_connected_account' as any)).toBe(false);
  });

  it('accepts a publish that actually landed', () => {
    expect(countsTowardRequirement({
      name: 'post_on_connected_account',
      result: { success: true, tweetId: '1' },
    })).toBe(true);
  });

  it('accepts a publish that returned a payload with no success flag', () => {
    // Most tools return a payload rather than {success}; treating an absent flag as
    // failure would erase real publishes from the ledger (ENG-803's reasoning).
    expect(countsTowardRequirement({ name: 'post_on_connected_account', result: { postId: 'x' } })).toBe(true);
  });

  it('leaves NON-publish tools on the old attempted-counts rule', () => {
    // The scope guard. A failed read/search still satisfies its requirement exactly
    // as it did before, so no non-publish schedule changes behaviour.
    expect(countsTowardRequirement({ name: 'analyze_competitors', error: 'upstream 500' })).toBe(true);
    expect(countsTowardRequirement({ name: 'describe_image', result: { success: false } })).toBe(true);
    expect(countsTowardRequirement({ name: 'you_search_web' })).toBe(true);
  });
});

describe('requirementEvidenceNames (ENG-947)', () => {
  it('drops only the failed publishes from a mixed ledger', () => {
    const ledger = [
      { name: 'update_knowledge_base_file', result: { success: true } },
      { name: 'post_on_connected_account', error: 'Multiple twitter accounts connected' },
      { name: 'analyze_competitors', error: 'upstream 500' },
      { name: 'post_on_connected_account', result: { success: true } },
    ];
    expect(requirementEvidenceNames(ledger)).toEqual([
      'update_knowledge_base_file',
      'analyze_competitors',
      'post_on_connected_account',
    ]);
  });

  it('reproduces the preview run: a lone failed publish leaves NO evidence', () => {
    expect(requirementEvidenceNames([
      { name: 'post_on_connected_account', result: {}, error: 'Multiple twitter accounts connected' },
    ])).toEqual([]);
  });

  it('survives a missing or malformed ledger', () => {
    expect(requirementEvidenceNames(undefined as any)).toEqual([]);
    expect(requirementEvidenceNames([null, undefined, { noName: true }] as any)).toEqual([]);
  });
});

/**
 * ENG-1276 follow-up — a schedule's requiredFunctionCalls names
 * `post_on_connected_account`, but `twitter_manage_post`'s OWN description tells
 * the model to use `post_thread` instead for a multi-tweet thread ("NEVER use
 * this tool to post a single new tweet — use post_on_connected_account for
 * that... if you only have 1 tweet, use post_on_connected_account instead"). A
 * schedule has no way to know its agent will reach for the thread-specific tool,
 * so a real, successful, irreversible publish never satisfied the requirement
 * and the run was pressed to publish a DUPLICATE thread for the full 20-attempt
 * budget (ENG-1276: a real production run published a 3-tweet thread via
 * twitter_manage_post(post_thread), then got nudged 19 times with "Please try
 * again. Make sure to post_on_connected_account" even though re-calling it
 * would have duplicated a live post).
 *
 * Every OTHER twitter_manage_post action (reply/quote_tweet/like/unlike/
 * retweet/unretweet/delete_tweet/get_tweet_metrics/list_replies/...) is not a
 * new standalone post and must NOT alias — only post_thread creates the kind of
 * content post_on_connected_account would have. linkedin_manage_post never gets
 * an alias at all: none of its actions (repost/comment/list_comments/react/
 * get_analytics) create a new top-level post the way post_on_connected_account
 * does.
 */
describe('requirementEvidenceNames aliases the thread-post substitute (ENG-1276 follow-up)', () => {
  it('credits a SUCCEEDED post_thread call toward post_on_connected_account', () => {
    const ledger = [
      {
        name: 'twitter_manage_post',
        arguments: { action: 'post_thread', tweets: ['one', 'two', 'three'] },
        result: { success: true, data: [{ id: '1' }, { id: '2' }, { id: '3' }] },
      },
    ];
    expect(requirementEvidenceNames(ledger)).toEqual(['twitter_manage_post', 'post_on_connected_account']);
  });

  it('handles a JSON-string arguments payload the same as a parsed object', () => {
    const ledger = [
      {
        name: 'twitter_manage_post',
        arguments: JSON.stringify({ action: 'post_thread', tweets: ['one', 'two'] }),
        result: { success: true },
      },
    ];
    expect(requirementEvidenceNames(ledger)).toEqual(['twitter_manage_post', 'post_on_connected_account']);
  });

  it('does NOT alias a FAILED post_thread call — nothing actually published', () => {
    // twitter_manage_post itself keeps the historical non-publish "attempted
    // counts" rule (unrelated to this alias, ENG-947 scopes tightening to
    // publish-classified names only) — but the ALIAS specifically must require
    // success, since it stands in for an irreversible publish.
    const ledger = [
      {
        name: 'twitter_manage_post',
        arguments: { action: 'post_thread', tweets: ['one', 'two'] },
        error: 'rate limited',
      },
    ];
    expect(requirementEvidenceNames(ledger)).toEqual(['twitter_manage_post']);
  });

  it('does NOT alias any non-post_thread twitter_manage_post action', () => {
    const actions = ['reply', 'quote_tweet', 'delete_tweet', 'like', 'unlike', 'retweet', 'unretweet', 'get_tweet_metrics'];
    for (const action of actions) {
      const ledger = [{ name: 'twitter_manage_post', arguments: { action }, result: { success: true } }];
      expect([action, requirementEvidenceNames(ledger)]).toEqual([action, ['twitter_manage_post']]);
    }
  });

  it('does NOT alias linkedin_manage_post — none of its actions are a new top-level post', () => {
    const actions = ['repost', 'comment', 'list_comments', 'react', 'get_analytics'];
    for (const action of actions) {
      const ledger = [{ name: 'linkedin_manage_post', arguments: { action }, result: { success: true } }];
      expect([action, requirementEvidenceNames(ledger)]).toEqual([action, ['linkedin_manage_post']]);
    }
  });
});

/**
 * ENG-1276 follow-up #2 — a schedule that requires BOTH post_on_connected_account
 * AND twitter_manage_post as SEPARATE line items wants two distinct actions, not
 * one thread-post call silently satisfying both. No evidenced schedule does this
 * today, but the alias must not blindly double-credit if one ever does: the
 * caller can pass the schedule's own requiredFunctionCalls, and the alias is
 * suppressed exactly when the schedule ALSO separately requires the alias's
 * SOURCE tool name (twitter_manage_post) as its own requirement.
 */
describe('requirementEvidenceNames suppresses the alias when both names are separately required (ENG-1276 follow-up)', () => {
  const succeededPostThread = [
    { name: 'twitter_manage_post', arguments: { action: 'post_thread', tweets: ['one', 'two'] }, result: { success: true } },
  ];

  it('still aliases when the caller passes NO requirement list (legacy callers keep today\'s fix)', () => {
    expect(requirementEvidenceNames(succeededPostThread)).toEqual(['twitter_manage_post', 'post_on_connected_account']);
  });

  it('still aliases when the schedule requires ONLY post_on_connected_account (the evidenced production case)', () => {
    expect(requirementEvidenceNames(succeededPostThread, ['post_on_connected_account', 'generate_image'])).toEqual([
      'twitter_manage_post',
      'post_on_connected_account',
    ]);
  });

  it('still aliases when the schedule requires ONLY twitter_manage_post (nothing to double-credit against)', () => {
    expect(requirementEvidenceNames(succeededPostThread, ['twitter_manage_post'])).toEqual([
      'twitter_manage_post',
      'post_on_connected_account',
    ]);
  });

  it('SUPPRESSES the alias when the schedule requires BOTH names as separate line items', () => {
    expect(requirementEvidenceNames(succeededPostThread, ['post_on_connected_account', 'twitter_manage_post'])).toEqual([
      'twitter_manage_post',
    ]);
  });

  it('accepts a Set as well as an array for the requirement list', () => {
    const required = new Set(['post_on_connected_account', 'twitter_manage_post']);
    expect(requirementEvidenceNames(succeededPostThread, required)).toEqual(['twitter_manage_post']);
  });
});

/**
 * ENG-1276 follow-up #3 — a full audit of every "use tool X instead" redirect
 * in the tool registry (see the drift/coverage test in
 * agentModeController.conditionalSkip.test.ts) turned up ONE more verified,
 * genuine analog to twitter_manage_post/post_on_connected_account:
 *
 *   email(action='send') <-> send_email_from_sender
 *
 * Both send a REAL email to a recipient — email's own description says
 * "Prefer this over the `email` tool when the user has no connected mailbox
 * but has a configured sender" and send_email_from_sender's says the mirror
 * image ("Prefer this over the `email` tool when..."). Which one a run
 * actually calls depends on whether the user has a connected mailbox or a
 * configured CRM sender — account state the schedule owner has no way to
 * predict when they set up requiredFunctionCalls. Verified via both
 * execute() paths: email(action='send') resolves through
 * resolveEmailAccount(userId, account_id, 'send') (a real write), and
 * send_email_from_sender always sends (no action param — every call IS a
 * send) via sendEmailFromConfiguredSender.
 *
 * Unlike twitter_manage_post/post_on_connected_account (one-directional —
 * post_on_connected_account can never do a thread), this pair is genuinely
 * BIDIRECTIONAL: whichever tool the account state routes through should
 * credit the OTHER one too.
 */
describe('requirementEvidenceNames aliases the email send substitute (ENG-1276 follow-up #3)', () => {
  it('credits a SUCCEEDED email(action=send) call toward send_email_from_sender', () => {
    const ledger = [{ name: 'email', arguments: { action: 'send', to: 'x@y.com' }, result: { success: true } }];
    expect(requirementEvidenceNames(ledger)).toEqual(['email', 'send_email_from_sender']);
  });

  it('credits a SUCCEEDED send_email_from_sender call toward email (the reverse direction)', () => {
    const ledger = [{ name: 'send_email_from_sender', arguments: { to: 'x@y.com' }, result: { success: true } }];
    expect(requirementEvidenceNames(ledger)).toEqual(['send_email_from_sender', 'email']);
  });

  it('does NOT alias any non-send email action', () => {
    const actions = ['search', 'list', 'get'];
    for (const action of actions) {
      const ledger = [{ name: 'email', arguments: { action }, result: { success: true } }];
      expect([action, requirementEvidenceNames(ledger)]).toEqual([action, ['email']]);
    }
  });

  it('does NOT alias a FAILED call in either direction', () => {
    expect(requirementEvidenceNames([{ name: 'email', arguments: { action: 'send' }, error: 'rate limited' }])).toEqual(['email']);
    expect(requirementEvidenceNames([{ name: 'send_email_from_sender', arguments: {}, error: 'no sender configured' }])).toEqual([
      'send_email_from_sender',
    ]);
  });

  it('suppresses the alias when a schedule requires BOTH email and send_email_from_sender', () => {
    const emailSend = [{ name: 'email', arguments: { action: 'send' }, result: { success: true } }];
    expect(requirementEvidenceNames(emailSend, ['email', 'send_email_from_sender'])).toEqual(['email']);

    const senderSend = [{ name: 'send_email_from_sender', arguments: {}, result: { success: true } }];
    expect(requirementEvidenceNames(senderSend, ['email', 'send_email_from_sender'])).toEqual(['send_email_from_sender']);
  });

  it('still aliases when only ONE of the pair is required (the realistic case)', () => {
    const emailSend = [{ name: 'email', arguments: { action: 'send' }, result: { success: true } }];
    expect(requirementEvidenceNames(emailSend, ['send_email_from_sender'])).toEqual(['email', 'send_email_from_sender']);
  });
});
