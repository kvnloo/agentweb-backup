/**
 * Tests for the generic loop attribution cron.
 *
 * The cron must be product-wide: any registered loop with a sensor + learning
 * store should get a Layer-5 attribution pass without custom per-surface code.
 */

import {
  _resetRegistryForTesting,
  registerGate,
  registerLearningStore,
  registerLoop,
  registerRuleSet,
  registerSensor,
  registerTools,
} from '../loops';
import type {
  ApprovalGate,
  EventSource,
  LearningStore,
  LoopManifest,
  MutationTools,
  NormalizedEvent,
  RuleSet,
} from '../loops/core/types';
import { asLoopId } from '../loops/core/types';
import type { LoopPorts } from '../loops/core/ports';
import { runLoopAttributionOnce } from '../loops/cron/loopAttributionCron';

function manifest(id: string, paused = false): LoopManifest {
  return {
    loopId: asLoopId(id),
    displayName: id,
    paused,
    pauseReason: paused ? 'maintenance' : undefined,
    targetMetric: {
      name: 'conversion_rate',
      numeratorEvent: 'converted',
      denominatorEvent: 'landed',
      windowDays: 7,
    },
    allowedEventTypes: ['landed', 'converted'],
    mutationSurface: [{ key: 'hero', kind: 'copy' }],
    sensorImpl: `${id}:sensor`,
    rulesetImpl: `${id}:rules`,
    toolsImpl: `${id}:tools`,
    gateImpl: `${id}:gate`,
    learningImpl: `${id}:learning`,
    thresholds: {
      promoteLiftPct: 10,
      promoteMinNPerArm: 10,
      retireLiftPct: -10,
      retireMinNPerArm: 10,
      watchdogRollbackPct24h: 20,
      watchdogPausePct7d: 20,
      maxActiveArmsPerKey: 1,
      maxTokensPerCycleUsd: 1,
    },
    generator: { candidatesPerCycle: 1, model: 'test', systemPrompt: 'test' },
    critic: { model: 'test', rubric: ['test'], minScore: 0.5 },
    approval: { dmTitleTemplate: 'test' },
    businessRules: [],
  };
}

const sensor: EventSource<NormalizedEvent> = { fetchEvents: jest.fn().mockResolvedValue([]) };
const rules: RuleSet<NormalizedEvent, unknown> = { evaluate: jest.fn().mockResolvedValue([]) };
const tools: MutationTools<unknown> = { apply: jest.fn() };
const gate: ApprovalGate = { requestApproval: jest.fn(), pollDecision: jest.fn() };

function learningStore() {
  return {
    record: jest.fn().mockResolvedValue(undefined),
    queryHistory: jest.fn().mockResolvedValue([]),
    lastOutcomeForRule: jest.fn().mockResolvedValue(null),
  } satisfies LearningStore;
}

function ports(): LoopPorts {
  const now = new Date('2026-06-08T18:00:00Z');
  return {
    s3: {} as LoopPorts['s3'],
    dynamo: {} as LoopPorts['dynamo'],
    bedrock: {} as LoopPorts['bedrock'],
    slack: { postMessage: jest.fn(), getReactions: jest.fn(), getReplies: jest.fn() },
    clock: { now: () => now },
    logger: { log: jest.fn() },
  };
}

function registerTestLoop(m: LoopManifest, learning: LearningStore) {
  registerSensor(m.sensorImpl, sensor);
  registerRuleSet(m.rulesetImpl, rules);
  registerTools(m.toolsImpl, tools);
  registerGate(m.gateImpl, gate);
  registerLearningStore(m.learningImpl, learning);
  registerLoop(m);
}

describe('runLoopAttributionOnce', () => {
  beforeEach(() => _resetRegistryForTesting());
  afterEach(() => _resetRegistryForTesting());

  it('runs attribution for each registered unpaused loop and skips paused loops', async () => {
    const activeLearning = learningStore();
    const pausedLearning = learningStore();
    registerTestLoop(manifest('active-loop'), activeLearning);
    registerTestLoop(manifest('paused-loop', true), pausedLearning);

    const result = await runLoopAttributionOnce(ports());

    expect(activeLearning.queryHistory).toHaveBeenCalledWith({
      loopId: asLoopId('active-loop'),
      status: ['approved', 'auto_shipped'],
    });
    expect(pausedLearning.queryHistory).not.toHaveBeenCalled();
    expect(result.loops).toEqual([
      expect.objectContaining({ loopId: asLoopId('active-loop'), skipped: false }),
      expect.objectContaining({ loopId: asLoopId('paused-loop'), skipped: true, reason: 'maintenance' }),
    ]);
  });
});
