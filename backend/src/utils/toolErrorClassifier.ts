/**
 * classifyToolErrorClass — semantic taxonomy for agent tool failures.
 *
 * The June 9-12 runtime-spine telemetry recorded errorClass "Error" on every
 * one of the 60+ tool failures: most tools throw plain `new Error(message)`,
 * so the constructor-name fallback carried zero signal. The failure policy
 * could only cluster by tool name, and the model could not tell a retryable
 * timeout from a terminal auth failure.
 *
 * Classes are intentionally coarse and stable — they feed the agent-mode
 * loop's failure clustering and the inspector UI, so renaming one is a
 * breaking change for historical queries:
 *   timeout | auth | rate_limit | quota_exceeded | invalid_args | not_found |
 *   network | upstream_5xx | policy_blocked | repeated_failure |
 *   tool_unavailable | upstream_rejected | empty_result | invalid_output |
 *   subscription_blocked | truncated_response | read_incomplete | read_bounded |
 *   scope_refused | publisher_refused | skill_install_refused | missing_brand_logo
 *
 * `skill_install_refused` was added by ENG-1795; see its routing below for why no existing
 * class fit. The three classes before it were added 2026-06-14 after a 7-day production
 * sweep of Dev-AW-LoopEvents `agent_tool_failed` events: re-classifying the
 * 283 real failures with the prior patterns still left 63% in the generic
 * `Error` fallback (dev.md target was <20%). The real residual clusters were:
 *   - tool_unavailable  (~41) "Tool \"X\" is not available. You must install
 *                        the required skill first using install_skills." — the
 *                        model called an uninstalled skill; not a bug, a config
 *                        gap. Largest single missed cluster.
 *   - invalid_args      (~45 newly caught) "...arguments failed schema
 *                        validation...", "has the wrong type", "Missing
 *                        required argument/variable" — model emitted bad args.
 *   - upstream_rejected (~28) LinkedIn business-rule refusals: "Cannot resend
 *                        yet", "Should delay new invitation to this recipient",
 *                        "not a 1st-degree connection". The provider accepted
 *                        the call and deliberately refused the action —
 *                        terminal + actionable, distinct from a 5xx or a bug.
 *   - empty_result      (~9) "No search results found", "Unable to retrieve a
 *                        Summarizer summary.", "No analysis results received
 *                        from Gemini" — the call succeeded but yielded nothing.
 * New fallback rate on the same 283-failure set: ~10%. The ~29 residual are
 * genuinely idiosyncratic one-offs ("Unknown error", "success=false", file
 * hash mismatch) that do not form a clusterable class.
 *
 * Unrecognized errors fall back to the legacy name-based class (explicit
 * `.name`, else constructor name) so named custom errors lose nothing.
 */

// ENG-1844 review: this module was previously import-free by convention. A single import
// of a plain string constant (no transitive weight — brandLogo.ts lazy-loads everything
// else) is worth the small deviation: the alternative was a second, independently-typed
// copy of 'missing_brand_logo' in this file, which a future rename of the real constant
// would silently desync from — classification would revert to the generic fallback with
// every test still green, since the test would need the same independent literal too.
import { MISSING_BRAND_LOGO_ERROR } from '../services/agentMode/brandLogo';

const GATEWAY_NAME_CLASSES: Record<string, string> = {
  AgentToolBudgetExceededError: 'repeated_failure',
  AgentToolPolicyBlockedError: 'policy_blocked',
  ToolResultPolicyBlockedError: 'policy_blocked',
  AgentToolRepeatedFailureError: 'repeated_failure',
  AgentToolContractValidationError: 'invalid_args',
  // A tool returned without throwing but produced no usable output (ENG-105).
  // Distinct from an execution failure so telemetry can separate "tool ran and
  // gave us nothing" from "tool errored".
  ToolOutputContractError: 'invalid_output',
  TimeoutError: 'timeout',
  AbortError: 'timeout',
  // Typed X credit-exhaustion (ENG-664) — classify by name so a 402 clusters as
  // a billing stop even when it crosses a module/mock boundary.
  XCreditsExhaustedError: 'payment_required',
  // A tool call's arguments were a clean-but-incomplete JSON prefix — the
  // stream was cut off mid-generation, not a formatting mistake (ENG-1477
  // follow-up; see repairToolCallArguments.ts). Distinct from invalid_args so
  // the model gets retry guidance instead of "fix your arguments first".
  TruncatedToolCallArgumentsError: 'truncated_response',
};

function classFromStatus(status: number): string | null {
  if (status === 401 || status === 403) return 'auth';
  // 402 Payment Required — a metered vendor wallet is out of credits (X shared
  // Developer App, ENG-604/664). A hard billing stop, distinct from a transient
  // 429 rate limit, so it clusters on its own.
  if (status === 402) return 'payment_required';
  if (status === 404) return 'not_found';
  if (status === 408 || status === 504) return 'timeout';
  if (status === 429) return 'rate_limit';
  if (status === 400 || status === 422) return 'invalid_args';
  if (status >= 500) return 'upstream_5xx';
  return null;
}

function classFromMessage(message: string): string | null {
  const m = message.toLowerCase();

  /*
   * ENG-1795 — install_skills refusals, matched FIRST and deliberately so.
   *
   * These sentences are ours, emitted verbatim by installSkills, so their presence is
   * definitive and nothing later can describe the failure better. Order matters twice over:
   *
   *   1. The refusal interpolates the REJECTED SKILL IDS, which on the `unresolved` path are
   *      strings a model invented. An id like "UTM Audit 404 Report" or "ads 403 manager" would
   *      otherwise be caught by the embedded-status and bare-substring patterns below and
   *      classified `not_found` / `auth` / `upstream_5xx` — the last of which is RETRYABLE, so
   *      a permanent refusal would advertise itself as worth retrying. Matching our own marker
   *      first makes the classification independent of whatever the model put in the id.
   *
   *   2. A mixed refusal carries several of these sentences at once. Unknown ids are the
   *      actionable half — the model can retry with a correct id — so they win, and the
   *      subscription sentence must not pull the whole message under a billing verdict. That
   *      conflation is the entire bug this ticket exists to remove.
   *
   * `skill_install_refused` exists because no pre-existing class fit. `empty_result` says "the
   * call succeeded but returned nothing … try a different source" — appending that beneath a
   * refusal whose own text forbids substitution is precisely how ENG-1625 produced a fabricated
   * audit table. `tool_unavailable` was tried next and is also wrong: its guidance opens with
   * "this tool is not available in this session" (install_skills ran) and tells the model to
   * "install the required skill via install_skills" (the call that just refused), and its
   * failure type drops the bucket out of the investigate set.
   */
  if (/could not resolve these skill ids to any known skill/.test(m)) return 'invalid_args';
  // ENG-2786: a client_id-scoped Meta call that omitted account_id is a tool-contract
  // (usage) error the model fixes by passing account_id — not a credential failure.
  if (/client_id-scoped calls require an explicit account_id/.test(m)) return 'invalid_args';
  if (/these skills are currently unavailable to install/.test(m)) return 'skill_install_refused';
  /*
   * ENG-1627 — create_html_file's remaining generic `Error` cluster. Matched
   * early because these messages embed JSON positions and S3 URLs whose digits
   * can trip the embedded-status patterns below.
   *  - "Failed to parse arguments: … cut off …" is a mid-generation cutoff
   *    (retryable), anything else from the arg parser is malformed JSON.
   *  - Private-image size limits (inlineS3Images.ts) are oversized input, not
   *    a runtime bug; access failures keep falling through (e.g. not_found).
   */
  if (/^failed to parse arguments:/.test(m)) {
    return /were cut off before the json object was complete/.test(m) ? 'truncated_response' : 'invalid_args';
  }
  if (/decoded image exceeds the \d+ mb limit|exceeds? the \d+ mb (aggregate )?decoded limit/.test(m)) return 'invalid_args';
  /*
   * The entitlement sentence needs the same protection, and for the same reason: a published
   * skillId beginning with a "500"/"404"/"403"-shaped token would otherwise be caught by the
   * embedded-status regex below and classified `upstream_5xx` / `not_found` / `auth`.
   * `upstream_5xx` is RETRYABLE, appending "Wait briefly, then retry ONCE" beneath a permanent
   * billing refusal.
   *
   * ANCHORED to our own full sentence, unlike the generic phrasing kept at its original
   * position further down. "not available with your current subscription" is ordinary vendor
   * English, not a string we own — matching it here would promote it above the read-bounded and
   * ad-account guards that this file deliberately orders for truthfulness, and would reclassify
   * a vendor 403 ("...status code 403: this feature is not available with your current
   * subscription") from `auth` to `subscription_blocked`, telling the model to say the
   * capability is off the user's plan instead of to reconnect the account.
   */
  if (/the requested skills are not available with your current subscription/.test(m)) {
    return 'subscription_blocked';
  }

  // Hard quota exhaustion (OpenAI/Azure `insufficient_quota`, "exceeded your
  // current quota, please check your plan and billing details") is a
  // permanent billing stop even though the provider surfaces it as HTTP 429 —
  // checked before the status/rate-limit matches below so it isn't folded
  // into the transient 'rate_limit' class, which is exempt from the
  // session-wide media budget (ENG-1220).
  if (/insufficient_quota|exceeded your current quota|quota exceeded|check your plan and billing/.test(m)) return 'quota_exceeded';

  /*
   * A read that did not finish is NOT evidence of absence — and until this branch existed, the
   * classifier said the opposite of the message it was appended to.
   *
   * These messages are ours, and every one of them exists to REFUSE an absence conclusion:
   * "Do NOT report the file as absent", "this is not a confirmed absence", "this is a FAILED
   * read". Unclassified, they fell to `not_found` (whose next step is "the target was not
   * found") or, once main widened the `invalid_args` regex with `is too large`, to "fix the
   * arguments" for a filename that was never wrong. The verdict is appended AFTER the warning,
   * so it is the last thing the model reads — ENG-1584 reintroduced through the one channel
   * this PR had not checked.
   *
   * Checked ahead of not_found, invalid_args AND the embedded-status regex below for that
   * reason. That regex matches any whitespace-preceded 3-digit 4xx/5xx-shaped number — including
   * one interpolated from a FOLDER OR FILE NAME. "Landing 404 Copy.docx" classified not_found and
   * appended "the target was not found" directly beneath "Do NOT report the file as absent";
   * "Studio 403 Shared" appended "reconnect the account" beneath "NOT a permissions problem";
   * "Creative 500x500.png" — an everyday ad dimension in this product — appended "Retryable: yes"
   * to a deterministic bound. Being ahead of not_found was not enough while the regex that
   * defeats it ran first.
   */
  if (/do not report the file as absent|not a confirmed absence|this is a failed read|rate-limiting this account|rate-limited the scan/.test(m)) {
    /*
     * Two sub-cases, and they need OPPOSITE verdicts.
     *
     * A wall-clock/scope bound is deterministic — the message itself says "Do NOT retry this
     * same call ... a tree this large will stop in the same place every time" — so a
     * `Retryable: yes` beneath it is the same contradiction one level down. A throttle or a
     * transient page failure clears on its own and must stay retryable.
     */
    if (/do not retry this same call|stop in the same place every time/.test(m)) return 'read_bounded';
    return 'read_incomplete';
  }

  /*
   * ENG-1162: a PUBLISHER (not an AgentWeb-connected account) refused or failed to serve a
   * plain external fetch — a 401/403 from read_file_content's own marker (see its catch
   * block), or one of a specific set of Chromium/Playwright network-level navigation failures
   * (net::ERR_EMPTY_RESPONSE, net::ERR_CONNECTION_REFUSED, net::ERR_CONNECTION_RESET,
   * net::ERR_CONNECTION_CLOSED) — a server hangup or reset before any HTTP response, common for
   * anti-bot filtering and frequently recurring for the same URL rather than a one-off blip.
   * Deliberately narrower than every net::ERR_* code: ERR_NAME_NOT_RESOLVED (DNS), ERR_ABORTED,
   * and ERR_CERT_* are different failure modes with no bearing on whether the publisher refused
   * to serve content, and the "NOT evidence the content does not exist" guidance below is wrong
   * for at least DNS/cert failures.
   *
   * Checked ahead of the embedded-HTTP-status regex below, which would otherwise catch the
   * literal "403"/"401" inside read_file_content's own marker text and mis-route it to 'auth' —
   * whose guidance ("reconnect the account or fix permissions") is nonsensical for an anonymous
   * external read and was exactly what let a browser/publisher block masquerade as OUR
   * credentials problem. Neither case is evidence the source doesn't exist — see
   * NEXT_STEP_BY_CLASS.
   */
  if (/the publisher refused this fetch|net::err_(empty_response|connection_refused|connection_reset|connection_closed)/.test(m)) return 'publisher_refused';

  // HTTP status embedded in the message ("status code 429", "503 Service…").
  const statusMatch = m.match(/(?:status(?:\s+code)?\s+|^|\s)([45]\d{2})(?:\s|$|[^\d])/);
  if (statusMatch) {
    const byStatus = classFromStatus(Number(statusMatch[1]));
    if (byStatus) return byStatus;
  }

  // Uninstalled-skill calls — checked first so "install the required skill"
  // text never gets misread by a later branch. The model invoked a tool the
  // user has not enabled; a config gap, not a failure of the tool itself.
  if (/is not available\. you must install the required skill|install_skills/.test(m)) return 'tool_unavailable';


  /*
   * An ad-account scope refusal. Unclassified it fell to the legacy `Error` class, whose default
   * next step ends "...use a different tool" — and for a SCOPE refusal the available different
   * tool is the unscoped account-wide list, i.e. widening exactly the read whose scope was just
   * refused. The transient sibling ("could not verify ... please retry") additionally got "do NOT
   * retry" appended over its own "please retry".
   *
   * Keyed on the marker `assertOwnedByAccount` guarantees on every branch, and on the
   * unverifiable-lookup wording that deliberately does NOT carry it.
   */
  /*
   * Only the MISMATCH branch. `assertOwnedByAccount` deliberately varies its remedy across three
   * branches, and collapsing them into one class attaches the mismatch verdict — "the object is
   * not in the selected ad account, select the account that owns it" — to two states where that
   * is factually untrue:
   *
   *   no owner reported  → "ownership could not be CONFIRMED … not a proven mismatch. Retry."
   *   no account resolved → "a connection problem, not a permissions one — reconnect Meta."
   *
   * The second matters most: `account_id ?? ''` deliberately routes an unresolved credential
   * into exactly that branch, so the two fixes composed into telling a user their own object
   * belongs to someone else's ad account. Keyed on the remedy sentence, which only the mismatch
   * branch emits.
   */
  if (/is not available in the selected ad account/.test(m)
      && /belongs to a different ad account, select that account/.test(m)) {
    return 'scope_refused';
  }
  // Could not confirm ownership — our failure or Meta's silence, not a statement about the node.
  if (/is not available in the selected ad account/.test(m)) return 'upstream_5xx';
  if (/could not verify the requested .* against the selected ad account/.test(m)) return 'upstream_5xx';

  // Generic vendor phrasing, kept exactly where it has always been — BELOW the embedded-status
  // and ad-account guards, so a "403 ... not available with your current subscription" still
  // classifies `auth`. Our own refusal is anchored and matched at the top of this function
  // instead; the two are deliberately separate (ENG-1795).
  if (/not available with your current subscription|capability is not on their plan/.test(m)) return 'subscription_blocked';
  // Bad skill ids from the model — an argument problem, not a plan problem.
  if (/no valid skills found/.test(m)) return 'invalid_args';

  if (/etimedout|timed?\s*out|deadline exceeded|operation was aborted/.test(m)) return 'timeout';
  if (/too many requests|rate limit/.test(m)) return 'rate_limit';

  // Bad arguments the model emitted — schema-validation rejections (the
  // contract layer rejects before execution) plus classic validation phrasing.
  //
  // `is too large` (ENG-1672) is deliberately global, not scoped to the schedule
  // size-block message it was added for — it requires the literal word "is"
  // before "too large" (verified: "Video file too large…"/"Content too
  // large…"/"Image too large…" do NOT match this, only messages phrased as
  // "X is too large" do), but for the ones that do match — an oversized
  // perform_data_analysis instruction, a too-large cookie header, Gmail's
  // HTML-body limit — this now classifies messages that previously fell
  // through unclassified to the generic legacy-name fallback below. The one
  // exception is a named custom error whose message happens to say "is too
  // large" AND which previously relied on keeping its own distinct name via
  // that same fallback (gmailService.ts's GmailBodyTooLargeError) — this now
  // reclassifies it to invalid_args too. Accepted: a genuinely oversized input
  // isn't retryable either way, and consistent classification across the app
  // outweighs one error keeping a bespoke class name.
  if (/arguments failed schema validation|has the wrong type|missing required (array )?(argument|variable)|invalid parameters?|invalid argument|validation (failed|error)|(is|are) required|must be|is too long|too long \(|is too short|too large to save|is too large/.test(m)) return 'invalid_args';

  if (/unauthorized|forbidden|invalid (access |api )?token|invalid api key|authentication|missing credentials|not authorized|do not have permission|permission to|no secrets configured|not a member of channel|account connected|account not configured|not configured to access/.test(m)) return 'auth';
  if (/enotfound|econnrefused|econnreset|eai_again|socket hang up|network error|fetch failed|connection error|premature close|invalid response body/.test(m)) return 'network';
  if (/does not exist|not found|no landing page found/.test(m)) return 'not_found';
  if (/internal server error|bad gateway|service unavailable|upstream/.test(m)) return 'upstream_5xx';
  // Meta Graph transient (codes 1/2): the SDK/campaign path surfaces Meta's generic
  // body verbatim with NO HTTP status in the string, so the status-regex above misses
  // it. Meta classifies these as "temporary, wait & retry" (metaService codes 1/2/4/17
  // → RETRYABLE_ERROR); treat as retryable upstream instead of a terminal legacy class.
  if (/an unexpected error has occurred\.?\s*please retry/.test(m)) return 'upstream_5xx';

  // Upstream accepted the call and deliberately refused the action (provider
  // business rules — LinkedIn invite/message cadence + connection-degree
  // gates). Terminal + actionable, distinct from a transport 5xx or a bug.
  if (/cannot resend yet|should delay new invitation|recipient cannot be reached|already connected with this person|not a 1st-degree connection|not a \d.{0,4}degree connection|cannot send (invite|message)/.test(m)) return 'upstream_rejected';

  // Call succeeded but produced nothing usable — distinct from a hard error;
  // the model should broaden/retry the query rather than treat it as broken.
  if (/no (search )?results? (found|received)|unable to retrieve|no analysis results|returned no results/.test(m)) return 'empty_result';

  return null;
}

/** Legacy fallback — what errorClassOf in the run recorder produced before. */
function legacyNameClass(error: unknown): string {
  if (error instanceof Error) {
    if (error.name && error.name !== 'Error') return error.name;
    return error.constructor?.name || 'Error';
  }
  if (typeof error === 'string') return 'StringError';
  return 'UnknownError';
}

/**
 * ENG-1949 — semantic classes a tool may stamp on its own structured failure
 * result (`{ success: false, errorClass }`). coding_agent's failures are
 * returned, not thrown, and the message is often the sub-agent's own prose
 * summary ("Done! ..."), so message matching cannot classify them; the tool
 * knows the class and says so. Only names from this taxonomy are honoured —
 * an arbitrary string never becomes a new cluster.
 */
export const KNOWN_TOOL_ERROR_CLASSES: ReadonlySet<string> = new Set([
  'timeout', 'auth', 'rate_limit', 'quota_exceeded', 'payment_required', 'invalid_args',
  'not_found', 'network', 'upstream_5xx', 'policy_blocked', 'repeated_failure',
  'tool_unavailable', 'upstream_rejected', 'empty_result', 'invalid_output',
  'truncated_response',
]);

export function classifyToolErrorClass(error: unknown): string {
  if (error instanceof Error) {
    const declared = (error as { toolErrorClass?: unknown }).toolErrorClass;
    if (typeof declared === 'string' && KNOWN_TOOL_ERROR_CLASSES.has(declared)) return declared;

    // Check both the explicit .name and the constructor name — `class
    // TimeoutError extends Error {}` inherits .name === 'Error'.
    const byName = GATEWAY_NAME_CLASSES[error.name]
      ?? GATEWAY_NAME_CLASSES[error.constructor?.name ?? ''];
    if (byName) return byName;

    // AWS SDK v2 (DynamoDB et al.) puts the exception name in the STRING
    // `.code` property (ENG-1626, CodeRabbit) — checked BEFORE the numeric
    // status below, not after: these errors also carry a numeric
    // `.statusCode` of 400, and classFromStatus(400) returns 'invalid_args'
    // before this string check would otherwise ever run, silently discarding
    // the real classification and disabling retry during throttling.
    const stringCodeProp = (error as { code?: unknown }).code;
    if (typeof stringCodeProp === 'string'
      && (stringCodeProp === 'ThrottlingException' || stringCodeProp === 'ProvisionedThroughputExceededException')) {
      return 'rate_limit';
    }

    // ENG-1844: the landing-page generate/duplicate routes' brand-logo gate reaches this
    // point via httpClient.ts's self-call Error, which preserves the route's `error` code
    // on `.code` specifically so it can be matched here instead of the human `message`
    // text — that message embeds "(422)" with no preceding whitespace, which the
    // embedded-status regex below does not match, so this was previously falling through
    // to the generic unclassified 'Error' bucket and reporting as an outage. Matched
    // against the imported constant (the INPUT marker), not a second independent
    // literal — the returned class name below stays its own literal on purpose: this
    // taxonomy is a stable, independently-owned namespace (see file docblock), and
    // renaming the trigger's source constant must not silently rename the class too.
    if (stringCodeProp === MISSING_BRAND_LOGO_ERROR) {
      return 'missing_brand_logo';
    }

    let statusProp = (error as { status?: unknown }).status
      ?? (error as { statusCode?: unknown }).statusCode;
    // `.code` is where twitter-api-v2's ApiResponseError puts the HTTP status
    // (there is no `.status`/`.statusCode` on it) — read it too so X errors
    // (402/403/404/429) classify by status. Guarded to the HTTP range so a Node
    // errno or other non-HTTP numeric `.code` is never mistaken for a status.
    if (statusProp === undefined) {
      const codeProp = (error as { code?: unknown }).code;
      if (typeof codeProp === 'number' && codeProp >= 100 && codeProp <= 599) {
        statusProp = codeProp;
      }
    }
    if (typeof statusProp === 'number') {
      // A 429 is ambiguous: transient per-minute throttling (rate_limit,
      // retryable) and a permanent hard-quota/billing stop that providers
      // ALSO report via 429 (OpenAI/Azure `insufficient_quota` etc.) are
      // indistinguishable by status code alone. classFromStatus(429)
      // unconditionally returns 'rate_limit' and would win by default. That
      // mattered only for telemetry clustering before ENG-1661; now callLLM's
      // OpenRouter retry loop keys its retry decision on 'rate_limit', so this
      // ordering would make it blindly retry an error that can never succeed.
      //
      // Deliberately narrower than classFromMessage's own quota_exceeded
      // pattern below: that pattern's bare "quota exceeded" substring also
      // matches Google Custom Search's genuinely transient per-day quota
      // message ("Quota exceeded", ENG-1300), which must stay rate_limit and
      // already relies on classFromStatus(429) winning by default for a
      // status-shaped error with no more specific phrasing. Match only the
      // unambiguous OpenAI/Azure hard-stop phrasings here.
      if (statusProp === 429
        && /insufficient_quota|exceeded your current quota|check your plan and billing/.test((error.message ?? '').toLowerCase())) {
        return 'quota_exceeded';
      }
      const byStatus = classFromStatus(statusProp);
      if (byStatus) return byStatus;
    }

    const byMessage = classFromMessage(error.message ?? '');
    if (byMessage) return byMessage;
  } else if (typeof error === 'string') {
    const byMessage = classFromMessage(error);
    if (byMessage) return byMessage;
  }

  return legacyNameClass(error);
}
