import jwt from 'jsonwebtoken';
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

/**
 * Convert the intake layer's markdown/plaintext into the HTML that Featurebase's `content` field
 * expects (their documented API contract: "content should be formatted as HTML").
 *
 * WHY THIS EXISTS: Emma's report_product_issues (and the in-app reporter) hand us markdown/plaintext
 * with bare newlines. Featurebase renders those newlines on its own board (it nl2br's on display),
 * but its native Linear push treats them as insignificant HTML whitespace and collapses the whole
 * body into one run-on paragraph — the "blob" a synced Linear issue shows (e.g. ENG-204). Real HTML
 * block tags (<p>/<ul>/<h2>…) survive BOTH the Featurebase render and the Linear push.
 *
 * WHY HAND-ROLLED (not `marked`): the backend compiles to CommonJS and `marked` is ESM-only, so a
 * static import risks an ERR_REQUIRE_ESM at load time on older Node (which would break ALL intake,
 * not just formatting), and dynamic-import/jest-ESM plumbing is disproportionate for the handful of
 * constructs Emma/users actually emit. This converter is total and dependency-free, and it
 * HTML-escapes the input FIRST — so raw user text can never inject markup (no reliance on
 * Featurebase-side sanitization). Best-effort by construction: any input yields valid HTML, so a
 * filing never fails on formatting.
 *
 * Handles: headings (#..######), unordered lists (-/*), ordered lists (N.), blank-line paragraphs,
 * single-newline <br>, inline **bold** and `code`.
 */
export function mdToFeaturebaseHtml(md: string): string {
  const src = (md ?? '').replace(/\r\n?/g, '\n').trim();
  if (!src) return '';

  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (s: string) =>
    esc(s)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+?)`/g, '<code>$1</code>');

  const out: string[] = [];
  let para: string[] = [];
  let list: string[] | null = null;
  let listTag: 'ul' | 'ol' = 'ul';
  const flushPara = () => { if (para.length) { out.push('<p>' + para.map(inline).join('<br>') + '</p>'); para = []; } };
  const flushList = () => { if (list) { out.push(`<${listTag}>` + list.map((li) => `<li>${inline(li)}</li>`).join('') + `</${listTag}>`); list = null; } };

  for (const raw of src.split('\n')) {
    const line = raw.trimEnd();
    if (line.trim() === '') { flushPara(); flushList(); continue; }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    const uli = line.match(/^[-*]\s+(.*)$/);
    const oli = line.match(/^\d+\.\s+(.*)$/);
    if (heading) {
      flushPara(); flushList();
      out.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`);
    } else if (uli) {
      flushPara();
      if (!list || listTag !== 'ul') { flushList(); list = []; listTag = 'ul'; }
      list.push(uli[1]);
    } else if (oli) {
      flushPara();
      if (!list || listTag !== 'ol') { flushList(); list = []; listTag = 'ol'; }
      list.push(oli[1]);
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara(); flushList();
  return out.join('\n');
}

export interface FeaturebaseCredentials {
  apiKey: string;
  appId?: string;
  /** HMAC secret for signing Featurebase Identity-Verification (SSO) JWTs. Dashboard → Settings → Access & Security → Security. */
  ssoSecret?: string;
}

/** The Featurebase board subdomain (`<org>.featurebase.app`) — the SDK `identify` call needs it. */
export const FEATUREBASE_ORG = 'agentweb';

const credentialsCache: Record<string, FeaturebaseCredentials> = {};

/** Test seam — clear the cached Featurebase credentials. */
export function _resetCredentialsCache(): void {
  for (const k of Object.keys(credentialsCache)) delete credentialsCache[k];
}

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

/**
 * Mint a Featurebase Identity-Verification JWT (HS256) for a logged-in user, signed with the board's
 * SSO secret. The frontend hands this to `Featurebase("identify", { organization, featurebaseJwt })`
 * so the user is recognized in the embedded widget and sees their OWN posts + private tickets — no
 * separate Featurebase login. Short-lived (minted per session). Throws if the SSO secret isn't
 * configured, so the caller can surface a clean 503 instead of a widget that silently shows nobody.
 */
export async function signFeaturebaseIdentityJwt(p: { userId: string; email: string; name?: string }): Promise<string> {
  const { ssoSecret } = await getFeaturebaseCredentials();
  if (!ssoSecret) throw new Error('Featurebase ssoSecret not configured');
  const payload: Record<string, unknown> = { userId: p.userId, email: p.email };
  if (p.name) payload.name = p.name;
  return jwt.sign(payload, ssoSecret, { algorithm: 'HS256', expiresIn: '10m' });
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
      content: mdToFeaturebaseHtml(p.description),
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
 * Resolve a Featurebase post by EXACT title match (ENG-187 contract #4). The FB->Linear sync
 * copies the post title onto the Linear issue verbatim, so a synced issue's title is the join key
 * back to its post — and its author. Uses the verified `GET /v2/posts?q=` search, then filters to
 * exact (case/whitespace-insensitive) matches; zero or multiple matches return null, because
 * attributing the WRONG author's funnel stage to an issue is worse than no attribution. Falls back
 * to `getPost` when the search result omits the author.
 */
export async function findPostByTitle(title: string): Promise<{ id: string; authorEmail?: string } | null> {
  const norm = (s: string) => (s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const want = norm(title);
  if (!want) return null;
  const data = await featurebaseFetch(`/posts?q=${encodeURIComponent(title.trim().slice(0, 200))}&limit=20`, { method: 'GET' });
  const posts: any[] = data?.data || [];
  const matches = posts.filter((p) => norm(p.title) === want);
  if (matches.length !== 1) return null;
  const post = matches[0];
  if (post.author?.email) return { id: post.id, authorEmail: post.author.email };
  const full = await getPost(post.id);
  return { id: full.id, authorEmail: full.authorEmail };
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

/** Add a voter (additional reporter) to a post, attributed by email. Auto-creates the contact. */
export async function addVoter(postId: string, email: string, name?: string): Promise<void> {
  await featurebaseFetch(`/posts/${postId}/voters`, {
    method: 'POST',
    body: JSON.stringify({ email, name: name || email }),
  });
}

// ---------------------------------------------------------------------------
// Tickets (private, per-reporter "own card").
//
// A bug report becomes a private Customer ticket (the category's postDefaults are
// authorOnly), authored by the reporter, so each reporter sees ONLY their own card in
// the Ticket Portal with a live status. Featurebase's API does NOT expose customer↔tracker
// linking, and Linear doesn't sync to tickets — so grouping + "resolve once → notify all"
// is driven by us (intakeService groups reporters onto one Linear canonical; a Linear
// webhook patches/replies to the linked tickets on resolve). The tracker ticket TYPE is
// therefore unused in this design — the canonical is the Linear issue.
//
// IMPORTANT: the ticket API is keyed by the numeric `ticketNumber`, NOT the hex id.
// Contract verified live (2026-06-29):
//   POST  /v2/tickets {ticketCategoryId, title, content, author:{email,name}} -> {id, ticketNumber, ticketUrl, status}
//   PATCH /v2/tickets/{number} {statusId} ; ticket categories are at /v2/tickets/categories
// ---------------------------------------------------------------------------

let customerTicketCategoryCache: string | null = null;

/** For tests: reset cached ticket-category id. */
export function _resetTicketCategoryCache(): void {
  customerTicketCategoryCache = null;
}

/**
 * Resolve the Customer ("Bug Report") ticket category id by name (the API does not expose
 * the customer/tracker type on the category, so we match by name). Override the name with
 * FEATUREBASE_BUG_TICKET_CATEGORY. Cached for the process lifetime.
 */
export async function getCustomerTicketCategoryId(): Promise<string> {
  if (customerTicketCategoryCache) return customerTicketCategoryCache;
  const data = await featurebaseFetch('/tickets/categories', { method: 'GET' });
  const cats: any[] = Array.isArray(data) ? data : data?.data || [];
  const wantName = (process.env.FEATUREBASE_BUG_TICKET_CATEGORY || 'Bug Report').trim().toLowerCase();
  const chosen = cats.find((c) => ((c.name || c.localization?.name?.en || '').trim().toLowerCase() === wantName)) || cats[0];
  const id: string = chosen?._id || chosen?.id;
  if (!id) throw new Error(`Featurebase: no ticket category found (looked for "${wantName}")`);
  customerTicketCategoryCache = id;
  return id;
}

export interface CreatedTicket {
  id: string;     // hex id
  number: number; // ticketNumber — the key for GET/PATCH
  url: string;    // ticketUrl — the user-facing link to their own card
}

/**
 * Create a private Customer ticket authored by the reporter. content is the reporter's own
 * words (what THEY see on their private card).
 */
export async function createTicket(p: {
  title: string;
  content: string;
  authorEmail: string;
  authorName?: string;
  categoryId?: string;
}): Promise<CreatedTicket> {
  const ticketCategoryId = p.categoryId || (await getCustomerTicketCategoryId());
  const data = await featurebaseFetch('/tickets', {
    method: 'POST',
    body: JSON.stringify({
      ticketCategoryId,
      title: p.title,
      content: mdToFeaturebaseHtml(p.content),
      author: { email: p.authorEmail, name: p.authorName || p.authorEmail },
    }),
  });
  const t = data?.data || data;
  if (!t?.id || t?.ticketNumber == null) {
    throw new Error(`Featurebase createTicket did not return id+number: ${JSON.stringify(data).slice(0, 200)}`);
  }
  return { id: t.id, number: t.ticketNumber, url: t.ticketUrl || '' };
}

/** Post details for the ship-notify path — fills webhook-payload gaps (author email, public URL). */
export interface PostDetails {
  id: string;
  title: string;
  url?: string;
  authorEmail?: string;
  statusType?: string;
}

export async function getPost(postId: string): Promise<PostDetails> {
  const data = await featurebaseFetch(`/posts/${encodeURIComponent(postId)}`, { method: 'GET' });
  const post = data?.data || data?.post || data;
  if (!post?.id) throw new Error(`Featurebase getPost did not return a post: ${JSON.stringify(data).slice(0, 200)}`);
  return {
    id: post.id,
    title: post.title || '',
    url: post.postUrl || post.url,
    authorEmail: post.author?.email,
    statusType: post.status?.type,
  };
}

export interface PostVoter {
  email?: string;
  name?: string;
}

/**
 * List a post's voters (the additional reporters stacked by dedup). Single page,
 * capped at the API max of 100 — logged when truncated so a silent cap can't read
 * as full coverage.
 */
export async function listPostVoters(postId: string, limit = 100): Promise<PostVoter[]> {
  const data = await featurebaseFetch(`/posts/${encodeURIComponent(postId)}/voters?limit=${limit}`, { method: 'GET' });
  const voters: any[] = data?.data || [];
  if (data?.nextCursor) console.warn(`[featurebase] post ${postId} has >${limit} voters — notifying the first ${limit} only`);
  return voters.map((v) => ({ email: v.email, name: v.name }));
}

/** Set a ticket's status (keyed by ticketNumber). Used by the resolve bridge to flip cards on fix. */
export async function patchTicketStatus(ticketNumber: number, statusId: string): Promise<void> {
  await featurebaseFetch(`/tickets/${ticketNumber}`, {
    method: 'PATCH',
    body: JSON.stringify({ statusId }),
  });
}

let ticketStatusCache: Record<string, string> = {};

/** For tests: reset cached ticket statuses. */
export function _resetTicketStatusCache(): void {
  ticketStatusCache = {};
}

/** Resolve a ticket status id by name (e.g. "Completed"). Cached for the process lifetime. */
export async function getTicketStatusId(name: string): Promise<string> {
  if (Object.keys(ticketStatusCache).length === 0) {
    const data = await featurebaseFetch('/tickets/statuses', { method: 'GET' });
    const statuses: any[] = Array.isArray(data) ? data : data?.data || [];
    for (const s of statuses) {
      const id = s._id || s.id;
      if (s.name && id) ticketStatusCache[s.name] = id;
    }
  }
  const id = ticketStatusCache[name];
  if (!id) throw new Error(`Featurebase: no ticket status named "${name}"`);
  return id;
}
