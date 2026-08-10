/**
 * ENG-803 — the publish-approval setting is ENFORCED at dispatch, not just asked for
 * in the prompt (Greptile review #21), and that enforcement is complete (review #22).
 *
 * A directive is guidance, and this ticket is literally a report of a model
 * reasoning its way around instructions. An owner-facing safety setting that only
 * exists as prompt text is not a boundary.
 *
 * These tests pin the SCOPE of the block, which is where it can do damage in either
 * direction: too narrow and LinkedIn publishing slips through (review #22), too
 * broad and the reported X reply run can no longer even read the mentions it is
 * supposed to draft answers to.
 *
 * They import the REAL predicate. An earlier revision re-declared a copy of the
 * action map here and asserted against the copy, which passes regardless of what the
 * guard does — and duly kept passing while the guard was letting `post-thread`
 * through (review #24).
 */

import { isExternalContentPublish } from '../utils/schedulePublishApproval';

describe('ENG-803 publish enforcement — what counts as external content publishing', () => {
  it('covers the whole-tool publishers', () => {
    expect(isExternalContentPublish('post_on_connected_account', {})).toBe(true);
    expect(isExternalContentPublish('publish_blog_article', {})).toBe(true);
    expect(isExternalContentPublish('publish_landing_page_changes', {})).toBe(true);
  });

  it('covers the X actions that put content on the owner\'s timeline', () => {
    for (const action of ['reply', 'post_thread', 'quote_tweet', 'retweet']) {
      expect(isExternalContentPublish('twitter_manage_post', { action })).toBe(true);
    }
  });

  // Greptile review #22: linkedin_manage_post reached the guard but its actions were
  // absent from the X-only set, so authored comments and reposts published on an
  // approval-required schedule.
  it('covers the LinkedIn authored-publishing actions', () => {
    expect(isExternalContentPublish('linkedin_manage_post', { action: 'comment' })).toBe(true);
    expect(isExternalContentPublish('linkedin_manage_post', { action: 'repost' })).toBe(true);
  });

  // Greptile review #24 (security): `_twitterManagePostImpl` starts with
  // `args.action.replace(/_/g, '-')` and switches on the HYPHENATED spelling, so
  // `post-thread` and `quote-tweet` publish just as surely as their underscore
  // twins. The guard compared the raw string against underscore-only entries, so an
  // approval-required schedule was protected only against the spellings the model
  // happened not to pick.
  it('covers the hyphenated spelling the X dispatcher also accepts', () => {
    for (const action of ['post-thread', 'quote-tweet']) {
      expect(isExternalContentPublish('twitter_manage_post', { action })).toBe(true);
    }
    // …and the folding must not drag a read action in with it.
    for (const action of ['list-replies', 'get-tweet-metrics', 'get-quote-tweets']) {
      expect(isExternalContentPublish('twitter_manage_post', { action })).toBe(false);
    }
  });

  it('is not defeated by casing or surrounding whitespace', () => {
    // Stricter than the dispatcher on purpose: its switch is case-sensitive, so
    // these would fail downstream anyway. A guard that over-blocks a call that was
    // going to error is harmless; one that under-blocks publishes irreversibly.
    expect(isExternalContentPublish('twitter_manage_post', { action: 'Post-Thread' })).toBe(true);
    expect(isExternalContentPublish('twitter_manage_post', { action: ' reply ' })).toBe(true);
    expect(isExternalContentPublish('linkedin_manage_post', { action: 'REPOST' })).toBe(true);
  });

  it('does NOT block the read actions the reported run depends on', () => {
    // The run's job is "source recent mentions, then reply". If sourcing were blocked
    // too, an approval-required schedule would produce nothing at all — not even the
    // drafts it is supposed to save for the owner.
    for (const action of ['get_tweet_metrics', 'list_replies', 'get_retweeters', 'get_liking_users', 'get_quote_tweets']) {
      expect(isExternalContentPublish('twitter_manage_post', { action })).toBe(false);
    }
    for (const action of ['list_comments', 'get_analytics']) {
      expect(isExternalContentPublish('linkedin_manage_post', { action })).toBe(false);
    }
  });

  it('does NOT treat pure engagement or deletion as publishing', () => {
    // These create no post; delete has its own confirmation rules.
    for (const action of ['like', 'unlike', 'unretweet', 'delete_tweet']) {
      expect(isExternalContentPublish('twitter_manage_post', { action })).toBe(false);
    }
    expect(isExternalContentPublish('linkedin_manage_post', { action: 'react' })).toBe(false);
  });

  it('treats an UNKNOWN *_manage_post dispatcher as publishing (fail closed)', () => {
    // The review-#22 gap generalised: a new posting surface must not get a free pass
    // just because nobody added it to the map.
    expect(isExternalContentPublish('instagram_manage_post', { action: 'anything' })).toBe(true);
    expect(isExternalContentPublish('threads_manage_post', {})).toBe(true);
  });

  it('does not fire on unrelated tools', () => {
    expect(isExternalContentPublish('you_search_web', {})).toBe(false);
    expect(isExternalContentPublish('save_file', {})).toBe(false);
    expect(isExternalContentPublish('get_brand_guidelines', {})).toBe(false);
  });

  it('treats a missing or malformed action on a KNOWN dispatcher as non-publishing', () => {
    // Known dispatchers enumerate their publishing actions, so an absent action is
    // not evidence of publishing — and the whole-tool publishers are matched by name.
    expect(isExternalContentPublish('twitter_manage_post', {})).toBe(false);
    expect(isExternalContentPublish('twitter_manage_post', { action: 123 })).toBe(false);
    expect(isExternalContentPublish('linkedin_manage_post', null)).toBe(false);
  });
});
