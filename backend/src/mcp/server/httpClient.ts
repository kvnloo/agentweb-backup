/**
 * MCP HTTP Client — generates short-lived JWTs and makes self-calls to the
 * backend REST API so every MCP tool goes through authenticateToken middleware.
 */

import jwt from 'jsonwebtoken';

// ─── Types ──────────────────────────────────────────────────────────────────

interface UserRecord {
  userId: string;
  email: string;
  isAdmin: boolean;
}

interface McpFetchOptions {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  context: { userId?: string; agentUserId?: string };
  body?: Record<string, unknown>;
  queryParams?: Record<string, string>;
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
    { userId: user.userId, email: user.email, isAdmin: user.isAdmin },
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
  const token = generateSelfCallToken(user);

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
  };

  const controller = new AbortController();
  const timeoutMs = 5 * 60 * 1000; // 5 minutes — v0 generation + deploy can take several minutes
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

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
