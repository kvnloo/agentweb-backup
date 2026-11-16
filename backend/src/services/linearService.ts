import { getSecret } from '../utils/secretsManager';
import type { AttributionIssueOutcome } from '../loops/core/learning/attribution';

/**
 * Linear intake service.
 *
 * Linear is the source of truth for engineering work. User-filed feature requests
 * and bugs (via Emma's report_product_issues tool) are created here as Linear issues
 * tagged with the "Featurebase" label — which makes Featurebase automatically import
 * the issue as a linked, public post and keep its status in sync (Linear -> Featurebase).
 *
 * Why this direction: Featurebase's FB->Linear auto-push does NOT fire for posts
 * created via its REST API (only its own UI/widget), so the reliable path is to
 * create in Linear and let Featurebase mirror it via the label import. Verified
 * working 2026-06-28 (import + status sync both ~10s).
 *
 * Manual Linear issues created WITHOUT the "Featurebase" label are never imported,
 * so internal engineering work stays private.
 */

const LINEAR_API = 'https://api.linear.app/graphql';
const TEAM_KEY = 'ENG';

export interface LinearCredentials {
  apiKey: string;
}

const credentialsCache: Record<string, LinearCredentials> = {};

export async function getLinearCredentialsForEnv(env: 'development' | 'production'): Promise<LinearCredentials> {
  if (credentialsCache[env]) return credentialsCache[env];
  const secretName = env === 'production' ? 'prod/AgentWeb/Linear' : 'dev/AgentWeb/Linear';
  const secretString = await getSecret(secretName);
  if (!secretString || secretString.trim() === '') {
    throw new Error(`Linear credentials secret is empty for ${env}`);
  }
  const credentials = JSON.parse(secretString) as LinearCredentials;
  if (!credentials.apiKey) throw new Error(`Linear credentials missing apiKey for ${env}`);
  credentialsCache[env] = credentials;
  return credentials;
}

export async function getLinearCredentials(): Promise<LinearCredentials> {
  const environment = process.env.NODE_ENV || 'development';
  return getLinearCredentialsForEnv(environment === 'production' ? 'production' : 'development');
}

/** Shared authenticated Linear GraphQL boundary for production adapters. */
export async function linearGraphQL(query: string, variables?: Record<string, any>): Promise<any> {
  const { apiKey } = await getLinearCredentials();
  const MAX_RETRIES = 3;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(LINEAR_API, {
      method: 'POST',
      // Linear personal API keys use the raw key in Authorization (NO "Bearer " prefix).
      headers: { 'Authorization': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    const data = await res.json().catch(() => ({} as any));
    const rateLimited = res.status === 400 && Array.isArray(data?.errors)
      && data.errors.some((e: any) => e?.extensions?.code === 'RATELIMITED');
    if (rateLimited && attempt < MAX_RETRIES) {
      await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
      continue;
    }
    if (!res.ok || data?.errors) {
      throw new Error(`Linear API error: ${JSON.stringify(data?.errors || res.status)}`);
    }
    return data.data;
  }
  throw new Error('Linear API: rate-limit retries exhausted');
}

interface TeamMeta {
  teamId: string;
  backlogStateId: string;
  stateIds: Record<string, string>; // name (lowercased) -> id
  labelIds: Record<string, string>; // name -> id
}
let teamMetaCache: TeamMeta | null = null;

async function getTeamMeta(): Promise<TeamMeta> {
  if (teamMetaCache) return teamMetaCache;
  // Both connections MUST be explicitly sized: Linear defaults to 50 nodes, and the ENG team
  // already has >50 labels — the un-sized query silently truncated "Bug" out of the page
  // (caught by the 2026-07-07 live smoke). 250 is Linear's max page size.
  const data = await linearGraphQL(
    `query($key: String!) {
      teams(filter: { key: { eq: $key } }, first: 1) {
        nodes {
          id
          states(first: 250) { nodes { id name type } pageInfo { hasNextPage } }
          labels(first: 250) { nodes { id name } pageInfo { hasNextPage } }
        }
      }
    }`,
    { key: TEAM_KEY },
  );
  const team = data?.teams?.nodes?.[0];
  if (!team) throw new Error(`Linear team "${TEAM_KEY}" not found`);
  if (team.states?.pageInfo?.hasNextPage || team.labels?.pageInfo?.hasNextPage) {
    console.error(
      `[linear] team "${TEAM_KEY}" metadata exceeds 250 states/labels — resolution map is truncated and names may be dropped; add pagination to getTeamMeta`,
    );
  }
  const states: any[] = team.states?.nodes || [];
  const backlog = states.find(s => s.type === 'backlog') || states.find(s => s.type === 'unstarted');
  const stateIds: Record<string, string> = {};
  for (const s of states) stateIds[s.name.toLowerCase()] = s.id;
  const labelIds: Record<string, string> = {};
  for (const l of (team.labels?.nodes || [])) labelIds[l.name.toLowerCase()] = l.id;
  teamMetaCache = {
    teamId: team.id,
    backlogStateId: backlog?.id,
    stateIds,
    labelIds,
  };
  return teamMetaCache;
}

/**
 * Resolve label names -> ids against the team, LOUDLY (ENG-187): a silently dropped label erases
 * triage signal (funnel-stage labels drive the bug priority ladder), so every name that fails to
 * resolve is an error log naming the label — never a silent drop.
 */
function resolveLabelIdsLoud(meta: TeamMeta, labelNames: string[]): string[] {
  const ids: string[] = [];
  for (const name of labelNames) {
    const id = meta.labelIds[name.toLowerCase()];
    if (id) {
      ids.push(id);
    } else {
      console.error(`[linear] label "${name}" does not exist in team ${TEAM_KEY} — dropped from the issue. Create it in Linear to restore the triage signal.`);
    }
  }
  return ids;
}

/** Test seam — reset the cached team metadata. */
export function _resetLinearTeamCache(): void {
  teamMetaCache = null;
}

export interface LinearIssueResult {
  identifier: string; // e.g. ENG-42
  url: string;
  id?: string;        // internal uuid (returned by createInternalLinearIssue, for commenting)
}

export interface OpenCanonical {
  identifier: string; // e.g. ENG-42
  issueId: string;    // internal uuid (for comments/mutations)
  title: string;
  description: string;
}

/**
 * List OPEN private bug canonicals — the single Linear issue we create per customer-reported bug
 * (labels Bug + Customer Reported, NO Featurebase label, so it's never a public post and isn't a
 * per-reporter ticket copy). These are the dedup-match candidates: additional reporters of the
 * same bug group onto one canonical.
 */
export async function listOpenBugCanonicals(limit = 30): Promise<OpenCanonical[]> {
  const data = await linearGraphQL(
    // Open-state WHITELIST (ENG-358): duplicate-state canonicals must never absorb new reports —
    // see OPEN_STATE_TYPES below for the live-verified root cause.
    `query($team: String!, $bug: String!, $cust: String!, $limit: Int!) {
      issues(
        first: $limit,
        orderBy: createdAt,
        filter: {
          team: { key: { eq: $team } },
          state: { type: { in: ["triage", "backlog", "unstarted", "started"] } },
          and: [
            { labels: { name: { eq: $bug } } },
            { labels: { name: { eq: $cust } } }
          ]
        }
      ) {
        nodes { id identifier title description }
      }
    }`,
    { team: TEAM_KEY, bug: 'Bug', cust: 'Customer Reported', limit },
  );
  const nodes: any[] = data?.issues?.nodes || [];
  return nodes.map((n) => ({ identifier: n.identifier, issueId: n.id, title: n.title || '', description: n.description || '' }));
}

/** An issue comment with its creation timestamp (ISO string), for order-sensitive consumers. */
export interface IssueCommentDetail {
  body: string;
  createdAt: string;
}

/**
 * Read an issue's comments WITH `createdAt`, so callers that need "the most recent comment" can
 * decide by timestamp instead of relying on the API's list order. The resolve bridge reads this
 * ONCE per resolve for both of its jobs: parsing the `[reporter-ticket #N <email>]` markers and
 * picking the latest `@Emma` comment as the customer-facing resolution message (ENG-316).
 *
 * Explicitly sized + ordered: Linear defaults connections to 50 nodes — the same silent-truncation
 * trap getTeamMeta documents — and a high-reporter canonical can carry more comments than that.
 * 250 is Linear's max page size; `orderBy: createdAt` returns NEWEST-first (verified live
 * 2026-07-15 against ENG-316), so an overflow drops the OLDEST comments and the @Emma resolution
 * message — written right before the flip to Done — always survives. Overflow is loud because
 * reporter-ticket markers deep in the dropped tail would otherwise silently miss their email.
 */
export async function getIssueCommentsDetailed(issueId: string): Promise<IssueCommentDetail[]> {
  const data = await linearGraphQL(
    `query($id: String!) { issue(id: $id) { comments(first: 250, orderBy: createdAt) { nodes { body createdAt } pageInfo { hasNextPage } } } }`,
    { id: issueId },
  );
  if (data?.issue?.comments?.pageInfo?.hasNextPage) {
    console.error(
      `[linear] issue ${issueId} has >250 comments — the page is truncated and the OLDEST comments were dropped; reporter-ticket markers may be missing. Add pagination to getIssueCommentsDetailed.`,
    );
  }
  return (data?.issue?.comments?.nodes || []).map((c: any) => ({ body: c?.body || '', createdAt: c?.createdAt || '' }));
}

/** Add a comment to a Linear issue (used to record additional reporters on a canonical). */
export async function addIssueComment(issueId: string, body: string): Promise<void> {
  const data = await linearGraphQL(
    `mutation($input: CommentCreateInput!) {
      commentCreate(input: $input) { success }
    }`,
    { input: { issueId, body } },
  );
  if (!data?.commentCreate?.success) {
    throw new Error('Linear commentCreate failed');
  }
}

/**
 * Create an INTERNAL Linear issue (auto-identified by the system). Crucially does NOT
 * carry the "Featurebase" label, so Featurebase never imports it as a public post —
 * these stay private engineering items. labelNames (e.g. ["Auto","Oncall"]) are
 * resolved against the team's labels; unknown names are dropped LOUDLY (error log per name).
 *
 * Optional triage fields (ENG-187): `priority` (Linear enum 1=Urgent 2=High 3=Medium 4=Low),
 * `stateName` (workflow state by name, e.g. "Todo"; falls back to the backlog state when omitted
 * or unknown), `assigneeId` (Linear user uuid).
 *
 * Returns `null` — filing nothing — outside production (ENG-1099). This rail files real rows on the
 * production board, so a test-env/local/preview backend filing through it manufactures issues
 * indistinguishable from genuine production incidents, and inflates the ENG-240 dedupe clusters that
 * assume a filed cluster reflects production reality. `sendOncallAlert` sits on the same failure
 * paths and has always been guarded this way; this uses that same NODE_ENV mechanism deliberately
 * rather than introducing a second environment convention. Callers must handle `null`.
 */
export async function createInternalLinearIssue(params: {
  title: string;
  description: string;
  labelNames: string[];
  priority?: number;
  stateName?: string;
  assigneeId?: string;
}): Promise<LinearIssueResult | null> {
  if (process.env.NODE_ENV !== 'production') {
    // Loud, not silent: a developer debugging locally still sees the intake decision it would have made.
    console.log(
      `[DEV] Suppressed Linear issue creation: ${params.title} [${params.labelNames.join(', ')}]\n${params.description}`,
    );
    return null;
  }
  const meta = await getTeamMeta();
  const labelIds = resolveLabelIdsLoud(meta, params.labelNames);
  const input: Record<string, any> = {
    teamId: meta.teamId,
    title: params.title,
    description: params.description,
    labelIds,
  };
  let stateId = meta.backlogStateId;
  if (params.stateName) {
    const named = meta.stateIds[params.stateName.toLowerCase()];
    if (named) {
      stateId = named;
    } else {
      console.error(`[linear] state "${params.stateName}" not found in team ${TEAM_KEY} — falling back to the backlog state.`);
    }
  }
  if (stateId) input.stateId = stateId;
  if (typeof params.priority === 'number') input.priority = params.priority;
  if (params.assigneeId) input.assigneeId = params.assigneeId;
  const data = await linearGraphQL(
    `mutation($input: IssueCreateInput!) {
      issueCreate(input: $input) { success issue { id identifier url } }
    }`,
    { input },
  );
  const issue = data?.issueCreate?.issue;
  if (!data?.issueCreate?.success || !issue) {
    throw new Error('Linear issueCreate (internal) did not return an issue');
  }
  return { id: issue.id, identifier: issue.identifier, url: issue.url };
}

/**
 * Raise-only triage update on an existing issue (ENG-187 dedup upgrade): UNION the given labels in,
 * and RAISE the priority to `priority` when it is more urgent than the current one. Route callers
 * may also atomically remove mutually exclusive labels and set the canonical owner; ordinary
 * callers retain the original union-only behavior. Linear priority enum: 0=None, 1=Urgent … 4=Low,
 * so "more urgent" = smaller non-zero number (and anything beats 0/None).
 *
 * `settleStateName` (ENG-187 contract #4): ensure a freshly synced issue SITS in the named state
 * (e.g. Backlog for FB-synced feature requests). Applied only while the issue is still in a
 * pre-work state (`triage`/`unstarted`) — an issue already in a backlog state needs no move, and
 * one a human advanced to started/completed/canceled is never yanked back, so webhook retries
 * can't fight people. An unknown state name is a LOUD error (no silent drop), state left untouched.
 *
 * No-op (no mutation) when nothing — labels, priority, state — would change.
 */
export async function raiseIssueTriage(
  issueId: string,
  params: {
    addLabelNames: string[];
    removeLabelNames?: string[];
    priority?: number;
    settleStateName?: string;
    assigneeId?: string;
  },
): Promise<void> {
  const meta = await getTeamMeta();
  const data = await linearGraphQL(
    `query($id: String!) { issue(id: $id) { priority assignee { id } state { id type } labels { nodes { id } } } }`,
    { id: issueId },
  );
  const issue = data?.issue;
  if (!issue) throw new Error('Linear issue not found for triage raise');

  const currentLabelIds: string[] = (issue.labels?.nodes || []).map((n: any) => n.id);
  const removeIds = new Set(resolveLabelIdsLoud(meta, params.removeLabelNames ?? []));
  const retainedLabelIds = currentLabelIds.filter((id) => !removeIds.has(id));
  const addIds = resolveLabelIdsLoud(meta, params.addLabelNames).filter((id) => !retainedLabelIds.includes(id));
  const nextLabelIds = [...retainedLabelIds, ...addIds];

  const input: Record<string, any> = {};
  if (
    nextLabelIds.length !== currentLabelIds.length ||
    nextLabelIds.some((id) => !currentLabelIds.includes(id))
  ) {
    input.labelIds = nextLabelIds;
  }
  if (params.assigneeId && issue.assignee?.id !== params.assigneeId) {
    input.assigneeId = params.assigneeId;
  }
  const current: number = typeof issue.priority === 'number' ? issue.priority : 0;
  if (typeof params.priority === 'number' && params.priority > 0 && (current === 0 || params.priority < current)) {
    input.priority = params.priority;
  }
  if (params.settleStateName) {
    const targetId = meta.stateIds[params.settleStateName.toLowerCase()];
    if (!targetId) {
      console.error(`[linear] state "${params.settleStateName}" not found in team ${TEAM_KEY} — leaving the issue's state untouched.`);
    } else {
      const currentType = issue.state?.type;
      if ((currentType === 'triage' || currentType === 'unstarted') && issue.state?.id !== targetId) {
        input.stateId = targetId;
      }
    }
  }
  if (Object.keys(input).length === 0) return;

  const res = await linearGraphQL(
    `mutation($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) { success }
    }`,
    { id: issueId, input },
  );
  if (!res?.issueUpdate?.success) {
    throw new Error('Linear issueUpdate (triage raise) failed');
  }
}

export interface OpenIssue {
  identifier: string;
  issueId: string;
  title: string;
  /** Issue body — carries the structured Session/Schedule IDs the auto-issue dedup gate matches on. */
  description: string;
  /** ISO creation time. ENG-3088: the baseline for "is any failure newer than the filing". */
  createdAt?: string;
}

/**
 * State types a dedupe candidate may be in — a WHITELIST of Linear's open types. Deliberately not
 * a completed/canceled blacklist: Linear's "Duplicate" state has its own state type ("duplicate",
 * verified live on ENG-350, 2026-07-16), and under the old blacklist a canceled Duplicate stayed a
 * dedupe candidate — recurrence comments landed on it instead of the open canonical (ENG-358).
 * A whitelist also stays correct if Linear ever adds another closed-ish type.
 */
const OPEN_STATE_TYPES = ['triage', 'backlog', 'unstarted', 'started'] as const;
const OPEN_STATE_TYPES_GQL = `[${OPEN_STATE_TYPES.map((t) => `"${t}"`).join(', ')}]`;

/** ENG-2766: page size and runaway cap for the open-issue dedupe candidate scan. */
export const OPEN_ISSUES_PAGE_SIZE = 100;
export const OPEN_ISSUES_SCAN_CAP = 1000;

/**
 * List OPEN issues carrying a given label (used for auto-issue dedup). Open-only — see
 * OPEN_STATE_TYPES.
 *
 * ARCHIVED CANDIDACY (ENG-730): Linear's default `issues()` query already excludes archived
 * issues (they only surface with the explicit `includeArchived: true` argument, which this query
 * deliberately omits) — an archived canonical can therefore never come back as a match here,
 * belt-and-braces confirmed by the `state.type` whitelist too (an archived issue's underlying
 * workflow state can be anything, so the whitelist alone would not be a safe guard on its own).
 * This is a candidacy EXCLUSION, not a post-selection filter (ENG-730 AC2): archived rows never
 * enter the candidate list in the first place.
 */
export async function listOpenIssuesByLabel(labelName: string, limit = OPEN_ISSUES_SCAN_CAP): Promise<OpenIssue[]> {
  // ENG-2766: this list is the dedupe CANDIDATE SET. A single `first: 50` page returned only the
  // newest 50 open Auto issues, so once the board held more than 50, an older open canonical
  // (e.g. ENG-2374, filed Oct 9) silently dropped out and every recurrence filed a parallel issue.
  // Page through every open match (bounded by `limit` as a runaway guard).
  const out: OpenIssue[] = [];
  let after: string | null = null;
  while (out.length < limit) {
    const pageSize = Math.min(OPEN_ISSUES_PAGE_SIZE, limit - out.length);
    const data: any = await linearGraphQL(
      `query($team: String!, $label: String!, $limit: Int!, $after: String) {
        issues(
          first: $limit,
          after: $after,
          orderBy: createdAt,
          filter: {
            team: { key: { eq: $team } },
            state: { type: { in: ${OPEN_STATE_TYPES_GQL} } },
            labels: { name: { eq: $label } }
          }
        ) { nodes { id identifier title description createdAt } pageInfo { hasNextPage endCursor } }
      }`,
      { team: TEAM_KEY, label: labelName, limit: pageSize, after },
    );
    const nodes = data?.issues?.nodes || [];
    for (const n of nodes) {
      out.push({ identifier: n.identifier, issueId: n.id, title: n.title || '', description: n.description || '', createdAt: n.createdAt || undefined });
    }
    const pageInfo = data?.issues?.pageInfo;
    if (!pageInfo?.hasNextPage || !pageInfo?.endCursor || nodes.length === 0) break;
    after = pageInfo.endCursor;
  }
  return out.slice(0, limit);
}

/**
 * Find the most-recently-archived issue carrying `labelName` whose title or body matches
 * `isMatch` (ENG-730 AC3). Used ONLY to record lineage — "the archived predecessor this new
 * canonical replaces" — on a freshly created canonical, never as a dedupe target: archived issues
 * are permanently excluded from candidacy (see `listOpenIssuesByLabel`).
 *
 * `includeArchived: true` is the ONLY way to see archived rows through Linear's API — the default
 * `issues()` query silently omits them. Best-effort by contract: a lookup failure (network,
 * schema surprise) must never block filing the new canonical, so callers should catch and log,
 * never let this throw into the intake path.
 */
export async function findMostRecentArchivedIssueByLabel(
  labelName: string,
  isMatch: (issue: OpenIssue) => boolean,
  limit = 50,
): Promise<OpenIssue | null> {
  const data = await linearGraphQL(
    `query($team: String!, $label: String!, $limit: Int!) {
      issues(
        first: $limit,
        includeArchived: true,
        orderBy: updatedAt,
        filter: {
          team: { key: { eq: $team } },
          labels: { name: { eq: $label } }
        }
      ) { nodes { id identifier title description archivedAt } }
    }`,
    { team: TEAM_KEY, label: labelName, limit },
  );
  const nodes: any[] = data?.issues?.nodes || [];
  // Defense in depth: even though `includeArchived: true` widens the query to include archived
  // rows, still-open issues remain in the page too — filter to ONLY archived ones so this can
  // never accidentally be reused as a dedupe-candidate source.
  const archived = nodes.filter((n) => !!n.archivedAt);
  const candidate = archived
    .map((n) => ({ identifier: n.identifier, issueId: n.id, title: n.title || '', description: n.description || '' }))
    .find(isMatch);
  return candidate || null;
}

/**
 * ENG-589: most-recently-updated COMPLETED, non-archived issue carrying
 * `labelName` that matches `isMatch`. Lets a recurring failure cluster reopen its canonical
 * instead of filing a fresh issue after the first one was closed. Canceled issues are excluded:
 * a cancel is a human decision the loop must not override. Read-only; callers must treat
 * a lookup failure as "no closed canonical" and fall through to normal intake.
 */
export async function findMostRecentClosedIssueByLabel(
  labelName: string,
  isMatch: (issue: OpenIssue) => boolean,
  limit = OPEN_ISSUES_SCAN_CAP,
): Promise<OpenIssue | null> {
  // Page newest-updated first and stop at the first match: a single `first: 50` page dropped the
  // class's closed canonical once >50 completed Auto issues were updated after it, filing a
  // duplicate instead of reopening (same defect class as ENG-2766). `limit` is a runaway guard.
  let scanned = 0;
  let after: string | null = null;
  while (scanned < limit) {
    const pageSize = Math.min(OPEN_ISSUES_PAGE_SIZE, limit - scanned);
    const data: any = await linearGraphQL(
      `query($team: String!, $label: String!, $limit: Int!, $after: String) {
        issues(
          first: $limit,
          after: $after,
          orderBy: updatedAt,
          filter: {
            team: { key: { eq: $team } },
            state: { type: { eq: "completed" } },
            labels: { name: { eq: $label } }
          }
        ) { nodes { id identifier title description createdAt archivedAt } pageInfo { hasNextPage endCursor } }
      }`,
      { team: TEAM_KEY, label: labelName, limit: pageSize, after },
    );
    const nodes: any[] = data?.issues?.nodes || [];
    scanned += nodes.length;
    const candidate = nodes
      .filter((n) => !n.archivedAt)
      .map((n) => ({ identifier: n.identifier, issueId: n.id, title: n.title || '', description: n.description || '', createdAt: n.createdAt || undefined }))
      .find(isMatch);
    if (candidate) return candidate;
    const pageInfo = data?.issues?.pageInfo;
    if (!pageInfo?.hasNextPage || !pageInfo?.endCursor || nodes.length === 0) break;
    after = pageInfo.endCursor;
  }
  return null;
}

/**
 * Thrown when a mutation attempts to move an issue into Linear's `Duplicate` state (or otherwise
 * create a duplicate relation) against a target that is archived. Linear hard-rejects this
 * server-side ("Issues can only be moved to a duplicate state when a duplicate issue relation
 * exists") because an archived issue cannot hold a duplicate relation — ENG-730's root cause.
 * A distinct, named error class so callers can classify this failure instead of it surfacing as
 * an opaque `Linear API error` string, and so it can never be silently swallowed (ENG-730 AC5).
 */
export class ArchivedDuplicateTargetError extends Error {
  constructor(public readonly targetIssueId: string, cause: string) {
    super(`Cannot mark duplicate against archived Linear issue ${targetIssueId}: ${cause}`);
    this.name = 'ArchivedDuplicateTargetError';
  }
}

const ARCHIVED_DUPLICATE_TARGET_RE = /can only be moved to a duplicate state when a duplicate issue relation exists/i;

/**
 * Create a "duplicate" relation from `issueId` onto `canonicalIssueId` (moves `issueId` toward
 * Linear's Duplicate semantics). ENG-730 AC5: an archived `canonicalIssueId` is Linear's own
 * hard-rejection case — that specific rejection is reclassified into `ArchivedDuplicateTargetError`
 * (loud, named, catchable) instead of leaking as an undifferentiated `Linear API error` string that
 * a caller could plausibly catch-and-ignore. Any other failure propagates unchanged.
 */
export async function markIssueDuplicateOf(issueId: string, canonicalIssueId: string): Promise<void> {
  try {
    const data = await linearGraphQL(
      `mutation($input: IssueRelationCreateInput!) {
        issueRelationCreate(input: $input) { success }
      }`,
      { input: { issueId, relatedIssueId: canonicalIssueId, type: 'duplicate' } },
    );
    if (!data?.issueRelationCreate?.success) {
      throw new Error('Linear issueRelationCreate (duplicate) did not report success');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (ARCHIVED_DUPLICATE_TARGET_RE.test(message)) {
      throw new ArchivedDuplicateTargetError(canonicalIssueId, message);
    }
    throw error;
  }
}

/**
 * Raise-only escalation of an open canonical (ENG-358): when a recurring alert's severity rises
 * (e.g. v0 credits low -> critical), the ONE open canonical is updated in place — priority raised
 * and title refreshed to the latest occurrence's wording — instead of a new issue being filed.
 * Returns false (no mutation at all) when the incoming priority does not beat the current one, so
 * routine same-level occurrences never churn the issue. Throws on Linear failure; callers
 * best-effort it (the occurrence comment + dedupe result must stand regardless).
 */
export async function escalateIssue(issueId: string, params: { title: string; priority: number }): Promise<boolean> {
  const data = await linearGraphQL(
    `query($id: String!) { issue(id: $id) { priority } }`,
    { id: issueId },
  );
  const issue = data?.issue;
  if (!issue) throw new Error('Linear issue not found for escalation');
  const current: number = typeof issue.priority === 'number' ? issue.priority : 0;
  // Linear priority: 1=Urgent … 4=Low, 0=None. Raise-only: only a strictly more severe incoming
  // priority (numerically lower, or anything over "None") updates the canonical.
  if (!(params.priority > 0 && (current === 0 || params.priority < current))) return false;
  const res = await linearGraphQL(
    `mutation($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) { success }
    }`,
    { id: issueId, input: { title: params.title, priority: params.priority } },
  );
  if (!res?.issueUpdate?.success) {
    throw new Error('Linear issueUpdate (escalation) failed');
  }
  return true;
}

/**
 * List recently RESOLVED (completed/canceled) private bug canonicals — the reopen candidates for a
 * regression / failed-retest report (ENG-240 contract #3). A new customer report that matches one of
 * these must REOPEN the existing ticket, not file a brand-new canonical for a bug we already tracked.
 * Same label pair as `listOpenBugCanonicals` (Bug + Customer Reported), ordered most-recently-updated
 * first so freshly-closed tickets are the top candidates.
 */
export async function listRecentlyResolvedBugCanonicals(limit = 30): Promise<OpenCanonical[]> {
  const data = await linearGraphQL(
    `query($team: String!, $bug: String!, $cust: String!, $limit: Int!) {
      issues(
        first: $limit,
        orderBy: updatedAt,
        filter: {
          team: { key: { eq: $team } },
          state: { type: { in: ["completed", "canceled"] } },
          and: [
            { labels: { name: { eq: $bug } } },
            { labels: { name: { eq: $cust } } }
          ]
        }
      ) {
        nodes { id identifier title description }
      }
    }`,
    { team: TEAM_KEY, bug: 'Bug', cust: 'Customer Reported', limit },
  );
  const nodes: any[] = data?.issues?.nodes || [];
  return nodes.map((n) => ({ identifier: n.identifier, issueId: n.id, title: n.title || '', description: n.description || '' }));
}

/**
 * Reopen a resolved Linear issue by moving it to a live workflow state (default "Todo"). Used by the
 * reopen-not-refile path (ENG-240 contract #3) when a regression / failed-retest report matches a Done
 * canonical. An unknown state name throws (no silent no-op) so a reopen never quietly leaves the issue
 * closed.
 */
export async function reopenIssue(issueId: string, stateName = 'Todo'): Promise<void> {
  const meta = await getTeamMeta();
  const stateId = meta.stateIds[stateName.toLowerCase()];
  if (!stateId) {
    throw new Error(`Linear reopen: state "${stateName}" not found in team ${TEAM_KEY}`);
  }
  const res = await linearGraphQL(
    `mutation($id: String!, $stateId: String!) {
      issueUpdate(id: $id, input: { stateId: $stateId }) { success }
    }`,
    { id: issueId, stateId },
  );
  if (!res?.issueUpdate?.success) {
    throw new Error('Linear reopen (issueUpdate) failed');
  }
}

export type LoopAttributionWriteResult =
  | { status: 'applied' }
  | { status: 'already_applied' }
  | { status: 'missing_issue' };

function attributionMarker(outcome: AttributionIssueOutcome): string {
  return `<!-- loop-attribution:${outcome.loopId}:${outcome.mutationId}:${outcome.verdict} -->`;
}

function metricValue(value: number | null): string {
  return value == null ? 'n/a' : value.toFixed(4);
}

interface LinkedPullRequest {
  url: string;
  title: string;
}

const GITHUB_PR_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/;

function escapeMarkdownLinkText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\[/g, '\\[').replace(/\]/g, '\\]');
}

/** GitHub PRs the Linear GitHub integration attached to the issue (ENG-590). */
function linkedPullRequests(
  attachments: Array<{ url?: string | null; title?: string | null } | null> | undefined,
): LinkedPullRequest[] {
  const seen = new Set<string>();
  const prs: LinkedPullRequest[] = [];
  for (const attachment of attachments ?? []) {
    const url = attachment?.url?.trim();
    if (!url || !GITHUB_PR_URL.test(url) || seen.has(url)) continue;
    seen.add(url);
    prs.push({ url, title: attachment?.title?.trim() || url });
  }
  return prs;
}

function howToVerify(
  outcome: AttributionIssueOutcome,
  prs: LinkedPullRequest[],
  lift: string,
): string[] {
  const delta = `${outcome.metricName}: ${metricValue(outcome.metricBefore)} → ${metricValue(outcome.metricAfter)} (${lift}; n=${outcome.sampleN})`;
  const prLines = prs.length
    ? prs.map((pr) => `- Linked PR [${escapeMarkdownLinkText(pr.title)}](${pr.url}); if it shipped this change, follow its "How to test" steps.`)
    : ['- No linked GitHub PR on this issue; verify against the metric below.'];
  return [
    '### How to verify',
    '',
    ...prLines,
    `- Confirm the metric moved as attributed: ${delta}.`,
    '',
  ];
}

function attributionEvidence(
  outcome: AttributionIssueOutcome,
  marker: string,
  prs: LinkedPullRequest[] = [],
): string {
  const lift = outcome.observedLiftPct == null
    ? 'n/a'
    : `${outcome.observedLiftPct >= 0 ? '+' : ''}${outcome.observedLiftPct.toFixed(1)}%`;
  const state = outcome.transition === 'verifying'
    ? 'Moved to **Verifying** and assigned to the verifier.'
    : outcome.transition === 'reopen'
      ? 'Regression detected; reopened to **Todo** and assigned to the verifier.'
      : 'Evidence recorded; workflow state left unchanged.';
  return [
    `## Loop attribution: ${outcome.verdict}`,
    '',
    `- Loop: \`${outcome.loopId}\``,
    `- Rule: \`${outcome.ruleId}\``,
    `- Run: \`${outcome.runId}\``,
    `- Mutation: \`${outcome.mutationId}\``,
    `- ${outcome.metricName}: ${metricValue(outcome.metricBefore)} → ${metricValue(outcome.metricAfter)} (${lift}; n=${outcome.sampleN})`,
    `- Result: ${state}`,
    '',
    ...howToVerify(outcome, prs, lift),
    marker,
  ].join('\n');
}

/**
 * Close the loop's Linear lifecycle after metric attribution.
 *
 * Ordering is deliberate: state/assignee update first, evidence marker last.
 * If the comment fails, the next cron safely repeats the idempotent state
 * update and retries the comment. Once the marker exists, all later retries
 * are no-ops. The only writable states are Verifying and Todo; this path can
 * never set Done.
 */
export async function recordLoopAttributionOutcome(
  outcome: AttributionIssueOutcome,
): Promise<LoopAttributionWriteResult> {
  const marker = attributionMarker(outcome);
  const data = await linearGraphQL(
    `query($id: String!) {
      issue(id: $id) {
        id
        attachments(first: 50) { nodes { url title } }
        comments(first: 250, orderBy: createdAt) {
          nodes { body }
          pageInfo { hasNextPage }
        }
      }
    }`,
    { id: outcome.issueId },
  );
  const issue = data?.issue;
  if (!issue) return { status: 'missing_issue' };

  if (issue.comments?.pageInfo?.hasNextPage) {
    console.error(
      `[linear] issue ${outcome.issueId} has >250 comments — loop-attribution idempotency scan is truncated`,
    );
  }
  const alreadyApplied = (issue.comments?.nodes ?? []).some(
    (comment: { body?: string } | null) => comment?.body?.includes(marker),
  );
  if (alreadyApplied) return { status: 'already_applied' };

  if (outcome.transition !== 'evidence_only') {
    const meta = await getTeamMeta();
    const stateName = outcome.transition === 'verifying' ? 'Verifying' : 'Todo';
    const stateId = meta.stateIds[stateName.toLowerCase()];
    if (!stateId) {
      throw new Error(`Linear loop attribution: state "${stateName}" not found in team ${TEAM_KEY}`);
    }
    const updated = await linearGraphQL(
      `mutation($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) { success }
      }`,
      {
        id: issue.id,
        input: {
          stateId,
          assigneeId: outcome.verifierId,
        },
      },
    );
    if (!updated?.issueUpdate?.success) {
      throw new Error('Linear loop attribution issueUpdate failed');
    }
  }

  const commented = await linearGraphQL(
    `mutation($input: CommentCreateInput!) {
      commentCreate(input: $input) { success }
    }`,
    {
      input: {
        issueId: issue.id,
        body: attributionEvidence(outcome, marker, linkedPullRequests(issue.attachments?.nodes)),
      },
    },
  );
  if (!commented?.commentCreate?.success) {
    throw new Error('Linear loop attribution commentCreate failed');
  }
  return { status: 'applied' };
}

export interface LinearIssueSummary {
  identifier: string;
  issueId: string;
  title: string;
  priority: number;
  state: string;
  stateType: string;
  labels: string[];
  assigneeName: string | null;
  assigneeEmail: string | null;
  updatedAt: string;
}

export interface LinearRelatedIssue {
  identifier: string;
  title: string;
  stateType: string;
}

export interface LinearIssueDetail extends LinearIssueSummary {
  description: string;
  team: string;
  comments: IssueCommentDetail[];
  subIssues: { identifier: string; title: string; state: string; stateType: string }[];
  blocks: LinearRelatedIssue[];
  blockedBy: LinearRelatedIssue[];
  related: LinearRelatedIssue[];
  /**
   * Non-empty when one of the connections above hit its page cap and was cut off — the caller
   * (an admin making a decision from this data) needs to know the view may be incomplete, not
   * just find it in a server log (CodeRabbit ENG-789 review).
   */
  truncationWarnings: string[];
}

/**
 * Search/list issues with filters — the general-purpose admin read behind board-triage tooling
 * (ENG-789). team defaults to ENG; priorities follow Linear's enum (1=Urgent..4=Low).
 */
export async function searchIssues(params: {
  teamKey?: string;
  stateTypes?: string[];
  priorities?: number[];
  labelName?: string;
  assigneeEmail?: string;
  limit?: number;
}): Promise<LinearIssueSummary[]> {
  const filter: Record<string, any> = { team: { key: { eq: params.teamKey || TEAM_KEY } } };
  if (params.stateTypes?.length) filter.state = { type: { in: params.stateTypes } };
  if (params.priorities?.length) filter.priority = { in: params.priorities };
  if (params.labelName) filter.labels = { name: { eq: params.labelName } };
  if (params.assigneeEmail) filter.assignee = { email: { eq: params.assigneeEmail } };
  const data = await linearGraphQL(
    `query($filter: IssueFilter!, $limit: Int!) {
      issues(first: $limit, orderBy: updatedAt, filter: $filter) {
        nodes {
          id identifier title priority updatedAt
          state { name type }
          labels(first: 50) { nodes { name } }
          assignee { name email }
        }
      }
    }`,
    { filter, limit: params.limit ?? 50 },
  );
  return (data?.issues?.nodes || []).map((n: any) => ({
    identifier: n.identifier,
    issueId: n.id,
    title: n.title || '',
    priority: typeof n.priority === 'number' ? n.priority : 0,
    state: n.state?.name || '',
    stateType: n.state?.type || '',
    labels: (n.labels?.nodes || []).map((l: any) => l.name),
    assigneeName: n.assignee?.name ?? null,
    assigneeEmail: n.assignee?.email ?? null,
    updatedAt: n.updatedAt || '',
  }));
}

/** Resolve an issue ref ("ENG-42" or a raw Linear uuid) to its internal id. */
async function resolveIssueId(ref: string): Promise<string> {
  const m = /^([A-Za-z]+)-(\d+)$/.exec(ref.trim());
  if (!m) return ref.trim();
  const data = await linearGraphQL(
    `query($tk: String!, $n: Float!) { issues(filter: { team: { key: { eq: $tk } }, number: { eq: $n } }, first: 1) { nodes { id } } }`,
    { tk: m[1].toUpperCase(), n: Number(m[2]) },
  );
  const id = data?.issues?.nodes?.[0]?.id;
  if (!id) throw new Error(`Linear issue "${ref}" not found`);
  return id;
}

/**
 * Full read of a single issue for board triage (ENG-789): detail, comments, and sub-issue /
 * blocking relationships in one call. `relations`/`inverseRelations` are outgoing/incoming
 * relation edges (Linear's directional model) — a "blocks" edge FROM this issue means this issue
 * blocks the related one; a "blocks" edge INTO this issue (inverseRelations) means this issue is
 * blocked by the related one.
 */
export async function getIssueFullDetail(ref: string): Promise<LinearIssueDetail> {
  const issueId = await resolveIssueId(ref);
  const data = await linearGraphQL(
    `query($id: String!) {
      issue(id: $id) {
        id identifier title description priority updatedAt
        state { name type }
        team { key }
        labels(first: 50) { nodes { name } }
        assignee { name email }
        comments(first: 250, orderBy: createdAt) { nodes { body createdAt } pageInfo { hasNextPage } }
        children(first: 50) { nodes { identifier title state { name type } } pageInfo { hasNextPage } }
        relations(first: 50) { nodes { type relatedIssue { identifier title state { type } } } pageInfo { hasNextPage } }
        inverseRelations(first: 50) { nodes { type relatedIssue { identifier title state { type } } } pageInfo { hasNextPage } }
      }
    }`,
    { id: issueId },
  );
  const issue = data?.issue;
  if (!issue) throw new Error(`Linear issue "${ref}" not found`);
  const truncationWarnings: string[] = [];
  if (issue.comments?.pageInfo?.hasNextPage) {
    const msg = `issue has >250 comments — comment list is truncated, oldest comments are missing`;
    console.error(`[linear] ${ref}: ${msg}`);
    truncationWarnings.push(msg);
  }
  if (issue.children?.pageInfo?.hasNextPage) {
    const msg = `issue has >50 sub-issues — sub-issue list is truncated, some sub-issues are missing`;
    console.error(`[linear] ${ref}: ${msg}`);
    truncationWarnings.push(msg);
  }
  if (issue.relations?.pageInfo?.hasNextPage || issue.inverseRelations?.pageInfo?.hasNextPage) {
    const msg = `issue has >50 relations on one side — blocking/related issue list is truncated, some are missing`;
    console.error(`[linear] ${ref}: ${msg}`);
    truncationWarnings.push(msg);
  }
  const toRelated = (nodes: any[]): LinearRelatedIssue[] => nodes
    .filter((r) => r.relatedIssue)
    .map((r) => ({
      identifier: r.relatedIssue.identifier,
      title: r.relatedIssue.title || '',
      stateType: r.relatedIssue.state?.type || '',
    }));
  const outgoing: any[] = issue.relations?.nodes || [];
  const incoming: any[] = issue.inverseRelations?.nodes || [];
  return {
    identifier: issue.identifier,
    issueId: issue.id,
    title: issue.title || '',
    description: issue.description || '',
    priority: typeof issue.priority === 'number' ? issue.priority : 0,
    state: issue.state?.name || '',
    stateType: issue.state?.type || '',
    team: issue.team?.key || '',
    labels: (issue.labels?.nodes || []).map((l: any) => l.name),
    assigneeName: issue.assignee?.name ?? null,
    assigneeEmail: issue.assignee?.email ?? null,
    updatedAt: issue.updatedAt || '',
    comments: (issue.comments?.nodes || []).map((c: any) => ({ body: c.body || '', createdAt: c.createdAt || '' })),
    subIssues: (issue.children?.nodes || []).map((c: any) => ({
      identifier: c.identifier,
      title: c.title || '',
      state: c.state?.name || '',
      stateType: c.state?.type || '',
    })),
    blocks: toRelated(outgoing.filter((r) => r.type === 'blocks')),
    blockedBy: toRelated(incoming.filter((r) => r.type === 'blocks')),
    related: toRelated([...outgoing, ...incoming].filter((r) => r.type === 'related')),
    truncationWarnings,
  };
}

export interface EngineeringBugStats {
  netOpenBugs: number;
  opened7d: number;
  closed7d: number;
}

/**
 * Read-only Engineering bug scoreboard counts. This deliberately does not use
 * Featurebase/customer-report specific labels: the scoreboard wants all open
 * ENG bugs, plus 7d bug inflow/outflow.
 */
export async function getEngineeringBugStats(startDate: string, endDate: string): Promise<EngineeringBugStats> {
  const data = await linearGraphQL(
    `query($team: String!, $bug: String!, $start: DateTime!, $end: DateTime!) {
      open: issues(
        first: 1,
        filter: {
          team: { key: { eq: $team } },
          labels: { name: { eq: $bug } },
          state: { type: { nin: ["completed", "canceled"] } }
        }
      ) {
        totalCount
      }
      opened: issues(
        first: 1,
        filter: {
          team: { key: { eq: $team } },
          labels: { name: { eq: $bug } },
          createdAt: { gte: $start, lt: $end }
        }
      ) {
        totalCount
      }
      closed: issues(
        first: 1,
        filter: {
          team: { key: { eq: $team } },
          labels: { name: { eq: $bug } },
          completedAt: { gte: $start, lt: $end }
        }
      ) {
        totalCount
      }
      canceled: issues(
        first: 1,
        filter: {
          team: { key: { eq: $team } },
          labels: { name: { eq: $bug } },
          canceledAt: { gte: $start, lt: $end }
        }
      ) {
        totalCount
      }
    }`,
    {
      team: TEAM_KEY,
      bug: 'Bug',
      start: `${startDate}T00:00:00.000Z`,
      end: `${endDate}T00:00:00.000Z`,
    },
  );

  return {
    netOpenBugs: Number(data?.open?.totalCount ?? 0),
    opened7d: Number(data?.opened?.totalCount ?? 0),
    closed7d: Number(data?.closed?.totalCount ?? 0) + Number(data?.canceled?.totalCount ?? 0),
  };
}
