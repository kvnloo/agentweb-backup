/**
 * Tests for the loop-health aggregation service (the I/O wrapper).
 *
 * Verifies it iterates every registered loop, reads each loop's OWN learning
 * store, and degrades gracefully when one loop's store throws — a single bad
 * loop must not blind the operator to the rest.
 */

import {
  _resetRegistryForTesting,
  registerLearningStore,
  registerLoop,
  registerRuleSet,
  registerSensor,
  registerTools,
} from '../loops';
import type {
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
import loopHealthRouter from '../routes/loopHealth';
import type { Request, Response, NextFunction } from 'express';

// Invoke the real /health handler without opening a local HTTP server.
async function readHealthRoute() {
  const route = loopHealthRouter.stack.find((layer: { route?: { path: string } }) => layer.route?.path === '/health');
  if (!route?.route) throw new Error('health route missing');
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
  await route.route.stack[0].handle({} as Request, res as unknown as Response, jest.fn() as NextFunction);
  expect(res.status).toHaveBeenCalledWith(200);
  return res.json.mock.calls[0][0];
}

const NOW = new Date('2026-06-09T18:00:00Z');
const clock: ClockPort = { now: () => NOW };

const sensor: EventSource<NormalizedEvent> = { fetchEvents: jest.fn().mockResolvedValue([]) };
const rules: RuleSet<NormalizedEvent, unknown> = { evaluate: jest.fn().mockResolvedValue([]) };
const tools: MutationTools<unknown> = { apply: jest.fn() };
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
    recordDecisionIfAbsent: jest.fn().mockResolvedValue(true),
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
    const bad = report.loops.find((l) => l.loopId === 'bad');
    expect(good?.state).toBe('learned');
    expect(bad?.state).toBe('unavailable');
    expect(bad?.counts).toBeNull();
    expect(bad).toMatchObject({ error: 'learning_history_unavailable', lastActivityAt: null, lastOutcome: null });
    expect(JSON.stringify(report)).not.toContain('dynamo unavailable');
  });

  it.each([false, true])('preserves unknown observations through the route (paused=%s)', async (paused) => {
    const failed = manifest('bad', paused);
    failed.pauseReason = 'maintenance';
    const store = learningStore();
    (store.queryHistory as jest.Mock).mockRejectedValue({ token: 'secret-fixture', toString: () => 'secret-fixture' });
    registerWith(failed, store);
    registerWith(manifest('good'), learningStore([improvedRecord('good')]));
    registerWith(manifest('empty'), learningStore());
    const report = await readHealthRoute();
    expect(report.loops[0]).toMatchObject({ state: 'unavailable', counts: null, paused, pauseReason: 'maintenance', error: 'learning_history_unavailable' });
    expect(report.loops[1]).toMatchObject({ state: 'learned', counts: { total: 1, improved: 1 } });
    expect(report.loops[2]).toMatchObject({ state: 'empty', counts: { total: 0 } });
    expect(JSON.stringify(report)).not.toContain('secret-fixture');
  });

  it.each(['ResourceNotFoundException', 'AccessDeniedException', 'ThrottlingException', 'secret-name'])(
    'logs a bounded cause and loop identity without leaking error details (%s)', async (name) => {
    const log = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const store = learningStore();
      const error = new Error('secret-fixture');
      error.name = name;
      (store.queryHistory as jest.Mock).mockRejectedValue(error);
      registerWith(manifest('bad'), store);
      await getLoopHealthReport(clock);
      expect(log).toHaveBeenCalledWith('[loopHealth] learning history unavailable', {
        loopId: 'bad', cause: name === 'secret-name' ? 'unknown' : name,
      });
      expect(JSON.stringify(log.mock.calls)).not.toContain('secret-fixture');
      expect(JSON.stringify(log.mock.calls)).not.toContain('secret-name');
    } finally {
      log.mockRestore();
    }
  });

  it('returns an empty loops array when nothing is registered', async () => {
    const report = await getLoopHealthReport(clock);
    expect(report.loops).toEqual([]);
  });
});
