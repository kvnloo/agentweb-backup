/**
 * MCP HTTP Client — generates short-lived JWTs and makes self-calls to the
 * backend REST API so every MCP tool goes through authenticateToken middleware.
 */

import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { getJwtSecret } from '../../config/jwt';
import { Agent, setGlobalDispatcher } from 'undici';
import { SCHEDULED_SESSION_HEADER } from '../../utils/scheduledPublishConsentGuard';
import { normalizeRestrictionClaim, type RestrictionProfileId } from '../../services/toolRestrictionProfiles';

// Extend Node's built-in fetch timeouts. The default undici headersTimeout (300s)
// is too short for MCP tools that call slow endpoints (e.g. generate_landing_page
// calls v0 API which can take 2-5 min).
setGlobalDispatcher(new Agent({
  headersTimeout: 15 * 60 * 1000,  // 15 minutes
  bodyTimeout: 15 * 60 * 1000,     // 15 minutes
  connectTimeout: 30 * 1000,       // 30 seconds
}));

// ─── Types ──────────────────────────────────────────────────────────────────

interface UserRecord {
  userId: string;
  email: string;
  isAdmin: boolean;
}

interface McpFetchOptions {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  context: {
    userId?: string;
    agentUserId?: string;
    isDelegatedAccess?: boolean;
    sessionId?: string;
    /**
     * ENG-2816 (step 3): the restriction the caller acts under (see ctx() in toolHelpers.ts). Signed into the self-call token as
     * the `_rp` claim, so the route this call lands on can tell a share-link visitor's write from the owner's own.
     */
    restrictionProfile?: string;
    /**
     * A pre-minted JWT to use as the Bearer token instead of self-call token
     * generation (ENG-1596). Set by adminClientScope.ts's
     * `resolveClientScopedContext` when an admin tool call is scoped to a
     * different client via `client_id` — the token already carries that
     * client's identity, so no self-call minting is needed here.
     */
    overrideToken?: string;
  };
  body?: Record<string, unknown>;
  queryParams?: Record<string, string>;
  /** Override the default 5-minute timeout (in ms). Use for long-running calls like v0 generation. */
  timeoutMs?: number;
}

// ─── User cache (per-process, cleared on restart) ───────────────────────────

const userCache = new Map<string, { record: UserRecord; expiresAt: number }>();
const USER_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function lookupUser(userId: string): Promise<UserRecord> {
  const cached = userCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.record;
  }

  const { userDb } = await import('../../services/db');
  const user = await userDb.getUserById(userId);
  if (!user) {
    throw new Error(`User not found: ${userId}`);
  }

  const record: UserRecord = {
    userId: user.userId,
    email: user.email,
    isAdmin: user.isAdmin || false,
  };

  userCache.set(userId, { record, expiresAt: Date.now() + USER_CACHE_TTL_MS });
  return record;
}

// ─── JWT generation ─────────────────────────────────────────────────────────

const SELF_CALL_TOKEN_TTL = 600; // seconds — must outlast slow operations like v0 generation

export function generateSelfCallToken(user: UserRecord, restrictionProfile?: RestrictionProfileId): string {
  const secret = getJwtSecret();
  return jwt.sign(
    // `_rp` only when there is a restriction: an unrestricted caller's token is byte-for-byte what it always was.
    { userId: user.userId, email: user.email, isAdmin: user.isAdmin, _svc: true, ...(restrictionProfile ? { _rp: restrictionProfile } : {}) },
    secret,
    { expiresIn: SELF_CALL_TOKEN_TTL }
  );
}

/**
 * ENG-2816 (step 3): a self-call that reaches a schedule or schedule-template WRITE route. Such a call must carry the caller's
 * restriction claim, because the route decides from it whether the write is a share-link visitor's (and so marks the schedule).
 */
function isScheduleWriteCall(method: string, path: string): boolean {
  if (method === 'GET') return false;
  const pathname = String(path).split('?')[0];
  return pathname.startsWith('/api/agent-mode/scheduled-chats') || pathname.startsWith('/api/agent-mode/schedule-templates');
}

// ─── HTTP self-call helper ──────────────────────────────────────────────────

function getBaseUrl(): string {
  const port = process.env.PORT || '3001';
  return `http://localhost:${port}`;
}

// ─── Network-error retry ────────────────────────────────────────────────────
//
// A self-call that fails before it ever reaches the route (connection refused/reset,
// DNS lookup failure, etc. — e.g. because the backend process was mid-restart) makes
// Node's fetch throw `TypeError: fetch failed`, which used to propagate to the LLM
// verbatim via mcpServerCore's `Error: ${error.message}` with no endpoint, no cause,
// and no retry (ENG-1189: manage_scheduled_chat failed 3 times this way in one session,
// each time surfacing only the bare string "fetch failed"). A genuine request timeout
// aborts with a distinct `AbortError`, not this TypeError, so retrying only this case
// cannot mask a real timeout.
//
// Retries are gated to GET and PUT: both are safe to repeat by HTTP semantics
// (GET has no side effect, PUT replaces state so re-sending the same body is a
// no-op). POST/PATCH/DELETE self-calls (task execute, scheduled-chats/leads
// create, toggle, etc.) are NOT retried — the error may have occurred after the
// server already processed the request (e.g. ECONNRESET while reading the
// response), and retrying a non-idempotent call risks silently duplicating it.
const SELF_CALL_MAX_ATTEMPTS = 3;
const SELF_CALL_RETRY_BASE_DELAY_MS = 200;
const SELF_CALL_RETRYABLE_METHODS = new Set(['GET', 'PUT']);

function isTransientNetworkError(error: unknown): boolean {
  return error instanceof TypeError && error.message === 'fetch failed';
}

async function fetchSelfCallWithRetry(url: string, fetchOptions: RequestInit, method: string, path: string): Promise<Response> {
  const correlationId = randomUUID();
  const maxAttempts = SELF_CALL_RETRYABLE_METHODS.has(method) ? SELF_CALL_MAX_ATTEMPTS : 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fetch(url, fetchOptions);
    } catch (error) {
      const cause: any = (error as any)?.cause;
      const detail = cause ? `${cause.code ? `${cause.code}: ` : ''}${cause.message || cause}` : (error as Error).message;

      if (!isTransientNetworkError(error) || attempt >= maxAttempts) {
        console.error(`[MCP self-call ${correlationId}] ${method} ${path} failed after ${attempt} attempt(s): ${detail}`);
        throw new Error(`MCP self-call ${method} ${path} failed after ${attempt} attempt(s) [correlationId=${correlationId}]: ${detail}`);
      }

      const backoffMs = SELF_CALL_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
      console.warn(`[MCP self-call ${correlationId}] ${method} ${path} network error on attempt ${attempt}/${maxAttempts}, retrying in ${backoffMs}ms: ${detail}`);
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }
  /* istanbul ignore next — loop always returns or throws */
  throw new Error(`MCP self-call ${method} ${path} failed: exhausted retries`);
}

/**
 * ENG-2963: a self-call's path is built from tool arguments, which an outside MCP caller controls. A value such as
 * `../agent-mode/sessions?` used to turn `/api/tasks/${task_id}/execute` into a call to a different route. Tools escape their
 * arguments (encodeURIComponent); this is the shared backstop, so a tool that forgets cannot be steered: the path part (before
 * any `?`) must start with `/api/` and may not contain a dot segment, an empty segment or a percent-encoded dot (`%2e`, which URL
 * normalisation turns into a dot segment); and no raw backslash, `#` or control character may appear anywhere, query included.
 * An escaped slash (`%2F`) is allowed: Express keeps it inside one path parameter, and ids with slashes (file keys) need it.
 */
export function assertSafeSelfCallPath(path: string): void {
  const pathname = String(path).split('?')[0];
  const segments = pathname.split('/').slice(1);
  const unsafe =
    !pathname.startsWith('/api/') ||
    /[\\#\u0000-\u001f\u007f]/.test(String(path)) ||
    /%2e/i.test(pathname) ||
    segments.some((segment, i) => segment === '.' || segment === '..' || (segment === '' && i < segments.length - 1));
  if (unsafe) {
    throw new Error('Invalid request: an id in this call contains characters that are not allowed. Nothing was sent.');
  }
}

/**
 * Make an authenticated self-call to the backend REST API on behalf of an MCP
 * tool. Mints a short-lived self-call JWT for `context.userId`/`agentUserId`
 * unless `context.overrideToken` is already set (ENG-1596: a client-scoped
 * call that already carries a pre-minted delegate token for the target
 * client), in which case that token is used as-is.
 */
export async function mcpFetch(options: McpFetchOptions): Promise<any> {
  const { method, path, context, body, queryParams } = options;
  assertSafeSelfCallPath(path);

  // ENG-2816 (step 3): normalised once. A claim that is present but unknown reads as the strictest profile, never as none.
  const restrictionProfile = normalizeRestrictionClaim(context.restrictionProfile);

  let token: string;
  if (context.overrideToken) {
    // ENG-1596: a client-scoped call already carries a fully-formed delegate
    // token for the target client — skip self-call minting entirely.
    //
    // ENG-2816 (step 3): that token is not a self-call token, so it cannot carry the restriction claim, and a schedule write that
    // arrives without it would read as the owner's. Today only read tools mint one (list_scheduled_chats and friends, GET), so
    // no schedule write travels this way; if a restricted caller ever tries, refuse rather than let the claim be lost.
    if (restrictionProfile && isScheduleWriteCall(method, path)) {
      throw new Error('Not allowed: a restricted caller cannot change schedules on another account\'s behalf. Nothing was changed.');
    }
    token = context.overrideToken;
  } else {
    const userId = context.userId || context.agentUserId;
    if (!userId) {
      throw new Error('Authentication required: no userId in context');
    }

    const user = await lookupUser(userId);
    // When called via admin delegated access, mint the token with isAdmin:true so
    // admin REST routes (requireAdmin middleware) accept the self-call.
    const tokenUser = context.isDelegatedAccess ? { ...user, isAdmin: true } : user;
    token = generateSelfCallToken(tokenUser, restrictionProfile);
  }

  // Build URL with query params
  let url = `${getBaseUrl()}${path}`;
  if (queryParams) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(queryParams)) {
      if (value !== undefined && value !== null && value !== '') {
        params.append(key, value);
      }
    }
    const qs = params.toString();
    if (qs) url += `?${qs}`;
  }

  const headers: Record<string, string> = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    // Lets routes attribute the request to the agent channel (vs portal UI)
    // for lifecycle telemetry — see services/landerLifecycleEvents.ts.
    'X-AgentWeb-Channel': 'agent',
  };

  // ENG-827: carries the scheduled run's identity to the route so it can re-check
  // publish consent against live state at its own last moment. Absent for ordinary
  // interactive calls, which are not gated.
  if (context.sessionId) {
    headers[SCHEDULED_SESSION_HEADER] = String(context.sessionId);
  }

  const controller = new AbortController();
  const effectiveTimeout = options.timeoutMs ?? 5 * 60 * 1000; // default 5 minutes
  const timeoutId = setTimeout(() => controller.abort(), effectiveTimeout);

  const fetchOptions: RequestInit = { method, headers, signal: controller.signal };
  if (body && method !== 'GET') {
    fetchOptions.body = JSON.stringify(body);
  }

  let response: Response;
  try {
    response = await fetchSelfCallWithRetry(url, fetchOptions, method, path);
  } finally {
    clearTimeout(timeoutId);
  }

  // Parse response
  const contentType = response.headers.get('content-type') || '';
  let data: any;
  if (contentType.includes('application/json')) {
    data = await response.json();
  } else {
    data = await response.text();
  }

  if (!response.ok) {
    const restarting = data && typeof data === 'object' && data.code === 'SERVER_RESTARTING';
    const message = restarting
      ? 'The server is restarting. The message may have been saved. Check the session before retrying to avoid duplicate messages.'
      : typeof data === 'object' ? (data.message || data.error || JSON.stringify(data)) : data;
    const err = new Error(`API error (${response.status}): ${message}`);
    // Routes sometimes emit BOTH a human `message` (which wins above, and is
    // what a real UI would show) and a stable machine-readable `error` code —
    // e.g. `missing_brand_logo`. That code is otherwise lost the moment
    // `message` wins the `||` above. Preserve it separately so
    // classifyToolErrorClass can key off the stable code instead of matching
    // prose that was never meant to be a classification target (ENG-1844).
    if (typeof data === 'object' && typeof data.error === 'string' && data.error !== message) {
      (err as { code?: string }).code = data.error;
    }
    // A route's structured `details` (e.g. which Smartlead connections the caller may choose between) would otherwise be lost.
    if (data && typeof data === 'object' && data.details !== undefined) {
      (err as { details?: unknown }).details = data.details;
    }
    throw err;
  }

  return data;
}

/** Clear user cache (useful for testing) */
export function clearUserCache(): void {
  userCache.clear();
}
