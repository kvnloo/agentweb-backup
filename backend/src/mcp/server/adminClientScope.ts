/**
 * ENG-1596: lets an admin-facing MCP tool call operate against a specific
 * client's account instead of the caller's own, by minting the exact same
 * kind of delegate-access token routes/admin.ts already mints for the
 * customer-portal "delegate access" UI flow — just internally, per tool call,
 * with no browser session involved. Every downstream REST route already
 * trusts `req.user.userId` however it was set (see middleware/auth.ts's
 * `decoded.delegateAccess` branch), so this requires zero route changes.
 */

import { ctx } from './toolHelpers';

// Used once inside a single self-call and discarded — no reason for this to
// outlive the HTTP round-trip it was minted for, unlike the real delegate-access
// route's token (DELEGATE_TOKEN_TTL, default 8h) which has to survive an entire
// browser session.
const CLIENT_SCOPE_TOKEN_TTL_SECONDS = 300;

interface ClientScopedContext {
  userId?: string;
  agentUserId?: string;
  isDelegatedAccess?: boolean;
  sessionId?: string;
  overrideToken?: string;
}

/**
 * Resolve an MCP tool's execution context, optionally re-pointed at a specific
 * client via `clientId` (an email or userId). Admin-only: throws loudly rather
 * than silently falling back to the caller's own data when the caller isn't a
 * real admin, or when `clientId` doesn't resolve to a real customer account.
 */
export async function resolveClientScopedContext(context: any, clientId: unknown): Promise<ClientScopedContext> {
  const base = ctx(context);
  if (typeof clientId !== 'string' || !clientId.trim()) {
    return base;
  }

  const callerId = context?.userId || context?.agentUserId;
  if (!callerId) {
    throw new Error('client_id requires an authenticated caller.');
  }

  const { userDb } = await import('../../services/db');
  const caller = await userDb.getUserById(callerId);
  if (!caller?.isAdmin) {
    throw new Error('client_id is admin-only — this account is not an admin.');
  }

  const trimmedClientId = clientId.trim();
  const target = trimmedClientId.includes('@')
    ? await userDb.getUserByEmail(trimmedClientId)
    : await userDb.getUserById(trimmedClientId);
  if (!target) {
    throw new Error(`No client account found for "${trimmedClientId}".`);
  }
  if (!target.roles?.includes('customer')) {
    throw new Error(`"${trimmedClientId}" does not have customer portal access — cannot scope to it.`);
  }

  const { mintDelegateToken } = await import('../../services/delegateAccessToken');
  const overrideToken = mintDelegateToken(
    { userId: caller.userId, email: caller.email },
    target,
    CLIENT_SCOPE_TOKEN_TTL_SECONDS,
  );

  return { ...base, overrideToken };
}
