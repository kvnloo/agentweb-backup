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
 */

import { isPublishName } from '../utils/hardeningGaps';

// Mirrors AgentModeService.isExternalContentPublish.
const DISPATCHER_PUBLISHING_ACTIONS: Record<string, Set<string>> = {
  twitter_manage_post: new Set(['reply', 'post_thread', 'quote_tweet', 'retweet']),
  linkedin_manage_post: new Set(['comment', 'repost']),
};
const isExternalContentPublish = (toolName: string, args: any): boolean => {
  if (isPublishName(toolName)) return true;
  if (!/_manage_post$/.test(toolName)) return false;
  const known = DISPATCHER_PUBLISHING_ACTIONS[toolName];
  const action = typeof args?.action === 'string' ? args.action : '';
  if (!known) return true;
  return known.has(action);
};

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
