import { getSecret } from '../utils/secretsManager';

/**
 * Featurebase intake service.
 *
 * User-filed feature requests + bugs (via Emma's report_product_issues tool) are
 * created here as Featurebase posts attributed to the user's email. Featurebase
 * handles the per-user portal, dedup/voting, two-way Linear sync, and the
 * status/ship email natively — this service is just the thin write layer.
 *
 * Contract verified against the live API (2026-06-28):
 *   base  https://do.featurebase.app/v2   header  Featurebase-Version: 2026-01-01.nova
 *   auth  Authorization: Bearer <apiKey>
 *   create  POST /v2/posts            -> top-level { id, slug, postUrl, ... }
 *   search  GET  /v2/posts?q=&boardId=&limit=  -> { data: [ ... ] }
 *   upvote  POST /v2/posts/{id}/voters { email, name }
 *   boards  GET  /v2/boards           -> [ { id, name, ... } ]
 * Author attribution: an inline `author: { email, name }` auto-creates/links the
 * contact (no pre-upsert needed).
 */

export interface FeaturebaseCredentials {
  apiKey: string;
  appId?: string;
}

const FB_API_BASE = 'https://do.featurebase.app/v2';
const FB_VERSION = '2026-01-01.nova';

const credentialsCache: Record<string, FeaturebaseCredentials> = {};

export async function getFeaturebaseCredentialsForEnv(env: 'development' | 'production'): Promise<FeaturebaseCredentials> {
  if (credentialsCache[env]) return credentialsCache[env];

  const secretName = env === 'production'
    ? 'prod/AgentWeb/Featurebase'
    : 'dev/AgentWeb/Featurebase';

  const secretString = await getSecret(secretName);
  if (!secretString || secretString.trim() === '') {
    throw new Error(`Featurebase credentials secret is empty for ${env}`);
  }

  const credentials = JSON.parse(secretString) as FeaturebaseCredentials;
  if (!credentials.apiKey) {
    throw new Error(`Featurebase credentials missing apiKey for ${env}`);
  }

  credentialsCache[env] = credentials;
  return credentials;
}

export async function getFeaturebaseCredentials(): Promise<FeaturebaseCredentials> {
  const environment = process.env.NODE_ENV || 'development';
  return getFeaturebaseCredentialsForEnv(environment === 'production' ? 'production' : 'development');
}

async function featurebaseFetch(path: string, options: RequestInit = {}): Promise<any> {
  const { apiKey } = await getFeaturebaseCredentials();
  const MAX_RETRIES = 3;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(`${FB_API_BASE}${path}`, {
      ...options,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Featurebase-Version': FB_VERSION,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    // Rate-limit: back off and retry (limits are undocumented; 429 => retry).
    if (res.status === 429 && attempt < MAX_RETRIES) {
      await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
      continue;
    }

    const data = await res.json().catch(() => ({} as any));
    if (!res.ok) {
      throw new Error(`Featurebase API error ${res.status}: ${data?.message || JSON.stringify(data)}`);
    }
    return data;
  }
  throw new Error('Featurebase API: rate-limit retries exhausted');
}

let boardsCache: Array<{ id: string; name: string }> | null = null;

/** Resolve a board id by trying each preferred name in order; falls back to the first board. */
async function resolveBoardId(preferredNames: string[]): Promise<string> {
  if (!boardsCache) {
    const boards = await featurebaseFetch('/boards', { method: 'GET' });
    const list = Array.isArray(boards) ? boards : (boards?.data || []);
    boardsCache = list.map((b: any) => ({ id: b.id, name: b.name }));
  }
  for (const name of preferredNames) {
    const hit = boardsCache!.find(b => b.name.toLowerCase() === name.toLowerCase());
    if (hit) return hit.id;
  }
  if (boardsCache!.length > 0) return boardsCache![0].id;
  throw new Error('Featurebase: no boards available to post to');
}

let pushStatusIdCache: string | null = null;

/**
 * Resolve a status id that Featurebase WILL auto-push to Linear.
 * New posts default to the "reviewing"-type status (e.g. "In Review"), which
 * Featurebase holds in its inbox and does NOT push. Creating the post directly
 * in a committed status (prefer "Planned", else the first non-reviewing status)
 * makes the native auto-push fire immediately, so every filing reaches Linear.
 */
async function resolvePushStatusId(): Promise<string | null> {
  if (pushStatusIdCache) return pushStatusIdCache;
  try {
    const statuses = await featurebaseFetch('/post_statuses', { method: 'GET' });
    const list: any[] = Array.isArray(statuses) ? statuses : (statuses?.data || []);
    const planned = list.find(s => (s.name || '').toLowerCase() === 'planned');
    const firstCommitted = list.find(s => s.type && s.type !== 'reviewing');
    const chosen = planned || firstCommitted;
    if (chosen) { pushStatusIdCache = chosen.id; return chosen.id; }
  } catch (e) {
    console.warn('[featurebase] could not resolve push status; post will use default status:', e instanceof Error ? e.message : e);
  }
  return null;
}

/** Test seam — reset the in-process caches. */
export function _resetFeaturebaseBoardCache(): void {
  boardsCache = null;
  pushStatusIdCache = null;
}

export type FeaturebaseItemType = 'feature_request' | 'bug';

export interface CreateFeaturebasePostParams {
  type: FeaturebaseItemType;
  title: string;
  description: string;
  userEmail: string;
  userName?: string;
  /** When true (default), search for a near-duplicate and upvote it instead of creating a new post. */
  dedupe?: boolean;
}

export interface FeaturebasePostResult {
  /** Featurebase post id (the existing post's id when deduped). */
  id: string;
  /** Public post URL on the portal. */
  url: string;
  /** True when an existing near-duplicate was upvoted instead of creating a new post. */
  deduped: boolean;
}

const FEATURE_BOARD_NAMES = ['Feature Request', 'Feature Requests', 'Feedback'];
// No dedicated Bugs board yet (board creation isn't exposed via the API) — fall back
// to the Feature Request board with author-only visibility until a Bugs board exists.
const BUG_BOARD_NAMES = ['Bugs', 'Bug', 'Feature Request'];

export async function createFeaturebasePost(params: CreateFeaturebasePostParams): Promise<FeaturebasePostResult> {
  const { type, title, description, userEmail, userName, dedupe = true } = params;

  const boardId = await resolveBoardId(type === 'feature_request' ? FEATURE_BOARD_NAMES : BUG_BOARD_NAMES);
  const author = { email: userEmail, name: userName || userEmail };
  // Feature requests are public + votable; bugs default to author-only ("show users
  // their own"). An admin can flip a bug to public to surface it as a known issue.
  const visibility = type === 'bug' ? 'authorOnly' : 'public';

  // Dedup -> vote: best-effort. A failed search must never block the filing.
  if (dedupe) {
    try {
      const q = encodeURIComponent(title.slice(0, 200));
      const search = await featurebaseFetch(`/posts?q=${q}&boardId=${boardId}&limit=5`, { method: 'GET' });
      const candidates: any[] = search?.data || [];
      const match = candidates.find((p: any) => isSimilarTitle(p.title, title));
      if (match) {
        await featurebaseFetch(`/posts/${match.id}/voters`, {
          method: 'POST',
          body: JSON.stringify(author),
        });
        return { id: match.id, url: postUrl(match), deduped: true };
      }
    } catch (e) {
      console.warn('[featurebase] dedup search failed; creating new post:', e instanceof Error ? e.message : e);
    }
  }

  // Create directly in a committed (non-"reviewing") status so Featurebase's native
  // Linear auto-push fires immediately — otherwise new posts sit in the "In Review"
  // inbox and never reach Linear. statusId is best-effort; omitted if unresolved.
  const statusId = await resolvePushStatusId();
  const body: Record<string, any> = { title, content: description, boardId, visibility, author };
  if (statusId) body.statusId = statusId;

  const created = await featurebaseFetch('/posts', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return { id: created.id, url: postUrl(created), deduped: false };
}

/** Token-overlap heuristic: a candidate is "similar" if >=60% of the new title's words appear in it. */
function isSimilarTitle(candidate: string, incoming: string): boolean {
  const tokenize = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  const candidateTokens = new Set(tokenize(candidate));
  const incomingTokens = tokenize(incoming);
  if (incomingTokens.length === 0) return false;
  const overlap = incomingTokens.filter(w => candidateTokens.has(w)).length;
  return overlap / incomingTokens.length >= 0.6;
}

function postUrl(post: any): string {
  return post?.postUrl || post?.url || '';
}
