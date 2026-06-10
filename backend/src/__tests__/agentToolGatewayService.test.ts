import {
  AgentToolPolicyBlockedError,
  executeAgentToolThroughGateway,
  evaluateAgentToolPolicy,
  summarizeAgentToolPolicyFlags,
  summarizeAgentToolPolicyModes,
} from '../services/agentToolGatewayService';

describe('agentToolGatewayService', () => {
  it('treats read tools as low-risk and allowed', () => {
    const decision = evaluateAgentToolPolicy({
      toolName: 'search_web',
      args: { query: 'agent reliability architecture' },
    });

    expect(decision).toMatchObject({
      allowed: true,
      mode: 'observe',
      effect: 'read',
      risk: 'low',
      flags: [],
    });
  });

  it('flags external send tools as high-risk and confirmation recommended', () => {
    const decision = evaluateAgentToolPolicy({
      toolName: 'send_email',
      args: { to: 'customer@example.com', subject: 'hello' },
    });

    expect(decision.allowed).toBe(true);
    expect(decision.effect).toBe('external_send');
    expect(decision.risk).toBe('high');
    expect(decision.flags).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'confirmation_recommended', severity: 'critical' }),
    ]));
  });

  it('can enforce critical policy flags behind an explicit switch', () => {
    const decision = evaluateAgentToolPolicy({
      toolName: 'publish_blog_article',
      args: { status: 'published' },
      enforce: true,
    });

    expect(decision.mode).toBe('enforce');
    expect(decision.allowed).toBe(false);
    expect(decision.flags.map((flag) => flag.code)).toContain('confirmation_recommended');
  });

  it('detects a GTM-plan tool chosen for task-like language', () => {
    const decision = evaluateAgentToolPolicy({
      toolName: 'create_gtm_plan',
      args: {
        title: 'Internal follow-up',
        description: 'Create a task to review the AgentRun stress trace',
      },
    });

    expect(decision.flags).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'possible_task_tool_mismatch', severity: 'warning' }),
    ]));
  });

  it('summarizes policy decisions for compact AgentRun telemetry', () => {
    const decisions = [
      evaluateAgentToolPolicy({ toolName: 'search_web' }),
      evaluateAgentToolPolicy({ toolName: 'send_email' }),
    ];

    expect(summarizeAgentToolPolicyFlags(decisions)).toContain('send_email:confirmation_recommended:critical');
    expect(summarizeAgentToolPolicyModes(decisions)).toContain('search_web:read:low:observe');
  });

  it('executes allowed tools and returns the exact result object', async () => {
    const result = { ok: true, nested: { id: 'same-reference' } };
    let now = 100;

    const outcome = await executeAgentToolThroughGateway({
      toolName: 'search_web',
      args: { query: 'agent runtime' },
      now: () => {
        now += 25;
        return now;
      },
      execute: async () => result,
    });

    expect(outcome.status).toBe('success');
    if (outcome.status === 'success') {
      expect(outcome.result).toBe(result);
      expect(outcome.durationMs).toBe(25);
      expect(outcome.policyDecision.effect).toBe('read');
    }
  });

  it('preserves the exact error object when the tool throws', async () => {
    const error = new Error('tool failed');

    const outcome = await executeAgentToolThroughGateway({
      toolName: 'search_web',
      execute: async () => {
        throw error;
      },
    });

    expect(outcome.status).toBe('error');
    if (outcome.status === 'error') {
      expect(outcome.error).toBe(error);
      expect(outcome.policyDecision.allowed).toBe(true);
    }
  });

  it('blocks before execution only when policy is already enforcing', async () => {
    const execute = jest.fn(async () => ({ shouldNotRun: true }));

    const outcome = await executeAgentToolThroughGateway({
      toolName: 'publish_blog_article',
      args: { status: 'published' },
      enforce: true,
      execute,
    });

    expect(execute).not.toHaveBeenCalled();
    expect(outcome.status).toBe('error');
    if (outcome.status === 'error') {
      expect(outcome.error).toBeInstanceOf(AgentToolPolicyBlockedError);
      expect(outcome.policyDecision.allowed).toBe(false);
    }
  });
});
