/**
 * ENG-1526 / ENG-1322 — an approval token must survive the tool-result minimizer.
 *
 * Both gates halt, disclose, and issue an HMAC the caller is told to replay "exactly as
 * returned here". `extractMinimalToolResult` discards everything it does not explicitly
 * name, and its confirmation branch named neither token — so the model was handed an
 * instruction it could not follow. The override could never be applied and the removal
 * could never be completed, no matter how many times a user approved.
 *
 * It failed CLOSED, which is why it went unnoticed: the tracking gate simply kept
 * blocking. But a recovery path callers cannot complete is one they route around, and
 * ENG-1526's own "the path is a loop, not a dead end" was untrue in production.
 *
 * Caught by driving the real agent on prod, NOT by the handler tests — those call the
 * dispatcher directly and never reach the minimizer, so they proved the tokens were
 * ISSUED while saying nothing about whether they were DELIVERED. That gap is exactly what
 * these tests close.
 */
import { AgentModeService } from '../services/agentModeService';

// Private instance method, and its signature is (result, toolName) — not the other way
// round. Reached through the instance so the test exercises the real function rather than
// a re-implementation of it.
const service = new AgentModeService();
const minimize = (result: unknown) =>
  (service as any).extractMinimalToolResult(result, 'call_google_ads_api');

const halt = (extra: Record<string, unknown>) => ({
  success: true,
  requiresConfirmation: true,
  awaitingUserConfirmation: true,
  confirmationPrompt: 'prompt',
  confirmationDetail: 'detail',
  summary: 'summary',
  ...extra,
});

describe('ENG-1526 approval tokens survive the minimizer', () => {
  it('relays tracking_override_token from a launch-waiver halt', () => {
    const out = minimize(halt({ tracking_override_token: 'abc123digest' }));
    expect(out.tracking_override_token).toBe('abc123digest');
  });

  it('relays conversion_action_removal_token from a removal halt', () => {
    const out = minimize(halt({ conversion_action_removal_token: 'def456digest' }));
    expect(out.conversion_action_removal_token).toBe('def456digest');
  });

  it('keeps the halt itself intact — the token is additive, not a replacement', () => {
    const out = minimize(halt({ tracking_override_token: 'abc123digest' }));
    expect(out.awaitingUserConfirmation).toBe(true);
    expect(out.requiresConfirmation).toBe(true);
    expect(out.confirmationPrompt).toBe('prompt');
    expect(out.summary).toBe('summary');
  });

  it('emits no token key when the halt issued none', () => {
    // A confirmation that waives nothing needs no token, and inventing an undefined key
    // would tell the model to replay something that does not exist.
    const out = minimize(halt({}));
    expect('tracking_override_token' in out).toBe(false);
    expect('conversion_action_removal_token' in out).toBe(false);
  });

  it('does not relay unrelated fields — the branch stays an allowlist', () => {
    // The minimizer's whole purpose is dropping what it does not name. This fix widens it
    // by exactly two fields, not into a passthrough.
    const out = minimize(halt({ access_token: 'SECRET', internalState: { a: 1 } }));
    expect('access_token' in out).toBe(false);
    expect('internalState' in out).toBe(false);
  });
});
