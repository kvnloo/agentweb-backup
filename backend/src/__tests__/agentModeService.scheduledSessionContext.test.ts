/**
 * Tests for scheduled-session context injection.
 *
 * Covers two surfaces:
 *   1. getScheduledSessionOverride() — the pure function in agentModeSystemPrompt.ts
 *      that produces the CRITICAL OVERRIDE addendum.
 *   2. getEmmaSystemContext(sessionType) — the Emma sidebar system prompt builder
 *      in chatbotService.ts that threads the override into the full prompt.
 *
 * Goal: verify that scheduled sessions suppress schedule suggestions while
 * regular/undefined sessions preserve the proactive scheduling behaviour.
 */

import { getScheduledSessionOverride, getUnattendedExecutionDirective } from '../docs/agentModeSystemPrompt';
import { getEmmaSystemContext } from '../services/chatbotService';

// ── Heavy module mocks required to import chatbotService ──────────────────────
jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      query: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({ Items: [] }) })),
      get: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
      put: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
      update: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
      batchWrite: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
    })),
  },
  S3: jest.fn(() => ({
    upload: jest.fn().mockReturnThis(),
    promise: jest.fn(),
  })),
  config: { update: jest.fn() },
}));
jest.mock('openai', () => jest.fn(() => ({})));
jest.mock('@google-cloud/discoveryengine', () => ({
  EngineServiceClient: jest.fn(),
  SearchServiceClient: jest.fn(),
}));
jest.mock('@google-cloud/storage', () => ({ Storage: jest.fn() }));
jest.mock('../controllers/guide', () => ({ getGuide: jest.fn() }));
jest.mock('../controllers/release', () => ({ getReleases: jest.fn() }));
jest.mock('../controllers/docsController', () => ({ getUserReleaseNotes: jest.fn() }));
jest.mock('../services/db', () => ({ taskDb: {} }));
jest.mock('../utils/secretsManager', () => ({
  getGCSPPrivateKey: jest.fn(),
  getSecret: jest.fn().mockResolvedValue('fake-key'),
}));

// ─────────────────────────────────────────────────────────────────────────────

describe('getScheduledSessionOverride — pure function', () => {
  // ── Returns empty string (no suppression) for non-scheduled sessions ────────

  it('returns empty string when sessionType is undefined', () => {
    expect(getScheduledSessionOverride(undefined)).toBe('');
  });

  it('returns empty string when sessionType is "regular"', () => {
    expect(getScheduledSessionOverride('regular')).toBe('');
  });

  it('returns empty string for other known non-scheduled types', () => {
    const nonScheduled = [
      'predefined-work-plan',
      'image-generation',
      'video-generation',
      'book-generation',
      'report_generation',
      'result-endpoint',
      'emma-email',
      'meeting-intake',
    ];
    for (const t of nonScheduled) {
      expect(getScheduledSessionOverride(t)).toBe('');
    }
  });

  it('returns empty string for an unknown/arbitrary session type', () => {
    expect(getScheduledSessionOverride('something-random')).toBe('');
  });

  // ── Returns override text only for "scheduled" ───────────────────────────────

  it('returns non-empty string when sessionType is "scheduled"', () => {
    expect(getScheduledSessionOverride('scheduled')).not.toBe('');
  });

  it('contains CRITICAL OVERRIDE marker for scheduled sessions', () => {
    expect(getScheduledSessionOverride('scheduled')).toContain('CRITICAL OVERRIDE');
  });

  it('explicitly forbids suggesting a new schedule in scheduled sessions', () => {
    const override = getScheduledSessionOverride('scheduled');
    expect(override).toContain('NEVER suggest creating a schedule');
  });

  it('explicitly forbids "want this to run automatically" phrasing', () => {
    const override = getScheduledSessionOverride('scheduled');
    expect(override).toContain('want this to run automatically');
  });

  it('explicitly forbids "setting up automated runs" phrasing', () => {
    const override = getScheduledSessionOverride('scheduled');
    expect(override).toContain('setting up automated runs');
  });

  it('tells Emma to just deliver results instead', () => {
    const override = getScheduledSessionOverride('scheduled');
    expect(override).toContain('Just deliver the results');
  });

  // ── Non-scheduled prompts ALLOW schedule suggestions ────────────────────────

  it('non-scheduled override does NOT forbid schedule suggestions', () => {
    const override = getScheduledSessionOverride('regular');
    expect(override).not.toContain('NEVER suggest creating a schedule');
    expect(override).not.toContain('CRITICAL OVERRIDE');
  });

  // ── Idempotent ───────────────────────────────────────────────────────────────

  it('returns the same string on repeated calls for "scheduled"', () => {
    expect(getScheduledSessionOverride('scheduled')).toBe(getScheduledSessionOverride('scheduled'));
  });

  it('returns the same empty string on repeated calls for "regular"', () => {
    expect(getScheduledSessionOverride('regular')).toBe('');
    expect(getScheduledSessionOverride('regular')).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('getUnattendedExecutionDirective — per-entity completion guidance', () => {
  // Regression coverage for session b56a2eac (Daily Event Lead Engagement Review):
  // the agent extracted guest lists for all 3 events but then skipped LinkedIn
  // research / ICP filtering / pending-approval checks for events 2 & 3 after
  // hitting a single per-entity blocker (one teammate's LinkedIn not connected).
  // The directive must (1) enforce a per-entity completion loop, (2) isolate a
  // blocker to its entity and keep going, (3) add a pre-output completion gate,
  // and (4) surface gaps as actionable items.

  const directive = getUnattendedExecutionDirective('scheduled');
  // The userId→identity (list_all_clients) slice is admin-gated — it only
  // injects for an admin schedule owner, so identity-resolution assertions run
  // against the admin variant.
  const adminDirective = getUnattendedExecutionDirective('scheduled', true);

  // ── Self-guard: mirrors getScheduledSessionOverride so the function is safe
  //    to call unconditionally and cannot leak the unattended block into a
  //    non-scheduled session even if a future caller forgets the call-site guard.
  it('returns empty string when sessionType is undefined', () => {
    expect(getUnattendedExecutionDirective(undefined)).toBe('');
  });

  it('returns empty string when sessionType is "regular"', () => {
    expect(getUnattendedExecutionDirective('regular')).toBe('');
  });

  it('returns empty string for other known non-scheduled types', () => {
    for (const t of ['image-generation', 'report_generation', 'emma-email', 'predefined-work-plan']) {
      expect(getUnattendedExecutionDirective(t)).toBe('');
    }
  });

  it('returns the directive only for sessionType "scheduled"', () => {
    expect(getUnattendedExecutionDirective('scheduled')).not.toBe('');
  });

  it('is non-empty and labelled as the unattended execution block', () => {
    expect(directive).toContain('AUTOMATED UNATTENDED EXECUTION');
  });

  it('still instructs continuous single-run execution (preserves existing behaviour)', () => {
    expect(directive).toContain('without stopping to ask');
    expect(directive).toContain('FULL stated amount');
  });

  // ── (1) Per-entity completion loop ──────────────────────────────────────────
  it('requires completing ALL steps for EACH entity before finishing', () => {
    expect(directive.toLowerCase()).toContain('each');
    expect(directive).toMatch(/every (entity|item)/i);
  });

  it('forbids stopping after the first entity when more remain', () => {
    expect(directive.toLowerCase()).toContain('do not stop after the first');
  });

  // ── (2) Blocker isolation ────────────────────────────────────────────────────
  it('scopes a blocker to its own entity and continues the others', () => {
    expect(directive.toLowerCase()).toContain('blocker');
    expect(directive.toLowerCase()).toContain('continue');
    // must distinguish a per-entity blocker from a true unrecoverable error
    expect(directive.toLowerCase()).toContain('does not block');
  });

  it('still allows stopping only on a truly unrecoverable / global error', () => {
    expect(directive.toLowerCase()).toContain('unrecoverable');
  });

  // ── (3) Pre-output completion gate ──────────────────────────────────────────
  it('adds a completion gate before producing the final output', () => {
    expect(directive.toLowerCase()).toContain('before');
    expect(directive.toLowerCase()).toMatch(/completion (gate|check)|verify (that )?(all|every)/i);
  });

  // ── (4) Surface gaps as actionable items ────────────────────────────────────
  it('requires surfacing skipped/blocked work as actionable items', () => {
    expect(directive.toLowerCase()).toContain('actionable');
  });

  // ── (5) ENG-396/ENG-369 reconciliation: irreversible-parameter carve-out ─────
  // ENG-369's best-effort mandate says a scheduled run should self-pick rather
  // than ever present a blocking menu. That must NOT extend to an irreversible /
  // immutable parameter no human specified (e.g. the Meta campaign objective) —
  // guessing one is the RankAI incident ENG-396 exists to prevent. The directive
  // must carve that class out of "pick it yourself".
  it('carves irreversible/immutable parameters out of the best-effort self-pick rule', () => {
    const lower = directive.toLowerCase();
    expect(lower).toContain('irreversible');
    expect(lower).toContain('never fabricate');
    // The named exemplar keeps the boundary concrete.
    expect(directive).toContain('Meta campaign objective');
  });

  it('routes an irreversible unspecified decision to park (or logged auto-take), not a guess', () => {
    const lower = directive.toLowerCase();
    // parks for the owner by default...
    expect(lower).toContain('park');
    // ...and only auto-proceeds on an explicitly autonomous schedule, logged.
    expect(lower).toContain('autonomous');
    expect(lower).toMatch(/log(s|ged)? the delegation/);
  });

  it('still lets reversible choices proceed best-effort (the carve-out is narrow)', () => {
    // The exception must not swallow ENG-369: reversible work still runs.
    expect(directive.toLowerCase()).toContain('reversible');
    expect(directive).toContain('best-effort');
  });

  // ── (6) Prescribed per-item call patterns are intent, not literal law ────────
  // Regression coverage for ENG-480 (sessions 54325528 / fa552592, "Daily User
  // Activity Report"): the scheduled prompt prescribed impossible per-session and
  // per-userId tool calls. One run proceeded via the efficient supported path
  // (get_chat_history already returns per-session data) but was scored as having
  // "refused/bypassed explicit constraints"; the other stopped to explain instead
  // of delivering. The directive must reframe using the supported path as CORRECT
  // and compliant — not a refusal — and still require producing the deliverable.
  it('treats a prescribed per-item call pattern as intent, not a literal tool requirement', () => {
    expect(directive.toLowerCase()).toContain('not a literal requirement');
    expect(directive.toLowerCase()).toContain('one call per item');
  });

  it('names the efficient supported path (get_chat_history) as the correct, complete execution', () => {
    expect(directive).toContain('get_chat_history');
  });

  it('states that using the supported path is NOT skipping/refusing/violating the instruction', () => {
    expect(directive.toLowerCase()).toContain('not skipping, refusing');
  });

  it('still requires producing the deliverable in full rather than stopping', () => {
    expect(directive.toLowerCase()).toContain('always produce the requested deliverable');
  });

  // The reframing must NOT bleed into per-entity ACTIONS (send/post/draft). It is
  // scoped to fetching per-item DATA for a report; a batched call must never be
  // treated as satisfying a per-entity side effect (guards the tension with the
  // PER-ENTITY COMPLETION LOOP directive that immediately follows it).
  it('scopes the reframing to reading/gathering data, not per-entity actions', () => {
    expect(directive.toLowerCase()).toContain('reading/gathering data');
  });

  it('carves out per-entity actions so a batched call never collapses per-item side effects', () => {
    const lower = directive.toLowerCase();
    expect(lower).toContain('carve-out');
    expect(lower).toContain('does not loosen per-entity actions');
    expect(lower).toContain('per-entity completion loop');
  });

  // ── (7) userId → email/name identity resolution ─────────────────────────────
  // Regression coverage for ENG-500 (session fa552592, "Daily User Activity
  // Report"): get_chat_history returns per-session data keyed by numeric userId
  // only — no email/name — and there is no per-userId profile lookup tool. The
  // run correctly recognised it could not turn userIds into human-readable
  // identities, proposed the supported workaround (map userIds to emails via the
  // client list), but — being unattended — stopped to ask for approval, so the
  // report was never delivered. A sibling 5/5 run proved the report is fully
  // achievable by resolving identities via list_all_clients. The directive must
  // teach that supported mapping so the run completes on its own instead of
  // stopping for a lookup tool that does not exist.
  it('names list_all_clients as the supported userId → email/name resolution path', () => {
    expect(adminDirective).toContain('list_all_clients');
  });

  it('tells the run to map userIds to emails/names rather than ship raw userIds or stop', () => {
    const lower = adminDirective.toLowerCase();
    expect(lower).toContain('userid');
    // the mapping produces a human-readable identity (email / name)
    expect(lower).toMatch(/email.*(name|displayname)|(name|displayname).*email/);
    // and the absence of a direct per-userId lookup is not a blocker
    expect(lower).toContain('not');
  });

  // Strict data-minimization (ENG-500 / Greptile P1): scheduled reports are
  // auto-emailed / posted to Slack with no recipient-level authorization, so the
  // sensitive account fields list_all_clients also returns must NEVER leave the
  // session — even if the task explicitly asks for them. list_all_clients is used
  // ONLY for the userId→email/displayName mapping.
  it('forbids copying list_all_clients sensitive fields into the report even when the task asks for them', () => {
    const lower = adminDirective.toLowerCase();
    // it must flag that list_all_clients returns more than identity data
    expect(lower).toContain('roles');
    expect(lower).toContain('subscription');
    expect(lower).toMatch(/stripe|billing|payment/);
    // and hard-forbid emitting them (no explicit-request carve-out)
    expect(lower).toMatch(/only|never/);
    expect(lower).toContain('even if the task asks for them');
    // the guard must reference the auto-distribution / recipient-authorization risk
    expect(lower).toMatch(/recipient|auto-emailed|slack/);
  });

  // The identity-resolution slice references two admin-only tools
  // (get_chat_history, list_all_clients). It must be admin-gated: a non-admin
  // scheduled run cannot call either (403 at the service layer), so injecting
  // the guidance would be dead weight — and we never want to hand the "is this
  // caller authorized" decision to the model as prose. The rest of the
  // unattended directive still applies to every scheduled run.
  it('injects the identity-resolution slice only for admin owners, never for non-admins', () => {
    const nonAdmin = getUnattendedExecutionDirective('scheduled', false);
    expect(nonAdmin).not.toContain('list_all_clients');
    expect(nonAdmin).not.toContain('IDENTITY RESOLUTION');
    // default (no isAdmin arg) must also omit it — safe by default
    expect(directive).not.toContain('list_all_clients');
    // but the general best-effort/per-entity directive is still present for all
    // scheduled runs regardless of admin status
    expect(nonAdmin).toContain('BEST-EFFORT');
    expect(nonAdmin).toContain('PER-ENTITY COMPLETION LOOP');
    expect(adminDirective).toContain('PER-ENTITY COMPLETION LOOP');
  });

  // ── (8) Publish authorization signal (ENG-827) ──────────────────────────────
  // Regression coverage for sessions 1b28ae36 / a924892d (Kevin — Daily LinkedIn
  // / X posts): the agent drafted a 5/5 post, then refused post_on_connected_account
  // in an unattended run because it had no machine-readable signal that the
  // schedule authorized live publishing, so it fell back to refusing and the
  // required-tool checker nudged it in a loop that burned the run. The directive
  // must carry an explicit, deterministic publish-authorization block — not leave
  // it to the model to guess.
  // An authorized directive is ALWAYS tool-scoped — the resolver cannot produce
  // 'authorized' with an empty tool list, so the prompt never emits an unscoped
  // publish mandate (Greptile P1 #5).
  const publishAuthorizedDirective = getUnattendedExecutionDirective('scheduled', false, 'authorized', ['post_on_connected_account']);
  const publishGatedDirective = getUnattendedExecutionDirective('scheduled', false, 'withheld');

  it('always carries an explicit PUBLISH AUTHORIZATION block on scheduled runs', () => {
    expect(publishAuthorizedDirective).toContain('PUBLISH AUTHORIZATION');
    expect(publishGatedDirective).toContain('PUBLISH AUTHORIZATION');
    // default (no publishAuthorized arg) is the safe, publish-gated variant
    expect(directive).toContain('PUBLISH AUTHORIZATION');
  });

  it('AUTHORIZES publishing (satisfies the approval gate, requires the publish tool) when pre-authorized', () => {
    expect(publishAuthorizedDirective).toContain('PRE-AUTHORIZED to publish');
    expect(publishAuthorizedDirective).toContain('ALREADY SATISFIED');
    // it must name the concrete publishing tool the run was refusing to call
    expect(publishAuthorizedDirective).toContain('post_on_connected_account');
    expect(publishAuthorizedDirective).toContain('you MUST call post_on_connected_account');
    // and it must NOT tell the run to withhold / seek sign-off
    expect(publishAuthorizedDirective.toLowerCase()).not.toContain('awaiting the owner');
  });

  it('WITHHOLDS publishing deterministically (draft + notify once, no loop) when NOT pre-authorized', () => {
    expect(publishGatedDirective).toContain('NOT pre-authorized to publish');
    expect(publishGatedDirective.toLowerCase()).toContain('do not call a live-publishing tool');
    expect(publishGatedDirective).toContain('post_on_connected_account');
    // draft-and-notify is the correct COMPLETE terminal state, not a failure
    expect(publishGatedDirective.toLowerCase()).toContain('awaiting the owner');
    expect(publishGatedDirective.toLowerCase()).toContain('not unfinished');
    // and it must stop the nudge loop rather than re-attempting the withheld publish
    expect(publishGatedDirective.toLowerCase()).toContain('do not repeatedly');
  });

  it('safe-by-default: omitting publishAuthorized yields the publish-GATED block, never the authorized one', () => {
    expect(directive).toContain('NOT pre-authorized to publish');
    expect(directive).not.toContain('PRE-AUTHORIZED to publish');
  });

  it('still returns empty (no publish block) for non-scheduled sessions even when publishAuthorized is true', () => {
    expect(getUnattendedExecutionDirective('regular', false, 'authorized')).toBe('');
    expect(getUnattendedExecutionDirective(undefined, true, 'authorized')).toBe('');
  });

  it('names the exact publish tools the owner approved, and scopes to them', () => {
    const scoped = getUnattendedExecutionDirective('scheduled', false, 'authorized', ['post_on_connected_account']);
    expect(scoped).toContain('approved post_on_connected_account');
    expect(scoped).toContain('The authorization covers post_on_connected_account');
    expect(scoped).not.toContain('publish_landing_page_changes');
  });

  // ENG-1045 follow-up: a grant for post_on_connected_account alone used to leave the
  // model believing twitter_manage_post was categorically off-limits, so it never
  // attempted the thread/reply/quote-tweet route the completion checker's equivalence
  // fix exists to credit — live-verified on preview 2026-08-17 (the model narrated
  // "only pre-authorized to publish using post_on_connected_account" and silently
  // collapsed a requested 2-tweet thread into one tweet).
  it('tells the model the equivalent-outcome route is ALSO covered by the same grant', () => {
    const scoped = getUnattendedExecutionDirective('scheduled', false, 'authorized', ['post_on_connected_account']);
    expect(scoped).toContain('twitter_manage_post');
    expect(scoped).toContain('post_thread/reply/quote_tweet only');
    expect(scoped.toLowerCase()).toContain('do not silently shrink or merge');
  });

  // retweet is deliberately NOT part of the equivalence route (it reshares someone
  // else's content, a different act from the mandated publish) — the directive must
  // not blanket-authorize the whole tool.
  it('does not blanket-name the equivalent tool as fully authorized — only its specific actions', () => {
    const scoped = getUnattendedExecutionDirective('scheduled', false, 'authorized', ['post_on_connected_account']);
    expect(scoped).not.toContain('you MUST call post_on_connected_account / twitter_manage_post');
  });

  it('does NOT append the equivalence note for a grant with no known equivalent route', () => {
    const scoped = getUnattendedExecutionDirective('scheduled', false, 'authorized', ['publish_landing_page_changes']);
    expect(scoped).toContain('The authorization covers publish_landing_page_changes.');
    expect(scoped).not.toContain('twitter_manage_post');
  });

  // Consent is tool-scoped, so authorization with no approved tool has unknown scope
  // and must NOT become a licence to reach for any live-publishing tool. The resolver
  // already refuses to emit this state; this is defence in depth.
  it('emits NO authorization block when authorized with no tools named', () => {
    const broad = getUnattendedExecutionDirective('scheduled', false, 'authorized', []);
    expect(broad).not.toContain('PRE-AUTHORIZED to publish');
    expect(broad).toContain('NOT pre-authorized to publish');
  });

  // Greptile P1: the prompt is rebuilt (and the schedule re-read) on EVERY
  // verification attempt, while the required-function checker fixes its list once
  // from its own snapshot. If an unreadable schedule emitted the prohibition, a
  // single throttled read would forbid a tool the checker still demands —
  // re-creating the nudge-loop contradiction. 'unknown' must stay silent.
  it('emits NO publish block when authorization could not be determined', () => {
    const unknown = getUnattendedExecutionDirective('scheduled', false, 'unknown');
    expect(unknown).not.toContain('PUBLISH AUTHORIZATION');
    expect(unknown).not.toContain('NOT pre-authorized to publish');
    expect(unknown).not.toContain('PRE-AUTHORIZED to publish');
    expect(unknown.toLowerCase()).not.toContain('do not call a live-publishing tool');
    // the rest of the unattended directive is unaffected
    expect(unknown).toContain('PER-ENTITY COMPLETION LOOP');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('getEmmaSystemContext — scheduled-session integration', () => {
  // ── Base prompt is always present ────────────────────────────────────────────

  it('always contains the core Emma identity', () => {
    expect(getEmmaSystemContext()).toContain('EMMA');
    expect(getEmmaSystemContext('regular')).toContain('EMMA');
    expect(getEmmaSystemContext('scheduled')).toContain('EMMA');
  });

  it('always contains the sidebar addendum', () => {
    expect(getEmmaSystemContext()).toContain('Sidebar Mode');
    expect(getEmmaSystemContext('regular')).toContain('Sidebar Mode');
    expect(getEmmaSystemContext('scheduled')).toContain('Sidebar Mode');
  });

  // ── Proactive scheduling instruction is present in the base prompt ──────────
  // (ensures regular sessions CAN suggest scheduling)

  it('contains the proactive scheduling instruction for regular sessions', () => {
    const prompt = getEmmaSystemContext('regular');
    expect(prompt).toContain('Proactively Suggest Scheduling');
  });

  it('contains the proactive scheduling instruction for undefined sessions', () => {
    const prompt = getEmmaSystemContext();
    expect(prompt).toContain('Proactively Suggest Scheduling');
  });

  it('contains the schedule suggestion example text for regular sessions', () => {
    // The system prompt includes an example "want this to run automatically" nudge
    // that Emma should use. It should be present in non-scheduled prompts.
    const prompt = getEmmaSystemContext('regular');
    expect(prompt).toContain('schedule this');
  });

  // ── Scheduled sessions suppress schedule suggestions ────────────────────────
  // Use the unique phrase that only appears in the injected override, not in the base prompt.

  it('includes "This IS a scheduled automated session" for scheduled sessions', () => {
    expect(getEmmaSystemContext('scheduled')).toContain('This IS a scheduled automated session');
  });

  it('includes NEVER suggest creating a schedule for scheduled sessions', () => {
    expect(getEmmaSystemContext('scheduled')).toContain('NEVER suggest creating a schedule');
  });

  it('tells Emma to just deliver results in scheduled sessions', () => {
    expect(getEmmaSystemContext('scheduled')).toContain('Just deliver the results');
  });

  // ── Non-scheduled sessions do NOT include the override ──────────────────────

  it('does NOT include "This IS a scheduled automated session" for regular sessions', () => {
    expect(getEmmaSystemContext('regular')).not.toContain('This IS a scheduled automated session');
  });

  it('does NOT include "This IS a scheduled automated session" when sessionType is undefined', () => {
    expect(getEmmaSystemContext()).not.toContain('This IS a scheduled automated session');
  });

  it('does NOT include the override for other non-scheduled types', () => {
    for (const t of ['image-generation', 'report_generation', 'emma-email']) {
      expect(getEmmaSystemContext(t)).not.toContain('This IS a scheduled automated session');
    }
  });

  // ── Override appears at the END (after sidebar addendum) ────────────────────
  // Ensures the override is the final word and not buried mid-prompt

  it('override text appears after the sidebar addendum in scheduled prompts', () => {
    const prompt = getEmmaSystemContext('scheduled');
    const sidebarIdx = prompt.indexOf('Sidebar Mode');
    const overrideIdx = prompt.indexOf('This IS a scheduled automated session');
    expect(sidebarIdx).toBeGreaterThan(-1);
    expect(overrideIdx).toBeGreaterThan(sidebarIdx);
  });
});
