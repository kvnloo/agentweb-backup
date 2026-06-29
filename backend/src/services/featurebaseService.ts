import { getSecret } from '../utils/secretsManager';

/**
 * Featurebase client — Featurebase-FIRST intake.
 *
 * We create the canonical as a Featurebase POST via the API with `integrations.linear:true`,
 * which (a) returns the post id synchronously, (b) attributes it to the filer (author =
 * the reporter), and (c) pushes it to Linear as an issue for eng. This is simpler than the
 * old Linear-first import: the post exists immediately, so the filer natively owns their
 * post (shows in their Featurebase "My profile") and we hand them a direct link on the spot
 * — no deferred attribution against a ~10s-late import.
 *
 * Public vs private: the post body is PUBLIC (title + the user's description). Per-reporter
 * eng data (session ids, "also reported by", a duplicate's full text) goes in PRIVATE
 * comments (isPrivate:true) so it is eng-only, never shown on the public board.
 *
 * Contract verified live (2026-06-29):
 *   POST /v2/posts {title,content,boardId,author:{email,name},integrations:{linear:true}}
 *   POST /v2/posts/{id}/voters {email,name}
 *   POST /v2/comments {postId,content,isPrivate}
 *   GET  /v2/posts?q= | GET /v2/posts?boardId= | GET /v2/boards
 *   auth `Authorization: Bearer <apiKey>`, header `Featurebase-Version: 2026-01-01.nova`.
 */

const FB_API_BASE = 'https://do.featurebase.app/v2';
const FB_VERSION = '2026-01-01.nova';

/** Status types that mean "closed" — excluded when listing open canonicals for dedup. */
const CLOSED_STATUS_TYPES = new Set(['completed', 'canceled']);

export interface FeaturebaseCredentials {
  apiKey: string;
  appId?: string;
}

const credentialsCache: Record<string, FeaturebaseCredentials> = {};

export async function getFeaturebaseCredentialsForEnv(env: 'development' | 'production'): Promise<FeaturebaseCredentials> {
  if (credentialsCache[env]) return credentialsCache[env];
  const secretName = env === 'production' ? 'prod/AgentWeb/Featurebase' : 'dev/AgentWeb/Featurebase';
  const secretString = await getSecret(secretName);
  if (!secretString || secretString.trim() === '') {
    throw new Error(`Featurebase credentials secret is empty for ${env}`);
  }
  const credentials = JSON.parse(secretString) as FeaturebaseCredentials;
  if (!credentials.apiKey) throw new Error(`Featurebase credentials missing apiKey for ${env}`);
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
    if (res.status === 429 && attempt < MAX_RETRIES) {
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
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

export interface FeaturebasePost {
  id: string;
  title: string;
  url?: string;
}

/** A candidate canonical for dedup: an open public post on the board. */
export interface OpenPost {
  id: string;
  title: string;
  description: string;
  url?: string;
}

export interface CreatedPost {
  id: string;
  /** Public, user-facing post URL — the link we hand the reporter. */
  url: string;
}

let boardIdCache: string | null = null;

/**
 * Resolve the board to file into. Defaults to the board named by FEATUREBASE_BOARD_NAME,
 * else the first board on the account. Cached for the process lifetime.
 */
export async function getDefaultBoardId(): Promise<string> {
  if (boardIdCache) return boardIdCache;
  const data = await featurebaseFetch('/boards', { method: 'GET' });
  const boards: any[] = Array.isArray(data) ? data : data?.data || [];
  if (boards.length === 0) throw new Error('Featurebase: no boards configured');
  const wantName = (process.env.FEATUREBASE_BOARD_NAME || '').trim().toLowerCase();
  const chosen = (wantName && boards.find((b) => (b.name || '').trim().toLowerCase() === wantName)) || boards[0];
  const id: string = chosen._id || chosen.id;
  if (!id) throw new Error('Featurebase: board has no id');
  boardIdCache = id;
  return id;
}

/** For tests: reset the cached board id. */
export function _resetBoardCache(): void {
  boardIdCache = null;
}

/**
 * Create the canonical as a public Featurebase post, attributed to the filer, and push it
 * to Linear (integrations.linear:true) for eng. Returns the post id + public URL synchronously.
 */
export async function createPost(p: {
  title: string;
  description: string;
  authorEmail: string;
  authorName?: string;
  boardId?: string;
}): Promise<CreatedPost> {
  const boardId = p.boardId || (await getDefaultBoardId());
  const data = await featurebaseFetch('/posts', {
    method: 'POST',
    body: JSON.stringify({
      title: p.title,
      content: p.description,
      boardId,
      author: { email: p.authorEmail, name: p.authorName || p.authorEmail },
      integrations: { linear: true },
    }),
  });
  const post = data?.data || data?.post || data;
  if (!post?.id) throw new Error(`Featurebase createPost did not return a post id: ${JSON.stringify(data).slice(0, 200)}`);
  return { id: post.id, url: post.postUrl || post.url || '' };
}

/**
 * List open (non-completed/non-canceled) posts on the board — the candidate canonicals a
 * new filing is deduped against. Best-effort status filtering.
 */
export async function listOpenPosts(limit = 50): Promise<OpenPost[]> {
  const boardId = await getDefaultBoardId();
  const data = await featurebaseFetch(`/posts?boardId=${encodeURIComponent(boardId)}&limit=${limit}`, { method: 'GET' });
  const posts: any[] = data?.data || [];
  return posts
    .filter((p) => !CLOSED_STATUS_TYPES.has((p.postStatus?.type || p.status?.type || '').toLowerCase()))
    .map((p) => ({ id: p.id, title: p.title || '', description: p.content || p.description || '', url: p.postUrl || p.url }));
}

/**
 * Add a comment to a post. isPrivate=true makes it an eng-only (internal) note — use it for
 * session ids / reporter attribution / a duplicate's full text so nothing private goes public.
 */
export async function addComment(postId: string, content: string, isPrivate = true): Promise<void> {
  await featurebaseFetch('/comments', {
    method: 'POST',
    body: JSON.stringify({ postId, content, isPrivate }),
  });
}

/** Find a post by (near-exact) title — used to resolve a canonical's imported post. */
export async function findPostByTitle(title: string): Promise<FeaturebasePost | null> {
  const q = encodeURIComponent(title.slice(0, 200));
  const data = await featurebaseFetch(`/posts?q=${q}&limit=5`, { method: 'GET' });
  const candidates: any[] = data?.data || [];
  const norm = (s: string) => (s || '').trim().toLowerCase();
  const exact = candidates.find((p) => norm(p.title) === norm(title));
  const chosen = exact || candidates[0];
  if (!chosen) return null;
  return { id: chosen.id, title: chosen.title, url: chosen.postUrl || chosen.url };
}

/** Add a voter (additional reporter) to a post, attributed by email. Auto-creates the contact. */
export async function addVoter(postId: string, email: string, name?: string): Promise<void> {
  await featurebaseFetch(`/posts/${postId}/voters`, {
    method: 'POST',
    body: JSON.stringify({ email, name: name || email }),
  });
}
