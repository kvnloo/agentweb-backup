/**
 * Production LinearPort for the Fathom → Linear router (ENG-536).
 *
 * The reconciliation policy stays in fathomLinearRouter.ts. This adapter only
 * translates its five boundary operations to Linear GraphQL. GraphQL is
 * injectable so all behavior is covered with fakes and production credentials
 * continue to come from linearService / AWS Secrets Manager.
 */

import {
  ALL_TEAMS,
  LinearCandidateIssue,
  LinearPort,
  LinearTeamKey,
  fathomKeyMarker,
} from './fathomLinearRouter';
import { createHash } from 'crypto';

import { linearGraphQL } from './linearService';

export type FathomLinearGraphql = (
  query: string,
  variables?: Record<string, unknown>,
) => Promise<any>;

export interface FathomLinearPortDependencies {
  graphql?: FathomLinearGraphql;
  now?: () => Date;
}

const OPEN_STATE_TYPES = ['triage', 'backlog', 'unstarted', 'started'];
const CLOSED_STATE_TYPES = ['completed', 'canceled'];
const OPEN_STATE_TYPES_GQL = `[${OPEN_STATE_TYPES.map(type => `"${type}"`).join(', ')}]`;
const CLOSED_STATE_TYPES_GQL = `[${CLOSED_STATE_TYPES.map(type => `"${type}"`).join(', ')}]`;
const RECENTLY_CLOSED_DAYS = 30;
const MAX_LINEAR_PAGE = 250;
const FATHOM_KEY_RE = /\[\[fathom-key:([^\]]+)\]\]/;

/**
 * Derive the issue's Linear id deterministically from the stable Fathom key.
 *
 * This is what makes creation idempotent ACROSS processes. Linear enforces
 * uniqueness on the primary key, so two backend instances handling the same
 * webhook redelivery necessarily send the same id and exactly one insert wins —
 * the loser gets `conflict on insert of Issue`, which `performCreate` resolves
 * by reading back the winner. A process-local in-flight map cannot give this
 * guarantee; it only coalesces requests that happen to land on one instance.
 *
 * The id must be a **v4-shaped** UUID. Verified against the live API: Linear's
 * `IssueCreateInput.id` runs an `isUuid` validator that rejects a UUIDv5
 * (`"id must be a UUID"`), so the version and variant nibbles are forced here
 * rather than using `uuid.v5` directly. The value is still a pure function of
 * the key — same key in, same id out, on every instance and across restarts.
 */
export function issueIdForFathomKey(key: string): string {
  const bytes = createHash('sha256').update(`fathom-linear-router:${key}`).digest().subarray(0, 16);
  const b = Buffer.from(bytes);
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = b.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

/** Linear's error when a client-supplied primary key is already taken. */
function isIdConflict(error: unknown): boolean {
  return error instanceof Error && /conflict on insert|already exists/i.test(error.message);
}

function isTeamKey(value: unknown): value is LinearTeamKey {
  return typeof value === 'string' && ALL_TEAMS.includes(value as LinearTeamKey);
}

function toCandidate(node: any): LinearCandidateIssue {
  const team = node?.team?.key;
  if (!node?.id || !node?.identifier || !isTeamKey(team)) {
    throw new Error('Linear returned an invalid Fathom router issue (missing id, identifier, or supported team)');
  }
  return {
    id: node.id,
    identifier: node.identifier,
    team,
    title: node.title || '',
    description: node.description || '',
    url: node.url || '',
    owner: node.assignee?.email || node.assignee?.name || undefined,
  };
}

function issueFields(): string {
  return `
    id
    identifier
    title
    description
    url
    team { key }
    assignee { name email }
  `;
}

function daysAgo(now: Date, days: number): string {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1_000).toISOString();
}

function searchRank(issue: LinearCandidateIssue, query: string): number {
  const haystack = `${issue.identifier} ${issue.title} ${issue.description}`.toLowerCase();
  const terms = query.toLowerCase().match(/[a-z0-9-]{3,}/g) || [];
  return terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}

/** Create an adapter. Omit dependencies in production; tests inject GraphQL. */
export function createFathomLinearPort(
  dependencies: FathomLinearPortDependencies = {},
): LinearPort {
  const graphql = dependencies.graphql || linearGraphQL;
  const now = dependencies.now || (() => new Date());
  const teamCache = new Map<LinearTeamKey, { id: string; labels: Map<string, string> }>();
  const createsByKey = new Map<string, Promise<LinearCandidateIssue>>();

  async function findByFathomKey(key: string): Promise<LinearCandidateIssue | null> {
    const marker = fathomKeyMarker(key);
    const data = await graphql(
      `query FathomLinearFindByKey($teamKeys: [String!]!, $marker: String!) {
        issues(
          first: 2
          filter: {
            team: { key: { in: $teamKeys } }
            description: { contains: $marker }
          }
        ) {
          nodes { ${issueFields()} }
        }
        comments(
          first: 2
          filter: {
            body: { contains: $marker }
            issue: { team: { key: { in: $teamKeys } } }
          }
        ) {
          nodes { issue { ${issueFields()} } }
        }
      }`,
      { teamKeys: ALL_TEAMS, marker },
    );
    const direct = data?.issues?.nodes?.[0];
    const viaComment = data?.comments?.nodes?.[0]?.issue;
    const found = direct || viaComment;
    return found ? toCandidate(found) : null;
  }

  async function searchIssues(params: {
    teams: LinearTeamKey[];
    query: string;
    limit?: number;
  }): Promise<LinearCandidateIssue[]> {
    const limit = Math.min(Math.max(params.limit ?? 30, 1), MAX_LINEAR_PAGE);
    const recent = daysAgo(now(), RECENTLY_CLOSED_DAYS);
    // Relevance is applied by Linear BEFORE truncation.
    //
    // This previously fetched the `limit` most-recently-updated eligible issues
    // and only then ranked them against `params.query` locally. A canonical
    // issue that had not been touched recently fell outside that page, was
    // never seen, and the router created a duplicate instead of enriching it —
    // precisely the outcome this adapter exists to prevent.
    //
    // `searchIssues` is Linear's own full-text search and accepts the same
    // filter, so the eligibility rules below are unchanged; only the ordering
    // the truncation applies to has changed. Verified against the live API:
    // searching an old issue's title returns it first, ahead of issues updated
    // more recently. Note `updatedAt` here takes `DateTimeOrDuration`, not
    // `DateTime` — the stricter type is a validation error on this field.
    const data = await graphql(
      `query FathomLinearSearch(
        $term: String!
        $teamKeys: [String!]!
        $limit: Int!
        $recentlyClosedSince: DateTimeOrDuration!
      ) {
        searchIssues(
          term: $term
          first: $limit
          filter: {
            team: { key: { in: $teamKeys } }
            or: [
              { state: { type: { in: ${OPEN_STATE_TYPES_GQL} } } }
              {
                state: { type: { in: ${CLOSED_STATE_TYPES_GQL} } }
                updatedAt: { gte: $recentlyClosedSince }
              }
            ]
          }
        ) {
          nodes { ${issueFields()} }
        }
      }`,
      {
        term: params.query,
        teamKeys: params.teams,
        limit,
        recentlyClosedSince: recent,
      },
    );
    return (data?.searchIssues?.nodes || [])
      .map(toCandidate)
      .sort((a: LinearCandidateIssue, b: LinearCandidateIssue) =>
        searchRank(b, params.query) - searchRank(a, params.query));
  }

  async function teamMeta(team: LinearTeamKey): Promise<{ id: string; labels: Map<string, string> }> {
    const cached = teamCache.get(team);
    if (cached) return cached;
    const data = await graphql(
      `query FathomLinearTeam($teamKey: String!) {
        teams(filter: { key: { eq: $teamKey } }, first: 1) {
          nodes {
            id
            key
            labels(first: 250) {
              nodes { id name }
              pageInfo { hasNextPage }
            }
          }
        }
      }`,
      { teamKey: team },
    );
    const node = data?.teams?.nodes?.[0];
    if (!node?.id || node.key !== team) throw new Error(`Linear team "${team}" not found`);
    if (node.labels?.pageInfo?.hasNextPage) {
      throw new Error(`Linear team "${team}" has more than 250 labels; adapter label lookup is truncated`);
    }
    const meta = {
      id: node.id as string,
      labels: new Map<string, string>(
        (node.labels?.nodes || []).map((label: any) => [String(label.name).toLowerCase(), label.id]),
      ),
    };
    teamCache.set(team, meta);
    return meta;
  }

  async function performCreate(params: {
    team: LinearTeamKey;
    title: string;
    description: string;
    labels?: string[];
    fathomKey?: string;
  }): Promise<LinearCandidateIssue> {
    const meta = await teamMeta(params.team);
    const labelIds = (params.labels || []).map((name) => {
      const id = meta.labels.get(name.toLowerCase());
      if (!id) throw new Error(`Linear label "${name}" not found on team ${params.team}`);
      return id;
    });
    let data: any;
    try {
      data = await graphql(
        `mutation FathomLinearIssueCreate($input: IssueCreateInput!) {
          issueCreate(input: $input) {
            success
            issue { ${issueFields()} }
          }
        }`,
        {
          input: {
            teamId: meta.id,
            title: params.title,
            description: params.description,
            ...(labelIds.length ? { labelIds } : {}),
            // Only keyed creates are idempotent. An unkeyed create (no
            // [[fathom-key:...]] marker) keeps Linear's server-generated id,
            // because there is nothing stable to derive one from.
            ...(params.fathomKey ? { id: issueIdForFathomKey(params.fathomKey) } : {}),
          },
        },
      );
    } catch (error) {
      // Another process won the insert for this key. That is success, not
      // failure: the issue the router wanted now exists. Read it back rather
      // than surfacing an error the caller would retry into a third attempt.
      if (params.fathomKey && isIdConflict(error)) {
        const winner = await findByFathomKey(params.fathomKey);
        if (winner) return winner;
        // The row exists but is not yet visible to our read. Surfacing the
        // conflict is correct here — it is loud, and a retry resolves it once
        // the write settles. Silently inventing a candidate would be worse.
      }
      throw error;
    }
    if (data?.issueCreate?.success !== true || !data?.issueCreate?.issue) {
      throw new Error('Linear Fathom issueCreate did not return an issue');
    }
    return toCandidate(data.issueCreate.issue);
  }

  async function createIssue(params: {
    team: LinearTeamKey;
    title: string;
    description: string;
    labels?: string[];
  }): Promise<LinearCandidateIssue> {
    const key = params.description.match(FATHOM_KEY_RE)?.[1];
    if (!key) return performCreate(params);

    // The in-flight map is now only a same-process coalescer — it saves a
    // duplicate round-trip when one instance handles overlapping redeliveries.
    // Correctness no longer depends on it: the deterministic id in
    // performCreate is what prevents a duplicate across processes.
    const inFlight = createsByKey.get(key);
    if (inFlight) return inFlight;
    const creation = (async () => {
      const existing = await findByFathomKey(key);
      return existing || performCreate({ ...params, fathomKey: key });
    })();
    createsByKey.set(key, creation);
    try {
      return await creation;
    } finally {
      createsByKey.delete(key);
    }
  }

  async function addComment(params: { issueId: string; body: string }): Promise<void> {
    const data = await graphql(
      `mutation FathomLinearCommentCreate($input: CommentCreateInput!) {
        commentCreate(input: $input) { success }
      }`,
      { input: params },
    );
    if (data?.commentCreate?.success !== true) throw new Error('Linear Fathom commentCreate failed');
  }

  async function relateIssues(params: { issueId: string; relatedIssueId: string }): Promise<void> {
    try {
      const data = await graphql(
        `mutation FathomLinearRelationCreate($input: IssueRelationCreateInput!) {
          issueRelationCreate(input: $input) { success }
        }`,
        { input: { ...params, type: 'related' } },
      );
      if (data?.issueRelationCreate?.success !== true) {
        throw new Error('Linear Fathom issueRelationCreate failed');
      }
    } catch (error) {
      // The router deliberately re-asserts relations on redelivery. Linear may
      // report an already-existing relation as an error; that is the desired state.
      if (error instanceof Error && /already exists|duplicate relation/i.test(error.message)) return;
      throw error;
    }
  }

  return { findByFathomKey, searchIssues, createIssue, addComment, relateIssues };
}
