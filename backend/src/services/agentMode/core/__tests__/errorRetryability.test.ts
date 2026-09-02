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

describe('a refusal that forbids substitution is never handed a "use a different tool" verdict', () => {
  /*
   * The bug this pins: install_skills' plan refusal says "Do NOT substitute a different tool's
   * output". Unclassified, it took DEFAULT_NEXT_STEP — "...use a different tool..." — and the
   * dispatcher appended that directly underneath. The last line the model reads was an
   * instruction to do the thing the line above forbids, which is the ENG-1625 fabricated
   * "UTM Tagging Audit Summary — PASS, 6/6 tagged".
   */
  it('subscription_blocked tells the model to report, never to substitute', () => {
    const line = retryabilityLine('subscription_blocked');
    expect(line).toContain('Retryable: no');
    expect(line.toLowerCase()).toContain('do not substitute');
    expect(line.toLowerCase()).not.toContain('use a different tool');
  });

  it('tool_unavailable no longer suggests substituting either', () => {
    // Same hazard one wiring change away: this class is what an uninstalled gated tool throws.
    const line = retryabilityLine('tool_unavailable');
    expect(line).toContain('install_skills');
    expect(line.toLowerCase()).not.toContain('use a different tool');
  });

  it('end to end: the appended verdict does not contradict the refusal above it', () => {
    const refusal =
      "⚠️ Tool Error: install_skills\nReason: The requested skills are not available with your current"
      + " subscription. Do NOT substitute a different tool's output for the tool that needed this skill.";
    const out = appendRetryabilityGuidance(refusal, 'subscription_blocked');
    expect(out).toContain(refusal);
    expect(out.toLowerCase()).not.toContain('use a different tool');
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
