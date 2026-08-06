/**
 * ENG-803 — the publish-approval setting is ENFORCED at dispatch, not just asked for
 * in the prompt (Greptile review #21).
 *
 * A directive is guidance, and this ticket is literally a report of a model
 * reasoning its way around instructions. An owner-facing safety setting that only
 * exists as prompt text is not a boundary. So the same resolved decision that
 * selects the PUBLISH AUTHORIZATION block also stops the tool from running.
 *
 * These tests pin the SCOPE of the block, which is where this could do damage. The
 * scheduled X reply run in the report must still be able to read mentions and
 * metrics while being unable to post — blocking `twitter_manage_post` wholesale
 * would break the very run it is meant to protect.
 */

import { isPublishName } from '../utils/hardeningGaps';

// Mirrors AgentModeService.isExternalContentPublish.
const X_PUBLISHING_ACTIONS = new Set(['reply', 'post_thread', 'quote_tweet']);
const isExternalContentPublish = (toolName: string, args: any): boolean => {
  if (isPublishName(toolName)) return true;
  if (/_manage_post$/.test(toolName)) {
    const action = typeof args?.action === 'string' ? args.action : '';
    return X_PUBLISHING_ACTIONS.has(action);
  }
  return false;
};

describe('ENG-803 publish enforcement — what counts as external content publishing', () => {
  it('covers the whole-tool publishers', () => {
    expect(isExternalContentPublish('post_on_connected_account', {})).toBe(true);
    expect(isExternalContentPublish('publish_blog_article', {})).toBe(true);
    expect(isExternalContentPublish('publish_landing_page_changes', {})).toBe(true);
  });

  it('covers the X actions that put authored content in front of an audience', () => {
    for (const action of ['reply', 'post_thread', 'quote_tweet']) {
      expect(isExternalContentPublish('twitter_manage_post', { action })).toBe(true);
    }
  });

  it('does NOT block the read actions the reported run depends on', () => {
    // The run's job is "source recent mentions, then reply". If sourcing were
    // blocked too, an approval-required schedule would produce nothing at all —
    // not even the drafts it is supposed to save for the owner.
    for (const action of ['get_tweet_metrics', 'list_replies', 'get_retweeters', 'get_liking_users', 'get_quote_tweets']) {
      expect(isExternalContentPublish('twitter_manage_post', { action })).toBe(false);
    }
  });

  it('does NOT treat engagement or deletion as publishing', () => {
    // These surface no authored content; delete has its own confirmation rules.
    for (const action of ['like', 'unlike', 'retweet', 'unretweet', 'delete_tweet']) {
      expect(isExternalContentPublish('twitter_manage_post', { action })).toBe(false);
    }
  });

  it('does not fire on unrelated tools', () => {
    expect(isExternalContentPublish('you_search_web', {})).toBe(false);
    expect(isExternalContentPublish('save_file', {})).toBe(false);
    expect(isExternalContentPublish('get_brand_guidelines', {})).toBe(false);
  });

  it('treats a missing or malformed action as non-publishing', () => {
    // Fail-open on the dispatcher: an unknown action is not evidence of publishing,
    // and the whole-tool publishers above are matched by name regardless.
    expect(isExternalContentPublish('twitter_manage_post', {})).toBe(false);
    expect(isExternalContentPublish('twitter_manage_post', { action: 123 })).toBe(false);
    expect(isExternalContentPublish('twitter_manage_post', null)).toBe(false);
  });
});
