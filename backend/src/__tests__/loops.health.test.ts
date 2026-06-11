/**
 * Tests for the pure loop-health computation.
 *
 * A loop is only trustworthy if an operator (Fangfang/Rui) can see, at a
 * glance, which of the six lifecycle states it is in — without reading logs.
 * `computeLoopHealth` derives that state + the supporting counts from the
 * manifest and the durable learning history, with no I/O, so it's exhaustively
 * unit-testable across every state.
 */

import { computeLoopHealth, type LoopHealth } from '../loops/core/health';
import type {
  Decision,
  LearningRecord,
  LoopManifest,
  Mutation,
  MutationProposal,
  OutcomeVerdict,
} from '../loops/core/types';
import { asLoopId, asMutationId, asRunId } from '../loops/core/types';

const NOW = new Date('2026-06-09T18:00:00Z');

function manifest(over: Partial<LoopManifest> = {}): LoopManifest {
  return {
    loopId: asLoopId('test-loop'),
    displayName: 'Test Loop',
    paused: false,
    targetMetric: {
      name: 'conversion_rate',
      numeratorEvent: 'converted',
      denominatorEvent: 'landed',
      windowDays: 7,
    },
    allowedEventTypes: ['landed', 'converted'],
    mutationSurface: [{ key: 'hero', kind: 'copy' }],
    sensorImpl: 'test:sensor',
    rulesetImpl: 'test:rules',
    toolsImpl: 'test:tools',
    gateImpl: 'test:gate',
    learningImpl: 'test:learning',
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
    ...over,
  };
}

let counter = 0;
function record(over: Partial<LearningRecord> = {}): LearningRecord {
  counter++;
  const ts = over.ts ?? NOW;
  return {
    loopId: asLoopId('test-loop'),
    runId: asRunId('run-1'),
    ts,
    sortKey: `${ts.toISOString()}#${String(counter).padStart(6, '0')}`,
    ...over,
  };
}

function proposal(ruleId = 'rule-a'): MutationProposal<unknown> {
  return {
    proposalId: asMutationId(`prop-${ruleId}`),
    sourceRuleId: ruleId,
    hypothesis: 'h',
    kind: 'copy',
    payload: {},
    triggeringStats: {},
  };
}

function mutation(ruleId = 'rule-a'): Mutation {
  return {
    mutationId: asMutationId(`mut-${ruleId}`),
    proposalId: asMutationId(`prop-${ruleId}`),
    kind: 'copy',
    artifact: {},
  };
}

function decision(status: Decision['status']): Decision {
  return { status, decidedAt: NOW };
}

describe('computeLoopHealth', () => {
  it('reports blocked when the manifest is paused, regardless of history', () => {
    const h = computeLoopHealth(manifest({ paused: true, pauseReason: 'maintenance' }), [
      record({ proposal: proposal(), mutation: mutation(), verdict: 'improved' }),
    ], NOW);
    expect(h.state).toBe('blocked');
    expect(h.pauseReason).toBe('maintenance');
  });

  it('reports empty when there is no learning history at all', () => {
    const h = computeLoopHealth(manifest(), [], NOW);
    expect(h.state).toBe('empty');
    expect(h.counts.total).toBe(0);
    expect(h.lastActivityAt).toBeNull();
    expect(h.lastOutcome).toBeNull();
  });

  it('reports pending_approval when a proposal is awaiting a human decision', () => {
    const h = computeLoopHealth(manifest(), [
      record({ proposal: proposal(), mutation: mutation(), decision: decision('pending') }),
    ], NOW);
    expect(h.state).toBe('pending_approval');
    expect(h.counts.pendingApproval).toBe(1);
  });

  it('reports in_flight when a fix shipped but attribution has not graded it yet', () => {
    const h = computeLoopHealth(manifest(), [
      record({
        proposal: proposal(),
        mutation: mutation(),
        decision: decision('approved'),
        shippedAt: new Date('2026-06-08T18:00:00Z'),
        verdict: null,
      }),
    ], NOW);
    expect(h.state).toBe('in_flight');
    expect(h.counts.inFlight).toBe(1);
  });

  it('reports regressed when the most recent graded outcome regressed', () => {
    const h = computeLoopHealth(manifest(), [
      record({
        proposal: proposal(),
        shippedAt: new Date('2026-06-01T18:00:00Z'),
        verdict: 'regressed' as OutcomeVerdict,
        observedLiftPct: -22,
      }),
    ], NOW);
    expect(h.state).toBe('regressed');
    expect(h.counts.regressed).toBe(1);
    expect(h.lastOutcome).toEqual(
      expect.objectContaining({ verdict: 'regressed', ruleId: 'rule-a', observedLiftPct: -22 }),
    );
  });

  it('reports learned when a fix improved the metric and nothing is regressed/pending/in-flight', () => {
    const h = computeLoopHealth(manifest(), [
      record({
        proposal: proposal(),
        shippedAt: new Date('2026-06-01T18:00:00Z'),
        verdict: 'improved' as OutcomeVerdict,
        observedLiftPct: 31,
      }),
    ], NOW);
    expect(h.state).toBe('learned');
    expect(h.counts.improved).toBe(1);
  });

  it('reports idle when records exist but only no_change/inconclusive outcomes remain', () => {
    const h = computeLoopHealth(manifest(), [
      record({ proposal: proposal(), shippedAt: new Date('2026-06-01T18:00:00Z'), verdict: 'no_change' }),
      record({ proposal: proposal('rule-b'), shippedAt: new Date('2026-06-02T18:00:00Z'), verdict: 'inconclusive' }),
    ], NOW);
    expect(h.state).toBe('idle');
    expect(h.counts.noChange).toBe(1);
    expect(h.counts.inconclusive).toBe(1);
  });

  it('prioritizes regressed over in_flight, pending, and learned (most urgent wins)', () => {
    const h = computeLoopHealth(manifest(), [
      record({ proposal: proposal('rule-a'), mutation: mutation('rule-a'), decision: decision('pending') }),
      record({ proposal: proposal('rule-b'), shippedAt: new Date('2026-06-07T18:00:00Z'), verdict: null }),
      record({ proposal: proposal('rule-c'), shippedAt: new Date('2026-06-06T18:00:00Z'), verdict: 'improved' }),
      record({ proposal: proposal('rule-d'), shippedAt: new Date('2026-06-05T18:00:00Z'), verdict: 'regressed' }),
    ], NOW);
    expect(h.state).toBe('regressed');
    // counts still reflect the full picture
    expect(h.counts.pendingApproval).toBe(1);
    expect(h.counts.inFlight).toBe(1);
    expect(h.counts.improved).toBe(1);
    expect(h.counts.regressed).toBe(1);
  });

  it('surfaces the latest activity timestamp and the latest graded outcome', () => {
    const h = computeLoopHealth(manifest(), [
      record({ ts: new Date('2026-06-01T00:00:00Z'), proposal: proposal('rule-a'), shippedAt: new Date('2026-06-01T00:00:00Z'), verdict: 'improved', observedLiftPct: 12 }),
      record({ ts: new Date('2026-06-05T00:00:00Z'), proposal: proposal('rule-a'), mutation: mutation('rule-a'), decision: decision('pending') }),
    ], NOW);
    expect(h.lastActivityAt).toBe('2026-06-05T00:00:00.000Z');
    // lastOutcome is the most recent record that actually carries a verdict
    expect(h.lastOutcome).toEqual(
      expect.objectContaining({ verdict: 'improved', observedLiftPct: 12 }),
    );
  });
});
