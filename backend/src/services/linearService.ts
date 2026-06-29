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
const FEATUREBASE_LABEL = 'Featurebase';

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
  labelIds: Record<string, string>; // name -> id
}
let teamMetaCache: TeamMeta | null = null;

async function getTeamMeta(): Promise<TeamMeta> {
  if (teamMetaCache) return teamMetaCache;
  const data = await linearGraphQL(
    `query($key: String!) {
      teams(filter: { key: { eq: $key } }, first: 1) {
        nodes { id states { nodes { id name type } } labels { nodes { id name } } }
      }
    }`,
    { key: TEAM_KEY },
  );
  const team = data?.teams?.nodes?.[0];
  if (!team) throw new Error(`Linear team "${TEAM_KEY}" not found`);
  const states: any[] = team.states?.nodes || [];
  const backlog = states.find(s => s.type === 'backlog') || states.find(s => s.type === 'unstarted');
  const labelIds: Record<string, string> = {};
  for (const l of (team.labels?.nodes || [])) labelIds[l.name.toLowerCase()] = l.id;
  teamMetaCache = {
    teamId: team.id,
    backlogStateId: backlog?.id,
    labelIds,
  };
  return teamMetaCache;
}

/** Test seam — reset the cached team metadata. */
export function _resetLinearTeamCache(): void {
  teamMetaCache = null;
}

export type LinearItemType = 'feature_request' | 'bug';

export interface CreateLinearIssueParams {
  type: LinearItemType;
  title: string;
  description: string;
  userEmail: string;
  /** Admin email when this was filed via a delegated session (admin acting on the user's behalf). */
  reportedByAdmin?: string;
  /** Public Featurebase post URL, if one already exists to cross-link. */
  sourceUrl?: string;
  /** Reporter's chat session id, recorded in the body so eng can jump to the session. */
  sessionId?: string;
}

export interface LinearIssueResult {
  identifier: string; // e.g. ENG-42
  url: string;
}

/**
 * Create a Linear issue for a user-filed request. Tags it with the "Featurebase"
 * label so Featurebase imports + links + status-syncs it as a public post.
 */
export async function createLinearIssue(params: CreateLinearIssueParams): Promise<LinearIssueResult> {
  const { type, title, description, userEmail, reportedByAdmin, sourceUrl, sessionId } = params;
  const meta = await getTeamMeta();

  // Always include the Featurebase label (drives the FB import/sync) + the type label.
  const wantLabels = [FEATUREBASE_LABEL, type === 'bug' ? 'Bug' : 'Feature'];
  if (type === 'feature_request') wantLabels.push('Customer Request');
  else wantLabels.push('Customer Reported');
  const labelIds = wantLabels
    .map(n => meta.labelIds[n.toLowerCase()])
    .filter((id): id is string => Boolean(id));

  const body = [
    description,
    '',
    '---',
    reportedByAdmin
      ? `Filed by ${userEmail} (via ${reportedByAdmin} acting on their behalf — delegated session) through Emma.`
      : `Filed by ${userEmail} via Emma.`,
    ...(sessionId ? [`Session: ${sessionId}`] : []),
    ...(sourceUrl ? [`Source: ${sourceUrl}`] : []),
  ].join('\n');

  const input: Record<string, any> = {
    teamId: meta.teamId,
    title,
    description: body,
    labelIds,
  };
  if (meta.backlogStateId) input.stateId = meta.backlogStateId;

  const data = await linearGraphQL(
    `mutation($input: IssueCreateInput!) {
      issueCreate(input: $input) { success issue { identifier url } }
    }`,
    { input },
  );
  const issue = data?.issueCreate?.issue;
  if (!data?.issueCreate?.success || !issue) {
    throw new Error('Linear issueCreate did not return an issue');
  }
  return { identifier: issue.identifier, url: issue.url };
}

export interface OpenCanonical {
  identifier: string; // e.g. ENG-42
  issueId: string;    // internal uuid (for comments/mutations)
  title: string;
  description: string;
  /** Public Featurebase post URL, from the "Featurebase Submission" attachment, if present. */
  featurebasePostUrl?: string;
}

/**
 * List OPEN canonical issues of a given type — i.e. user-filed requests that were
 * imported to Featurebase (carry the "Featurebase" label) and are not yet resolved.
 * These are the dedup-match candidates. Type-scoped (Bug vs Feature) and open-only
 * (excludes completed/canceled) per the dedup contract.
 */
export async function listOpenCanonicals(type: LinearItemType, limit = 30): Promise<OpenCanonical[]> {
  const meta = await getTeamMeta();
  const typeLabel = type === 'bug' ? 'Bug' : 'Feature';
  const data = await linearGraphQL(
    `query($team: String!, $fb: String!, $typeLabel: String!, $limit: Int!) {
      issues(
        first: $limit,
        orderBy: createdAt,
        filter: {
          team: { key: { eq: $team } },
          state: { type: { nin: ["completed", "canceled"] } },
          and: [
            { labels: { name: { eq: $fb } } },
            { labels: { name: { eq: $typeLabel } } }
          ]
        }
      ) {
        nodes { id identifier title description attachments { nodes { title url } } }
      }
    }`,
    { team: TEAM_KEY, fb: FEATUREBASE_LABEL, typeLabel, limit },
  );
  const nodes: any[] = data?.issues?.nodes || [];
  return nodes.map((n) => {
    const fbAttachment = (n.attachments?.nodes || []).find(
      (a: any) => typeof a?.url === 'string' && a.url.includes('featurebase.app'),
    );
    return {
      identifier: n.identifier,
      issueId: n.id,
      title: n.title || '',
      description: n.description || '',
      featurebasePostUrl: fbAttachment?.url,
    };
  });
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
 * resolved against the team's labels; unknown names are dropped.
 */
export async function createInternalLinearIssue(params: { title: string; description: string; labelNames: string[] }): Promise<LinearIssueResult> {
  const meta = await getTeamMeta();
  const labelIds = params.labelNames
    .map((n) => meta.labelIds[n.toLowerCase()])
    .filter((id): id is string => Boolean(id));
  const input: Record<string, any> = {
    teamId: meta.teamId,
    title: params.title,
    description: params.description,
    labelIds,
  };
  if (meta.backlogStateId) input.stateId = meta.backlogStateId;
  const data = await linearGraphQL(
    `mutation($input: IssueCreateInput!) {
      issueCreate(input: $input) { success issue { identifier url } }
    }`,
    { input },
  );
  const issue = data?.issueCreate?.issue;
  if (!data?.issueCreate?.success || !issue) {
    throw new Error('Linear issueCreate (internal) did not return an issue');
  }
  return { identifier: issue.identifier, url: issue.url };
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
