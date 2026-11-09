/**
 * ENG-481: admin-only lookup tools for audit/activity reporting.
 *
 * - get_session_transcript(session_id): message-level transcript of ONE chat
 *   session, via the existing admin route GET /api/admin/chat-sessions?sessionId=.
 * - get_user_by_id(user_id): profile/email for a raw userId, via the existing
 *   admin route GET /api/admin/users/:userId (sanitized; secret values stripped).
 *
 * Both are read-only wrappers over routes already behind authenticateToken +
 * isAdmin, so a non-admin caller is rejected server-side (403) regardless of how
 * the tool is reached. No new persistence, schema, or data-plane surface.
 */
import { mcpToolRegistry } from './registry';
import { mcpFetch } from './httpClient';
import { ctx, jsonResult } from './toolHelpers';

/** Per-message content cap so one huge tool payload can't blow the context. */
export const TRANSCRIPT_MESSAGE_CHAR_CAP = 4000;
/** Max messages returned per call; callers page with offset/nextOffset. */
export const TRANSCRIPT_PAGE_SIZE_MAX = 50;

const toText = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part: any) => (typeof part === 'string' ? part : part?.text ?? (part?.type ? `[${part.type}]` : '')))
      .filter(Boolean)
      .join('\n');
  }
  if (content == null) return '';
  try { return JSON.stringify(content); } catch { return String(content); }
};

mcpToolRegistry.register({
  name: 'get_session_transcript',
  definition: {
    name: 'get_session_transcript',
    description: `Get the message-level transcript of ONE chat session by session_id. Admin-only, read-only. Use with get_chat_history (which returns session ids and metadata but no messages) when an audit or activity report needs what was actually said. Each message's content is truncated to ${TRANSCRIPT_MESSAGE_CHAR_CAP} chars (truncated=true marks it). Returns at most ${TRANSCRIPT_PAGE_SIZE_MAX} messages per call; when hasMore=true call again with offset=nextOffset. Returns found=false when the session does not exist or has no user messages.`,
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'The chat session id (e.g. from get_chat_history).' },
        offset: { type: 'number', description: 'Index of the first message to return (default 0).' },
        limit: { type: 'number', description: `Messages to return (default and max ${TRANSCRIPT_PAGE_SIZE_MAX}).` },
      },
      required: ['session_id'],
    },
  },
  execute: async (args: any, context: any) => {
    const sessionId = typeof args?.session_id === 'string' ? args.session_id.trim() : '';
    if (!sessionId) return jsonResult({ error: 'session_id is required.' });
    const data: any = await mcpFetch({
      method: 'GET',
      path: `/api/admin/chat-sessions?sessionId=${encodeURIComponent(sessionId)}`,
      context: ctx(context),
    });
    const session = (data?.sessions || [])[0];
    if (!session) return jsonResult({ sessionId, found: false });
    const all: any[] = session.messages || [];
    const offset = Math.max(0, Math.floor(Number(args?.offset) || 0));
    const reqLimit = Math.floor(Number(args?.limit) || TRANSCRIPT_PAGE_SIZE_MAX);
    const limit = Math.min(TRANSCRIPT_PAGE_SIZE_MAX, Math.max(1, reqLimit));
    const page = all.slice(offset, offset + limit);
    const nextOffset = offset + page.length;
    const hasMore = nextOffset < all.length;
    const messages = page.map((m: any) => {
      const text = toText(m?.content);
      const truncated = text.length > TRANSCRIPT_MESSAGE_CHAR_CAP;
      return {
        role: m?.role,
        timestamp: m?.timestamp ?? m?.createdAt ?? null,
        model: m?.role === 'assistant' ? (m?.llm ?? null) : undefined,
        content: truncated ? text.slice(0, TRANSCRIPT_MESSAGE_CHAR_CAP) : text,
        ...(truncated ? { truncated: true, originalLength: text.length } : {}),
      };
    });
    return jsonResult({
      sessionId: session.sessionId ?? sessionId,
      found: true,
      userId: session.userId ?? null,
      title: session.title ?? null,
      createdAt: session.createdAt ?? null,
      updatedAt: session.updatedAt ?? null,
      messageCount: all.length,
      offset,
      returned: messages.length,
      hasMore,
      ...(hasMore ? { nextOffset } : {}),
      messages,
    });
  },
});

mcpToolRegistry.register({
  name: 'get_user_by_id',
  definition: {
    name: 'get_user_by_id',
    description: 'Resolve a raw userId (e.g. from get_chat_history) to that account\'s profile: email, displayName, roles, subscription, timestamps. Admin-only, read-only; secret values are never returned. Returns found=false for an unknown userId.',
    inputSchema: {
      type: 'object',
      properties: {
        user_id: { type: 'string', description: 'The internal userId to look up.' },
      },
      required: ['user_id'],
    },
  },
  execute: async (args: any, context: any) => {
    const userId = typeof args?.user_id === 'string' ? args.user_id.trim() : '';
    if (!userId) return jsonResult({ error: 'user_id is required.' });
    try {
      const user: any = await mcpFetch({
        method: 'GET',
        path: `/api/admin/users/${encodeURIComponent(userId)}`,
        context: ctx(context),
      });
      return jsonResult({
        found: true,
        userId: user?.userId ?? userId,
        email: user?.email ?? null,
        displayName: user?.displayName ?? user?.name ?? null,
        isAdmin: !!user?.isAdmin,
        isActive: user?.isActive !== false,
        subscriptionType: user?.subscriptionType ?? user?.subscription?.type ?? null,
        orgId: user?.orgId ?? user?.organizationId ?? null,
        createdAt: user?.createdAt ?? null,
        lastLogin: user?.lastLogin ?? null,
      });
    } catch (err: any) {
      const msg = String(err?.message || err);
      if (/^API error \(404\)/.test(msg)) return jsonResult({ userId, found: false });
      throw err;
    }
  },
});

mcpToolRegistry.register({
  name: 'inspect_client_usage',
  definition: {
    name: 'inspect_client_usage',
    description: "ENG-2771: a named client's effective usage allowance for the CURRENT month — billing owner, paused, gatedBy, used, limit, percentUsed, resetsOn, usagePolicyVersion — exactly as the usage enforcer decided it. Admin-only, read-only, internal: never relay the raw output to a customer-facing channel. Cannot change tiers, bonuses, or counters. Pass email or user_id.",
    inputSchema: {
      type: 'object',
      properties: {
        email: { type: 'string', description: 'Account email of the client.' },
        user_id: { type: 'string', description: 'Internal userId of the client (or an org member; resolved to the billing owner).' },
      },
    },
  },
  execute: async (args: any, context: any) => {
    const email = typeof args?.email === 'string' ? args.email.trim() : '';
    const userId = typeof args?.user_id === 'string' ? args.user_id.trim() : '';
    if (!email && !userId) return jsonResult({ error: 'email or user_id is required.' });
    const qs = userId ? `userId=${encodeURIComponent(userId)}` : `email=${encodeURIComponent(email)}`;
    try {
      const data: any = await mcpFetch({ method: 'GET', path: `/api/admin/usage/enforcement?${qs}`, context: ctx(context) });
      return jsonResult({ found: true, internalAdminOnly: true, ...data });
    } catch (err: any) {
      const msg = String(err?.message || err);
      if (/^API error \(404\)/.test(msg)) return jsonResult({ found: false, ...(userId ? { userId } : { email }) });
      throw err;
    }
  },
});
