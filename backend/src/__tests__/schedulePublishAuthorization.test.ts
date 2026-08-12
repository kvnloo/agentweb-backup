import {
  resolveSchedulePublishAuthorization,
  filterRequiredFunctionsToAuthorizedScope,
  narrowPublishAuthorization,
  isPublishCall,
  isPublishCapableTool,
  ACTION_SCOPED_PUBLISH_TOOLS,
} from '../utils/schedulePublishAuthorization';
import { emmaToolRegistry } from '../emma/registry';
import '../emma/tools';

/**
 * ENG-827 — the schedule-level publish authorization signal.
 *
 * Regression anchor for the reported sessions (1b28ae36 / a924892d / f5687454 /
 * 5951b5d9 / 2cec27ac — "Kevin — Daily LinkedIn Post" / "X Morning" / "X Evening"),
 * where an unattended run refused post_on_connected_account because nothing told it
 * the schedule was authorized to publish, and the required-function checker then
 * nudged it ~21 times.
 *
 * CONSENT IS AFFIRMATIVE AND TOOL-SCOPED. A schedule publishes unattended only where
 * the owner explicitly said so and only through the tools they approved. Absence is not
 * consent; an empty scope authorizes nothing; and an explicit hold
 * (`requirePublishApproval`) outranks any grant.
 *
 * The rejected-signal list is pinned below. Each was wrong for the same reason — a
 * control whose own wording never tells the owner that publishing-without-review is
 * what they are agreeing to cannot be consent for it:
 *   - the Required Functions picker (a verification control, no waiver language)
 *   - approval-waiver wording in the schedule prompt (unscoped: a waiver about a
 *     different step would authorize a live post)
 *   - fullAutonomy (governs how a blocking question is ANSWERED, not live writes)
 */
describe('resolveSchedulePublishAuthorization (ENG-827)', () => {
  const GRANT = {
    autopublishAuthorized: true,
    autopublishAuthorizedTools: ['post_on_connected_account'],
  };

  // ── Fail-closed: every ambiguous / missing case ─────────────────────────────
  it('is NOT authorized for a missing schedule (a failed lookup must never authorize)', () => {
    expect(resolveSchedulePublishAuthorization(null)).toEqual({ authorized: false, tools: [] });
    expect(resolveSchedulePublishAuthorization(undefined)).toEqual({ authorized: false, tools: [] });
  });

  it('defers a legacy schedule (never asked) to the shipped opt-out, scoped to its publish tools', () => {
    // 897 rows predate this field. Reading that silence as "withheld" would stop the 25
    // schedules that publish today — the exact ENG-827 failure, at 25x scale, on deploy
    // day. Absence is a question nobody was asked, not a refusal.
    expect(
      resolveSchedulePublishAuthorization({ requiredFunctionCalls: ['post_on_connected_account'] })
    ).toEqual({ authorized: true, tools: ['post_on_connected_account'] });
    // Scope still comes from the schedule, so the write-time guard binds to a real
    // tool list rather than becoming a licence to reach for any publishing tool.
    expect(
      resolveSchedulePublishAuthorization({
        requiredFunctionCalls: ['you_search_web', 'post_on_connected_account', 'publish_blog_article'],
      }).tools
    ).toEqual(['post_on_connected_account', 'publish_blog_article']);
  });

  it('is NOT authorized for a legacy schedule that designates no publishing tool', () => {
    // Nothing to authorize: there is no publish tool to scope consent to.
    expect(resolveSchedulePublishAuthorization({})).toEqual({ authorized: false, tools: [] });
    expect(
      resolveSchedulePublishAuthorization({ requiredFunctionCalls: ['you_search_web'] })
    ).toEqual({ authorized: false, tools: [] });
  });

  it('treats an explicit false as a revocation, not as "never asked"', () => {
    // The distinction the whole deferral rests on: silence falls back to the shipped
    // default, but an owner who switched it OFF stays off even though their schedule
    // still designates a publish tool.
    expect(
      resolveSchedulePublishAuthorization({
        autopublishAuthorized: false,
        requiredFunctionCalls: ['post_on_connected_account'],
      })
    ).toEqual({ authorized: false, tools: [] });
  });

  it('lets the owner hold a legacy schedule with requirePublishApproval', () => {
    // The opt-out ENG-803 shipped still works on a row that has no grant recorded —
    // otherwise deferring to it would be deferring to a control that does nothing.
    expect(
      resolveSchedulePublishAuthorization({
        requirePublishApproval: true,
        requiredFunctionCalls: ['post_on_connected_account'],
      })
    ).toEqual({ authorized: false, tools: [] });
  });

  it('requires the consent flag to be strictly true (truthy values do not authorize)', () => {
    for (const truthy of ['true', 1, {}]) {
      expect(
        resolveSchedulePublishAuthorization({ autopublishAuthorized: truthy as any, ...{ autopublishAuthorizedTools: ['post_on_connected_account'] } }).authorized
      ).toBe(false);
    }
  });

  // ── The owner's explicit hold outranks a grant ─────────────────────────────
  it('WITHHOLDS when the owner asked to approve publishing, even with a grant present', () => {
    expect(
      resolveSchedulePublishAuthorization({ ...GRANT, requirePublishApproval: true })
    ).toEqual({ authorized: false, tools: [] });
  });

  // ── Consent without SCOPE authorizes nothing ───────────────────────────────
  // The owner may consent but designate no publishing tool. Authorizing that turns an
  // empty scope into a licence to reach for ANY live-publishing tool.
  it('does NOT authorize consent with no approved tool', () => {
    expect(resolveSchedulePublishAuthorization({ autopublishAuthorized: true }))
      .toEqual({ authorized: false, tools: [] });
    expect(
      resolveSchedulePublishAuthorization({ autopublishAuthorized: true, autopublishAuthorizedTools: [] })
    ).toEqual({ authorized: false, tools: [] });
  });

  it('ignores a malformed approved-tools list rather than trusting it', () => {
    expect(
      resolveSchedulePublishAuthorization({
        autopublishAuthorized: true,
        autopublishAuthorizedTools: [null, 42, {}] as any,
      })
    ).toEqual({ authorized: false, tools: [] });
  });

  it('drops an approved entry that is not a publishing tool at all', () => {
    expect(
      resolveSchedulePublishAuthorization({
        autopublishAuthorized: true,
        autopublishAuthorizedTools: ['read_brand_guidelines'],
      })
    ).toEqual({ authorized: false, tools: [] });
  });

  // ── Authorized: explicit, owner-set, tool-scoped ───────────────────────────
  it('AUTHORIZES on an affirmative grant, reporting the approved tools', () => {
    expect(resolveSchedulePublishAuthorization(GRANT))
      .toEqual({ authorized: true, tools: ['post_on_connected_account'] });
  });

  it('de-duplicates the approved tools', () => {
    const r = resolveSchedulePublishAuthorization({
      autopublishAuthorized: true,
      autopublishAuthorizedTools: ['publish_blog_article', 'post_on_connected_account', 'publish_blog_article'],
    });
    expect(r.tools).toEqual(['publish_blog_article', 'post_on_connected_account']);
  });

  it('recognises an action-scoped tool as an approvable publishing tool', () => {
    expect(
      resolveSchedulePublishAuthorization({
        autopublishAuthorized: true,
        autopublishAuthorizedTools: ['twitter_manage_post'],
      })
    ).toEqual({ authorized: true, tools: ['twitter_manage_post'] });
  });

  // ── Consent is BOUND to the scope it was granted for ───────────────────────
  // Without this, editing requiredFunctionCalls after a grant silently re-scopes
  // standing consent onto tools the owner never saw.
  it('does NOT extend consent to a publish tool the schedule requires but the owner never approved', () => {
    const r = resolveSchedulePublishAuthorization({
      ...GRANT,
      requiredFunctionCalls: ['post_on_connected_account', 'publish_landing_page_changes'],
    });
    expect(r.tools).toEqual(['post_on_connected_account']);
    expect(r.tools).not.toContain('publish_landing_page_changes');
  });

  // ── The rejected signals ───────────────────────────────────────────────────
  // These are NOT consent controls. Deferring the never-asked case to ENG-803's
  // opt-out means a legacy row with a publish tool does resolve authorized — but by
  // the shipped DEFAULT, never by one of these. The property that still has to hold
  // is that none of them can override a decision the owner actually made, in either
  // direction: a revocation and a hold must survive all of them.
  it.each([
    ['the Required Functions picker (a verification control, no waiver language)', {}],
    [
      'approval-waiver wording in the schedule prompt',
      // verbatim tail of the real "Kevin — Daily LinkedIn Post" prompt
      { startingMessage: 'CRITICAL: Post the FULL text automatically. Do not truncate. Do not ask for approval.' },
    ],
    // ENG-396/ENG-517: it governs how a blocking AskUserQuestion is ANSWERED.
    ['fullAutonomy', { fullAutonomy: true }],
  ])('cannot override an explicit revocation: %s', (_label, signal) => {
    expect(
      resolveSchedulePublishAuthorization({
        ...(signal as any),
        autopublishAuthorized: false,
        requiredFunctionCalls: ['post_on_connected_account'],
      }).authorized
    ).toBe(false);
  });

  it.each([
    ['the Required Functions picker', {}],
    [
      'approval-waiver wording in the schedule prompt',
      { startingMessage: 'CRITICAL: Post the FULL text automatically. Do not ask for approval.' },
    ],
    ['fullAutonomy', { fullAutonomy: true }],
  ])('cannot override the owner\'s hold: %s', (_label, signal) => {
    expect(
      resolveSchedulePublishAuthorization({
        ...(signal as any),
        requirePublishApproval: true,
        requiredFunctionCalls: ['post_on_connected_account'],
      }).authorized
    ).toBe(false);
  });

  it('does not let a rejected signal invent a scope where the schedule designates none', () => {
    // The one case where the picker's absence is decisive: no publishing tool is
    // designated, so waiver wording and fullAutonomy have nothing to authorize.
    expect(
      resolveSchedulePublishAuthorization({
        fullAutonomy: true,
        startingMessage: 'Post it automatically without asking for approval.',
        requiredFunctionCalls: ['you_search_web'],
      } as any)
    ).toEqual({ authorized: false, tools: [] });
  });

  it('does not mutate or alias the caller\'s approved-tools array', () => {
    const approved = ['post_on_connected_account'];
    const r = resolveSchedulePublishAuthorization({
      autopublishAuthorized: true,
      autopublishAuthorizedTools: approved,
    });
    expect(r.tools).not.toBe(approved);
    expect(approved).toEqual(['post_on_connected_account']);
  });
});

/**
 * The prompt/checker invariant (Greptile P1 #9).
 *
 * The deterministic required-function checker must never nudge for a publishing
 * tool the system prompt forbids — that contradiction is what burned ~21 turns per
 * run in the reported sessions. Both sides derive from the same authorization, but
 * the filter has to key on the authorized TOOL SET: with consent bound to a scope,
 * `authorized` can be true while some required publish tool sits outside it.
 */
describe('filterRequiredFunctionsToAuthorizedScope (ENG-827)', () => {
  const auth = (tools: string[], authorized = tools.length > 0) => ({ authorized, tools });

  it('keeps a publish tool that is within the approved scope', () => {
    expect(
      filterRequiredFunctionsToAuthorizedScope(
        ['you_search_web', 'post_on_connected_account'],
        auth(['post_on_connected_account'])
      )
    ).toEqual(['you_search_web', 'post_on_connected_account']);
  });

  // The partial-scope case: authorized, but only for SOME of the required publish
  // tools. The unapproved one must be dropped, or the checker demands what the
  // prompt prohibits.
  it('DROPS a required publish tool outside the approved scope, even when authorized', () => {
    expect(
      filterRequiredFunctionsToAuthorizedScope(
        ['post_on_connected_account', 'publish_landing_page_changes', 'generate_image'],
        auth(['post_on_connected_account'])
      )
    ).toEqual(['post_on_connected_account', 'generate_image']);
  });

  it('drops every publish tool when the run is not authorized', () => {
    expect(
      filterRequiredFunctionsToAuthorizedScope(
        ['post_on_connected_account', 'publish_blog_article', 'you_search_web'],
        auth([], false)
      )
    ).toEqual(['you_search_web']);
  });

  it('never touches non-publishing requirements', () => {
    const required = ['you_search_web', 'send_email', 'generate_image', 'linkedin_outreach'];
    expect(filterRequiredFunctionsToAuthorizedScope(required, auth([], false))).toEqual(required);
  });

  it('is safe on a missing/malformed required list', () => {
    expect(filterRequiredFunctionsToAuthorizedScope(undefined, auth(['post_on_connected_account']))).toEqual([]);
    expect(filterRequiredFunctionsToAuthorizedScope('nope' as any, auth([]))).toEqual([]);
  });

  // The end-to-end property, stated directly: whatever survives the filter is
  // something the prompt will also have authorized.
  it('never yields a publishing requirement outside the authorized tool set', () => {
    const cases: Array<[string[], string[]]> = [
      [['post_on_connected_account', 'publish_blog_article'], ['post_on_connected_account']],
      [['publish_landing_page_changes'], ['post_on_connected_account']],
      [['post_on_account', 'post_on_connected_account'], ['post_on_account']],
      [['publish_blog_article'], []],
    ];
    for (const [required, approved] of cases) {
      const out = filterRequiredFunctionsToAuthorizedScope(required, auth(approved));
      for (const name of out) {
        if (/^(post_on_|publish_)/.test(name)) expect(approved).toContain(name);
      }
    }
  });
});

/**
 * ENG-827 — revoking consent must stop a run that is ALREADY executing.
 *
 * A scheduled run resolves its authorization once at admission and threads that one
 * value through every turn (the rule that stops the prompt and the checker
 * disagreeing). But a run lasts minutes, so without a re-check an owner who hits
 * revoke mid-run watches it publish anyway from a pre-revocation snapshot. The
 * combination is monotonic: it may only ever REMOVE authorization.
 */
describe('narrowPublishAuthorization (ENG-827 mid-run revocation)', () => {
  const A = (tools: string[], authorized = tools.length > 0) => ({ authorized, tools });

  it('drops authorization entirely when consent is revoked mid-run', () => {
    expect(narrowPublishAuthorization(A(['post_on_connected_account']), A([], false)))
      .toEqual({ authorized: false, tools: [] });
  });

  it('narrows to the intersection when the approved scope shrinks mid-run', () => {
    const admitted = A(['post_on_connected_account', 'publish_blog_article']);
    const latest = A(['post_on_connected_account']);
    expect(narrowPublishAuthorization(admitted, latest))
      .toEqual({ authorized: true, tools: ['post_on_connected_account'] });
  });

  it('CANNOT re-authorize a run admitted unauthorized (grant mid-run does not apply)', () => {
    expect(narrowPublishAuthorization(A([], false), A(['post_on_connected_account'])))
      .toEqual({ authorized: false, tools: [] });
  });

  it('CANNOT widen scope — a tool added mid-run is not reachable until the next run', () => {
    const out = narrowPublishAuthorization(A(['post_on_connected_account']), A(['post_on_connected_account', 'publish_blog_article']));
    expect(out.tools).toEqual(['post_on_connected_account']);
  });

  // Greptile review #19: keeping the admitted value while the schedule cannot be read
  // let a revoked run keep publishing. The outcomes are not symmetric — publishing
  // blind is an irreversible post the owner may already have revoked; withholding is a
  // draft, which this ticket calls a success state.
  it('FAILS CLOSED when the re-read is unavailable, rather than publishing while blind', () => {
    const admitted = A(['post_on_connected_account']);
    expect(narrowPublishAuthorization(admitted, null)).toEqual({ authorized: false, tools: [] });
    expect(narrowPublishAuthorization(admitted, undefined)).toEqual({ authorized: false, tools: [] });
  });

  it('is idempotent, so re-applying it every turn cannot oscillate', () => {
    const admitted = A(['post_on_connected_account', 'publish_blog_article']);
    const latest = A(['post_on_connected_account']);
    const once = narrowPublishAuthorization(admitted, latest);
    expect(narrowPublishAuthorization(once, latest)).toEqual(once);
  });

  it('leaves the checker with no publishing requirement once narrowed to nothing', () => {
    const narrowed = narrowPublishAuthorization(A(['post_on_connected_account']), A([], false));
    expect(filterRequiredFunctionsToAuthorizedScope(
      ['read_brand_guidelines', 'post_on_connected_account'],
      narrowed
    )).toEqual(['read_brand_guidelines']);
  });
});


/**
 * ENG-827 (Greptile, security): two tools publish under a name `isPublishName` does
 * not match. `twitter_manage_post` posts a NEW multi-tweet thread, replies and
 * quote-tweets; `linkedin_manage_post` reposts and comments. Both were reachable from
 * an unattended run with no consent check at all, which is the same public write the
 * rest of this module exists to gate — just behind a different tool name.
 *
 * Gating them wholesale would refuse a scheduled analytics read, so the decision is
 * per action.
 */
describe('isPublishCall — action-scoped publishing tools (ENG-827)', () => {
  it('gates the actions that write publicly', () => {
    for (const action of ['post_thread', 'reply', 'quote_tweet', 'retweet']) {
      expect(isPublishCall('twitter_manage_post', { action })).toBe(true);
    }
    for (const action of ['repost', 'comment']) {
      expect(isPublishCall('linkedin_manage_post', { action })).toBe(true);
    }
  });

  it('leaves reads, analytics and deletes alone', () => {
    // A delete is the REMEDY for a bad post; refusing it for want of publishing
    // consent would be backwards. Likes/reactions are not publications of content.
    for (const action of ['get_tweet_metrics', 'list_replies', 'delete_tweet', 'like', 'unretweet']) {
      expect(isPublishCall('twitter_manage_post', { action })).toBe(false);
    }
    for (const action of ['get_analytics', 'list_comments', 'react']) {
      expect(isPublishCall('linkedin_manage_post', { action })).toBe(false);
    }
  });

  it('fails CLOSED on an unknown, missing or malformed action', () => {
    expect(isPublishCall('twitter_manage_post', { action: 'post_something_new' })).toBe(true);
    expect(isPublishCall('twitter_manage_post', {})).toBe(true);
    expect(isPublishCall('twitter_manage_post', undefined)).toBe(true);
    expect(isPublishCall('linkedin_manage_post', { action: 42 })).toBe(true);
  });

  it('still classifies name-matched publish tools regardless of args', () => {
    expect(isPublishCall('post_on_connected_account', undefined)).toBe(true);
    expect(isPublishCall('publish_some_future_surface', { action: 'get_analytics' })).toBe(true);
  });

  it('does not touch tools with no publishing power', () => {
    expect(isPublishCall('read_brand_guidelines', { action: 'post_thread' })).toBe(false);
    expect(isPublishCapableTool('read_brand_guidelines')).toBe(false);
  });

  // An owner must be able to run a thread-posting schedule at all, so the nudge
  // SCOPE has to recognise these tools too — not just the dispatch guard.
  it('lets consent be granted for an action-scoped tool', () => {
    expect(
      resolveSchedulePublishAuthorization({
        autopublishAuthorized: true,
        autopublishAuthorizedTools: ['twitter_manage_post'],
        requiredFunctionCalls: ['search_web', 'twitter_manage_post'],
      })
    ).toEqual({ authorized: true, tools: ['twitter_manage_post'] });
  });

  it('drops an UNAUTHORIZED action-scoped tool from the required-function scope', () => {
    expect(
      filterRequiredFunctionsToAuthorizedScope(
        ['search_web', 'linkedin_manage_post'],
        { authorized: false, tools: [] }
      )
    ).toEqual(['search_web']);
  });

  // Drift guard: the fail-closed default must be a backstop, not the way new actions
  // silently arrive. Whoever adds an action to one of these tools has to classify it.
  it('classifies EVERY action the tool actually declares', () => {
    for (const [toolName, spec] of Object.entries(ACTION_SCOPED_PUBLISH_TOOLS)) {
      const tool = emmaToolRegistry.getTool(toolName);
      expect(tool).toBeDefined();
      const declared: string[] = tool!.definition.inputSchema.properties.action.enum;
      expect(declared.length).toBeGreaterThan(0);
      expect([...spec.publishing, ...spec.nonPublishing].sort()).toEqual([...declared].sort());
    }
  });
});
