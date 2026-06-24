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

  it('classifies rate limits', () => {
    expect(classifyToolErrorClass(err('Request failed with status code 429'))).toBe('rate_limit');
    expect(classifyToolErrorClass(err('Too Many Requests'))).toBe('rate_limit');
    expect(classifyToolErrorClass(err('Rate limit exceeded, retry in 2s'))).toBe('rate_limit');
  });

  it('classifies argument validation — the LinkedIn outreach cluster', () => {
    expect(classifyToolErrorClass(err('Invitation message is too long (224 characters). Max is 200.'))).toBe('invalid_args');
    expect(classifyToolErrorClass(err('Invalid parameters'))).toBe('invalid_args');
    expect(classifyToolErrorClass(err('Validation failed: url is required'))).toBe('invalid_args');
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
  });

  it('classifies gateway errors by error name', () => {
    expect(classifyToolErrorClass(err('budget exceeded', 'AgentToolBudgetExceededError'))).toBe('repeated_failure');
    expect(classifyToolErrorClass(err('blocked', 'AgentToolPolicyBlockedError'))).toBe('policy_blocked');
    expect(classifyToolErrorClass(err('failed 3 times', 'AgentToolRepeatedFailureError'))).toBe('repeated_failure');
    expect(classifyToolErrorClass(err('bad args', 'AgentToolContractValidationError'))).toBe('invalid_args');
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

  it('leaves genuinely idiosyncratic one-offs in the legacy fallback', () => {
    // These do not form a clusterable class — correct to keep them as `Error`.
    expect(classifyToolErrorClass(err('Tool returned success=false'))).toBe('Error');
    expect(classifyToolErrorClass(err('An unknown error has occurred.'))).toBe('Error');
    expect(classifyToolErrorClass(err('Replacement 1 failed: File hash mismatch.'))).toBe('Error');
  });
});
