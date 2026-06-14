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
 *                            fixable without touching tool logic (Brave 429,
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
const BY_DESIGN_RE =
  /task rejected|matched forbidden pattern|may only be used for|should delay new invitation|already connected|required function calls have not been made|cannot mark steps as completed|cannot resend|recipient cannot be reached|no (?:search )?results found|corrupted or password-protected|failed to parse pdf/i;

// "too long (N chars)" = an argument-length constraint (e.g. the LinkedIn 200/300
// invite-note limit) — an arg validation, not a tool defect.
const SCHEMA_RE =
  /failed schema validation|\b[\w-]+ (?:is|are) required\b|missing required (?:argument|variable|field|parameter)|both .* (?:is|are) required|message is too long|note is too long|too long \(\d/i;

// Includes the technical config/credential/quota signals from the error MESSAGE
// so pre-classifier events (errorClass recorded as the unhelpful 'Error') are
// still classified — e.g. the Brave 429s, which would otherwise fall to 'bug'.
// "summarizer summary" = downstream of a Brave 429 (cascade). "operation was
// aborted" = an AbortController timeout — a tunable-infra issue, not a code bug.
const CONFIG_RE =
  /\b429\b|too many requests|rate.?limit|quota exceeded|unauthorized|forbidden|invalid api key|missing credentials|bad credentials|authentication failed|does not exist|not configured|not a member of channel|not authorized|no secrets configured|account connected|specified bucket|job timed out|insights job|unable to retrieve a summarizer|status code 404|operation was aborted/i;

/**
 * @param errorClass  output of classifyToolErrorClass (may be '', undefined)
 * @param errorMessage the tool's error message (may be '', undefined)
 */
export function classifyToolFailureType(errorClass?: string, errorMessage?: string): ToolFailureType {
  const cls = (errorClass || '').toLowerCase();
  const msg = errorMessage || '';

  // 1. Model called a tool that isn't installed. Message-driven: these throw a
  //    plain Error, so errorClass carries no signal. Checked first so the
  //    "required skill" wording is never mistaken for a schema reject.
  if (UNINSTALLED_RE.test(msg)) return 'model_uninstalled_tool';

  // 2. Working-as-designed: a policy/validator deliberately rejected the call.
  if (cls === 'policy_blocked') return 'by_design';
  if (BY_DESIGN_RE.test(msg)) return 'by_design';

  // 3. Arguments rejected by schema validation before execution.
  if (cls === 'invalid_args') return 'schema_reject';
  if (SCHEMA_RE.test(msg)) return 'schema_reject';

  // 4. Config / environment / credentials / quota / missing resource.
  if (cls === 'rate_limit' || cls === 'auth' || cls === 'not_found') return 'config';
  if (CONFIG_RE.test(msg)) return 'config';

  // 5. Genuine or transient failure to investigate (network, generic timeout,
  //    opaque 5xx, unknown). Default.
  return 'bug';
}
