/**
 * Cutover characterization tests for the onboarding loop (Phase 2, PR 1).
 *
 * Phase 2 = behavior-preserving consolidation. The framework V2 instance is
 * already built + wired in gated parallel; this PR flips the live cron so V2
 * is the default path and the legacy heartbeat is OFF by default — stopping
 * the daily DOUBLE-FIRE (two DMs / double Bedrock spend) without deleting any
 * legacy code yet (deletion is PR 2).
 *
 * These tests pin the two HUMAN-WRITTEN acceptance criteria the cutover must
 * satisfy (see the Notion task's planner comment, 2026-06-14):
 *
 *   1. Signal parity — given a fixed onboardingEvents[] fixture containing a
 *      skip, a deviation, and a loop-back (goal_selected after channel_selected),
 *      the V2 analyst digest references each of those signal classes, i.e. V2
 *      does not lose a funnel signal the legacy heartbeat reported. We assert
 *      this deterministically: the journeys the analyst reasons over preserve
 *      all three signal classes, and the rendered DM surfaces the analyst's
 *      findings that reference them.
 *
 *   2. No double-fire — under the new default env (nothing set), exactly one
 *      onboarding daily job is live (V2), and the legacy runOnboardingLoop()
 *      path is NOT live unless its flag is explicitly set.
 */

import {
  resolveOnboardingLoopMode,
  isOnboardingV2Live,
  isOnboardingLegacyLive,
} from '../loops/instances/onboarding/cutover';
import {
  buildLoopDigestLines,
  analystFindingsBody,
  type LoopDigestTemplate,
} from '../loops/core/digest/loopDigest';
import { CaptureGate } from '../loops/core/gates/captureGate';
import { createInstanceRunner } from '../loops/core/instanceRunner';
import { UserArrayEventSource, type UserArrayRecord } from '../loops/core/sensors/userArrayEventSource';
import { LlmAnalystRuleSet } from '../loops/core/policy/llmAnalystRuleSet';
import { SpecOutputTool } from '../loops/core/tools/specOutputTool';
import { _resetRegistryForTesting } from '../loops';
import type { BedrockPort, BedrockResult, LoopPorts } from '../loops/core/ports';
import type { LearningStore, LoopRunResult } from '../loops/core/types';
import {
  onboardingManifest,
  ONBOARDING_FLOW_DESCRIPTION,
  ONBOARDING_LOOP_ID,
} from '../loops/instances/onboarding/manifest';

// ---------------------------------------------------------------------------
// Criterion 2 — No double-fire (env-gating policy, pure)
// ---------------------------------------------------------------------------

describe('onboarding cutover — no double-fire (criterion #2)', () => {
  const SAVED = {
    v2: process.env.ONBOARDING_LOOP_V2,
    legacy: process.env.ONBOARDING_LOOP_ENABLED,
  };
  afterEach(() => {
    for (const [k, v] of [
      ['ONBOARDING_LOOP_V2', SAVED.v2],
      ['ONBOARDING_LOOP_ENABLED', SAVED.legacy],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  function clearEnv() {
    delete process.env.ONBOARDING_LOOP_V2;
    delete process.env.ONBOARDING_LOOP_ENABLED;
  }

  it('with NOTHING set (new default), V2 is the single live path and legacy is OFF', () => {
    clearEnv();
    expect(isOnboardingV2Live()).toBe(true);
    expect(isOnboardingLegacyLive()).toBe(false);
  });

  it('exactly one onboarding loop is live under the default env — never both, never zero', () => {
    clearEnv();
    const live = [isOnboardingV2Live(), isOnboardingLegacyLive()].filter(Boolean);
    expect(live).toHaveLength(1);
  });

  it('legacy runs ONLY when its flag is explicitly true (opt-in escape hatch)', () => {
    clearEnv();
    expect(isOnboardingLegacyLive()).toBe(false);
    process.env.ONBOARDING_LOOP_ENABLED = 'true';
    expect(isOnboardingLegacyLive()).toBe(true);
  });

  it('V2 can be explicitly opted out (ONBOARDING_LOOP_V2=false) for rollback', () => {
    clearEnv();
    process.env.ONBOARDING_LOOP_V2 = 'false';
    expect(isOnboardingV2Live()).toBe(false);
  });

  it('explicitly enabling legacy turns V2 off, so the two never double-fire', () => {
    clearEnv();
    process.env.ONBOARDING_LOOP_ENABLED = 'true';
    // Turning legacy back on must not produce two live loops.
    const live = [isOnboardingV2Live(), isOnboardingLegacyLive()].filter(Boolean);
    expect(live).toHaveLength(1);
    expect(isOnboardingLegacyLive()).toBe(true);
    expect(isOnboardingV2Live()).toBe(false);
  });

  it('resolveOnboardingLoopMode returns a single mode string for observability', () => {
    clearEnv();
    expect(resolveOnboardingLoopMode()).toBe('v2');

    process.env.ONBOARDING_LOOP_ENABLED = 'true';
    expect(resolveOnboardingLoopMode()).toBe('legacy');

    // Legacy explicitly on wins even if V2 is explicitly off.
    process.env.ONBOARDING_LOOP_V2 = 'false';
    expect(resolveOnboardingLoopMode()).toBe('legacy');

    // Both off → neither runs.
    delete process.env.ONBOARDING_LOOP_ENABLED;
    process.env.ONBOARDING_LOOP_V2 = 'false';
    expect(resolveOnboardingLoopMode()).toBe('off');
  });
});

// ---------------------------------------------------------------------------
// Criterion 1 — Signal parity (V2 surfaces skip / deviation / loop-back)
// ---------------------------------------------------------------------------

/**
 * A fixed onboardingEvents[] fixture spanning three users that exercise the
 * three signal classes the legacy heartbeat reported:
 *   - userSkip      : onboarding_skipped (a SKIP)
 *   - userDeviation : a `deviation` event mid-flow (a DEVIATION)
 *   - userLoopBack  : goal_selected AFTER channel_selected (a LOOP-BACK)
 * plus a clean completer so the funnel isn't empty.
 */
function onboardingFixture(now: Date): UserArrayRecord[] {
  const t = (offsetMs: number) => new Date(now.getTime() - offsetMs).toISOString();
  return [
    {
      userId: 'u-skip',
      createdAt: t(60_000),
      onboardingEvents: [
        { event: 'signed_up', ts: t(60_000) },
        { event: 'onboarding_started', ts: t(59_000) },
        { event: 'goal_selected', ts: t(58_000) },
        { event: 'onboarding_skipped', ts: t(57_000) },
      ],
    },
    {
      userId: 'u-deviation',
      createdAt: t(50_000),
      onboardingEvents: [
        { event: 'goal_selected', ts: t(50_000) },
        { event: 'channel_selected', ts: t(49_000) },
        { event: 'deviation', ts: t(48_000) },
      ],
    },
    {
      userId: 'u-loopback',
      createdAt: t(40_000),
      onboardingEvents: [
        { event: 'goal_selected', ts: t(40_000) },
        { event: 'channel_selected', ts: t(39_000) },
        // loop-back: goal_selected fires AGAIN after channel_selected.
        { event: 'goal_selected', ts: t(38_000) },
      ],
    },
    {
      userId: 'u-complete',
      createdAt: t(30_000),
      onboardingEvents: [
        { event: 'goal_selected', ts: t(30_000) },
        { event: 'channel_selected', ts: t(29_000) },
        { event: 'ads_generated', ts: t(28_000) },
        { event: 'onboarding_completed', ts: t(27_000) },
      ],
    },
  ];
}

/** Bedrock stub whose analyst output is GROUNDED in whatever journeys the
 * userPrompt contains — it echoes back the three signal classes only when the
 * prompt actually surfaced them, so the test proves the SENSOR preserved them
 * (not that the mock hardcoded them). */
function groundedAnalyst(): { port: BedrockPort; capturedPrompt: () => string } {
  let prompt = '';
  const invoke = jest.fn(async (inv: { userPrompt: string }): Promise<BedrockResult> => {
    prompt = inv.userPrompt;
    const issues: unknown[] = [];
    if (/onboarding_skipped/.test(prompt)) {
      issues.push({
        title: 'High skip rate',
        whatHappened: 'A user fired onboarding_skipped right after goal_selected',
        evidence: 'onboarding_skipped present in the window',
        suggestedFix: 'Reduce friction before the skip point',
        kind: 'copy',
        severity: 'high',
      });
    }
    if (/deviation/.test(prompt)) {
      issues.push({
        title: 'Deviation mid-flow',
        whatHappened: 'A user hit a deviation after channel_selected',
        evidence: 'deviation event observed',
        suggestedFix: 'Investigate the off-path navigation',
        kind: 'code_change',
        severity: 'med',
      });
    }
    // loop-back shows up as goal_selected appearing twice in one journey.
    if (/goal_selected → channel_selected → goal_selected/.test(prompt)) {
      issues.push({
        title: 'Loop-back to goal',
        whatHappened: 'goal_selected fired again after channel_selected (a loop-back / step reset)',
        evidence: 'journey shows goal_selected after channel_selected',
        suggestedFix: 'Fix back-navigation so the step does not reset',
        kind: 'code_change',
        severity: 'high',
      });
    }
    return { text: JSON.stringify({ issues }), inputTokens: 1, outputTokens: 1, costUsd: 0 };
  });
  return { port: { invoke }, capturedPrompt: () => prompt };
}

function fakeLearningStore(): LearningStore {
  return {
    recordDecision: jest.fn().mockResolvedValue(undefined),
    recordOutcome: jest.fn().mockResolvedValue(undefined),
    getHistory: jest.fn().mockResolvedValue([]),
  } as unknown as LearningStore;
}

describe('onboarding cutover — signal parity (criterion #1)', () => {
  beforeEach(() => {
    _resetRegistryForTesting();
    process.env.ONBOARDING_LOOP_V2 = 'true';
  });
  afterEach(() => {
    _resetRegistryForTesting();
    delete process.env.ONBOARDING_LOOP_V2;
  });

  const digestTemplate: LoopDigestTemplate = {
    logTag: '[onboarding-loop-v2-test]',
    header: (date) => `*🚀 Onboarding loop — daily run ${date}*`,
    counts: (r) => `Users/events scanned: ${r.eventsScanned}  |  Findings: ${r.proposals.length}`,
    emptyBody: () => ['_No onboarding events in the window — too thin to judge._'],
    quietBody: () => ['_Funnel looks healthy — no issues surfaced._'],
    findingsBody: analystFindingsBody,
  };

  it('V2 surfaces SKIP, DEVIATION and LOOP-BACK in the digest — no signal lost vs legacy heartbeat', async () => {
    const now = new Date('2026-06-14T12:00:00.000Z');
    const fixture = onboardingFixture(now);
    const { port: bedrock, capturedPrompt } = groundedAnalyst();
    let posted = '';

    const ports: LoopPorts = {
      s3: {} as never,
      dynamo: {} as never,
      bedrock,
      slack: {
        postMessage: jest.fn(async (_u: string, md: string) => {
          posted = md;
        }),
      },
      clock: { now: () => now },
      logger: { log: jest.fn() },
    } as unknown as LoopPorts;

    const learning = fakeLearningStore();
    const runner = createInstanceRunner({
      loopId: ONBOARDING_LOOP_ID,
      ports: () => ports,
      isEnabled: () => process.env.ONBOARDING_LOOP_V2 === 'true',
      implNames: {
        sensor: 'onboardingUserSensor',
        ruleSet: 'onboardingAnalyst',
        tools: 'onboardingSpecTool',
        gate: 'onboardingGate',
        learning: 'onboardingLearning',
      },
      buildLayers: () => ({
        sensor: new UserArrayEventSource(async () => fixture),
        ruleSet: new LlmAnalystRuleSet(ONBOARDING_LOOP_ID, bedrock, {
          model: onboardingManifest.generator.model,
          targetMetricName: onboardingManifest.targetMetric.name,
          flowDescription: ONBOARDING_FLOW_DESCRIPTION,
          maxProposals: 5,
        }),
        tools: new SpecOutputTool(ONBOARDING_LOOP_ID),
        gate: new CaptureGate(),
        learning,
      }),
      manifest: () => onboardingManifest,
      onRunComplete: async ({ result, ports: p, manifest }) => {
        await p.slack.postMessage(
          manifest.approval.slackUserId!,
          buildLoopDigestLines(result, digestTemplate, undefined).join('\n'),
        );
      },
    });

    const result = (await runner.runOnce()) as LoopRunResult;

    // The sensor actually saw the fixture's events.
    expect(result.eventsScanned).toBeGreaterThan(0);

    // The analyst's prompt (built by the sensor → summary) preserved every
    // signal class — proves the V2 sensor did NOT drop a funnel signal.
    const prompt = capturedPrompt();
    expect(prompt).toMatch(/onboarding_skipped/); // SKIP preserved
    expect(prompt).toMatch(/deviation/); // DEVIATION preserved
    expect(prompt).toMatch(/goal_selected → channel_selected → goal_selected/); // LOOP-BACK preserved

    // And the rendered DM surfaces findings referencing each signal class.
    expect(posted).toMatch(/skip/i);
    expect(posted).toMatch(/deviation/i);
    expect(posted).toMatch(/loop-back|loop back|back-navigation/i);
  });
});
