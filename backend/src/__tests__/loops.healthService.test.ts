/**
 * Tests for the loop-health aggregation service (the I/O wrapper).
 *
 * Verifies it iterates every registered loop, reads each loop's OWN learning
 * store, and degrades gracefully when one loop's store throws — a single bad
 * loop must not blind the operator to the rest.
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
  LearningRecord,
  LearningStore,
  LoopManifest,
  MutationTools,
  NormalizedEvent,
  RuleSet,
} from '../loops/core/types';
import { asLoopId, asMutationId, asRunId } from '../loops/core/types';
import type { ClockPort } from '../loops/core/ports';
import { getLoopHealthReport } from '../loops/health/loopHealthService';

const NOW = new Date('2026-06-09T18:00:00Z');
const clock: ClockPort = { now: () => NOW };

const sensor: EventSource<NormalizedEvent> = { fetchEvents: jest.fn().mockResolvedValue([]) };
const rules: RuleSet<NormalizedEvent, unknown> = { evaluate: jest.fn().mockResolvedValue([]) };
const tools: MutationTools<unknown> = { apply: jest.fn() };
const gate: ApprovalGate = { requestApproval: jest.fn(), pollDecision: jest.fn() };

function manifest(id: string, paused = false): LoopManifest {
  return {
    loopId: asLoopId(id),
    displayName: `Loop ${id}`,
    paused,
    targetMetric: { name: 'rate', numeratorEvent: 'b', denominatorEvent: 'a', windowDays: 7 },
    allowedEventTypes: ['a', 'b'],
    mutationSurface: [{ key: 'k', kind: 'copy' }],
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
    critic: { model: 'test', rubric: ['r'], minScore: 0.5 },
    approval: { dmTitleTemplate: 't' },
    businessRules: [],
  };
}

function learningStore(records: LearningRecord[] = [], throws = false): LearningStore {
  return {
    record: jest.fn().mockResolvedValue(undefined),
    queryHistory: throws
      ? jest.fn().mockRejectedValue(new Error('dynamo unavailable'))
      : jest.fn().mockResolvedValue(records),
    lastOutcomeForRule: jest.fn().mockResolvedValue(null),
  };
}

function registerWith(m: LoopManifest, learning: LearningStore) {
  registerSensor(m.sensorImpl, sensor);
  registerRuleSet(m.rulesetImpl, rules);
  registerTools(m.toolsImpl, tools);
  registerGate(m.gateImpl, gate);
  registerLearningStore(m.learningImpl, learning);
  registerLoop(m);
}

function improvedRecord(loopId: string): LearningRecord {
  return {
    loopId: asLoopId(loopId),
    runId: asRunId('r'),
    ts: new Date('2026-06-08T00:00:00Z'),
    sortKey: '2026-06-08T00:00:00.000Z#000001',
    proposal: {
      proposalId: asMutationId('p'),
      sourceRuleId: 'rule-x',
      hypothesis: 'h',
      kind: 'copy',
      payload: {},
      triggeringStats: {},
    },
    shippedAt: new Date('2026-06-01T00:00:00Z'),
    verdict: 'improved',
    observedLiftPct: 20,
  };
}

describe('getLoopHealthReport', () => {
  beforeEach(() => _resetRegistryForTesting());
  afterEach(() => _resetRegistryForTesting());

  it('returns one health entry per registered loop, reading each loop own store', async () => {
    registerWith(manifest('alpha'), learningStore([improvedRecord('alpha')]));
    registerWith(manifest('beta', true), learningStore([]));

    const report = await getLoopHealthReport(clock);

    expect(report.generatedAt).toBe(NOW.toISOString());
    expect(report.loops).toHaveLength(2);
    const alpha = report.loops.find((l) => l.loopId === 'alpha');
    const beta = report.loops.find((l) => l.loopId === 'beta');
    expect(alpha?.state).toBe('learned');
    expect(beta?.state).toBe('blocked');
  });

  it('degrades a single failing loop to an error entry without failing the report', async () => {
    registerWith(manifest('good'), learningStore([improvedRecord('good')]));
    registerWith(manifest('bad'), learningStore([], true));

    const report = await getLoopHealthReport(clock);

    expect(report.loops).toHaveLength(2);
    const good = report.loops.find((l) => l.loopId === 'good');
    const bad = report.loops.find((l) => l.loopId === 'bad') as (typeof report.loops)[number] & {
      error?: string;
    };
    expect(good?.state).toBe('learned');
    expect(bad?.error).toContain('dynamo unavailable');
  });

  it('returns an empty loops array when nothing is registered', async () => {
    const report = await getLoopHealthReport(clock);
    expect(report.loops).toEqual([]);
  });
});
