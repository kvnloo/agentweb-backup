/**
 * ENG-1816 F1 — decideFallback: signature and one invariant only. Not wired into any
 * path yet; A4 does the real wiring (invalid/revoked key, provider quota, outage) and
 * B4 reuses it for subscription failures.
 */
import type { RunFunding } from "./runFunding";

/**
 * A deliberately small, funding-specific taxonomy — not the same set as
 * `classifyToolErrorClass` (tool-call failures), though the literal names overlap
 * where the underlying cause is the same (`quota_exceeded`, `network`). A4 maps
 * provider/transport errors onto this set; it should not import
 * `classifyToolErrorClass`'s untyped string return as-is.
 */
export type FundingErrorClass =
  | "invalid_credential"
  | "revoked_credential"
  | "quota_exceeded"
  | "provider_outage"
  | "network"
  | "unknown";

export type FallbackDecision = "retry" | "switch_to_agentweb" | "stop";

/**
 * Ticket rule, load-bearing: never let a subscription-only run silently become
 * AgentWeb-paid, including on rollback. `runFunding.fallback === 'stop'` is the
 * user's own strict choice — no error class may override it.
 */
export function decideFallback(_errorClass: FundingErrorClass, runFunding: RunFunding): FallbackDecision {
  if (runFunding.fallback === "stop") {
    return "stop";
  }
  // A4 fills in the real per-error-class policy. Until then, a non-`stop` run with no
  // wired policy also stops rather than guessing — F1 must not invent fallback
  // behavior that hasn't been reviewed.
  return "stop";
}
