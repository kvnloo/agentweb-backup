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
 *      correctly (LinkedIn arg validation, Brave 429s, Meta 5xx).
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

  it('classifies rate limits — the Brave search cluster', () => {
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
});
