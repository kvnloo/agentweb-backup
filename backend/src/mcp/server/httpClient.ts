/**
 * MCP HTTP Client — generates short-lived JWTs and makes self-calls to the
 * backend REST API so every MCP tool goes through authenticateToken middleware.
 */

import jwt from 'jsonwebtoken';
import { Agent, setGlobalDispatcher } from 'undici';

// Longest timeoutMs any MCP tool passes to mcpFetch (see generate_landing_page /
// deploy_landing_page in apiTools.ts, which need headroom for v0 generation + GitHub +
// Vercel deploy). Tools should import and use this constant rather than hardcoding their
// own value, so the dispatcher timeouts below can never fall behind a per-call timeout.
export const MCP_MAX_CALL_TIMEOUT_MS = 25 * 60 * 1000; // 25 minutes

// Extend Node's built-in fetch timeouts. The default undici headersTimeout (300s) is too
// short for MCP tools that call slow endpoints. These MUST stay strictly greater than
// MCP_MAX_CALL_TIMEOUT_MS — otherwise undici kills the socket before mcpFetch's own
// AbortController fires, and the caller sees a generic "TypeError: fetch failed" instead
// of the intended timeout, even though the server-side handler keeps running to
// completion (this is a same-process self-call).
export const DISPATCHER_TIMEOUT_MS = MCP_MAX_CALL_TIMEOUT_MS + 5 * 60 * 1000; // 30 minutes
setGlobalDispatcher(new Agent({
  headersTimeout: DISPATCHER_TIMEOUT_MS,
  bodyTimeout: DISPATCHER_TIMEOUT_MS,
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
  context: { userId?: string; agentUserId?: string; isDelegatedAccess?: boolean };
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
  const secret = process.env.JWT_SECRET || 'your-secret-key';
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

  const controller = new AbortController();
  const effectiveTimeout = options.timeoutMs ?? 5 * 60 * 1000; // default 5 minutes
  const timeoutId = setTimeout(() => controller.abort(), effectiveTimeout);

  const fetchOptions: RequestInit = { method, headers, signal: controller.signal };
  if (body && method !== 'GET') {
    fetchOptions.body = JSON.stringify(body);
  }

  let response: Response;
  try {
    response = await fetch(url, fetchOptions);
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
