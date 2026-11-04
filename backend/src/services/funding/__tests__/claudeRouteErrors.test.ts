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

/** Every stop that is not a route-decision reason: its status and whether asking again can help. Pinned so a change is deliberate. */
const EXPECTED: Record<string, { httpStatus: number; retryable: boolean }> = {
  host_unavailable: { httpStatus: 503, retryable: true },
  host_busy: { httpStatus: 429, retryable: true },
  connection_changed: { httpStatus: 409, retryable: true },
  context_too_large: { httpStatus: 413, retryable: false },
  usage_limit: { httpStatus: 429, retryable: false },
  policy_blocks: { httpStatus: 409, retryable: false },
  turn_failed: { httpStatus: 502, retryable: true },
  invalid_funding_choice: { httpStatus: 400, retryable: false },
  turn_timeout: { httpStatus: 504, retryable: false },
  server_restarting: { httpStatus: 503, retryable: true },
  extra_usage_needs_ack: { httpStatus: 409, retryable: false },
  org_not_supported: { httpStatus: 403, retryable: false },
  tools_too_large_for_plan: { httpStatus: 422, retryable: false },
  tools_unavailable_for_plan: { httpStatus: 503, retryable: true },
};

describe('claude plan stops', () => {
  it.each(Object.entries(EXPECTED))('%s has its pinned status and retry flag', (code, want) => {
    const e = new ClaudeRouteStopError(code as ClaudeStopCode);
    expect({ httpStatus: e.httpStatus, retryable: e.retryable }).toEqual(want);
    expect(claudeStopBody(e).retryable).toBe(want.retryable);
  });

  it('tools_too_large_for_plan: the exact (approved) copy, not retryable, AgentWeb credits offered', () => {
    const e = new ClaudeRouteStopError('tools_too_large_for_plan');
    expect(claudeStopBody(e)).toEqual({
      error: "A tool connected to your account can't be used with your Claude plan. Disconnect it in Settings, or continue on AgentWeb credits.",
      code: 'tools_too_large_for_plan',
      funding: 'claude_subscription',
      retryable: false,
      canUseAgentWebCredits: true,
    });
  });

  it('tools_unavailable_for_plan: the exact (approved) copy, retryable, AgentWeb credits offered', () => {
    expect(claudeStopBody(new ClaudeRouteStopError('tools_unavailable_for_plan'))).toEqual({
      error: "We couldn't prepare your tools for your Claude plan. Please try again, or continue on AgentWeb credits.",
      code: 'tools_unavailable_for_plan',
      funding: 'claude_subscription',
      retryable: true,
      canUseAgentWebCredits: true,
    });
  });

  it('a model the plan cannot run is not retryable', () => {
    expect(new ClaudeRouteStopError('model_not_on_plan').retryable).toBe(false);
  });

  it('the host ending a turn at its deadline is the timeout stop whatever the error kind said', () => {
    expect(fromResultErrorKind(undefined, 'deadline').code).toBe('turn_timeout');
    expect(fromResultErrorKind('transient', 'deadline').code).toBe('turn_timeout');
    expect(fromResultErrorKind('transient', 'interrupted').code).toBe('host_unavailable');
  });

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
    expect(body).toEqual({ error: e.userMessage, code: 'host_unavailable', funding: 'claude_subscription', retryable: true, canUseAgentWebCredits: true });
    expect(JSON.stringify(body)).not.toMatch(/10\.0\.1\.5|ECONNREFUSED|8443/);
  });

  it('never names AgentWeb as a silent fallback: every stop tells the user what to do', () => {
    const codes: ClaudeStopCode[] = [...ALL_REASONS, ...Object.keys(EXPECTED) as ClaudeStopCode[]];
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

describe('which stops offer AgentWeb credits (the user decides; nothing moves on its own)', () => {
  const OFFERED: ClaudeStopCode[] = ['no_connection', 'needs_reconnect', 'expired', 'revoked_or_disabled', 'lookup_failed', 'host_unavailable', 'host_busy', 'usage_limit', 'turn_failed', 'model_not_on_plan', 'tools_too_large_for_plan', 'tools_unavailable_for_plan'];
  const NOT_OFFERED: ClaudeStopCode[] = [
    'not_enabled', 'not_allowed_here', 'connection_changed', 'context_too_large', 'policy_blocks', 'invalid_funding_choice', 'turn_timeout', 'server_restarting',
    'extra_usage_needs_ack', 'org_not_supported',
  ];

  it.each(OFFERED)('%s is offered', (code) => {
    expect(claudeStopBody(new ClaudeRouteStopError(code)).canUseAgentWebCredits).toBe(true);
  });
  it.each(NOT_OFFERED)('%s is not offered', (code) => {
    expect(claudeStopBody(new ClaudeRouteStopError(code)).canUseAgentWebCredits).toBe(false);
  });
  it('every stop code is decided one way or the other (a new code must not default silently)', () => {
    const decided = new Set<string>([...OFFERED, ...NOT_OFFERED]);
    for (const code of Object.keys(EXPECTED)) expect(decided.has(code)).toBe(true);
    for (const r of ALL_REASONS) expect(decided.has(r)).toBe(true);
  });
});
