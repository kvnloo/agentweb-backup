/**
 * ENG-2113 (PR B): which bridge calls are "strict" for the repeat guard: an identical
 * call after completion, in the same turn, returns the original outcome instead of
 * running again.
 *
 * Emma's policy classifier (`evaluateAgentToolPolicy`) labels most tools by name, but the
 * `call_*` API tools carry their effect in their arguments and it returns `unknown` for
 * some of them. Each one that exists is listed here with an explicit rule, and a test
 * fails when a `call_*` tool in the code base is missing from the table.
 */

import { evaluateAgentToolPolicy } from "../agentToolGatewayService";

/** Effects whose repeat must not run twice: externally visible, irreversible or administrative. */
const STRICT_EFFECTS = new Set(["external_send", "external_publish", "destructive", "admin"]);

export type CallToolRule =
  /** Always strict: the action cannot be read from the arguments, so any identical repeat returns the original. */
  | "strict"
  /** Classified from the real arguments by Emma's policy (HubSpot, Attio). */
  | "by_args"
  /** Reads only. */
  | "read";

export const CALL_TOOL_RULES: Readonly<Record<string, CallToolRule>> = Object.freeze({
  call_meta_marketing_api: "strict",
  call_google_ads_api: "strict",
  call_linkedin_marketing_api: "strict",
  call_ads: "strict",
  call_hubspot_api: "by_args",
  call_attio_api: "by_args",
  call_meta_ads_insights_api: "read",
  call_google_ads_reporting_api: "read",
  call_linkedin_ads_insights_api: "read",
});

export function isStrictRepeatEffect(toolName: string, args: Record<string, unknown>): boolean {
  const rule = CALL_TOOL_RULES[toolName];
  if (rule === "strict") return true;
  if (rule === "read") return false;
  if (toolName.startsWith("call_") && rule === undefined) return true; // an unlisted call_* tool: fail toward not repeating
  // An argument shape that hides the action (a wrapped or renamed field) cannot be classified: fail toward not repeating.
  if (rule === "by_args" && typeof args.action !== "string") return true;
  const effect = evaluateAgentToolPolicy({ toolName, args }).effect;
  return STRICT_EFFECTS.has(effect);
}
