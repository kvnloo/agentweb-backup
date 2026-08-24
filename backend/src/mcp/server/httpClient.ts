/**
 * MCP HTTP Client — generates short-lived JWTs and makes self-calls to the
 * backend REST API so every MCP tool goes through authenticateToken middleware.
 */

import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { getJwtSecret } from '../../config/jwt';
import { Agent, setGlobalDispatcher } from 'undici';
import { SCHEDULED_SESSION_HEADER } from '../../utils/scheduledPublishConsentGuard';

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
  context: { userId?: string; agentUserId?: string; isDelegatedAccess?: boolean; sessionId?: string };
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

export function generateSelfCallToken(user: UserRecord): string {
  const secret = getJwtSecret();
  return jwt.sign(
    { userId: user.userId, email: user.email, isAdmin: user.isAdmin, _svc: true },
    secret,
    { expiresIn: SELF_CALL_TOKEN_TTL }
  );
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
const SELF_CALL_MAX_ATTEMPTS = 3;
const SELF_CALL_RETRY_BASE_DELAY_MS = 200;

function isTransientNetworkError(error: unknown): boolean {
  return error instanceof TypeError && error.message === 'fetch failed';
}

async function fetchSelfCallWithRetry(url: string, fetchOptions: RequestInit, method: string, path: string): Promise<Response> {
  const correlationId = randomUUID();
  for (let attempt = 1; attempt <= SELF_CALL_MAX_ATTEMPTS; attempt++) {
    try {
      return await fetch(url, fetchOptions);
    } catch (error) {
      const cause: any = (error as any)?.cause;
      const detail = cause ? `${cause.code ? `${cause.code}: ` : ''}${cause.message || cause}` : (error as Error).message;

      if (!isTransientNetworkError(error) || attempt >= SELF_CALL_MAX_ATTEMPTS) {
        console.error(`[MCP self-call ${correlationId}] ${method} ${path} failed after ${attempt} attempt(s): ${detail}`);
        throw new Error(`MCP self-call ${method} ${path} failed after ${attempt} attempt(s) [correlationId=${correlationId}]: ${detail}`);
      }

      const backoffMs = SELF_CALL_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
      console.warn(`[MCP self-call ${correlationId}] ${method} ${path} network error on attempt ${attempt}/${SELF_CALL_MAX_ATTEMPTS}, retrying in ${backoffMs}ms: ${detail}`);
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }
  /* istanbul ignore next — loop always returns or throws */
  throw new Error(`MCP self-call ${method} ${path} failed: exhausted retries`);
}

export async function mcpFetch(options: McpFetchOptions): Promise<any> {
  const { method, path, context, body, queryParams } = options;

  const userId = context.userId || context.agentUserId;
  if (!userId) {
    throw new Error('Authentication required: no userId in context');
  }

  const user = await lookupUser(userId);
  // When called via admin delegated access, mint the token with isAdmin:true so
  // admin REST routes (requireAdmin middleware) accept the self-call.
  const tokenUser = context.isDelegatedAccess ? { ...user, isAdmin: true } : user;
  const token = generateSelfCallToken(tokenUser);

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
    const message = typeof data === 'object' ? (data.message || data.error || JSON.stringify(data)) : data;
    throw new Error(`API error (${response.status}): ${message}`);
  }

  return data;
}

/** Clear user cache (useful for testing) */
export function clearUserCache(): void {
  userCache.clear();
}
