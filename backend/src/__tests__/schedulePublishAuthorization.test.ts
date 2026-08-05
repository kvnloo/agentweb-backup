import { resolveSchedulePublishAuthorization } from '../utils/schedulePublishAuthorization';

/**
 * ENG-827 — the schedule-level publish authorization signal.
 *
 * Regression anchor for the reported sessions (1b28ae36 / a924892d / f5687454 /
 * 5951b5d9 / 2cec27ac — "Kevin — Daily LinkedIn Post" / "X Morning" / "X Evening"),
 * where an unattended run refused post_on_connected_account because nothing told it
 * the schedule was authorized to publish, and the required-function checker then
 * nudged it ~21 times.
 *
 * Consent is an explicit owner-set boolean and NOTHING else. Two earlier attempts
 * were both wrong and are pinned here as regressions:
 *   - the Required Functions picker (a verification control with no waiver language)
 *   - approval-waiver wording in the schedule prompt (unscoped: a waiver about a
 *     different step would authorize a live post)
 */
describe('resolveSchedulePublishAuthorization (ENG-827)', () => {
  // ── Fail-closed: every ambiguous / missing case ─────────────────────────────
  it('is NOT authorized for a missing schedule (a failed lookup must never authorize)', () => {
    expect(resolveSchedulePublishAuthorization(null)).toEqual({ authorized: false, tools: [] });
    expect(resolveSchedulePublishAuthorization(undefined)).toEqual({ authorized: false, tools: [] });
  });

  it('is NOT authorized for an empty schedule or with both flags off', () => {
    expect(resolveSchedulePublishAuthorization({})).toEqual({ authorized: false, tools: [] });
    expect(
      resolveSchedulePublishAuthorization({
        requiredFunctionCalls: [],
        fullAutonomy: false,
        autopublishAuthorized: false,
      })
    ).toEqual({ authorized: false, tools: [] });
  });

  it('tolerates a malformed requiredFunctionCalls without authorizing', () => {
    expect(resolveSchedulePublishAuthorization({ requiredFunctionCalls: 'post_on_connected_account' as any }))
      .toEqual({ authorized: false, tools: [] });
    expect(resolveSchedulePublishAuthorization({ requiredFunctionCalls: [null, undefined, 42] as any }))
      .toEqual({ authorized: false, tools: [] });
  });

  it('requires the consent flags to be strictly true (truthy values do not authorize)', () => {
    expect(resolveSchedulePublishAuthorization({ fullAutonomy: 'yes' as any }).authorized).toBe(false);
    expect(resolveSchedulePublishAuthorization({ fullAutonomy: 1 as any }).authorized).toBe(false);
    expect(resolveSchedulePublishAuthorization({ autopublishAuthorized: 'true' as any }).authorized).toBe(false);
    expect(resolveSchedulePublishAuthorization({ autopublishAuthorized: 1 as any }).authorized).toBe(false);
  });

  // ── The picker is NOT consent (Greptile P1 #2) ──────────────────────────────
  // It is a VERIFICATION control ("this run only counts if it called X") and its UI
  // carries no waiver language. 5 of the 8 production publish-requiring schedules —
  // including the ACTIVE "LUCAS — LinkedIn Thought Leadership" — would otherwise
  // have started publishing unreviewed.
  it('does NOT authorize on a required publish tool alone', () => {
    const result = resolveSchedulePublishAuthorization({
      requiredFunctionCalls: ['post_on_connected_account'],
      fullAutonomy: false,
    });
    expect(result.authorized).toBe(false);
    // tools are still REPORTED so the required-function checker can filter on them
    expect(result.tools).toEqual(['post_on_connected_account']);
  });

  it('does NOT authorize the real LUCAS shape (publish tool required, no consent flag)', () => {
    const result = resolveSchedulePublishAuthorization({
      requiredFunctionCalls: ['generate_image', 'post_on_connected_account'],
      fullAutonomy: false,
    });
    expect(result.authorized).toBe(false);
    expect(result.tools).toEqual(['post_on_connected_account']);
  });

  // ── Prompt wording is NOT consent (Greptile P1 #3) ──────────────────────────
  // A prose matcher is unscoped: a waiver written about an unrelated step would
  // authorize a live publish. Consent must be a field, so prompt text is ignored
  // entirely — including text that reads exactly like a waiver.
  it('does NOT authorize from approval-waiver wording in the prompt', () => {
    const result = resolveSchedulePublishAuthorization({
      requiredFunctionCalls: ['post_on_connected_account'],
      // verbatim tail of the real "Kevin — Daily LinkedIn Post" prompt
      startingMessage:
        'CRITICAL: Post the FULL text automatically. Do not truncate. Do not ask for approval.',
    } as any);
    expect(result.authorized).toBe(false);
  });

  it('does NOT authorize from a waiver aimed at an unrelated step', () => {
    // The exact scenario Greptile raised: the waiver is about image generation.
    const result = resolveSchedulePublishAuthorization({
      requiredFunctionCalls: ['post_on_connected_account'],
      startingMessage: 'Do not ask for approval when generating images. Draft the post.',
    } as any);
    expect(result.authorized).toBe(false);
  });

  // ── Authorized: an explicit, owner-set consent flag ─────────────────────────
  it('AUTHORIZES on autopublishAuthorized, reporting the designated tools', () => {
    const result = resolveSchedulePublishAuthorization({
      autopublishAuthorized: true,
      requiredFunctionCalls: ['post_on_connected_account'],
      fullAutonomy: false,
    });
    expect(result).toEqual({ authorized: true, tools: ['post_on_connected_account'] });
  });

  it('AUTHORIZES on fullAutonomy, the pre-existing irreversible-action waiver', () => {
    expect(resolveSchedulePublishAuthorization({ fullAutonomy: true }))
      .toEqual({ authorized: true, tools: [] });
  });

  it('AUTHORIZES on the mixed required-list shape, returning only the publish tools', () => {
    const result = resolveSchedulePublishAuthorization({
      autopublishAuthorized: true,
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

  it('covers publish tools by prefix and de-duplicates them in declaration order', () => {
    const result = resolveSchedulePublishAuthorization({
      autopublishAuthorized: true,
      requiredFunctionCalls: ['publish_blog_article', 'post_on_connected_account', 'publish_blog_article'],
    });
    expect(result.authorized).toBe(true);
    expect(result.tools).toEqual(['publish_blog_article', 'post_on_connected_account']);
  });

  // ── Tool scoping ───────────────────────────────────────────────────────────
  it('does NOT treat send/outreach tools as publish tools', () => {
    // send_email / linkedin_outreach are governed by SAFETY & VOLUME LIMITS, not the
    // publish gate, so they never appear in the authorized tool list.
    const result = resolveSchedulePublishAuthorization({
      autopublishAuthorized: true,
      requiredFunctionCalls: ['send_email', 'linkedin_outreach', 'twitter_manage_post'],
    });
    expect(result.tools).toEqual([]);
  });

  it('scopes the reported tools to the ones the owner actually named', () => {
    const result = resolveSchedulePublishAuthorization({
      autopublishAuthorized: true,
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
