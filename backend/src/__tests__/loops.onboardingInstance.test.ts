/**
 * Tests for the onboarding framework instance — the REVAMP port.
 *
 * Asserts the acceptance-criteria-relevant properties of the manifest + the
 * gated-parallel registration (must NOT register unless ONBOARDING_LOOP_V2=true,
 * so it can never touch the live cron by accident).
 */

import { onboardingManifest, ONBOARDING_FLOW_DESCRIPTION } from '../loops/instances/onboarding/manifest';

describe('onboarding manifest (revamp contract)', () => {
  it('targets a real OUTCOME metric (completion rate), not a proxy — criterion #3', () => {
    expect(onboardingManifest.targetMetric.numeratorEvent).toBe('onboarding_completed');
    expect(onboardingManifest.targetMetric.denominatorEvent).toBe('goal_selected');
  });

  it('uses the analyst as its policy — criterion #2 (not the threshold heartbeat)', () => {
    expect(onboardingManifest.rulesetImpl).toBe('onboardingAnalyst');
  });

  it('allows STRUCTURAL changes, not just copy — local-maxima guardrail #1 / criterion #9', () => {
    const kinds = onboardingManifest.mutationSurface.map((m) => m.kind);
    expect(kinds).toContain('code_change');
  });

  it('DMs Harsha', () => {
    expect(onboardingManifest.approval.slackUserId).toBe('U08TM4QFQ1L');
  });

  it('the flow description tells the analyst to watch for the loop-back / deviation patterns', () => {
    expect(ONBOARDING_FLOW_DESCRIPTION).toMatch(/LOOPING BACK/i);
    expect(ONBOARDING_FLOW_DESCRIPTION).toContain('deviation');
  });

  it('impl names in the manifest match what the instance registers', () => {
    expect(onboardingManifest.sensorImpl).toBe('onboardingUserSensor');
    expect(onboardingManifest.toolsImpl).toBe('onboardingSpecTool');
    expect(onboardingManifest.gateImpl).toBe('onboardingGate');
    expect(onboardingManifest.learningImpl).toBe('onboardingLearning');
  });
});

describe('registerOnboardingLoopV2 gating (post-cutover)', () => {
  const OLD_V2 = process.env.ONBOARDING_LOOP_V2;
  const OLD_LEGACY = process.env.ONBOARDING_LOOP_ENABLED;
  beforeEach(async () => {
    const { _resetRegistryForTesting } = await import('../loops');
    _resetRegistryForTesting();
  });
  afterEach(async () => {
    const { _resetRegistryForTesting } = await import('../loops');
    _resetRegistryForTesting();
    if (OLD_V2 === undefined) delete process.env.ONBOARDING_LOOP_V2;
    else process.env.ONBOARDING_LOOP_V2 = OLD_V2;
    if (OLD_LEGACY === undefined) delete process.env.ONBOARDING_LOOP_ENABLED;
    else process.env.ONBOARDING_LOOP_ENABLED = OLD_LEGACY;
  });

  it('registers by default (V2 is the live path post-cutover) when nothing is set', async () => {
    delete process.env.ONBOARDING_LOOP_V2;
    delete process.env.ONBOARDING_LOOP_ENABLED;
    const { registerOnboardingLoopV2 } = await import('../loops/instances/onboarding');
    expect(registerOnboardingLoopV2()).toBe(true);
  });

  it('is a no-op (returns false) when the legacy heartbeat is explicitly opted in — never double-fires', async () => {
    delete process.env.ONBOARDING_LOOP_V2;
    process.env.ONBOARDING_LOOP_ENABLED = 'true';
    const { registerOnboardingLoopV2 } = await import('../loops/instances/onboarding');
    expect(registerOnboardingLoopV2()).toBe(false);
  });

  it('is a no-op (returns false) when V2 is explicitly disabled for rollback', async () => {
    process.env.ONBOARDING_LOOP_V2 = 'false';
    delete process.env.ONBOARDING_LOOP_ENABLED;
    const { registerOnboardingLoopV2 } = await import('../loops/instances/onboarding');
    expect(registerOnboardingLoopV2()).toBe(false);
  });
});
