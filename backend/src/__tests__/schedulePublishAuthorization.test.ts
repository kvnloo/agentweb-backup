import { resolveSchedulePublishAuthorization } from '../utils/schedulePublishAuthorization';

/**
 * ENG-827 — the schedule-level publish authorization signal.
 *
 * Regression anchor for the reported sessions (1b28ae36 / a924892d / f5687454 /
 * 5951b5d9 / 2cec27ac, "Kevin — Daily LinkedIn Post" / "X Morning" / "X Evening"):
 * the owner configured `requiredFunctionCalls: ['post_on_connected_account']` and a
 * prompt ending "Post the FULL text automatically. Do not ask for approval." — but
 * left `fullAutonomy` off, because that toggle is presented in the UI as governing
 * mid-run *questions*, not publishing. Keying authorization on `fullAutonomy` alone
 * therefore classified every one of those runs as unauthorized.
 *
 * That is not a hypothetical: across all 897 production schedules, 8 require a
 * publish tool and ZERO of them have fullAutonomy set — so a fullAutonomy-only
 * signal never authorizes anything in production.
 */
describe('resolveSchedulePublishAuthorization (ENG-827)', () => {
  // ── Not authorized: every ambiguous / missing case must fail safe ───────────
  it('is NOT authorized for a missing schedule (failed lookup must not authorize)', () => {
    expect(resolveSchedulePublishAuthorization(null)).toEqual({ authorized: false, tools: [] });
    expect(resolveSchedulePublishAuthorization(undefined)).toEqual({ authorized: false, tools: [] });
  });

  it('is NOT authorized for a schedule with no required functions and no autonomy', () => {
    expect(resolveSchedulePublishAuthorization({})).toEqual({ authorized: false, tools: [] });
    expect(resolveSchedulePublishAuthorization({ requiredFunctionCalls: [], fullAutonomy: false }))
      .toEqual({ authorized: false, tools: [] });
  });

  it('is NOT authorized when the required functions are all non-publishing tools', () => {
    // The "Articles for CHRO Leaders" shape — research/drafting only, nothing that
    // writes to a live account, so nothing to authorize.
    const result = resolveSchedulePublishAuthorization({
      requiredFunctionCalls: ['you_search_web', 'search_knowledge_base', 'create_social_media_posts', 'generate_image'],
    });
    expect(result).toEqual({ authorized: false, tools: [] });
  });

  it('does NOT treat send/outreach tools as publish authorization', () => {
    // send_email / linkedin_outreach are governed by the SAFETY & VOLUME LIMITS
    // rules, not the publish gate — they must not flip this signal.
    const result = resolveSchedulePublishAuthorization({
      requiredFunctionCalls: ['send_email', 'linkedin_outreach', 'twitter_manage_post'],
    });
    expect(result).toEqual({ authorized: false, tools: [] });
  });

  it('tolerates a malformed requiredFunctionCalls without authorizing', () => {
    expect(resolveSchedulePublishAuthorization({ requiredFunctionCalls: 'post_on_connected_account' as any }))
      .toEqual({ authorized: false, tools: [] });
    expect(resolveSchedulePublishAuthorization({ requiredFunctionCalls: [null, undefined, 42] as any }))
      .toEqual({ authorized: false, tools: [] });
  });

  it('requires fullAutonomy to be strictly true (truthy values do not authorize)', () => {
    expect(resolveSchedulePublishAuthorization({ fullAutonomy: 'yes' as any }).authorized).toBe(false);
    expect(resolveSchedulePublishAuthorization({ fullAutonomy: 1 as any }).authorized).toBe(false);
  });

  // ── Authorized: the owner's explicit, schedule-creation-time declaration ────
  it('AUTHORIZES when the owner required a publish tool — the exact reported shape', () => {
    const result = resolveSchedulePublishAuthorization({
      requiredFunctionCalls: ['post_on_connected_account'],
      fullAutonomy: false,
    });
    expect(result).toEqual({ authorized: true, tools: ['post_on_connected_account'] });
  });

  it('AUTHORIZES on the mixed required-list shape, returning only the publish tools', () => {
    // The "CMO Weekly Brew" / "LUCAS" shape: publish tool alongside research tools.
    const result = resolveSchedulePublishAuthorization({
      requiredFunctionCalls: [
        'read_brand_guidelines',
        'generate_image',
        'list_connected_accounts',
        'post_on_connected_account',
      ],
    });
    expect(result.authorized).toBe(true);
    expect(result.tools).toEqual(['post_on_connected_account']);
  });

  it('AUTHORIZES on fullAutonomy alone, with no specific tools named', () => {
    expect(resolveSchedulePublishAuthorization({ fullAutonomy: true }))
      .toEqual({ authorized: true, tools: [] });
  });

  it('covers publish tools by prefix and de-duplicates them in declaration order', () => {
    const result = resolveSchedulePublishAuthorization({
      requiredFunctionCalls: ['publish_blog_article', 'post_on_connected_account', 'publish_blog_article'],
    });
    expect(result.authorized).toBe(true);
    expect(result.tools).toEqual(['publish_blog_article', 'post_on_connected_account']);
  });

  // ── Per-tool scoping: authorizing one publish tool must not authorize others ─
  it('scopes authorization to the tools the owner actually named', () => {
    const result = resolveSchedulePublishAuthorization({
      requiredFunctionCalls: ['post_on_connected_account'],
    });
    expect(result.tools).toEqual(['post_on_connected_account']);
    expect(result.tools).not.toContain('publish_landing_page_changes');
  });

  it('does not mutate or alias the caller\'s requiredFunctionCalls array', () => {
    const required = ['post_on_connected_account'];
    const result = resolveSchedulePublishAuthorization({ requiredFunctionCalls: required });
    expect(result.tools).not.toBe(required);
    expect(required).toEqual(['post_on_connected_account']);
  });
});
