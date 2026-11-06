/**
 * Tests for classifyToolErrorClass — semantic error taxonomy for agent tool
 * failures.
 *
 * Behavioral contract (June 12 telemetry finding: every one of the 60+ tool
 * failures recorded errorClass "Error", so the failure policy could only
 * cluster by tool name and the model got no recoverable-vs-terminal signal):
 *   1. Recognizable failure modes map to a stable semantic class:
 *      timeout | auth | rate_limit | invalid_args | not_found | network |
 *      upstream_5xx | policy_blocked | repeated_failure
 *   2. Gateway error types classify by name without needing instanceof
 *      (errors cross module boundaries).
 *   3. Unrecognizable errors fall back to the legacy name-based class so no
 *      information is lost (named custom errors keep their name).
 *   4. Real failure messages from the June 9-12 prod window classify
 *      correctly (LinkedIn arg validation, provider 429s, Meta 5xx).
 */

import { classifyToolErrorClass } from '../utils/toolErrorClassifier';
import { ToolOutputContractError } from '../utils/toolOutputContract';
import { MISSING_BRAND_LOGO_ERROR } from '../services/agentMode/brandLogo';

function err(message: string, name?: string): Error {
  const e = new Error(message);
  if (name) e.name = name;
  return e;
}

describe('classifyToolErrorClass', () => {
  it('classifies timeouts', () => {
    expect(classifyToolErrorClass(err('Request timed out after 30000ms'))).toBe('timeout');
    expect(classifyToolErrorClass(err('connect ETIMEDOUT 1.2.3.4:443'))).toBe('timeout');
    expect(classifyToolErrorClass(err('boom', 'TimeoutError'))).toBe('timeout');
  });

  it('classifies auth failures', () => {
    expect(classifyToolErrorClass(err('Request failed with status code 401'))).toBe('auth');
    expect(classifyToolErrorClass(err('403 Forbidden'))).toBe('auth');
    expect(classifyToolErrorClass(err('Invalid access token provided'))).toBe('auth');
    expect(classifyToolErrorClass(err('Unauthorized: missing credentials'))).toBe('auth');
  });

  it('ENG-2786: client_id-scoped missing account_id is invalid_args, not auth; real token failure stays auth', () => {
    expect(classifyToolErrorClass(new Error('client_id-scoped calls require an explicit account_id — call assess_client_health with client_name_or_email="x@y.com" first; its ad_account_id field is this client\'s Meta ad account.'))).toBe('invalid_args');
    expect(classifyToolErrorClass(Object.assign(new Error('client_id-scoped calls require an explicit account_id'), { toolErrorClass: 'invalid_args' }))).toBe('invalid_args');
    expect(classifyToolErrorClass(Object.assign(new Error('Request failed'), { status: 401 }))).toBe('auth');
  });

  it('classifies rate limits', () => {
    expect(classifyToolErrorClass(err('Request failed with status code 429'))).toBe('rate_limit');
    expect(classifyToolErrorClass(err('Too Many Requests'))).toBe('rate_limit');
    expect(classifyToolErrorClass(err('Rate limit exceeded, retry in 2s'))).toBe('rate_limit');
  });

  // ENG-1220: hard-quota exhaustion (OpenAI/Azure `insufficient_quota`, "exceeded
  // your current quota") is 429-shaped like transient per-minute throttling, but
  // permanent — it must classify separately from 'rate_limit' so callers that
  // exempt rate_limit from a session-wide retry budget (agentToolGatewayService's
  // shouldTrackInSessionScope) don't also exempt a hard billing stop.
  it('classifies hard-quota exhaustion as quota_exceeded, distinct from rate_limit', () => {
    expect(classifyToolErrorClass(err('insufficient_quota'))).toBe('quota_exceeded');
    expect(classifyToolErrorClass(err('You exceeded your current quota, please check your plan and billing details.'))).toBe('quota_exceeded');
    expect(classifyToolErrorClass(err('gpt-image-2 API failed: quota exceeded for this billing period'))).toBe('quota_exceeded');
    // Genuine per-minute throttling stays rate_limit even though both are 429s.
    expect(classifyToolErrorClass(err('Too Many Requests'))).toBe('rate_limit');
  });

  // A real OpenAI-SDK APIError (thrown by every OpenRouter call, including a
  // BYOK upstream that's run out of quota) carries a numeric `.status`, unlike
  // the plain-message `err()` errors above. classFromStatus(429) must not win
  // by default over the quota_exceeded message check, or ENG-1661's
  // OpenRouter retry loop (keyed on 'rate_limit') would blindly retry a
  // permanent billing stop that can never succeed.
  it('prefers quota_exceeded over rate_limit for a status-429 error with quota-exhaustion text', () => {
    const quotaErrorWithStatus = Object.assign(
      new Error('429 You exceeded your current quota, please check your plan and billing details.'),
      { status: 429 }
    );
    expect(classifyToolErrorClass(quotaErrorWithStatus)).toBe('quota_exceeded');

    // The real ENG-1661 incident shape ("Provider returned error") must stay
    // rate_limit/retryable even with a numeric .status present.
    const genuineRateLimitWithStatus = Object.assign(
      new Error('429 Provider returned error'),
      { status: 429 }
    );
    expect(classifyToolErrorClass(genuineRateLimitWithStatus)).toBe('rate_limit');

    // Sibling statuses are unaffected by the 429-specific message check.
    const paymentRequiredWithStatus = Object.assign(new Error('402 insufficient credits'), { status: 402 });
    expect(classifyToolErrorClass(paymentRequiredWithStatus)).toBe('payment_required');
  });

  it('classifies argument validation — the LinkedIn outreach cluster', () => {
    expect(classifyToolErrorClass(err('Invitation message is too long (224 characters). Max is 200.'))).toBe('invalid_args');
    expect(classifyToolErrorClass(err('Invalid parameters'))).toBe('invalid_args');
    expect(classifyToolErrorClass(err('Validation failed: url is required'))).toBe('invalid_args');
  });

  // ENG-1672: a schedule write blocked by DynamoDB's 400KB item ceiling
  // ("Scheduled chat is too large to save...") fell through every pattern here
  // (only "too long"/"too short" matched) and landed on the generic legacy
  // "Error" class, indistinguishable from a random unclassified failure. It is a
  // client-fixable, non-retryable condition like any other "too long" rejection.
  // A projected size (e.g. "391KB") does not reliably start with a 4 or 5, so
  // the explicit "too large to save"/"is too large" pattern below must not
  // depend on incidental "400KB"-shaped digits elsewhere in the message —
  // these two fixtures omit "400KB" entirely to prove that.
  it('classifies an item-size-blocked schedule write as invalid_args, independent of incidental status-shaped digits', () => {
    expect(classifyToolErrorClass(err(
      'Scheduled chat is too large to save (about 391KB against the per-item limit) '
      + 'even after dropping saved history. The starting message is 10240 characters — shorten it and try again.'
    ))).toBe('invalid_args');
    expect(classifyToolErrorClass(err(
      'API error (400): Scheduled chat is too large to save — it exceeds the per-item limit.'
    ))).toBe('invalid_args');
  });

  // The three real messages agentModeController.ts actually throws (via
  // mcpFetch's `API error (${status}): ${message}` wrapping) all hard-code the
  // literal "DynamoDB's 400KB per-item limit" — so today they already classify
  // correctly via the earlier embedded-status-code match (classFromStatus(400))
  // before ever reaching the pattern above. Asserted here so a future change to
  // either branch can't silently break the real, verbatim production shape —
  // the fixtures above stay as the regression proof for message shapes (or
  // future callers) that don't happen to repeat "400KB".
  it('classifies the real manage_scheduled_chat size-block messages as invalid_args', () => {
    expect(classifyToolErrorClass(err(
      "API error (400): Scheduled chat is too large to save (about 391KB against DynamoDB's 400KB per-item "
      + 'limit) even after dropping saved history. The starting message is 10240 characters — shorten it and try again.'
    ))).toBe('invalid_args');
    expect(classifyToolErrorClass(err(
      "API error (400): Scheduled chat is too large to save — fitting it under DynamoDB's 400KB per-item limit "
      + "would mean dropping 3 saved runs from this schedule's history at once. The starting message is 10240 "
      + 'characters — shorten it and try again.'
    ))).toBe('invalid_args');
    expect(classifyToolErrorClass(err(
      "API error (400): Scheduled chat is too large to save — it exceeds DynamoDB's 400KB per-item limit. "
      + 'Shorten the starting message and try again.'
    ))).toBe('invalid_args');
  });

  // ENG-1672 (code review follow-up): the global `is too large` pattern this
  // added is a deliberate trade-off, not an oversight — it now also classifies
  // pre-existing "too large" messages elsewhere in the app that previously fell
  // through unclassified to the legacy name fallback, including a named error
  // (gmailService.ts's GmailBodyTooLargeError) that used to keep its own
  // distinct class via that same fallback. Locked in here so a future change to
  // either the regex or this error's name can't silently flip this back without
  // a test noticing.
  it('reclassifies GmailBodyTooLargeError to invalid_args (accepted trade-off, was previously its own distinct class)', () => {
    expect(classifyToolErrorClass(err(
      'Email body is too large (HTML content exceeds 50KB). '
      + 'Ask the user to open the email directly in Gmail, or specify which part they want — '
      + 'e.g. "just the subject and sender" or "first paragraph only".',
      'GmailBodyTooLargeError'
    ))).toBe('invalid_args');
  });

  it('classifies not-found and network failures', () => {
    expect(classifyToolErrorClass(err('Request failed with status code 404'))).toBe('not_found');
    expect(classifyToolErrorClass(err('getaddrinfo ENOTFOUND api.example.com'))).toBe('network');
    expect(classifyToolErrorClass(err('connect ECONNREFUSED 127.0.0.1:3001'))).toBe('network');
    expect(classifyToolErrorClass(err('socket hang up'))).toBe('network');
  });

  it('classifies upstream 5xx — the Meta ads cluster', () => {
    expect(classifyToolErrorClass(err('Request failed with status code 502'))).toBe('upstream_5xx');
    expect(classifyToolErrorClass(err('Internal Server Error'))).toBe('upstream_5xx');
    expect(classifyToolErrorClass(err('503 Service Unavailable'))).toBe('upstream_5xx');
    // ENG-394: Meta Graph transient (code 1/2) generic body — NO HTTP status in the
    // string. Regression: previously fell through to legacy 'Error' → non-retryable,
    // so the campaign-listing fallback told the model to give up on a recoverable blip.
    expect(classifyToolErrorClass(err('An unexpected error has occurred. Please retry your request later.'))).toBe('upstream_5xx');
  });

  it('classifies gateway errors by error name', () => {
    expect(classifyToolErrorClass(err('budget exceeded', 'AgentToolBudgetExceededError'))).toBe('repeated_failure');
    expect(classifyToolErrorClass(err('blocked', 'AgentToolPolicyBlockedError'))).toBe('policy_blocked');
    expect(classifyToolErrorClass(err('failed 3 times', 'AgentToolRepeatedFailureError'))).toBe('repeated_failure');
    expect(classifyToolErrorClass(err('bad args', 'AgentToolContractValidationError'))).toBe('invalid_args');
  });

  it('classifies a truncated tool-call-arguments error as truncated_response, distinct from invalid_args (ENG-1477)', () => {
    expect(classifyToolErrorClass(err('cut off mid-object', 'TruncatedToolCallArgumentsError'))).toBe('truncated_response');
  });

  it('uses numeric status properties when the message is unhelpful', () => {
    const withStatus = Object.assign(new Error('request failed'), { status: 429 });
    expect(classifyToolErrorClass(withStatus)).toBe('rate_limit');
    const withStatusCode = Object.assign(new Error('request failed'), { statusCode: 504 });
    expect(classifyToolErrorClass(withStatusCode)).toBe('timeout');
  });

  it('falls back to the legacy name-based class for unrecognized errors', () => {
    expect(classifyToolErrorClass(err('completely novel failure'))).toBe('Error');
    expect(classifyToolErrorClass(err('weird', 'CustomDomainError'))).toBe('CustomDomainError');
    expect(classifyToolErrorClass('string failure')).toBe('StringError');
    expect(classifyToolErrorClass(undefined)).toBe('UnknownError');
  });

  // --- 2026-06-14 real-message fixtures from a 7-day Dev-AW-LoopEvents sweep ---
  // (verbatim production errorMessage values; the prior patterns left 63% of
  //  these in the generic `Error` fallback — see classifier header.)

  it('classifies uninstalled-skill calls — the biggest missed cluster (~41)', () => {
    expect(classifyToolErrorClass(err('Tool "search_tool_response" is not available. You must install the required skill first using install_skills.'))).toBe('tool_unavailable');
    expect(classifyToolErrorClass(err('Tool "linkedin_outreach" is not available. You must install the required skill first using install_skills.'))).toBe('tool_unavailable');
    expect(classifyToolErrorClass(err('Tool "describe_image" is not available. You must install the required skill first using install_skills.'))).toBe('tool_unavailable');
  });

  /*
   * An install_skills refusal is NOT an uninstalled-skill call: the skill exists, the plan does
   * not include it. Left unclassified it fell to the legacy `Error` class, whose default next
   * step ends "...use a different tool" — appended by the dispatcher directly beneath a refusal
   * whose own text forbids substituting another tool's output. That contradiction is how the
   * absence of a gated tool becomes a fabricated result (ENG-1625).
   */
  /*
   * ENG-1795. Our own refusal is matched at the TOP of classFromMessage so a model-authored
   * skill id cannot hijack the class. That hoist must stay ANCHORED to our full sentence:
   * "not available with your current subscription" on its own is ordinary vendor English, and
   * promoting it above the embedded-status guard reclassified a vendor 403 from `auth` to
   * `subscription_blocked` — telling the model to say the capability is off the user's plan
   * when the real remedy is reconnecting the account.
   */
  it('keeps a vendor 403 as auth, even when it mentions a subscription', () => {
    expect(classifyToolErrorClass(err(
      'Request failed with status code 403: this feature is not available with your current subscription.'
    ))).toBe('auth');
  });

  it('classifies OUR refusal as subscription_blocked despite a status-shaped skill id', () => {
    // The id is admin-authored and real; it just happens to start with digits that the
    // embedded-status regex would read as an upstream 500 — which is RETRYABLE.
    expect(classifyToolErrorClass(err(
      'The requested skills are not available with your current subscription: 500-error-playbook.'
      + ' Tell the user plainly that this capability is not on their plan.'
    ))).toBe('subscription_blocked');
  });

  it('classifies a plan-gated install_skills refusal as subscription_blocked', () => {
    expect(classifyToolErrorClass(err(
      "The requested skills are not available with your current subscription."
      + " Tell the user plainly that this capability is not on their plan."
      + " Do NOT substitute a different tool's output for the tool that needed this skill, and do not describe that tool as having run.",
    ))).toBe('subscription_blocked');
  });

  /*
   * The verdict appended after a refusal must not assert what the refusal spends three
   * sentences denying.
   *
   * Every one of these messages exists to stop the model concluding absence. Unclassified they
   * fell to `not_found` — whose next step is literally "the target was not found" — or, after
   * main widened the invalid_args regex with `is too large`, to "fix the arguments" for a
   * filename that was never wrong. The verdict is appended AFTER the message, so it is the last
   * thing the model reads: ENG-1584 rebuilt in the guidance channel.
   */
  it('classifies an incomplete read as read_incomplete, never as not_found', () => {
    expect(classifyToolErrorClass(err(
      'File "ad.png" was not found, but Google Drive rate-limited the scan of folder "X". Wait a minute and try again. Do NOT report the file as absent.',
    ))).toBe('read_incomplete');
    expect(classifyToolErrorClass(err(
      'File "a.png" not found in folder "X" - but the folder scan did not cover the whole tree, so this is not a confirmed absence. Retry.',
    ))).toBe('read_incomplete');
    expect(classifyToolErrorClass(err(
      'the file search itself failed (rate limited). This is a FAILED read, not a confirmed absence. Retry the read.',
    ))).toBe('read_incomplete');
    expect(classifyToolErrorClass(err(
      'Google Drive is rate-limiting this account right now - a temporary quota answer. Wait a minute and retry.',
    ))).toBe('read_incomplete');
  });

  /*
   * A file or folder NAME must not change the verdict.
   *
   * The embedded-status regex matches any whitespace-preceded 3-digit 4xx/5xx-shaped number, and
   * these messages interpolate ${fileName}/${rootName}. It ran before the incomplete-read branch,
   * so "Landing 404 Copy.docx" classified not_found and appended "the target was not found"
   * directly beneath "Do NOT report the file as absent" — ENG-1584 restored by a customer's
   * choice of filename. "Creative 500x500.png" is an everyday ad dimension in this product.
   */
  it.each([
    'Client Assets',
    'Landing 404 Copy.docx',
    'Studio 403 Shared',
    'Creative 500x500.png',
    'Fortune 500 Clients',
  ])('a name containing a status-shaped number does not hijack the class (%s)', (name) => {
    const msg =
      `File "${name}" was not found, but Google Drive rate-limited the scan of folder "${name}". `
      + 'Wait a minute and try again. Do NOT report the file as absent.';
    expect(classifyToolErrorClass(err(msg))).toBe('read_incomplete');
  });

  it('separates a DETERMINISTIC bound, which must not be retried, from a transient one', () => {
    // The capped-search message says "Do NOT retry this same call ... will stop in the same
    // place every time". A Retryable: yes beneath that is the same contradiction one level down.
    expect(classifyToolErrorClass(err(
      'This is an INCOMPLETE read, not a confirmed absence: do not report the file as missing. '
      + 'Do NOT retry this same call - a tree this large will stop in the same place every time.',
    ))).toBe('read_bounded');
  });

  /*
   * scope_refused must key on the MISMATCH branch only.
   *
   * assertOwnedByAccount deliberately varies its remedy across three branches, and the classifier
   * collapsing them into one class would attach "select the account that owns it" to the two
   * branches where that is false — including the branch account_id ?? '' deliberately routes an
   * unresolved credential into, which would have told a user their OWN object belongs to someone
   * else's ad account.
   */
  it('classifies the ownership MISMATCH branch as scope_refused, and the other two branches as upstream_5xx', () => {
    const M = 'is not available in the selected ad account';
    const mismatch = `The requested ad ${M}. If it belongs to a different ad account, select that account and try again.`;
    const noOwner = `The requested ad ${M}. Meta did not report which ad account owns it, so ownership could not be CONFIRMED — this is a failed check, not a proven mismatch. Retry; if it persists, verify the object in Meta Ads Manager.`;
    const noAccount = `The requested ad ${M}. No ad account could be determined for this request, so ownership could not be checked. This is a connection problem, not a permissions one — reconnect Meta in Settings.`;

    expect(classifyToolErrorClass(err(mismatch))).toBe('scope_refused');
    expect(classifyToolErrorClass(err(noOwner))).toBe('upstream_5xx');
    expect(classifyToolErrorClass(err(noAccount))).toBe('upstream_5xx');
  });

  it('main\'s "is too large" invalid_args rule no longer swallows a Drive capped read', () => {
    /*
     * Asserted against the REAL message, not a paraphrase.
     *
     * ENG-1672 widened invalid_args with `is too large`, and the Drive capped message used to end
     * "this folder is too large to search within the read budget" — they met at auto-merge and
     * the model was told to fix a filename that was never wrong.
     *
     * The first version of this test asserted `not.toBe('invalid_args')` on a hand-written
     * fragment, which classified as the legacy `Error` and so passed before the fix as well as
     * after: it proved nothing. Pinning the sentence `driveNameSearchIncompleteMessage` actually
     * emits means a reword that reintroduces the collision fails here.
     */
    const REAL_CAPPED_MESSAGE =
      'File "notes.txt" was not found, but the file search ran out of its time budget before it '
      + 'had covered the whole folder tree. This is an INCOMPLETE read, not a confirmed absence: '
      + 'do not report the file as missing. Do NOT retry this same call — the budget is a fixed '
      + 'wall-clock bound spent walking this folder\'s sub-folders, so a tree this large will stop '
      + 'in the same place every time. The only thing that changes the outcome is a SMALLER '
      + 'search scope: ask the user for the file\'s direct Google Drive link, or for the specific '
      + 'sub-folder it lives in so that sub-folder can be registered as its own knowledge base '
      + 'source. If neither is available, tell the user plainly that this folder exceeded the '
      + 'read budget for a single search — do not describe it as a temporary glitch and do not '
      + 'try again.';

    // Positively classified, not merely "not invalid_args" — a message that matched nothing
    // would satisfy the negative alone.
    expect(classifyToolErrorClass(err(REAL_CAPPED_MESSAGE))).toBe('read_bounded');
    expect(classifyToolErrorClass(err(REAL_CAPPED_MESSAGE))).not.toBe('invalid_args');

    // And the collision itself: the old wording WOULD have been swallowed, which is what makes
    // the assertion above meaningful rather than incidental.
    expect(classifyToolErrorClass(err(
      'tell the user plainly that this folder is too large to search within the read budget',
    ))).toBe('invalid_args');
  });

  it('classifies bad skill ids as invalid_args, not as a plan problem', () => {
    // The model's fault, not the subscription's — the remedy is different.
    expect(classifyToolErrorClass(err('No valid skills found for the provided IDs.'))).toBe('invalid_args');
  });

  it('classifies contract/schema-validation rejections as invalid_args (~45)', () => {
    expect(classifyToolErrorClass(err('Tool "read_tool_response" arguments failed schema validation before execution. Argument "char_offset" has the wrong type. Expected number.'))).toBe('invalid_args');
    expect(classifyToolErrorClass(err('Tool "wait_seconds" arguments failed schema validation before execution. Missing required argument "reason".'))).toBe('invalid_args');
    expect(classifyToolErrorClass(err('Both s3_key and query are required'))).toBe('invalid_args');
    expect(classifyToolErrorClass(err('Missing required variables: total_spend, total_leads, avg_cpl'))).toBe('invalid_args');
  });

  it('classifies LinkedIn business-rule refusals as upstream_rejected (~28)', () => {
    expect(classifyToolErrorClass(err('Cannot resend yet'))).toBe('upstream_rejected');
    expect(classifyToolErrorClass(err('Should delay new invitation to this recipient'))).toBe('upstream_rejected');
    expect(classifyToolErrorClass(err('Recipient cannot be reached'))).toBe('upstream_rejected');
    expect(classifyToolErrorClass(err('Cannot send message: target is not a 1st-degree connection (status: SECOND_DEGREE). Use the send-invite action first to connect.'))).toBe('upstream_rejected');
    expect(classifyToolErrorClass(err('Cannot send invite: you are already connected with this person (network_distance: FIRST_DEGREE).'))).toBe('upstream_rejected');
  });

  it('classifies empty/no-data results as empty_result (~9)', () => {
    expect(classifyToolErrorClass(err('No search results found'))).toBe('empty_result');
    expect(classifyToolErrorClass(err('Unable to retrieve a Summarizer summary.'))).toBe('empty_result');
    expect(classifyToolErrorClass(err('No analysis results received from Gemini'))).toBe('empty_result');
  });

  it('classifies permission / missing-connection failures as auth', () => {
    expect(classifyToolErrorClass(err('Not authorized to edit this landing page. The org owner needs to add you as an editor.'))).toBe('auth');
    expect(classifyToolErrorClass(err('You do not have permission to add leads to this list'))).toBe('auth');
    expect(classifyToolErrorClass(err('No Fathom account connected. Please connect your Fathom account in Settings → Connected Accounts to use this tool.'))).toBe('auth');
    expect(classifyToolErrorClass(err('The Slack bot is not a member of channel C09JUSTFITKITCHEN. Please invite the bot to the channel first.'))).toBe('auth');
    expect(classifyToolErrorClass(err('MCP: User "67bec77c" has no secrets configured. Required for server "github".'))).toBe('auth');
    expect(classifyToolErrorClass(err('Ad account not configured'))).toBe('auth');
    expect(classifyToolErrorClass(err('Your application is not configured to access the related advertiser account(s), please ensure you have added the account ID(s) in your Account Management list.'))).toBe('auth');
  });

  it('classifies aborts as timeout and missing resources as not_found', () => {
    expect(classifyToolErrorClass(err('This operation was aborted'))).toBe('timeout');
    expect(classifyToolErrorClass(err('The specified bucket does not exist'))).toBe('not_found');
    expect(classifyToolErrorClass(err('The specified lead list does not exist'))).toBe('not_found');
  });

  it('classifies a verbatim multiline provider 429 payload as rate_limit', () => {
    const provider429 =
      '429 Too Many Requests\n{\n  "type": "ErrorResponse",\n  "error": {\n    "id": "5df087ef",\n    "status": 429,\n    "detail": "Request rate limit exceeded for plan",\n    "meta": { "plan": "Free" }\n  }\n}';
    expect(classifyToolErrorClass(err(provider429))).toBe('rate_limit');
  });

  it('classifies a ToolOutputContractError as invalid_output, distinct from execution failures (ENG-105)', () => {
    expect(classifyToolErrorClass(new ToolOutputContractError('Tool returned no output (null/undefined).'))).toBe('invalid_output');
  });

  it('leaves genuinely idiosyncratic one-offs in the legacy fallback', () => {
    // These do not form a clusterable class — correct to keep them as `Error`.
    expect(classifyToolErrorClass(err('Tool returned success=false'))).toBe('Error');
    expect(classifyToolErrorClass(err('An unknown error has occurred.'))).toBe('Error');
    expect(classifyToolErrorClass(err('Replacement 1 failed: File hash mismatch.'))).toBe('Error');
  });
});

/**
 * ENG-664 — X 402 (shared X wallet out of credits) must classify to a stable,
 * distinct class so it clusters in telemetry and a mid-run 402 never reads as a
 * generic 'Error'/bug. X errors carry the HTTP status on `.code` (not `.status`).
 */
describe('payment_required — X credit exhaustion (402)', () => {
  it('classifies an X ApiResponseError 402 (status on .code)', () => {
    const err = Object.assign(new Error('Request failed with code 402'), { code: 402 });
    expect(classifyToolErrorClass(err)).toBe('payment_required');
  });

  it('classifies a typed XCreditsExhaustedError by name (crosses module boundaries)', () => {
    const err = Object.assign(new Error('out of credits'), { name: 'XCreditsExhaustedError' });
    expect(classifyToolErrorClass(err)).toBe('payment_required');
  });

  it('classifies a 402 embedded in the message text', () => {
    expect(classifyToolErrorClass('X API error (HTTP 402): credits depleted')).toBe('payment_required');
  });

  it('does not misclassify a 403 as payment_required', () => {
    const err = Object.assign(new Error('Request failed with code 403'), { code: 403 });
    expect(classifyToolErrorClass(err)).toBe('auth');
  });
});

// ENG-1626 (CodeRabbit): DynamoDB throttling from the AWS SDK v2 carries the
// exception name as a STRING .code (not .status/.statusCode), and typically
// ALSO carries a numeric statusCode of 400 -- classFromStatus(400) returns
// 'invalid_args', so the string-code check must run before the numeric
// status check or it never gets a chance to fire.
describe('rate_limit — AWS SDK v2 DynamoDB throttling (ENG-1626)', () => {
  it('classifies ThrottlingException as rate_limit even with statusCode 400', () => {
    const err = Object.assign(new Error('Throttling'), { code: 'ThrottlingException', statusCode: 400 });
    expect(classifyToolErrorClass(err)).toBe('rate_limit');
  });

  it('classifies ProvisionedThroughputExceededException as rate_limit even with statusCode 400', () => {
    const err = Object.assign(new Error('Rate exceeded'), { code: 'ProvisionedThroughputExceededException', statusCode: 400 });
    expect(classifyToolErrorClass(err)).toBe('rate_limit');
  });

  it('classifies ThrottlingException as rate_limit with no statusCode at all', () => {
    const err = Object.assign(new Error('Throttling'), { code: 'ThrottlingException' });
    expect(classifyToolErrorClass(err)).toBe('rate_limit');
  });
});

// ENG-1844: the landing-page generate/duplicate routes' brand-logo 422 reaches the model
// as `API error (422): No brand logo is saved...` via httpClient.ts's self-call Error.
// The embedded-status regex requires whitespace/start-of-string before the digits, but
// "(422)" has "(" immediately before them, so it never matched — this fell all the way to
// the generic unclassified fallback. httpClient.ts now preserves the route's own
// `missing_brand_logo` marker on `.code` (separately from the human `.message`), so this
// must classify by that STRING code, not by the numeric status at all.
describe('missing_brand_logo — brand-logo content gate (ENG-1844)', () => {
  it('classifies by the .code marker even though the message embeds "(422)" unmatchably', () => {
    const err = Object.assign(
      new Error(
        'API error (422): No brand logo is saved in Brand Guidelines. Upload your logo in brand config (Brand Guidelines), then generate again — landing pages are never generated with an invented or approximate logo.'
      ),
      { code: MISSING_BRAND_LOGO_ERROR }
    );
    expect(classifyToolErrorClass(err)).toBe('missing_brand_logo');
  });

  it('falls back to invalid_args for an ordinary 422 with no .code marker (no regression)', () => {
    const err = Object.assign(new Error('API error (422): "prompt" is required'), { status: 422 });
    expect(classifyToolErrorClass(err)).toBe('invalid_args');
  });
});

// ENG-1162: a publisher (not an AgentWeb-connected account) refusing or failing to serve a
// plain external fetch — read_file_content's own 401/403 marker, or a Chromium/Playwright
// browser-navigation net-error — must not be swept into 'auth' ("reconnect the account" is
// nonsensical for an anonymous read) nor left in the unclassified legacy fallback (no signal
// that the failed read is not evidence the content is missing).
describe('publisher_refused — publisher/site blocks on a plain external fetch (ENG-1162)', () => {
  it('classifies a browser navigation net::ERR_* failure as publisher_refused, not the legacy fallback', () => {
    expect(classifyToolErrorClass(err(
      'page.goto: net::ERR_EMPTY_RESPONSE at https://ramaonhealthcare.com/hhs-working-to-strike-medicaid-work-requirement-deal-with-blue-states/'
    ))).toBe('publisher_refused');
    expect(classifyToolErrorClass(err('net::ERR_CONNECTION_REFUSED at https://example.com/'))).toBe('publisher_refused');
  });

  it('classifies read_file_content\'s publisher-refusal marker as publisher_refused, not auth', () => {
    expect(classifyToolErrorClass(err(
      'The publisher refused this fetch (HTTP 403: Forbidden) — this is a site-side access block '
      + '(bot filtering, WAF, or paywall), not an AgentWeb account or permissions problem.'
    ))).toBe('publisher_refused');
  });

  it('leaves an unrelated bare 401/403 (e.g. a connected-account API) classified as auth', () => {
    expect(classifyToolErrorClass(err('HTTP 403: Forbidden'))).toBe('auth');
    expect(classifyToolErrorClass(err('403 Forbidden'))).toBe('auth');
    expect(classifyToolErrorClass(err('Request failed with status code 401'))).toBe('auth');
  });
});

describe('create_html_file Error-class cluster (ENG-1627)', () => {
  // Verbatim shapes from prod Dev-AW-LoopEvents agent_tool_failed rows for
  // create_html_file that were still bucketed as generic `Error`.
  it('classifies private-image size limits as invalid_args, not generic Error', () => {
    expect(classifyToolErrorClass(err(
      'Could not inline private image https://agentweb-user-files.s3.us-west-2.amazonaws.com/users/u/brand/logo/1.png: decoded image exceeds the 5 MB limit. Reduce the image size or image count, confirm the asset is still accessible, and retry.',
    ))).toBe('invalid_args');
    expect(classifyToolErrorClass(err(
      'Private images exceed the 20 MB aggregate decoded limit after 4 images were inlined; offending asset: https://agentweb-user-files.s3.us-west-2.amazonaws.com/users/u/files/1/a.png. Reduce image sizes or image count and retry; no partial document was created.',
    ))).toBe('invalid_args');
    expect(classifyToolErrorClass(err(
      'Private image exceeds the 5 MB decoded limit: https://x/a.png. Reduce the image size and retry; the document was not created with a broken image.',
    ))).toBe('invalid_args');
  });

  it('keeps a private-image access failure out of invalid_args', () => {
    expect(classifyToolErrorClass(err(
      'Could not inline private image https://x/a.png: The specified key does not exist.. Reduce the image size or image count, confirm the asset is still accessible, and retry.',
    ))).toBe('not_found');
  });

  it('classifies malformed tool-call JSON as invalid_args even when the position looks like a status code', () => {
    expect(classifyToolErrorClass(err(
      "Failed to parse arguments: Expected ',' or '}' after property value in JSON at position 87 (line 1 column 88)",
    ))).toBe('invalid_args');
    expect(classifyToolErrorClass(err(
      "Failed to parse arguments: Expected ',' or '}' after property value in JSON at position 503 (line 1 column 504)",
    ))).toBe('invalid_args');
  });

  it('classifies cut-off tool-call JSON as truncated_response (retryable)', () => {
    expect(classifyToolErrorClass(err(
      'Failed to parse arguments: The arguments for this tool call were cut off before the JSON object was complete (received 1441 character(s), ending mid-object).',
    ))).toBe('truncated_response');
  });
});
