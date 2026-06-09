/**
 * Agent-mode loop wiring tests.
 *
 * Pins the audit's "plug AgentMode into the same apparatus" rule: the agent-mode
 * loop registers as a first-class instance using the SAME durable learning store
 * + cooldown read-back as the funnel loops, coexists with them regardless of
 * boot order, and its hot-path recorder can be enabled separately from the
 * daily learning loop for observability-only staging tests.
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
  isAgentRuntimeSpineEnabled,
  registerAgentModeLoop,
  _internal,
} from '../loops/instances/agent-mode';
import { AgentRunRecorder } from '../loops/instances/agent-mode/runRecorder';

describe('agent-mode loop wiring', () => {
  const OLD_FLAG = process.env.AGENT_MODE_LOOP_ENABLED;
  const OLD_SPINE_FLAG = process.env.AGENT_RUNTIME_SPINE_ENABLED;

  beforeEach(() => {
    _resetRegistryForTesting();
    _internal.resetForTesting();
  });

  afterEach(() => {
    _resetRegistryForTesting();
    _internal.resetForTesting();
    if (OLD_FLAG === undefined) delete process.env.AGENT_MODE_LOOP_ENABLED;
    else process.env.AGENT_MODE_LOOP_ENABLED = OLD_FLAG;
    if (OLD_SPINE_FLAG === undefined) delete process.env.AGENT_RUNTIME_SPINE_ENABLED;
    else process.env.AGENT_RUNTIME_SPINE_ENABLED = OLD_SPINE_FLAG;
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

  it('the hot-path recorder is a no-op (null) unless the runtime spine flag is enabled', () => {
    delete process.env.AGENT_MODE_LOOP_ENABLED;
    delete process.env.AGENT_RUNTIME_SPINE_ENABLED;
    expect(getAgentRunRecorder()).toBeNull();

    process.env.AGENT_RUNTIME_SPINE_ENABLED = 'true';
    expect(getAgentRunRecorder()).toBeInstanceOf(AgentRunRecorder);
  });

  it('keeps AGENT_MODE_LOOP_ENABLED as a backwards-compatible recorder switch', () => {
    delete process.env.AGENT_RUNTIME_SPINE_ENABLED;
    process.env.AGENT_MODE_LOOP_ENABLED = 'true';

    expect(isAgentRuntimeSpineEnabled()).toBe(true);
    expect(getAgentRunRecorder()).toBeInstanceOf(AgentRunRecorder);
  });

  it('allows shadow telemetry without enabling the daily learning loop flag', () => {
    delete process.env.AGENT_MODE_LOOP_ENABLED;
    process.env.AGENT_RUNTIME_SPINE_ENABLED = 'true';

    expect(isAgentRuntimeSpineEnabled()).toBe(true);
    expect(process.env.AGENT_MODE_LOOP_ENABLED).toBeUndefined();
    expect(getAgentRunRecorder()).toBeInstanceOf(AgentRunRecorder);
  });
});
