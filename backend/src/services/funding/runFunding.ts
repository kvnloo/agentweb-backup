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

export type FundingRoute = "agentweb" | "api_key" | "claude_subscription" | "codex_subscription";

export interface RunFunding {
  route: FundingRoute;
  connectionId?: string;
  provider?: string;
  fallback: "stop" | "agentweb";
  ownerUserId: string;
  billingUserId: string;
  /**
   * The account whose provider credential pays for this run's calls: the owner of
   * `connectionId`. It differs from `ownerUserId` (the person running the turn) when an
   * org owner has shared a key with the org. Set by whatever resolves the connection
   * (A2); until then usage falls back to `ownerUserId`.
   */
  fundingPrincipalId?: string;
  /** `claude_subscription` only: the credential epoch of the connection this run was admitted under (the host fences on it). */
  hostEpoch?: number;
  /** `claude_subscription` only: the CLI model alias the plan runs (haiku|sonnet|opus|fable). */
  planModel?: string;
  /** Names the run these calls belong to, e.g. "claude_plan:<runId>": the explicit AgentWeb scope of a plan turn's tool-internal calls. Carried for attribution; the AgentWeb meter does not record it yet. */
  runLabel?: string;
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
  // Lazy require, not a top-level import: `fundingFlags.ts` pulls in `settingsService.ts`,
  // which constructs a real AWS.DynamoDB.DocumentClient at module-load time. A top-level
  // import here would make merely importing `currentRunFunding`/`withRunFunding` — used
  // pervasively across files that have nothing to do with AWS (blog.ts, chatbotService.ts)
  // — eagerly load the AWS SDK graph. This broke `blog.test.ts`, which specifically avoids
  // an AWS SDK mock because `generateBlogContent` already lazy-imports settingsService for
  // exactly this reason. Same idiom as `deferredBillingMetering.ts`'s lazy tokenUsageService
  // require ("pulls in the db -> aws config graph").
  const { getFundingFlags } = require("./fundingFlags") as typeof import("./fundingFlags");
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

const seenUnsetRunFundingSites = new Set<string>();

/**
 * Greppable marker for call sites outside any `withRunFunding` scope. Log-only,
 * fire-and-forget, never throws — this is a discovery aid for A2+/B4+, not an
 * enforcement mechanism.
 *
 * Logs once per unique `where`, not once per call — `callLLM` is reached by
 * ~20+ unrelated files (crons, CRM enrichment, etc.) with nothing to do with
 * agent-mode chat turns, and logging on every one of their calls would spam a
 * warning on a large fraction of the backend's total LLM traffic.
 *
 * KNOWN LIMITATION (round-4 PR review): `where` is passed per CALLING FUNCTION
 * (`recordLlmUsage`, `generateMarketingResponseWorker`), not per ultimate
 * caller — in production there are exactly 2 distinct `where` values ever
 * logged, no matter how many different unwrapped features reach them. This
 * mechanism proved it could NOT be relied on to discover new gaps: it never
 * flagged GrowthGenius or Live Voice, both real unwrapped entry points found
 * only by manual review, because whichever surface hits `callLLM` first after
 * boot consumes the one `'agentModeService.callLLM'` slot forever. Treat this
 * as "at least one unwrapped path exists somewhere" at best, never as "no log
 * means no gap" — the entry-point inventory must be maintained by hand (see
 * the KNOWN GAP comment in `agentModeController.ts`), not discovered here.
 */
export function noteRunFundingUnset(where: string): void {
  if (seenUnsetRunFundingSites.has(where)) return;
  seenUnsetRunFundingSites.add(where);
  console.warn(`[RunFunding] UNSET at ${where} — treated as agentweb (logged once per call site)`);
}

/** Test hook: reset the unset-call-site set between test cases. */
export function __resetRunFundingUnsetCountForTests(): void {
  seenUnsetRunFundingSites.clear();
}

/** Test hook: read how many distinct unwrapped call sites have fired. */
export function __getRunFundingUnsetCountForTests(): number {
  return seenUnsetRunFundingSites.size;
}
