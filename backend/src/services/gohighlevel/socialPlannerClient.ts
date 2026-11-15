/**
 * ENG-2941 (slice A of ENG-2872) — GoHighLevel Social Planner draft client.
 *
 * Dark: nothing registers this as an Emma tool, and `isGhlSocialPlannerEnabled()`
 * defaults to false. The HTTP transport is injected so the client is fully testable
 * without network or credentials; OAuth/credential storage stays on ENG-2872.
 *
 * Maps to GHL API v2 "Create post":
 *   POST https://services.leadconnectorhq.com/social-media-posting/{locationId}/posts
 *   headers: Authorization: Bearer <token>, Version: 2021-07-28
 *
 * Invariant: this client only ever creates DRAFTS. Any other status is refused
 * before a request is built.
 */

export const GHL_API_BASE = 'https://services.leadconnectorhq.com';
export const GHL_API_VERSION = '2021-07-28';
export const GHL_POST_TEXT_MAX = 3000;
export const GHL_MEDIA_MAX = 10;

export function isGhlSocialPlannerEnabled(raw: string | undefined = process.env.GHL_SOCIAL_PLANNER_ENABLED): boolean {
  return raw === 'true';
}

export interface GhlHttpRequest {
  method: 'POST';
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface GhlHttpResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string | undefined>;
}

export type GhlTransport = (req: GhlHttpRequest) => Promise<GhlHttpResponse>;

export interface CreateSocialPlannerDraftInput {
  locationId: string;
  accountIds: string[];
  text: string;
  mediaUrls?: string[];
  /** ISO-8601 time the draft is planned for; still saved as a draft. */
  scheduleAt?: string;
  /** Callers may pass a status only to have it checked; anything but 'draft' is refused. */
  status?: string;
}

export interface SocialPlannerDraft {
  postId: string;
  status: 'draft';
  raw: unknown;
}

export type GhlErrorKind = 'validation_input' | 'publish_refused' | 'auth' | 'validation' | 'rate_limited' | 'retryable' | 'unexpected';

export class GhlSocialPlannerError extends Error {
  constructor(
    readonly kind: GhlErrorKind,
    message: string,
    readonly status?: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'GhlSocialPlannerError';
  }

  get retryable(): boolean {
    return this.kind === 'retryable' || this.kind === 'rate_limited';
  }
}

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function inputError(message: string): GhlSocialPlannerError {
  return new GhlSocialPlannerError('validation_input', message);
}

export function validateDraftInput(input: CreateSocialPlannerDraftInput): void {
  if (input.status !== undefined && input.status !== 'draft') {
    throw new GhlSocialPlannerError(
      'publish_refused',
      `This client only creates drafts; status "${input.status}" was refused and nothing was sent.`,
    );
  }
  if (typeof input.locationId !== 'string' || !ID_RE.test(input.locationId)) {
    throw inputError('locationId is required and must be a GoHighLevel location id.');
  }
  if (!Array.isArray(input.accountIds) || input.accountIds.length === 0) {
    throw inputError('accountIds must list at least one connected social account.');
  }
  for (const id of input.accountIds) {
    if (typeof id !== 'string' || !ID_RE.test(id)) throw inputError(`Invalid social account id: ${String(id)}`);
  }
  if (typeof input.text !== 'string' || input.text.trim() === '') {
    throw inputError('text is required.');
  }
  if (input.text.length > GHL_POST_TEXT_MAX) {
    throw inputError(`text is ${input.text.length} characters; the limit is ${GHL_POST_TEXT_MAX}.`);
  }
  const media = input.mediaUrls ?? [];
  if (media.length > GHL_MEDIA_MAX) throw inputError(`At most ${GHL_MEDIA_MAX} media URLs are allowed.`);
  for (const url of media) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw inputError(`Media URL is not a valid URL: ${url}`);
    }
    if (parsed.protocol !== 'https:') throw inputError(`Media URL must use https: ${url}`);
    if (mediaType(url) === null) throw inputError(`Unsupported media format: ${url}`);
  }
  if (input.scheduleAt !== undefined && !isValidIsoInstant(input.scheduleAt)) {
    throw inputError(`scheduleAt is not a valid ISO-8601 time: ${input.scheduleAt}`);
  }
}

const ISO_INSTANT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

function isValidIsoInstant(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const m = ISO_INSTANT_RE.exec(value);
  if (!m) return false;
  const [y, mo, d, h, mi, se] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? '0'].map(Number);
  if (mo < 1 || mo > 12 || h > 23 || mi > 59 || se > 59) return false;
  const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  if (d < 1 || d > daysInMonth) return false;
  return !Number.isNaN(Date.parse(value));
}

// Media types accepted by Social Planner create-post, API version 2021-07-28.
function mediaType(url: string): string | null {
  const path = new URL(url).pathname.toLowerCase();
  if (/\.(mp4|m4v)$/.test(path)) return 'video/mp4';
  if (/\.mov$/.test(path)) return 'video/mov';
  if (/\.webm$/.test(path)) return 'video/webm';
  if (/\.png$/.test(path)) return 'image/png';
  if (/\.gif$/.test(path)) return 'image/gif';
  if (/\.(jpe?g)$/.test(path)) return 'image/jpeg';
  return null;
}

export function buildDraftRequest(input: CreateSocialPlannerDraftInput, accessToken: string): GhlHttpRequest {
  validateDraftInput(input);
  const body: Record<string, unknown> = {
    accountIds: input.accountIds,
    summary: input.text,
    media: (input.mediaUrls ?? []).map((url) => ({ url, type: mediaType(url) })),
    status: 'draft',
    type: 'post',
  };
  if (input.scheduleAt !== undefined) body.scheduleDate = new Date(input.scheduleAt).toISOString();
  return {
    method: 'POST',
    url: `${GHL_API_BASE}/social-media-posting/${encodeURIComponent(input.locationId)}/posts`,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Version: GHL_API_VERSION,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  };
}

function providerMessage(body: unknown): string {
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    const m = b.message ?? b.error ?? b.msg;
    if (Array.isArray(m)) return m.map(String).join('; ');
    if (m != null) return String(m);
  }
  return typeof body === 'string' ? body : 'no message';
}

export function mapGhlError(res: GhlHttpResponse): GhlSocialPlannerError {
  const msg = providerMessage(res.body);
  if (res.status === 401 || res.status === 403) {
    return new GhlSocialPlannerError('auth', `GoHighLevel rejected the credentials (${res.status}): ${msg}`, res.status);
  }
  if (res.status === 400 || res.status === 422) {
    return new GhlSocialPlannerError('validation', `GoHighLevel rejected the draft (${res.status}): ${msg}`, res.status);
  }
  if (res.status === 429) {
    const ra = Number(res.headers?.['retry-after']);
    return new GhlSocialPlannerError('rate_limited', `GoHighLevel rate limit hit: ${msg}`, 429, Number.isFinite(ra) ? ra : undefined);
  }
  if (res.status >= 500) {
    return new GhlSocialPlannerError('retryable', `GoHighLevel server error (${res.status}): ${msg}`, res.status);
  }
  return new GhlSocialPlannerError('unexpected', `Unexpected GoHighLevel response (${res.status}): ${msg}`, res.status);
}

function extractPost(body: unknown): Record<string, any> | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, any>;
  const post = b.results?.post ?? b.post ?? b.results ?? b;
  return post && typeof post === 'object' ? post : null;
}

export async function createSocialPlannerDraft(
  transport: GhlTransport,
  accessToken: string,
  input: CreateSocialPlannerDraftInput,
): Promise<SocialPlannerDraft> {
  if (!accessToken) throw new GhlSocialPlannerError('auth', 'No GoHighLevel access token; nothing was sent.');
  const req = buildDraftRequest(input, accessToken);
  let res: GhlHttpResponse;
  try {
    res = await transport(req);
  } catch (error) {
    throw new GhlSocialPlannerError('retryable', `GoHighLevel request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (res.status < 200 || res.status >= 300) throw mapGhlError(res);
  const post = extractPost(res.body);
  const rawId = post?._id ?? post?.id;
  const postId = typeof rawId === 'string' && rawId ? rawId : null;
  if (!postId) throw new GhlSocialPlannerError('unexpected', 'GoHighLevel accepted the request but returned no post id.', res.status);
  const returnedStatus = post?.status;
  if (returnedStatus !== undefined && returnedStatus !== 'draft') {
    throw new GhlSocialPlannerError('unexpected', `GoHighLevel returned status "${returnedStatus}" for post ${postId}, not draft.`, res.status);
  }
  return { postId, status: 'draft', raw: res.body };
}
