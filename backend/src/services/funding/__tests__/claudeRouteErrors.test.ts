import {
  ClaudeRouteStopError,
  claudeStopBody,
  fromHostFailure,
  fromResultErrorKind,
  stopFromReason,
  type ClaudeStopCode,
} from '../claudeRouteErrors';
import { LoginHostError } from '../loginHostClient';
import type { StopReason } from '../subscriptionRoute';

const ALL_REASONS: StopReason[] = ['not_enabled', 'not_allowed_here', 'model_not_on_plan', 'no_connection', 'needs_reconnect', 'expired', 'revoked_or_disabled', 'lookup_failed'];

describe('claude plan stops', () => {
  it('every route-decision stop has copy, a status and a stable code', () => {
    for (const reason of ALL_REASONS) {
      const e = stopFromReason(reason);
      expect(e.code).toBe(reason);
      expect(e.userMessage.length).toBeGreaterThan(20);
      expect(e.httpStatus).toBeGreaterThanOrEqual(400);
      expect(e.markNeedsReconnect).toBe(false);
    }
  });

  it('the body is fixed copy, never the underlying failure', () => {
    const e = fromHostFailure(new LoginHostError('UNREACHABLE', 'ECONNREFUSED 10.0.1.5:8443'))!;
    const body = claudeStopBody(e);
    expect(body).toEqual({ error: e.userMessage, code: 'host_unavailable', funding: 'claude_subscription', retryable: true });
    expect(JSON.stringify(body)).not.toMatch(/10\.0\.1\.5|ECONNREFUSED|8443/);
  });

  it('never names AgentWeb as a silent fallback: every stop tells the user what to do', () => {
    const codes: ClaudeStopCode[] = [...ALL_REASONS, 'host_unavailable', 'host_busy', 'connection_changed', 'context_too_large', 'usage_limit', 'policy_blocks', 'turn_failed'];
    for (const code of codes) {
      const msg = new ClaudeRouteStopError(code).userMessage;
      expect(msg).not.toMatch(/falling back|switched to|using AgentWeb/i);
    }
  });

  describe('host failures', () => {
    const cases: Array<[ConstructorParameters<typeof LoginHostError>, ClaudeStopCode, boolean]> = [
      [['EBUSY'], 'host_busy', false],
      [['ESTALE'], 'connection_changed', false],
      [['ENOTFOUND'], 'needs_reconnect', true],
      [['ESTATE'], 'needs_reconnect', true],
      [['EHAZARD'], 'policy_blocks', false],
      [['UNREACHABLE', 'ECONNREFUSED'], 'host_unavailable', false],
      [['TIMEOUT', 'connect'], 'host_unavailable', false],
      [['BAD_RESPONSE'], 'host_unavailable', false],
      [['EINVALID'], 'turn_failed', false],
      [['EEXISTS'], 'turn_failed', false],
      [['EUNSUPPORTED'], 'turn_failed', false],
      [['EINTERNAL'], 'turn_failed', false],
    ];
    it.each(cases)('%j -> %s (mark reconnect: %s)', (args, code, mark) => {
      const e = fromHostFailure(new LoginHostError(...args))!;
      expect(e.code).toBe(code);
      expect(e.markNeedsReconnect).toBe(mark);
    });

    it('leaves a failure it does not own to the caller', () => {
      expect(fromHostFailure(new Error('anything'))).toBeUndefined();
      expect(fromHostFailure(undefined)).toBeUndefined();
      expect(fromHostFailure('EBUSY')).toBeUndefined();
    });
  });

  describe('turn results', () => {
    it('a dead login marks the connection for reconnect; nothing else does', () => {
      expect(fromResultErrorKind('auth_dead')).toMatchObject({ code: 'needs_reconnect', markNeedsReconnect: true });
      expect(fromResultErrorKind('refresh_reused')).toMatchObject({ code: 'needs_reconnect', markNeedsReconnect: true });
      for (const kind of ['usage_limit', 'transient', 'device_code_disabled', 'policy_blocks', 'unknown', undefined] as const) {
        expect(fromResultErrorKind(kind).markNeedsReconnect).toBe(false);
      }
    });

    it('maps the plan limit, policy and transient kinds', () => {
      expect(fromResultErrorKind('usage_limit').code).toBe('usage_limit');
      expect(fromResultErrorKind('policy_blocks').code).toBe('policy_blocks');
      expect(fromResultErrorKind('transient').code).toBe('host_unavailable');
      expect(fromResultErrorKind('unknown').code).toBe('turn_failed');
      expect(fromResultErrorKind(undefined).code).toBe('turn_failed');
    });
  });
});
