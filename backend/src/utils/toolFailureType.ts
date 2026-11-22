/**
 * classifyToolFailureType — decision-layer taxonomy for agent tool failures.
 *
 * Sits ON TOP of classifyToolErrorClass (the technical taxonomy:
 * timeout|auth|rate_limit|invalid_args|not_found|network|upstream_5xx|
 * policy_blocked|repeated_failure). Where errorClass says *what* the error was,
 * failureType says *what kind of action it needs* — so retire/keep decisions
 * and the weekly tool scorecard run off failure TYPE rather than raw failure
 * rate (dev.md 2026-06-13: most "failures" are uninstalled-tool calls,
 * by-design validator rejections, or schema rejects — not tool bugs).
 *
 *   model_uninstalled_tool — the model called a tool the user does not have
 *                            (the live symptom of tool-list truncation). Not a
 *                            tool bug; fix the catalog, not the tool.
 *   by_design              — a validator/policy correctly rejected the request
 *                            (out-of-scope task, anti-spam delay). The tool
 *                            WORKED. Excluding these is what stops the failure
 *                            rate from crying wolf.
 *   schema_reject          — arguments failed validation before execution
 *                            (missing required arg). Cheap; fix the schema/args.
 *   config                 — environment/credentials/quota/missing-resource;
 *                            fixable without touching tool logic (provider 429,
 *                            missing S3 bucket, bot-not-in-channel, auth gap).
 *   bug                    — genuine or transient failure to investigate
 *                            (network drop, opaque 5xx, unknown). The default.
 *
 * Renaming a type is a breaking change for historical scorecard queries on the
 * `failureType` dimension — keep these stable.
 */

export const FAILURE_TYPES = [
  'model_uninstalled_tool',
  'by_design',
  'schema_reject',
  'config',
  'bug',
] as const;

export type ToolFailureType = (typeof FAILURE_TYPES)[number];

const UNINSTALLED_RE = /not available\b[\s\S]*install the required skill/i;

// "cannot resend" / "recipient cannot be reached" = LinkedIn platform state (the
// action was valid, the platform declined it — like "should delay"). "no results
// found" = a benign empty result the tool recorded as a failure. "corrupted /
// failed to parse pdf" = bad user input the tool correctly rejected.
// "local_agent_deprecated" = the retired local-agent relay stubs (ENG-383)
// refusing by design — a call to a deliberately retired tool is not a tool bug.
// "the publisher refused this fetch" / "net::err_..." (ENG-1162) = a third-party
// site's own anti-bot/WAF block, not an AgentWeb config gap — checked here,
// ahead of CONFIG_RE, so a message-only call (no errorClass) doesn't fall into
// 'config' merely because the marker text contains the word "Forbidden".
const BY_DESIGN_RE =
  /task rejected|matched forbidden pattern|may only be used for|local_agent_deprecated|should delay new invitation|already connected|required function calls have not been made|cannot mark steps as completed|cannot resend|recipient cannot be reached|no (?:search )?results found|corrupted or password-protected|failed to parse pdf|the publisher refused this fetch|net::err_(?:empty_response|connection_refused|connection_reset|connection_closed)/i;

// "too long (N chars)" = an argument-length constraint (e.g. the LinkedIn 200/300
// invite-note limit) — an arg validation, not a tool defect.
const SCHEMA_RE =
  /failed schema validation|\b[\w-]+ (?:is|are) required\b|missing required (?:array )?(?:argument|variable|field|parameter)|both .* (?:is|are) required|message is too long|note is too long|too long \(\d/i;

// Includes the technical config/credential/quota signals from the error MESSAGE
// so pre-classifier events (errorClass recorded as the unhelpful 'Error') are
// still classified — e.g. provider 429s, which would otherwise fall to 'bug'.
// "summarizer summary" = downstream of a provider 429 (cascade). "operation was
// aborted" = an AbortController timeout — a tunable-infra issue, not a code bug.
// "HTTP 402" / "out of credits" / "payment required" = a metered vendor wallet
// is depleted (X shared app, ENG-664) — a billing/quota config gap, not a tool
// bug. The 402 alternation is anchored to an HTTP-status context (not a bare
// "402" number, which could appear in an unrelated id/line-number message).
// "insufficient_quota" / "exceeded your current quota" / "check your plan and
// billing details" = hard OpenAI/Azure quota exhaustion (ENG-1220) — same
// wording toolErrorClassifier's quota_exceeded branch matches, kept in sync so
// pre-classifier events (no errorClass yet) still land in 'config', not 'bug'.
const CONFIG_RE =
  /\b429\b|http\s*402|status(?:\s+code)?\s+402|out of credits|payment required|too many requests|rate.?limit|quota exceeded|insufficient_quota|exceeded your current quota|check your plan and billing details|unauthorized|forbidden|invalid api key|missing credentials|bad credentials|authentication failed|does not exist|not configured|not a member of channel|not authorized|no secrets configured|account connected|specified bucket|job timed out|insights job|unable to retrieve a summarizer|status code 404|operation was aborted/i;

/**
 * @param errorClass  output of classifyToolErrorClass (may be '', undefined)
 * @param errorMessage the tool's error message (may be '', undefined)
 */
export function classifyToolFailureType(errorClass?: string, errorMessage?: string): ToolFailureType {
  /*
   * ENG-1795. Deliberately NOT `model_uninstalled_tool` ("not a tool bug; fix the catalog, not
   * the tool"). The `unavailable` bucket IS a catalog bug — an entitled bundle whose tool pool
   * emptied out, the ENG-1237 production defect — so routing it to a non-dispatchable type
   * drops exactly the defect worth investigating out of the investigate bucket. `bug` keeps it
   * visible, which is where it was under the old single-message behaviour.
   */

  const cls = (errorClass || '').toLowerCase();

  if (cls === 'skill_install_refused') {
    /*
     * Two buckets share this class, and they are opposite kinds of event.
     *
     *   forbidden   — `__admin_tools__` refused to a non-admin. A ROLE boundary working
     *                 exactly as designed. Nothing to investigate; proposing a "robustness
     *                 fix" for the install_skills handler here is pure triage noise.
     *   unavailable — an entitled bundle whose tool pool emptied out. That IS the ENG-1237
     *                 catalog defect, and it must stay in the investigate set.
     *
     * Distinguished by message rather than by a second error class, because both real callers
     * (`runRecorder.ts`, `backfillFailureTypes.ts`) already pass errorMessage — so this needs
     * no new routing, guidance text or consumer trace.
     *
     * A MIXED refusal, carrying both an admin id and an entitled-but-empty one, stays `bug`:
     * the unavailable half is a genuine defect, and under-investigating is the expensive
     * direction. Absent or unreadable message likewise falls through to `bug`.
     */
    // `||`, not `??`: matches `cls` above, and coerces a non-string (0/false/NaN) that a
    // historical DynamoDB row can hand `backfillFailureTypes.ts` — `?? ''` leaves those
    // intact and `.toLowerCase()` then throws, aborting the whole backfill scan.
    const m = (errorMessage || '').toLowerCase();
    const rolesOnly = m.includes('requires admin access') && !m.includes('permitted to use it');
    return rolesOnly ? 'by_design' : 'bug';
  }
  const msg = errorMessage || '';

  // 1. Model called a tool that isn't installed. Message-driven: pre-classifier
  //    events threw a plain Error so errorClass carried no signal; the
  //    'tool_unavailable' class (added 2026-06-14) now carries it directly.
  //    Checked first so the "required skill" wording is never mistaken for a
  //    schema reject.
  if (cls === 'tool_unavailable' || UNINSTALLED_RE.test(msg)) return 'model_uninstalled_tool';

  // 2. Working-as-designed: a policy/validator deliberately rejected the call,
  //    or an upstream returned a benign empty result. 'upstream_rejected' =
  //    provider business-rule refusal (LinkedIn cadence); 'empty_result' = the
  //    call succeeded but yielded no data. 'publisher_refused' (ENG-1162) = a
  //    third-party site's own anti-bot/WAF block on our anonymous fetch — the
  //    tool executed correctly, an external party outside our control declined
  //    it, and there is no credential/config on our side that would fix it, so
  //    it belongs here rather than 'config'. 'missing_brand_logo' (ENG-1844) = the
  //    generate/duplicate brand-logo gate correctly refused an invented-logo page —
  //    the tool worked exactly as designed. None of these are a tool bug.
  if (cls === 'policy_blocked' || cls === 'upstream_rejected' || cls === 'empty_result' || cls === 'publisher_refused' || cls === 'missing_brand_logo') return 'by_design';
  if (BY_DESIGN_RE.test(msg)) return 'by_design';

  // 3. Arguments rejected by schema validation before execution.
  if (cls === 'invalid_args') return 'schema_reject';
  if (SCHEMA_RE.test(msg)) return 'schema_reject';

  // 4. Config / environment / credentials / quota / missing resource. Includes
  //    'payment_required' — a metered vendor wallet out of credits (X shared app,
  //    ENG-664) is a billing/quota gap fixable without touching tool logic, NOT a
  //    tool bug, so it stays out of the tool-bug rate while still being visible.
  //    'quota_exceeded' (ENG-1220) — hard OpenAI/Azure quota exhaustion, split out
  //    from 'rate_limit' so the session-wide media budget still counts it, but it
  //    is the same "resolve the account, not the code" gap as payment_required.
  if (cls === 'rate_limit' || cls === 'auth' || cls === 'not_found' || cls === 'payment_required' || cls === 'quota_exceeded') return 'config';
  if (CONFIG_RE.test(msg)) return 'config';

  // 5. Genuine or transient failure to investigate (network, generic timeout,
  //    opaque 5xx, unknown). Default.
  return 'bug';
}
