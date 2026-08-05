import {
  resolveSchedulePublishAuthorization,
  promptWaivesPublishApproval,
} from '../utils/schedulePublishAuthorization';

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

  // ── The picker alone is NOT consent (Greptile P1) ───────────────────────────
  // The Required Functions picker is a VERIFICATION control and its UI carries no
  // approval-waiver language. Treating the tick alone as standing approval would
  // silently convert schedules whose owner ticked it to VERIFY a publish into ones
  // that publish unreviewed — 5 of the 8 production publish-requiring schedules,
  // including the active "LUCAS — LinkedIn Thought Leadership".
  it('does NOT authorize on a required publish tool alone — the picker is not a waiver', () => {
    const result = resolveSchedulePublishAuthorization({
      requiredFunctionCalls: ['post_on_connected_account'],
      fullAutonomy: false,
      startingMessage: 'Write a thought-leadership post and post it to the connected account.',
    });
    expect(result.authorized).toBe(false);
    // the tools are still reported so the checker can filter on them
    expect(result.tools).toEqual(['post_on_connected_account']);
  });

  it('does NOT authorize the real LUCAS shape (publish tool required, no waiver in prompt)', () => {
    const result = resolveSchedulePublishAuthorization({
      requiredFunctionCalls: ['generate_image', 'post_on_connected_account'],
      fullAutonomy: false,
      startingMessage:
        'Generate an image automatically and draft a LinkedIn thought-leadership post for review.',
    });
    expect(result.authorized).toBe(false);
  });

  // ── Authorized: two independent owner-authored signals ──────────────────────
  it('AUTHORIZES when the required publish tool is paired with an approval waiver — the reported shape', () => {
    const result = resolveSchedulePublishAuthorization({
      requiredFunctionCalls: ['post_on_connected_account'],
      fullAutonomy: false,
      // verbatim tail of the real "Kevin — Daily LinkedIn Post" prompt
      startingMessage:
        'STEP 5: Post it to Kevin\'s connected LinkedIn account.\n\nCRITICAL: Post the FULL text automatically. Do not truncate. Do not ask for approval.',
    });
    expect(result).toEqual({ authorized: true, tools: ['post_on_connected_account'] });
  });

  it('AUTHORIZES on the mixed required-list shape, returning only the publish tools', () => {
    const result = resolveSchedulePublishAuthorization({
      requiredFunctionCalls: [
        'read_brand_guidelines',
        'generate_image',
        'list_connected_accounts',
        'post_on_connected_account',
      ],
      startingMessage: 'Publish the weekly brew without approval.',
    });
    expect(result.authorized).toBe(true);
    expect(result.tools).toEqual(['post_on_connected_account']);
  });

  it('does NOT authorize an approval waiver with no publish tool required', () => {
    // Both signals are required; a waiver alone cannot authorize a tool the owner
    // never designated.
    const result = resolveSchedulePublishAuthorization({
      requiredFunctionCalls: ['create_social_media_posts'],
      startingMessage: 'Post it automatically, do not ask for approval.',
    });
    expect(result).toEqual({ authorized: false, tools: [] });
  });

  it('AUTHORIZES on fullAutonomy alone, with no specific tools named', () => {
    expect(resolveSchedulePublishAuthorization({ fullAutonomy: true }))
      .toEqual({ authorized: true, tools: [] });
  });

  it('covers publish tools by prefix and de-duplicates them in declaration order', () => {
    const result = resolveSchedulePublishAuthorization({
      requiredFunctionCalls: ['publish_blog_article', 'post_on_connected_account', 'publish_blog_article'],
      startingMessage: 'Publish it automatically.',
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

describe('promptWaivesPublishApproval — the second consent signal (ENG-827)', () => {
  // Must MATCH: the owner wrote about approval/asking, or said "post automatically".
  it.each([
    'CRITICAL: Post the FULL text automatically. Do not truncate. Do not ask for approval.',
    'Publish it without approval.',
    'Post without asking me first.',
    'No approval needed — just post it.',
    "Don't wait for my sign-off.",
    'Automatically post the update to LinkedIn.',
    'Share this automatically once written.',
  ])('treats an explicit waiver as consent: %s', (msg) => {
    expect(promptWaivesPublishApproval(msg)).toBe(true);
  });

  // Must NOT match. The matcher is narrow on purpose: a false positive here
  // publishes to a live account, so anything short of an explicit waiver fails closed.
  it.each([
    // "automatically" about something OTHER than publishing
    'Automatically generate an image for the post.',
    'The topic rotation advances automatically each run.',
    // ordinary publish instructions with no waiver — the LUCAS / CMO Weekly Brew shape
    'Post it to the connected LinkedIn account.',
    'Draft the post and save it to the knowledge base.',
    // the OPPOSITE instruction must never read as consent
    'Ask for approval before posting.',
    'Wait for my sign-off before you publish.',
  ])('does NOT infer consent from: %s', (msg) => {
    expect(promptWaivesPublishApproval(msg)).toBe(false);
  });

  it('fails closed on empty, blank, or non-string prompts', () => {
    expect(promptWaivesPublishApproval('')).toBe(false);
    expect(promptWaivesPublishApproval('   \n  ')).toBe(false);
    expect(promptWaivesPublishApproval(undefined)).toBe(false);
    expect(promptWaivesPublishApproval(null as any)).toBe(false);
    expect(promptWaivesPublishApproval(42 as any)).toBe(false);
  });
});
