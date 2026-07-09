import { getSecret } from '../utils/secretsManager';

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

async function linearGraphQL(query: string, variables?: Record<string, any>): Promise<any> {
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
    `query($team: String!, $bug: String!, $cust: String!, $limit: Int!) {
      issues(
        first: $limit,
        orderBy: createdAt,
        filter: {
          team: { key: { eq: $team } },
          state: { type: { nin: ["completed", "canceled"] } },
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

/** Read an issue's comment bodies (the resolve bridge parses `[reporter-ticket #N]` from these). */
export async function getIssueComments(issueId: string): Promise<string[]> {
  const data = await linearGraphQL(
    `query($id: String!) { issue(id: $id) { comments { nodes { body } } } }`,
    { id: issueId },
  );
  return (data?.issue?.comments?.nodes || []).map((c: any) => c?.body || '');
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
 */
export async function createInternalLinearIssue(params: {
  title: string;
  description: string;
  labelNames: string[];
  priority?: number;
  stateName?: string;
  assigneeId?: string;
}): Promise<LinearIssueResult> {
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
 * and RAISE the priority to `priority` when it is more urgent than the current one. Never lowers
 * priority and never removes labels — a later lower-tier reporter must not downgrade a canonical
 * that a higher-tier reporter already escalated. Linear priority enum: 0=None, 1=Urgent … 4=Low,
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
  params: { addLabelNames: string[]; priority?: number; settleStateName?: string },
): Promise<void> {
  const meta = await getTeamMeta();
  const data = await linearGraphQL(
    `query($id: String!) { issue(id: $id) { priority state { id type } labels { nodes { id } } } }`,
    { id: issueId },
  );
  const issue = data?.issue;
  if (!issue) throw new Error('Linear issue not found for triage raise');

  const currentLabelIds: string[] = (issue.labels?.nodes || []).map((n: any) => n.id);
  const addIds = resolveLabelIdsLoud(meta, params.addLabelNames).filter((id) => !currentLabelIds.includes(id));

  const input: Record<string, any> = {};
  if (addIds.length > 0) input.labelIds = [...currentLabelIds, ...addIds];
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
}

/** List OPEN issues carrying a given label (used for auto-issue dedup). Open-only. */
export async function listOpenIssuesByLabel(labelName: string, limit = 50): Promise<OpenIssue[]> {
  const data = await linearGraphQL(
    `query($team: String!, $label: String!, $limit: Int!) {
      issues(
        first: $limit,
        orderBy: createdAt,
        filter: {
          team: { key: { eq: $team } },
          state: { type: { nin: ["completed", "canceled"] } },
          labels: { name: { eq: $label } }
        }
      ) { nodes { id identifier title } }
    }`,
    { team: TEAM_KEY, label: labelName, limit },
  );
  return (data?.issues?.nodes || []).map((n: any) => ({ identifier: n.identifier, issueId: n.id, title: n.title || '' }));
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
