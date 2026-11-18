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
  /** ENG-2816 (step 3): the caller's restriction, carried through from ctx() so mcpFetch can sign it into the self-call token. */
  restrictionProfile?: string;
  overrideToken?: string;
  /** ENG-1557: populated only on a successful client_id resolution, so a
   * write-capable caller (manage_leads action:add) can build its own audit
   * trail / dry-run preview against the resolved identities without a second
   * redundant userDb lookup. */
  resolvedScope?: {
    caller: { userId: string; email: string };
    target: { userId: string; email: string };
  };
}

/**
 * Resolve an MCP tool's execution context, optionally re-pointed at a specific
 * client via `clientId` (an email or userId). Admin-only: throws loudly rather
 * than silently falling back to the caller's own data when the caller isn't a
 * real admin, or when `clientId` doesn't resolve to a real customer account.
 *
 * `toolName` identifies the calling tool for the audit trail (ENG-1557 area
 * #3) — every successful scope resolution is a real admin looking at (never
 * yet mutating — writes are out of scope pending ENG-1557's authorization
 * contract) a specific customer's data, and that needs a record of who did
 * it, to whom, via which tool, same as the existing admin cross-account audit
 * trail (adminAuditLog.ts, ENG-721).
 */
export async function resolveClientScopedContext(context: any, clientId: unknown, toolName: string): Promise<ClientScopedContext> {
  const base = ctx(context);
  // Omitted (undefined/null) means "no scoping requested" — pass through
  // unscoped, same as always. Anything else PRESENT — a non-string value
  // (caller mistake) or a blank/whitespace-only string (CodeRabbit, PR #2651:
  // "client_id: '   '" was silently treated the same as omitted) — must not
  // silently degrade to the same "unscoped" outcome: that would run the call
  // as the admin's own identity while looking, to the caller, like their
  // client_id was honored.
  if (clientId === undefined || clientId === null) {
    return base;
  }
  if (typeof clientId !== 'string' || !clientId.trim()) {
    throw new Error(
      `client_id must be a non-blank string (email or userId); received ${typeof clientId === 'string' ? 'a blank string' : typeof clientId}.`
    );
  }

  // CodeRabbit (PR #2651): prefer agentUserId, per dev.md's stated convention —
  // "External clients (API keys, OAuth) always use the authenticated
  // agentUserId" (the ENG-… IDOR fix in mcpServerCore.ts). For the calls this
  // gate actually sees today the two fields already coincide (mcpServerCore.ts
  // sets both to the same value for external callers; the in-app dispatch never
  // sets agentUserId at all, so it falls through to userId either way) — this
  // is defense-in-depth: identity resolution for an admin-privilege check
  // should read the same authoritative field the rest of the codebase does,
  // not happen to agree with it by coincidence.
  const callerId = context?.agentUserId || context?.userId;
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

  const { recordAdminAudit } = await import('../../services/adminAuditLog');
  recordAdminAudit({
    actorUserId: caller.userId,
    actorEmail: caller.email,
    action: 'mcp_client_id_scope',
    tool: toolName,
    targetUserId: target.userId,
    targetEmail: target.email,
  });

  return {
    ...base,
    overrideToken,
    resolvedScope: {
      caller: { userId: caller.userId, email: caller.email },
      target: { userId: target.userId, email: target.email },
    },
  };
}
