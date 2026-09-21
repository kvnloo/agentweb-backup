/**
 * Lazy auth for the MCP transport (ENG-984).
 *
 * Auth was mandatory on every request, so a prospect who added the connector
 * could not see what Emma does without already having an account. That is a
 * hard stop at the top of the funnel: time-to-first-value is infinite for
 * anyone who has not signed up.
 *
 * The 2026 pattern is lazy auth — `initialize` and `tools/list` succeed with no
 * credentials, and the first PROTECTED call returns the `401 +
 * WWW-Authenticate` challenge that a compliant client turns into an inline
 * Connect card. That challenge is the signup (ENG-985).
 *
 * ── Why the allowlist lives here, at the transport ──────────────────────────
 *
 * ENG-822 already refuses account-scoped tools inside `registry.execute()` via
 * `requiresUserAccount`. That guard is good, but it is the WRONG place to rely
 * on for this: it is per-tool metadata, so a tool that simply forgets the flag
 * becomes anonymously callable. Defaulting to "reachable unless someone
 * remembered to mark it" is how the quota hole in ENG-973 happened — 59 routes
 * accreted past a gate nobody re-applied.
 *
 * So the door is an explicit allowlist checked BEFORE dispatch. Anything not
 * named here never reaches a handler at all, and adding a tool cannot make it
 * anonymously reachable by omission.
 */

import { randomUUID } from 'crypto';

/** Rollback without a redeploy (ENG-984 AC6): unset or non-'true' = OFF. */
export const MCP_ANONYMOUS_FLAG = 'MCP_ANONYMOUS_DISCOVERY';

export function isAnonymousDiscoveryEnabled(): boolean {
  return process.env[MCP_ANONYMOUS_FLAG] === 'true';
}

/**
 * JSON-RPC methods a stranger may call. Discovery only — none of these touch
 * user data, spend money, or perform an outbound action.
 */
const ANONYMOUS_METHODS: ReadonlySet<string> = new Set([
  'initialize',
  'notifications/initialized',
  'ping',
  'tools/list',
]);

/**
 * Tools a stranger may EXECUTE.
 *
 * Deliberately empty. Harsha's call (2026-08-08) is list + one free demo tool,
 * and the demo tool is not shipped here: it takes a caller-supplied URL, so it
 * needs SSRF protection (no private ranges, no redirects into them) plus a
 * per-IP rate limit and a global daily ceiling. That is its own change and its
 * own review — bolting it onto a transport-auth PR is how one of those gets
 * skimmed. Until it lands, anonymous callers can look but not run.
 */
export const ANONYMOUS_TOOLS: ReadonlySet<string> = new Set<string>();

/**
 * May this request body proceed with no credentials?
 *
 * Fails closed on every ambiguity: a non-array/non-object body, an empty batch,
 * a missing or non-string method, an unknown method, or a `tools/call` naming
 * anything outside ANONYMOUS_TOOLS. A batch is permitted only if EVERY entry is
 * permitted, so a protected call cannot ride along beside a discovery one.
 */
export function isAnonymouslyPermitted(body: unknown): boolean {
  const entries = Array.isArray(body) ? body : [body];
  if (entries.length === 0) return false;

  return entries.every(entry => {
    if (!entry || typeof entry !== 'object') return false;
    const method = (entry as { method?: unknown }).method;
    if (typeof method !== 'string') return false;

    if (method === 'tools/call') {
      const name = (entry as { params?: { name?: unknown } }).params?.name;
      return typeof name === 'string' && ANONYMOUS_TOOLS.has(name);
    }

    return ANONYMOUS_METHODS.has(method);
  });
}

/**
 * Anonymous callers get an `anon_` id so ENG-822's existing predicate
 * (`isAnonymousUserId`) recognises them as a second line of defence. They are
 * never given a real account id, so the IDOR control in mcpServerCore has
 * nothing to override.
 */
export function newAnonymousUserId(): string {
  return `anon_${randomUUID()}`;
}

/**
 * The anonymous principal for a request, STABLE across the life of a session.
 *
 * Minting a fresh id per request looks harmless and is not: `mcpServer` records
 * the owning principal when a session is created and, on any later request,
 * compares the caller against it (`ownsSession`). A per-request id never
 * matches, so the second call in an anonymous session — or the first one served
 * by another instance after rehydration — is rejected as not-owned and the
 * client is told to reinitialise, forever.
 *
 * Deriving it from the MCP session id makes it deterministic for that session
 * on every instance, with no shared state.
 *
 * It cannot be used to reach an authenticated session: those store a real
 * account id, and `anon_<sessionId>` never equals one. And this path only runs
 * when there is no Authorization header at all, so it can never downgrade a
 * credentialed request.
 */
export function anonymousUserIdForSession(sessionId: unknown): string {
  return typeof sessionId === 'string' && sessionId.length > 0
    ? `anon_${sessionId}`
    : newAnonymousUserId();
}
