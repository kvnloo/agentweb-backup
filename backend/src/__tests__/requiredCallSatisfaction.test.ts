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
    // Reply / quote-tweet put the mandated content on the owner's timeline too.
    ['reply', 'quote_tweet'].forEach((action) => {
      expect(
        callSatisfiesRequirement('post_on_connected_account', { name: 'twitter_manage_post', arguments: { action } })
      ).toBe(true);
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
