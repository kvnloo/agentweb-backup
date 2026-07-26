/**
 * Issue intake orchestration — one place that decides where a filing goes.
 *
 * The FEATUREBASE_INTAKE flag is an EXPLICIT migration switch (Linear when on, Notion
 * when off — the off branch is deleted once the migration completes). It is NOT an
 * on-error fallback: we do not silently reroute a failed Linear write to Notion.
 * Instead we fail well —
 *   - non-critical sub-steps (dedup search, upvote, comment) are best-effort and degrade
 *     in place (dedup fails -> treat as new; upvote/comment fails -> still filed),
 *   - a core create failure propagates so the caller surfaces it (user-filed -> the user
 *     is told it didn't file; auto -> the call site logs and moves on, since a failed
 *     self-report must never break the user's real request).
 *
 * Two entry points:
 *  - fileUserIssue:  USER-filed feature/bug (Emma report_product_issues + the in-app
 *    "report a bug" button). Dedups against open public canonicals; on a match it stacks
 *    (upvote the Featurebase post + comment the canonical); otherwise creates a canonical
 *    Linear issue (tagged "Featurebase" -> imported as a public, votable post).
 *  - fileAutoIssue:  AUTO-identified by the system. Creates a PRIVATE Linear issue
 *    (tagged "Auto", NO "Featurebase" label -> never public) and dedups by normalized title
 *    so recurring auto-issues group onto one item instead of flooding the board.
 */

import { getUserFunnelStatusIssueTags, getUserFunnelStatusCoarseTag } from '../utils/userFunnelStatus';
import type { OpenCanonical } from './linearService';

const FEATUREBASE_BOARD_URL = 'https://agentweb.featurebase.app/';
const LINEAR_ISSUE_BASE = 'https://linear.app/emmabyaw/issue';

/**
 * A report that explicitly names an existing tracked ticket — the user-facing "AGW-<n>" id or a raw
 * Linear "ENG-<n>" identifier. It's the signal that a report is a regression / failed retest of a
 * known bug rather than a fresh one, so we look for a resolved canonical to REOPEN (ENG-240 #3)
 * instead of filing a duplicate.
 */
const REFERENCES_CANONICAL = /\b(?:AGW|ENG)-\d+\b/i;

/**
 * Explicit ticket references extracted from a report's text — the input to the deterministic
 * exact-match short-circuit below. Only `agwNumbers` drives an exact match (see
 * `findExactCanonicalMatch`): a bare "ENG-N" mention is intentionally NOT compared against
 * `OpenCanonical.identifier` directly, because a report can casually NAME another ticket without
 * actually being the same bug (e.g. "new unrelated bug, mentions ENG-500 loosely") — that must
 * still go through the fuzzy judge, exactly as before this change. AGW-N is safe to match
 * deterministically because it only matches when the EXACT number appears in a candidate's own
 * private `[reporter-ticket #N ...]` comment (see `fileBugReport` below) — a real ticket-number
 * placement, not incidental prose.
 */
interface CanonicalRefs {
  agwNumbers: Set<string>;
}

function extractCanonicalRefs(text: string): CanonicalRefs {
  const agwNumbers = new Set<string>();
  for (const m of text.matchAll(/\bAGW-(\d+)\b/gi)) agwNumbers.add(m[1]);
  return { agwNumbers };
}

/**
 * Deterministic exact-match lookup for an explicit AGW-N reference — the fix for the "reported
 * new evidence against an already-tracked bug -> fuzzy judge misses it -> duplicate filed"
 * failure mode (ENG-329 incident). Runs BEFORE the fuzzy judge and only when the report text
 * names a specific AGW ticket number; on any miss (bad number, stale reference, candidate outside
 * the fetched window, a comments-fetch failure) it returns null and the caller falls through
 * unchanged to the existing fuzzy dedup path — this must never throw and never block filing.
 */
const EXACT_MATCH_COMMENT_SCAN_LIMIT = 10; // bounds worst-case Linear calls; both lists are already
// ordered most-recent-first, so capping below MAX_CANDIDATES (30) costs little match coverage
// while keeping worst-case added latency comfortably under report_product_issues' 30s filing timeout.

async function findExactCanonicalMatch(
  refs: CanonicalRefs,
  candidates: OpenCanonical[],
): Promise<OpenCanonical | null> {
  if (refs.agwNumbers.size === 0 || candidates.length === 0) return null;

  const { getIssueCommentsDetailed } = await import('./linearService');
  for (const c of candidates.slice(0, EXACT_MATCH_COMMENT_SCAN_LIMIT)) {
    try {
      const comments = await getIssueCommentsDetailed(c.issueId);
      for (const n of refs.agwNumbers) {
        if (comments.some((cm) => cm.body.includes(`[reporter-ticket #${n} `))) return c;
      }
    } catch (e) {
      // Also catches a malformed (non-array) resolved value, not just a rejection — keeps the
      // "never throw" contract even if the helper's return shape is ever unexpected.
      console.warn(`[intake] exact-ref comment scan failed for ${c.identifier}:`, e instanceof Error ? e.message : e);
      continue; // best-effort — a read failure on one candidate must not block the others or the filing
    }
  }
  return null;
}

function intakeEnabled(): boolean {
  return process.env.FEATUREBASE_INTAKE === 'true';
}

/**
 * Idempotency keys for auto-issue dedup (ENG-240): the stable identifiers of the underlying event —
 * the failing Session ID and/or the owning Schedule ID. Two filers reacting to the SAME failure carry
 * the same id even when their titles/sources differ, so we dedup on these instead of on wording.
 * Placeholder values ("N/A", "unknown", empty) are dropped — they'd collide across unrelated events.
 */
const IDEMPOTENCY_CONTEXT_KEYS = ['Session ID', 'Schedule ID'];
const IDEMPOTENCY_PLACEHOLDERS = new Set(['', 'n/a', 'na', 'unknown', 'none', 'null', 'undefined']);
function idempotencyKeys(context?: Record<string, any>): string[] {
  if (!context) return [];
  const keys: string[] = [];
  for (const k of IDEMPOTENCY_CONTEXT_KEYS) {
    const v = context[k];
    if (v === undefined || v === null) continue;
    const s = String(v).trim();
    if (s && !IDEMPOTENCY_PLACEHOLDERS.has(s.toLowerCase())) keys.push(s);
  }
  return keys;
}

function contextLines(context?: Record<string, any>): string[] {
  if (!context) return [];
  return Object.entries(context).map(([k, v]) => {
    const val = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return `- ${k}: ${val.length > 400 ? val.slice(0, 400) + '…' : val}`;
  });
}

/**
 * Context keys carrying the reporter's funnel stage — PRIVATE internal info (ENG-187). They may
 * reach Linear (labels / canonical description / eng comments) but must never reach Featurebase,
 * not even in a private note: nothing customer-adjacent carries funnel state.
 */
const LINEAR_ONLY_CONTEXT_KEYS = ['User Status'];
function featurebaseSafeContext(ctx?: Record<string, any>): Record<string, any> | undefined {
  if (!ctx) return ctx;
  return Object.fromEntries(Object.entries(ctx).filter(([k]) => !LINEAR_ONLY_CONTEXT_KEYS.includes(k)));
}

/**
 * Creation-time triage defaults for customer-filed bug canonicals (ENG-187): a user-filed bug is
 * NEVER created unassigned, unprioritized, or sitting in Backlog — bugs must not rot. Priority
 * follows the reporter's coarse funnel bucket per the board doc ("How this board works —
 * Engineering"): Retention -> Urgent, Setup/Activated -> High, Sales/Parked/unknown -> Medium.
 */
const BUG_CANONICAL_STATE = 'Todo';
const BUG_DEFAULT_ASSIGNEE_ID = 'cabadf7c-b95d-4455-b9ec-df11d5d83f5f'; // Manan Varma — default bug owner (changed from Harshit 2026-07-20, ENG-409)
const BUG_PRIORITY = { URGENT: 1, HIGH: 2, MEDIUM: 3 } as const; // Linear priority enum (1=Urgent … 4=Low)
const BUG_PRIORITY_BY_COARSE_TAG: Record<string, number> = {
  Retention: BUG_PRIORITY.URGENT,
  Setup: BUG_PRIORITY.HIGH,
  Activated: BUG_PRIORITY.HIGH,
};

function bugPriorityForFunnel(funnelStatus?: string | null): number {
  const coarse = getUserFunnelStatusCoarseTag(funnelStatus);
  return (coarse && BUG_PRIORITY_BY_COARSE_TAG[coarse]) || BUG_PRIORITY.MEDIUM;
}

export interface FileUserIssueParams {
  type: 'feature_request' | 'bug';
  title: string;
  description: string;
  userEmail: string;
  userName?: string;
  /** Admin email when filed via a delegated session. */
  reportedByAdmin?: string;
  /** Chat session id of the reporter, so eng can jump straight to the offending session. */
  sessionId?: string;
  /**
   * Reporter's funnel stage (user record `funnelStatus`, PR #2025) — drives the Linear-side triage
   * enrichment (stage labels + priority, ENG-187). PRIVATE internal info: never surfaces in
   * Featurebase content or any reporter-facing email.
   */
  funnelStatus?: string | null;
  /** Tags + context for the Notion path (flag off). */
  notionTags?: string[];
  notionContext?: Record<string, any>;
  /**
   * Reporter-stated priority (Urgent | High | Medium | Low, case-insensitive). Mapped onto the
   * Linear priority FIELD so the description text and the board never disagree (ENG-231). Blended
   * with the funnel-tier default: the more severe of the two wins, so a stated High/Urgent
   * upgrades the tier and a stated Low never downgrades it.
   */
  priority?: string;
}

// Reporter-stated priority text -> Linear enum (1=Urgent, 2=High, 3=Medium, 4=Low). Unknown or
// absent text contributes nothing — the funnel-tier default (ENG-187) then decides alone.
const LINEAR_PRIORITY: Record<string, number> = { urgent: 1, high: 2, medium: 3, low: 4 };

export interface FiledUserResult {
  pageId: string;       // Featurebase post id (or Notion pageId when the flag is off)
  trackerUrl: string;   // internal tracker link (Featurebase post / Notion page)
  userUrl?: string;     // public, user-facing Featurebase post link
  /**
   * Internal Linear canonical issue link (bugs only) — the single ticket eng works, whether this
   * report created it or deduped onto an existing one. Surfaced so the team gets a VISIBLE Linear
   * confirmation/link instead of only the reporter's private Featurebase card (ENG-289). Never
   * shown to the customer — it is an internal, eng-facing link for the notification email.
   */
  canonicalUrl?: string;
  deduped: boolean;
  tracker: 'Featurebase' | 'Notion';
}

export async function fileUserIssue(p: FileUserIssueParams): Promise<FiledUserResult> {
  // Migration switch (NOT a fallback): off -> Notion, the pre-migration default.
  if (!intakeEnabled()) {
    const { createOncallItem } = await import('./notionService');
    const o = await createOncallItem({
      title: p.title,
      description: p.description,
      additionalTags: p.notionTags || ['Customer Reported'],
      context: p.notionContext,
    });
    return { pageId: o.pageId, trackerUrl: o.notionUrl, deduped: false, tracker: 'Notion' };
  }

  // Featurebase-first. Bugs -> a private per-reporter TICKET (their own card) grouped onto a
  // Linear canonical (the resolve-bridge notifies every reporter on fix). Feature requests ->
  // a public, votable POST. This split matches Featurebase's own guidance (public requests on
  // boards; private issues as tickets).
  return p.type === 'bug' ? fileBugReport(p) : fileFeatureRequest(p);
}

function reporterLabel(p: FileUserIssueParams): string {
  return `${p.userEmail}${p.userName && p.userName !== p.userEmail ? ` (${p.userName})` : ''}`;
}

/** Feature request -> public Featurebase post (FB-first); on dedup, stack a voter + private comment. */
async function fileFeatureRequest(p: FileUserIssueParams): Promise<FiledUserResult> {
  const { findDuplicate, MAX_CANDIDATES } = await import('./dedupService');
  const { listOpenPosts, createPost, addComment, addVoter } = await import('./featurebaseService');

  const posts = await listOpenPosts(MAX_CANDIDATES);
  const byRef = new Map(posts.map((x) => [x.id, x]));
  const dup = await findDuplicate(
    { type: 'feature_request', title: p.title, description: p.description },
    posts.map((x) => ({ ref: x.id, title: x.title, description: x.description })),
  );

  if (dup) {
    const post = byRef.get(dup.ref)!;
    // Best-effort stacking — a failure must not create a duplicate post. Private (eng-only)
    // comment keeps the reporter's full text + session out of the public body.
    const reportedNote = [
      `Also reported by ${reporterLabel(p)} on ${new Date().toISOString().slice(0, 10)}${p.reportedByAdmin ? ` — via ${p.reportedByAdmin} acting on their behalf` : ''}.`,
      ...(p.sessionId ? [`Session: ${p.sessionId}`] : []),
      '',
      'Their report:',
      p.description,
      ...contextLines(featurebaseSafeContext(p.notionContext)),
    ].join('\n');
    try { await addComment(post.id, reportedNote, true); } catch (e) { console.warn('[intake] feature dedup comment failed:', e instanceof Error ? e.message : e); }
    try { await addVoter(post.id, p.userEmail, p.userName); } catch (e) { console.warn('[intake] feature dedup upvote failed:', e instanceof Error ? e.message : e); }
    return { pageId: post.id, trackerUrl: post.url || FEATUREBASE_BOARD_URL, userUrl: post.url || FEATUREBASE_BOARD_URL, deduped: true, tracker: 'Featurebase' };
  }

  // New public post, authored by the filer (-> their "My profile"); Featurebase pushes it to
  // Linear for eng. Propagates on failure — no Notion reroute.
  const post = await createPost({ title: p.title, description: p.description, authorEmail: p.userEmail, authorName: p.userName });
  const filedNote = [
    p.reportedByAdmin ? `Filed by ${reporterLabel(p)} via ${p.reportedByAdmin} acting on their behalf (delegated session).` : `Filed by ${reporterLabel(p)}.`,
    ...(p.sessionId ? [`Session: ${p.sessionId}`] : []),
    ...contextLines(featurebaseSafeContext(p.notionContext)),
  ].join('\n');
  try { await addComment(post.id, filedNote, true); } catch (e) { console.warn('[intake] feature filed comment failed:', e instanceof Error ? e.message : e); }
  return { pageId: post.id, trackerUrl: post.url || FEATUREBASE_BOARD_URL, userUrl: post.url || FEATUREBASE_BOARD_URL, deduped: false, tracker: 'Featurebase' };
}

/**
 * Bug -> a PRIVATE per-reporter Featurebase ticket (the reporter's own card, authorOnly) grouped
 * onto ONE canonical Linear ticket per bug.
 *
 * Each reporter gets their own card (their words). All reporters of the same bug group onto a
 * single canonical Linear issue (Bug + Customer Reported, NO Featurebase label) — the one ticket
 * eng works. That canonical lists every affected user (email + session) via a `[reporter-ticket #N]`
 * comment per reporter; eng sees who's impacted, and the Linear resolve-bridge reads those numbers
 * to flip + notify every reporter's card when the canonical is marked Done.
 *
 * Requires Linear sync to be OFF for the Bug Report ticket category (so cards don't each spawn
 * their own Linear issue) — the canonical is the only Linear ticket per bug.
 */
async function fileBugReport(p: FileUserIssueParams): Promise<FiledUserResult> {
  const { findDuplicate, MAX_CANDIDATES } = await import('./dedupService');
  const { listOpenBugCanonicals, listRecentlyResolvedBugCanonicals, createInternalLinearIssue, addIssueComment, raiseIssueTriage, reopenIssue } = await import('./linearService');
  const { createTicket } = await import('./featurebaseService');

  // Linear-side triage enrichment (ENG-187): the reporter's funnel stage becomes stage labels
  // ("Status: <stage>" + coarse bucket) and sets the priority default. Linear-only — the stage
  // never reaches the Featurebase ticket or any reporter-facing surface.
  const stageTags = getUserFunnelStatusIssueTags(p.funnelStatus);
  // Priority = the more severe of the funnel-tier default (ENG-187) and the reporter's stated
  // priority (ENG-231): a stated High/Urgent upgrades the tier; a stated Low never downgrades it.
  const stated = p.priority ? LINEAR_PRIORITY[p.priority.toLowerCase()] : undefined;
  const priority = stated ? Math.min(bugPriorityForFunnel(p.funnelStatus), stated) : bugPriorityForFunnel(p.funnelStatus);

  // 1. The reporter's OWN private card. Body = their words (what THEY see). Propagates on failure.
  const ticket = await createTicket({ title: p.title, content: p.description, authorEmail: p.userEmail, authorName: p.userName });

  // 2. Find or create the ONE canonical Linear ticket for this bug (dedup groups reporters).
  const cans = await listOpenBugCanonicals(MAX_CANDIDATES);
  const byRef = new Map(cans.map((c) => [c.identifier, c]));
  const refs = extractCanonicalRefs(`${p.title}\n${p.description}`);

  // Deterministic short-circuit (fixes the ENG-329 false-duplicate incident): an explicit AGW-N
  // reference is checked for an EXACT match — via its private reporter-ticket comment — before the
  // fuzzy judge ever runs. No AGW-N reference present -> no-op -> behavior identical to today.
  const exactOpenMatch = await findExactCanonicalMatch(refs, cans);
  const dup = exactOpenMatch
    ? { ref: exactOpenMatch.identifier, title: exactOpenMatch.title, description: exactOpenMatch.description }
    : await findDuplicate(
        { type: 'bug', title: p.title, description: p.description },
        cans.map((c) => ({ ref: c.identifier, title: c.title, description: c.description })),
      );

  // Reopen, not refile (ENG-240 contract #3): when no OPEN canonical matches but the report explicitly
  // references an existing ticket (regression / failed retest, e.g. "AGW-58" or "ENG-179"), match it
  // against recently-RESOLVED canonicals so we reopen the one it duplicates instead of filing anew.
  let reopenTarget: OpenCanonical | null = null;
  if (!dup && REFERENCES_CANONICAL.test(`${p.title}\n${p.description}`)) {
    const resolved = await listRecentlyResolvedBugCanonicals(MAX_CANDIDATES);
    if (resolved.length) {
      const rByRef = new Map(resolved.map((c) => [c.identifier, c]));
      const exactResolvedMatch = await findExactCanonicalMatch(refs, resolved);
      if (exactResolvedMatch) {
        reopenTarget = exactResolvedMatch;
      } else {
        const rdup = await findDuplicate(
          { type: 'bug', title: p.title, description: p.description },
          resolved.map((c) => ({ ref: c.identifier, title: c.title, description: c.description })),
        );
        reopenTarget = rdup ? rByRef.get(rdup.ref) || null : null;
      }
    }
  }

  let canonicalUuid = '';
  let canonicalUrl = '';
  let grouped = false;  // grouped onto an existing canonical (open dup OR reopened resolved one)
  let reopened = false; // reopened a Done/canceled canonical for a regression / failed retest
  if (dup) {
    const matched = byRef.get(dup.ref)!;
    canonicalUuid = matched.issueId;
    grouped = true;
    // A deduped report returns the SAME canonical link (ENG-289). listOpenBugCanonicals gives us
    // the identifier (e.g. ENG-42) but not the url, so build it from the stable issue-URL base.
    canonicalUrl = `${LINEAR_ISSUE_BASE}/${matched.identifier}`;
    // Dedup triage upgrade (ENG-187): a higher-tier reporter hitting an existing canonical unions
    // its stage labels in and raises the priority — never lowers it (raise-only by contract of
    // raiseIssueTriage). Best-effort: a failed upgrade must not block the filing.
    try {
      await raiseIssueTriage(canonicalUuid, { addLabelNames: stageTags, priority });
    } catch (e) {
      console.warn('[intake] bug canonical triage upgrade failed:', e instanceof Error ? e.message : e);
    }
  } else if (reopenTarget) {
    canonicalUuid = reopenTarget.issueId;
    // Surface the reopened canonical's link too (ENG-289) — same URL base as the dup path.
    canonicalUrl = `${LINEAR_ISSUE_BASE}/${reopenTarget.identifier}`;
    grouped = true;
    // Reopen first (Done -> Todo), then apply the same raise-only triage a fresh report would.
    // Best-effort so a reopen/triage hiccup never blocks recording the reporter. Only flip
    // `reopened` AFTER the state change actually lands — otherwise a swallowed reopen failure would
    // stamp a misleading "⚠️ Reopened by a new report" comment on a ticket still sitting in Done.
    try {
      await reopenIssue(canonicalUuid, BUG_CANONICAL_STATE);
      reopened = true;
    } catch (e) {
      console.warn('[intake] bug canonical reopen failed:', e instanceof Error ? e.message : e);
    }
    try {
      await raiseIssueTriage(canonicalUuid, { addLabelNames: stageTags, priority });
    } catch (e) {
      console.warn('[intake] bug canonical reopen triage upgrade failed:', e instanceof Error ? e.message : e);
    }
  } else {
    const filedBy = p.reportedByAdmin
      ? `via ${p.reportedByAdmin} acting on their behalf (delegated session)`
      : 'self-reported';
    const li = await createInternalLinearIssue({
      title: p.title,
      description: [
        p.description,
        '',
        '---',
        'Customer-reported bug. Each affected user has their own private Featurebase ticket; resolving THIS issue notifies them all (see the [reporter-ticket #N] comments).',
        '',
        `Affected user: ${reporterLabel(p)} (${filedBy})`,
        ...(p.sessionId ? [`Session: ${p.sessionId}`] : []),
        ...contextLines(p.notionContext),
      ].join('\n'),
      // Stage labels + no-rot defaults (ENG-187): every customer bug lands in Todo, assigned,
      // with a funnel-derived priority — never unowned in Backlog.
      labelNames: ['Bug', 'Customer Reported', ...stageTags],
      priority,
      stateName: BUG_CANONICAL_STATE,
      assigneeId: BUG_DEFAULT_ASSIGNEE_ID,
    });
    canonicalUuid = li.id || '';
    // Capture the canonical link (ENG-289) — createInternalLinearIssue returns it; fall back to
    // building from the identifier if the url is ever absent.
    canonicalUrl = li.url || (li.identifier ? `${LINEAR_ISSUE_BASE}/${li.identifier}` : '');
  }

  // 3. Record this reporter on the canonical (best-effort). `[reporter-ticket #N]` is the contract
  //    the resolve-bridge parses to notify each card; eng also sees the affected user + session.
  if (canonicalUuid) {
    const note = [
      ...(reopened ? ['⚠️ Reopened by a new report (regression / failed retest) — this bug is back.', ''] : []),
      `[reporter-ticket #${ticket.number} ${p.userEmail}] Affected user: ${reporterLabel(p)}${p.reportedByAdmin ? ` — via ${p.reportedByAdmin}` : ''} on ${new Date().toISOString().slice(0, 10)}.`,
      ...(p.sessionId ? [`Session: ${p.sessionId}`] : []),
      // The reopened canonical's body is the OLD report, so fold in this reporter's text too — as we
      // do for any reporter grouped onto an existing canonical. Only the brand-new canonical already
      // carries the text in its description.
      ...(grouped ? ['', 'Their report:', p.description] : []),
      ...contextLines(p.notionContext),
    ].join('\n');
    try { await addIssueComment(canonicalUuid, note); } catch (e) { console.warn('[intake] bug canonical comment failed:', e instanceof Error ? e.message : e); }
  }

  return {
    pageId: String(ticket.number),
    trackerUrl: ticket.url || FEATUREBASE_BOARD_URL,
    userUrl: ticket.url || FEATUREBASE_BOARD_URL, // the reporter's OWN private card
    canonicalUrl: canonicalUrl || undefined,      // internal Linear canonical (ENG-289)
    deduped: grouped,

    tracker: 'Featurebase',
  };
}

/**
 * Enrich a Featurebase-SYNCED Linear issue at creation time (ENG-187 contract #4).
 *
 * Feature requests are Featurebase-first: `fileFeatureRequest` creates a public post
 * (`integrations.linear:true`) and the linked Linear issue is created ~10s later by Featurebase's
 * native FB->Linear sync INSIDE their SaaS — there is no repo seam at issue creation. The Linear
 * webhook (routes/integrations.ts) therefore calls this for every created issue carrying the
 * "Featurebase" label (the sync's marker — issues our own code creates never carry it, see
 * createInternalLinearIssue), so the synced issue still ends up with the reporter's PRIVATE
 * funnel-stage labels + "Needs PM", resting in Backlog. Deliberately NO priority and NO assignee:
 * feature requests await the weekly PM pass (that's what "Needs PM" flags) — only bugs get the
 * no-rot auto-triage.
 *
 * Author resolution: synced issue title -> exact-match Featurebase post -> post author email ->
 * AgentWeb user -> funnelStatus. Every miss in that chain is LOUD (console.error) and degrades to
 * "Needs PM" alone — never a throw, so a resolution miss can't take down the webhook route (which
 * also serves the resolve bridge). Only a hard failure applying the labels/state propagates.
 * Idempotent under webhook retries: labels union (re-applying is a no-op) and the Backlog settle
 * never moves an issue a human already advanced. Privacy (contract #5) holds by construction:
 * this READS from Featurebase and writes only Linear labels/state — nothing funnel-related flows
 * back to Featurebase or any user-visible surface.
 */
const FEATURE_REQUEST_TRIAGE_LABEL = 'Needs PM';
const FEATURE_REQUEST_RESTING_STATE = 'Backlog';

export async function enrichFeaturebaseSyncedIssue(p: { issueId: string; title: string }): Promise<{ labelNames: string[] }> {
  const { raiseIssueTriage } = await import('./linearService');

  let stageTags: string[] = [];
  try {
    const { findPostByTitle } = await import('./featurebaseService');
    const post = await findPostByTitle(p.title);
    if (!post?.authorEmail) {
      console.error(`[intake] FB-synced issue ${p.issueId} ("${p.title}"): no unambiguous Featurebase post author — applying "${FEATURE_REQUEST_TRIAGE_LABEL}" only.`);
    } else {
      const { userDb } = await import('./db');
      const user = await userDb.getUserByEmail(post.authorEmail);
      if (!user) {
        console.error(`[intake] FB-synced issue ${p.issueId}: post author ${post.authorEmail} has no AgentWeb user — applying "${FEATURE_REQUEST_TRIAGE_LABEL}" only.`);
      } else {
        // A real user with no funnelStatus is a normal state (not yet staged) — no error, no stage labels.
        stageTags = getUserFunnelStatusIssueTags(user.funnelStatus);
      }
    }
  } catch (e) {
    console.error(`[intake] FB-synced issue ${p.issueId}: author/funnel resolution failed — applying "${FEATURE_REQUEST_TRIAGE_LABEL}" only:`, e instanceof Error ? e.message : e);
  }

  const labelNames = [...stageTags, FEATURE_REQUEST_TRIAGE_LABEL];
  // The label/state write is the core step — let a hard failure propagate to the webhook route's
  // catch (logged, 200 response) rather than half-succeed silently.
  await raiseIssueTriage(p.issueId, { addLabelNames: labelNames, settleStateName: FEATURE_REQUEST_RESTING_STATE });
  return { labelNames };
}

export interface FileAutoIssueParams {
  title: string;
  description: string;
  /** Human label for where this came from, e.g. "Context limit", "Scheduled chat". */
  source: string;
  /** Extra Linear labels beyond "Auto" (e.g. ["Scheduled Chat"]). Unknown names are dropped. */
  extraLabels?: string[];
  /**
   * Explicit execution decision for machine-generated work. Priority and complexity never imply
   * autonomy: callers should choose an execution route, and unknown/mixed work should use
   * `human-triage`. Omission fails closed to human triage for legacy callers.
   */
  executionRoute?: 'autofix' | 'human-triage';
  /** Legacy field retained for source compatibility; auto issues are always filed in Linear. */
  notionTags?: string[];
  /** Structured occurrence context used by the Linear dedupe gate. */
  notionContext?: Record<string, any>;
}

/**
 * Alert-class clustering (ENG-358): recurring threshold/balance alerts carry a stable class in
 * context (e.g. `"Alert Class": "v0-credits"`). The class is rendered into the created issue's
 * body via contextLines and matched by containment, so every occurrence lands on the ONE open
 * canonical no matter how the numbers in the title move — never per occurrence. Same mechanism
 * as the Session/Schedule idempotency keys above, checked FIRST because it is the sharper signal.
 *
 * `"Alert Priority"` (urgent|high|medium|low) sets the created canonical's priority and, on a
 * match, escalates the open canonical in place (raise-only priority + title refresh via
 * linearService.escalateIssue) — a warn-level escalation must surface on the SAME issue, not
 * file a new one.
 */
const ALERT_CLASS_CONTEXT_KEY = 'Alert Class';
const ALERT_PRIORITY_CONTEXT_KEY = 'Alert Priority';

export interface FiledAutoResult {
  pageId: string;
  /** Link to the filed Linear issue, for alert emails. */
  url?: string;
  deduped: boolean;
  tracker: 'Linear';
}

/**
 * File an auto-identified issue in Linear. Callers should treat this as best-effort and wrap it
 * (a failed self-report must not break the user's real request) — it throws on a hard failure.
 *
 * Auto issues deliberately ignore FEATUREBASE_INTAKE: that flag controls the customer-facing
 * Featurebase migration, while Linear is the sole source of truth for system-generated work.
 */
export async function fileAutoIssue(p: FileAutoIssueParams): Promise<FiledAutoResult> {
  const {
    listOpenIssuesByLabel,
    addIssueComment,
    createInternalLinearIssue,
    escalateIssue,
    raiseIssueTriage,
  } = await import('./linearService');
  const executionRoute = p.executionRoute ?? 'human-triage';
  const route =
    executionRoute === 'autofix'
      ? {
          labels: ['Bug', 'autofix'],
          removeLabels: ['Needs PM'],
          assigneeId: BUG_DEFAULT_ASSIGNEE_ID,
          stateName: 'Todo',
        }
      : {
          labels: ['Bug', 'Needs PM'],
          removeLabels: ['autofix'],
          assigneeId: '142fef82-4d45-4070-99be-c5debe565ac6', // Harsha
          stateName: 'Todo',
        };
  const routeLabels = route.labels;
  // Amount-insensitive title normalization (ENG-358): dollar amounts in a recurring alert's title
  // are occurrence data, not identity — "v0 credits LOW — $58.51 spendable" and "… $59.15 …" are
  // the same issue. Collapsing amounts also lets pre-ENG-358 open canonicals (no class marker in
  // their body yet) keep matching new classed occurrences instead of spawning a parallel canonical.
  const norm = (s: string) => (s || '').trim().toLowerCase().replace(/\$[\d,]+(?:\.\d+)?/g, '$').replace(/\s+/g, ' ');
  const open = await listOpenIssuesByLabel('Auto', 50);
  // Dedup gate (ENG-240 / ENG-358). One failure event must never spawn 2-3 issues, and a recurring
  // alert must never file per occurrence, whichever filer reacts to it:
  //  1. Alert class — an open Auto issue whose body carries this alert's `Alert Class: <name>`
  //     line owns EVERY occurrence of the class (source × errorClass clustering), regardless of
  //     the numbers in the title. listOpenIssuesByLabel is open-state-whitelisted, so a canceled
  //     or Duplicate canonical can never absorb the signal (the ENG-350 failure mode).
  //  2. Idempotency key — an open Auto issue already carrying this event's Session/Schedule ID owns it.
  //     Two filers (scheduled-chat + oncall) reacting to the same run, or a second analyzer re-filing
  //     the same session days later, both land on that one issue as an occurrence comment.
  //  3. Fallback — normalized-title match, for recurring auto-issues that carry no id context.
  const rawClass = p.notionContext?.[ALERT_CLASS_CONTEXT_KEY];
  const alertClass = rawClass === undefined || rawClass === null ? '' : String(rawClass).trim();
  // Both writer (contextLines above) and matcher live in this file; the bullet prefix is left out
  // of the needle because Linear normalizes "- " bullets to "* " in stored descriptions. The match
  // is anchored at end-of-line so a class name that is a prefix of another ("v0-credits" vs
  // "v0-credits-backup") can never cross-match — the writer always emits the class as the last
  // thing on its own line.
  const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const classNeedle = alertClass
    ? new RegExp(`${escapeRegExp(`${ALERT_CLASS_CONTEXT_KEY}: ${alertClass}`)}\\s*$`, 'm')
    : null;
  const rawPriority = p.notionContext?.[ALERT_PRIORITY_CONTEXT_KEY];
  const priority = rawPriority ? LINEAR_PRIORITY[String(rawPriority).trim().toLowerCase()] : undefined;
  const idKeys = idempotencyKeys(p.notionContext);
  const match =
    (classNeedle ? open.find((i) => classNeedle.test(i.description || '')) : undefined) ||
    (idKeys.length ? open.find((i) => idKeys.some((k) => (i.description || '').includes(k))) : undefined) ||
    open.find((i) => norm(i.title) === norm(p.title));
  if (match) {
    try {
      await addIssueComment(match.issueId, [`Recurred on ${new Date().toISOString().slice(0, 10)}.`, ...contextLines(p.notionContext)].join('\n'));
    } catch (e) {
      console.warn('[intake] auto recur-comment failed:', e instanceof Error ? e.message : e);
    }
    // Escalation (ENG-358 contract #3): a more severe occurrence (low -> critical) raises the open
    // canonical's priority and refreshes its title in place. Raise-only inside escalateIssue, so
    // routine same-level occurrences churn nothing. Best-effort: the occurrence comment + dedupe
    // result stand even if the escalation write hiccups (next occurrence retries).
    if (priority) {
      try {
        await escalateIssue(match.issueId, { title: p.title, priority });
      } catch (e) {
        console.warn('[intake] auto alert escalation failed:', e instanceof Error ? e.message : e);
      }
    }
    if (routeLabels.length > 0) {
      try {
        await raiseIssueTriage(match.issueId, {
          addLabelNames: routeLabels,
          removeLabelNames: route.removeLabels,
          assigneeId: route.assigneeId,
          ...(priority ? { priority } : {}),
          settleStateName: route.stateName,
        });
      } catch (e) {
        console.warn('[intake] auto route enrichment failed:', e instanceof Error ? e.message : e);
      }
    }
    return { pageId: match.identifier, url: `${LINEAR_ISSUE_BASE}/${match.identifier}`, deduped: true, tracker: 'Linear' };
  }
  const body = [
    p.description,
    '',
    '---',
    `Source: ${p.source} — auto-identified by the system.`,
    ...contextLines(p.notionContext),
  ].join('\n');
  const li = await createInternalLinearIssue({
    title: p.title,
    description: body,
    labelNames: [...new Set(['Auto', ...routeLabels, ...(p.extraLabels || [])])],
    stateName: route.stateName,
    assigneeId: route.assigneeId,
    // Classed alerts land with a real priority so the canonical never sits at "No priority"
    // (ENG-350 did). Absent the context key, behavior is unchanged.
    ...(priority ? { priority } : {}),
  });
  return { pageId: li.identifier, url: li.url, deduped: false, tracker: 'Linear' };
}

/**
 * Resolve bridge: when a bug canonical Linear issue is marked Done, notify EVERY reporter whose
 * private card is grouped onto it. We read the canonical's `[reporter-ticket #N <email>]` comments
 * (written at intake) to find each card + its reporter, then EMAIL the reporter and flip their card
 * to Completed. The email is sent from our own system address because Featurebase exposes no API
 * trigger for ticket emails (a ticket reply/status-change via API stays silent) — so we own
 * delivery rather than depend on a path that doesn't fire. Per-reporter best-effort so one failure
 * can't block the rest; idempotent in effect (re-flipping a Completed card is a no-op; a duplicate
 * email is harmless). Returns the ticket numbers we acted on. Called by the Linear webhook handler.
 *
 * Email body (ENG-316): if the canonical carries an `@Emma <message>` comment, the LATEST one
 * (by createdAt) is parroted as the email body — eng controls the customer-facing "here's what
 * happened" from inside Linear. Otherwise the default copy below is sent, unchanged.
 *
 * Feature requests need no bridge: their Featurebase post is synced to Linear, so marking the Linear
 * issue Done flips the post to Completed and Featurebase emails every upvoter natively (verified).
 */
const REPORTER_TICKET_RE = /\[reporter-ticket #(\d+)\s+([^\]\s]+)\]/g;
const escapeHtml = (s: string) => s.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c] as string));

// ENG-316: an `@Emma <message>` comment on the canonical becomes the customer-facing resolution
// email body. VERIFIED LIVE (2026-07-15, probe comment on ENG-316 read back through the same
// GraphQL field the service uses): a REAL Linear workspace mention serializes in the raw comment
// `body` as plain `@displayName` (the bodyData mention node round-trips to just "@harsha"), so
// plain-text `@emma` (case-insensitive) is the mainline form; the bracketed link forms
// (`@[Emma …](…)` / `[@Emma …](…)`) never occur in raw bodies but are tolerated for hand-written
// markdown mentions — either bracket order, so no stray `[](url)` ever reaches a customer email.
//
// The mention must be the comment's LEADING token — the documented convention is
// "@Emma <message>", and requiring it up front is the primary guard that keeps customer-written
// report text (which routinely addresses the agent as "@emma") from ever qualifying.
// `emma\b` anchoring keeps @emmabyaw and names that merely contain "emma" (@[Gemma Ortiz](…))
// from matching.
const EMMA_LEADING_MENTION_RE = /^\s*(?:@emma\b|@\[\s*emma\b[^\]]*\]\([^)]*\)|\[@\s*emma\b[^\]]*\]\([^)]*\))\s*/i;
// Non-global twin of REPORTER_TICKET_RE (`.test()` on a /g/ regex is stateful): marks a comment
// as intake-authored — i.e. carrying CUSTOMER-controlled report text.
const INTAKE_COMMENT_MARKER_RE = /\[reporter-ticket #\d+\s+[^\]\s]+\]/;

/**
 * Pick the customer-facing resolution message from the canonical's comments: the MOST RECENT
 * (by createdAt, not list order) comment that STARTS with an @Emma mention, mention stripped,
 * trimmed. Returns null when no comment qualifies — including mention-only comments — so the
 * default copy stays in play and we never send an empty email.
 *
 * PII guard (reviewer blocker on ENG-316): intake writes customer-controlled text into canonical
 * comments (`Their report:\n<description>`, intake comment above), and customers routinely
 * address the agent as "@emma" inside that text. Those comments are excluded twice over — they
 * carry the reporter-ticket marker, and the mention is never their leading token — so one
 * customer's report (email address included) can never become every reporter's resolution email.
 */
function pickEmmaResolutionMessage(comments: Array<{ body: string; createdAt: string }>): string | null {
  let best: { text: string; ts: number } | null = null;
  for (const c of comments) {
    const body = c.body || '';
    if (INTAKE_COMMENT_MARKER_RE.test(body)) continue;
    const m = body.match(EMMA_LEADING_MENTION_RE);
    if (!m) continue;
    const text = body.slice(m[0].length).trim();
    if (!text) continue;
    const parsed = Date.parse(c.createdAt || '');
    const ts = Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
    if (!best || ts >= best.ts) best = { text, ts };
  }
  return best ? best.text : null;
}

export async function notifyCanonicalResolved(
  canonicalIssueId: string,
  issueTitle = 'the issue you reported',
): Promise<{ ticketNumbers: number[] }> {
  const { getIssueCommentsDetailed } = await import('./linearService');
  const { getTicketStatusId, patchTicketStatus, mdToFeaturebaseHtml } = await import('./featurebaseService');
  const { resendService } = await import('./resendService');
  const { notifyReporterShipped } = await import('./shipNotifyService');

  // ONE comment fetch feeds both consumers — the reporter parse and the @Emma parrot — so the two
  // can never disagree on a mid-resolve snapshot. A fetch failure propagates (as it always has for
  // the reporter parse): without the comments there is nobody to notify, and the webhook route
  // catches + logs it.
  const comments = await getIssueCommentsDetailed(canonicalIssueId);
  const reporters = new Map<number, string>(); // ticket number -> reporter email
  for (const { body } of comments) {
    let m: RegExpExecArray | null;
    REPORTER_TICKET_RE.lastIndex = 0;
    while ((m = REPORTER_TICKET_RE.exec(body)) !== null) reporters.set(Number(m[1]), m[2]);
  }
  if (reporters.size === 0) return { ticketNumbers: [] };

  // ENG-316: eng writes the "here's what happened" message as an `@Emma <message>` comment on the
  // canonical before flipping it to Done; the latest one is parroted as the email body. Rendered
  // via mdToFeaturebaseHtml, which HTML-escapes FIRST — Linear comments are untrusted input for a
  // customer email. Best-effort: a rendering failure degrades to the default copy (loud warn), it
  // never blocks notifying the reporters.
  let emmaHtml: string | null = null;
  try {
    const message = pickEmmaResolutionMessage(comments);
    emmaHtml = message ? mdToFeaturebaseHtml(message) || null : null;
  } catch (e) {
    console.warn('[resolve-bridge] @Emma resolution message rendering failed — using default copy:', e instanceof Error ? e.message : e);
  }

  const completedId = await getTicketStatusId('Completed');
  const safeTitle = escapeHtml(issueTitle);
  const emailHtml =
    emmaHtml ??
    `<p>Good news — the issue you reported (<strong>${safeTitle}</strong>) has been resolved. Thanks for flagging it!</p><p>If you still run into it, just reply to this email and we'll take another look.</p>`;
  const acted: number[] = [];
  for (const [num, email] of reporters) {
    // Slack ping in the reporter's own channel — ADDITIVE to the email, independent of it.
    // notifyReporterShipped never throws by contract; guarded anyway so a bug there can
    // never block the email or the card flip.
    try {
      await notifyReporterShipped({ email, itemId: canonicalIssueId, title: issueTitle, kind: 'bug' });
    } catch (e) {
      console.warn(`[resolve-bridge] Slack ping for reporter #${num} failed:`, e instanceof Error ? e.message : e);
    }
    try {
      // The EMAIL is what notifies the reporter; the status flip reflects the resolved state on their card.
      await resendService.sendSystemEmail({
        to: email,
        subject: `Resolved: ${issueTitle}`,
        html: emailHtml,
      });
      await patchTicketStatus(num, completedId);
      acted.push(num);
    } catch (e) {
      console.warn(`[resolve-bridge] notifying reporter #${num} failed:`, e instanceof Error ? e.message : e);
    }
  }
  return { ticketNumbers: acted };
}
