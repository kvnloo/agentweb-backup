/**
 * Tests for instructive-error retryability at the gateway edge (ENG-124 —
 * retry-spiral half). Every tool error fed back to the model must carry an
 * explicit retryable: yes/no verdict + an actionable next step, derived from
 * the toolErrorClassifier classes:
 *   rate_limit / timeout / network / upstream_5xx      → retryable
 *   auth / upstream_rejected / invalid_args (schema
 *   reject) / tool_unavailable / invalid_output /
 *   policy_blocked                                     → NOT retryable (stop retrying)
 *
 * The non-retryable classes additionally FAST-TRIP the per-run circuit breaker
 * (threshold 2 instead of 3) — asserted in agentToolGatewayService.test.ts.
 */

import {
  isRetryableErrorClass,
  isFastTripErrorClass,
  retryabilityLine,
  appendRetryabilityGuidance,
} from '../errorRetryability';

describe('isRetryableErrorClass', () => {
  it.each(['rate_limit', 'timeout', 'network', 'upstream_5xx'])(
    'transient class %s is retryable',
    (cls) => expect(isRetryableErrorClass(cls)).toBe(true),
  );

  it.each(['auth', 'upstream_rejected', 'invalid_args', 'tool_unavailable', 'invalid_output', 'policy_blocked'])(
    'terminal class %s is NOT retryable',
    (cls) => expect(isRetryableErrorClass(cls)).toBe(false),
  );

  it('an unknown/legacy class defaults to NOT retryable (no blind retries)', () => {
    expect(isRetryableErrorClass('Error')).toBe(false);
    expect(isRetryableErrorClass('SomeCustomError')).toBe(false);
  });
});

describe('isFastTripErrorClass', () => {
  it.each(['auth', 'upstream_rejected', 'invalid_args', 'tool_unavailable', 'invalid_output', 'policy_blocked'])(
    'known-pointless-retry class %s fast-trips the breaker',
    (cls) => expect(isFastTripErrorClass(cls)).toBe(true),
  );

  it.each(['rate_limit', 'timeout', 'network', 'upstream_5xx', 'empty_result', 'not_found', 'Error'])(
    'class %s keeps the default breaker threshold',
    (cls) => expect(isFastTripErrorClass(cls)).toBe(false),
  );
});

describe('retryabilityLine', () => {
  it('retryable classes say yes with a wait/retry next step', () => {
    const line = retryabilityLine('rate_limit');
    expect(line).toContain('Retryable: yes');
    expect(line.toLowerCase()).toContain('wait');
  });

  it('auth says no and tells the model to stop retrying', () => {
    const line = retryabilityLine('auth');
    expect(line).toContain('Retryable: no');
    expect(line).toContain('Do NOT retry');
  });

  it('upstream_rejected says no — the provider deliberately refused', () => {
    const line = retryabilityLine('upstream_rejected');
    expect(line).toContain('Retryable: no');
    expect(line).toContain('Do NOT retry');
  });

  it('invalid_args says no as-is — fix the arguments first', () => {
    const line = retryabilityLine('invalid_args');
    expect(line).toContain('Retryable: no');
    expect(line.toLowerCase()).toContain('argument');
  });

  it('unknown class gets the conservative default (no identical retry)', () => {
    const line = retryabilityLine('Error');
    expect(line).toContain('Retryable: no');
  });
});

describe('appendRetryabilityGuidance', () => {
  it('appends the verdict line on its own line after the formatted error', () => {
    const out = appendRetryabilityGuidance('⚠️ Tool Error: send_email\nReason: Unauthorized', 'auth');
    expect(out.startsWith('⚠️ Tool Error: send_email\nReason: Unauthorized\n')).toBe(true);
    expect(out.split('\n').pop()).toContain('Retryable: no');
  });

  it('preserves the formatted error verbatim (what failed stays intact)', () => {
    const formatted = '⚠️ Tool Error: you_search_web\nReason: 429 too many requests';
    const out = appendRetryabilityGuidance(formatted, 'rate_limit');
    expect(out).toContain(formatted);
    expect(out).toContain('Retryable: yes');
  });
});
