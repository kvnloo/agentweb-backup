/**
 * Agent-mode loop wiring tests.
 *
 * Pins the audit's "plug AgentMode into the same apparatus" rule: the agent-mode
 * loop registers as a first-class instance using the SAME durable learning store
 * + cooldown read-back as the funnel loops, coexists with them regardless of
 * boot order, and its hot-path recorder is gated by AGENT_MODE_LOOP_ENABLED.
 */

import {
  _resetRegistryForTesting,
  getLearningStore,
  getRegisteredLoopIds,
  getRuleSet,
} from '../loops';
import { CooldownRuleSet } from '../loops/core/policy/cooldownRuleSet';
import { DynamoLearningStore } from '../loops/core/learning/dynamoLearningStore';
import { AGENT_MODE_LOOP_ID } from '../loops/instances/agent-mode/eventTypes';
import {
  getAgentRunRecorder,
  registerAgentModeLoop,
  _internal,
} from '../loops/instances/agent-mode';
import { AgentRunRecorder } from '../loops/instances/agent-mode/runRecorder';

describe('agent-mode loop wiring', () => {
  const OLD_FLAG = process.env.AGENT_MODE_LOOP_ENABLED;

  beforeEach(() => {
    _resetRegistryForTesting();
    _internal.resetForTesting();
  });

  afterEach(() => {
    _resetRegistryForTesting();
    _internal.resetForTesting();
    if (OLD_FLAG === undefined) delete process.env.AGENT_MODE_LOOP_ENABLED;
    else process.env.AGENT_MODE_LOOP_ENABLED = OLD_FLAG;
  });

  it('registers the agent-mode loop with durable learning + cooldown read-back', () => {
    registerAgentModeLoop();

    expect(getRegisteredLoopIds()).toContain(AGENT_MODE_LOOP_ID);
    expect(getLearningStore('agentModeLearning')).toBeInstanceOf(DynamoLearningStore);
    expect(getRuleSet('agentModeFailurePolicy')).toBeInstanceOf(CooldownRuleSet);
  });

  it('registration is idempotent (safe to call from app boot + cron)', () => {
    registerAgentModeLoop();
    registerAgentModeLoop();
    expect(getRegisteredLoopIds().filter((id) => id === AGENT_MODE_LOOP_ID)).toHaveLength(1);
  });

  it('coexists with the funnel loops regardless of boot order', async () => {
    const { registerAiReadinessFunnel } = await import('../loops/instances/ai-readiness-funnel');
    registerAgentModeLoop();
    registerAiReadinessFunnel();

    expect(getRegisteredLoopIds()).toContain(AGENT_MODE_LOOP_ID);
    expect(getRegisteredLoopIds()).toContain('ai-readiness-funnel');
  });

  it('the hot-path recorder is a no-op (null) unless AGENT_MODE_LOOP_ENABLED=true', () => {
    delete process.env.AGENT_MODE_LOOP_ENABLED;
    expect(getAgentRunRecorder()).toBeNull();

    process.env.AGENT_MODE_LOOP_ENABLED = 'true';
    expect(getAgentRunRecorder()).toBeInstanceOf(AgentRunRecorder);
  });
});
