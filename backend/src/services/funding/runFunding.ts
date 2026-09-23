/**
 * ENG-1816 F1 — RunFunding: the funding decision for one run, resolved once at run
 * entry and carried ambient for the rest of that run's async call graph.
 *
 * Carried across the worker fork as plain data on `GenerateMarketingResponseParams`
 * (the ENG-827 `publishAuthorizationOverride` precedent) rather than as a positional
 * argument — `generateSessionResponse` already has ~20 positional parameters, so this
 * cannot be a 21st. Inside each process it is ambient via AsyncLocalStorage (the
 * `twitterService.ts` `xActingUserStore` precedent), because the fork worker
 * multiplexes many customers over one IPC channel (`pendingRequests` /
 * `sessionToRequestId` maps) — a module-level global would leak one customer's
 * funding onto another customer's concurrent turn.
 *
 * F1 always resolves `route: 'agentweb'`. There is no connection kind or transport to
 * route to yet — A1 adds the connection store, A2/B3 add the transports that make a
 * non-agentweb route meaningful. This function is the one place later tickets extend.
 */
import { AsyncLocalStorage } from "async_hooks";
import { getFundingFlags } from "./fundingFlags";

export type FundingRoute = "agentweb" | "api_key" | "claude_subscription" | "codex_subscription";

export interface RunFunding {
  route: FundingRoute;
  connectionId?: string;
  provider?: string;
  fallback: "stop" | "agentweb";
  ownerUserId: string;
  billingUserId: string;
  resolvedAt: string;
}

export interface ResolveRunFundingInput {
  userId: string;
  sessionId?: string;
}

const runFundingStore = new AsyncLocalStorage<RunFunding>();

/**
 * Resolved once per run at every entry point (interactive, scheduled, work-plan,
 * API/MCP, Slack/email) — in practice, once at the single choke point where each of
 * those paths converges on `generateSessionResponse` before crossing the worker fork.
 *
 * `billingUserId` is set equal to `ownerUserId` for now: nothing reads it for a real
 * billing decision yet (route is always `agentweb`), so resolving it via the async
 * org-billing-subject lookup here would be an unnecessary DB read on every turn for no
 * behavioral benefit. A3 should revisit this once a customer-funded branch actually
 * needs the true billing subject.
 */
export async function resolveRunFunding({ userId }: ResolveRunFundingInput): Promise<RunFunding> {
  // Read the flags so the fallback path is exercised and covered by tests, even though
  // F1 cannot yet act on a non-agentweb result (no connection kind exists to route to).
  await getFundingFlags();

  return {
    route: "agentweb",
    fallback: "agentweb",
    ownerUserId: userId,
    billingUserId: userId,
    resolvedAt: new Date().toISOString(),
  };
}

/** Enters the ambient store for the duration of `fn`. Call once, at the worker's IPC boundary. */
export function withRunFunding<T>(runFunding: RunFunding, fn: () => T): T {
  return runFundingStore.run(runFunding, fn);
}

/**
 * Reads the ambient funding for the current async context. `undefined` outside a run
 * (crons, admin scripts, a call site not yet wrapped by `withRunFunding`) — callers
 * must treat that the same as `route: 'agentweb'` (today's behavior), never fail
 * closed, but should count it via `noteRunFundingUnset()` so unwrapped paths are
 * discoverable before a customer route depends on them.
 */
export function currentRunFunding(): RunFunding | undefined {
  return runFundingStore.getStore();
}

let unsetRunFundingCount = 0;

/**
 * Greppable marker for call sites outside any `withRunFunding` scope. Log-only,
 * fire-and-forget, never throws — this is a discovery aid for A2+/B4+, not an
 * enforcement mechanism.
 */
export function noteRunFundingUnset(where: string): void {
  unsetRunFundingCount += 1;
  console.warn(`[RunFunding] UNSET at ${where} (count=${unsetRunFundingCount}) — treated as agentweb`);
}

/** Test hook: reset the unset-call-site counter between test cases. */
export function __resetRunFundingUnsetCountForTests(): void {
  unsetRunFundingCount = 0;
}

/** Test hook: read the unset-call-site counter. */
export function __getRunFundingUnsetCountForTests(): number {
  return unsetRunFundingCount;
}
