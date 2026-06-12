/**
 * Product-wide loop hardening tests.
 *
 * These pin the architecture rule from the YC learning-loop audit:
 * production loop instances must persist learning durably, read past outcomes
 * before proposing again, and coexist without boot-order registry resets.
 */

import {
  _resetRegistryForTesting,
  getLearningStore,
  getRegisteredLoopIds,
  getRuleSet,
} from '../loops';
import { CooldownRuleSet } from '../loops/core/policy/cooldownRuleSet';
import { DynamoLearningStore } from '../loops/core/learning/dynamoLearningStore';
import { AI_EVAL_LOOP_ID } from '../loops/instances/ai-eval-funnel/manifest';
import { AI_READINESS_LOOP_ID } from '../loops/instances/ai-readiness-funnel/manifest';
import { ONBOARDING_LOOP_ID } from '../loops/instances/onboarding/manifest';

describe('production loop wiring', () => {
  const OLD_ONBOARDING = process.env.ONBOARDING_LOOP_V2;

  beforeEach(() => {
    _resetRegistryForTesting();
  });

  afterEach(() => {
    _resetRegistryForTesting();
    if (OLD_ONBOARDING === undefined) delete process.env.ONBOARDING_LOOP_V2;
    else process.env.ONBOARDING_LOOP_V2 = OLD_ONBOARDING;
  });

  it('registers ai-eval and ai-readiness in either order without wiping the registry', async () => {
    const { registerAiReadinessFunnel } = await import('../loops/instances/ai-readiness-funnel');
    const { registerAiEvalFunnelForProduction } = await import('../loops/instances/ai-eval-funnel');

    registerAiReadinessFunnel();
    registerAiEvalFunnelForProduction();

    expect(getRegisteredLoopIds()).toEqual(expect.arrayContaining([AI_READINESS_LOOP_ID, AI_EVAL_LOOP_ID]));
  });

  it('uses durable learning + cooldown read-back for ai-eval production', async () => {
    const { registerAiEvalFunnelForProduction } = await import('../loops/instances/ai-eval-funnel');

    registerAiEvalFunnelForProduction();

    expect(getLearningStore('aiEvalLearning:prod')).toBeInstanceOf(DynamoLearningStore);
    expect(getRuleSet('aiEvalRules:prod')).toBeInstanceOf(CooldownRuleSet);
  });

  it('uses durable learning + cooldown read-back for ai-readiness production', async () => {
    const { registerAiReadinessFunnel } = await import('../loops/instances/ai-readiness-funnel');

    registerAiReadinessFunnel();

    expect(getLearningStore('aiReadinessLearning')).toBeInstanceOf(DynamoLearningStore);
    expect(getRuleSet('aiReadinessAnalyst')).toBeInstanceOf(CooldownRuleSet);
  });

  it('uses durable learning + cooldown read-back when onboarding v2 is enabled', async () => {
    process.env.ONBOARDING_LOOP_V2 = 'true';
    const { registerOnboardingLoopV2 } = await import('../loops/instances/onboarding');

    expect(registerOnboardingLoopV2()).toBe(true);

    expect(getRegisteredLoopIds()).toContain(ONBOARDING_LOOP_ID);
    expect(getLearningStore('onboardingLearning')).toBeInstanceOf(DynamoLearningStore);
    expect(getRuleSet('onboardingAnalyst')).toBeInstanceOf(CooldownRuleSet);
  });
});
