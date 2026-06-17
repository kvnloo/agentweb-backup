/**
 * C2 — approval → settle-window elapse → graded verdict → reflected by health.
 *
 * Behavioral contract (HUMAN-WRITTEN acceptance criterion, do not weaken):
 *   Driving the real Layer-4→5 approval write (`recordLoopApproval`, the C1 gate
 *   contract — it stamps `decision=approved` + `shippedAt`) and then running the
 *   generic attribution cron after the settle window has elapsed must:
 *     1. write a graded `verdict` (improved | no_change | regressed) into the
 *        learning store for the shipped mutation, and
 *     2. cause `computeLoopHealth` to MOVE THE LOOP OFF `pending_approval` — it
 *        reports `in_flight` once shipped (pre-verdict) and `learned`/`regressed`
 *        once the verdict lands.
 *
 * This is the end-to-end (mocked) wiring test the restructure's WS-C2 calls for.
 * It uses the in-memory learning store + a fake sensor (no network), so the whole
 * approval→attribution→health path is asserted hermetically.
 *
 * Dependency note: this builds against C1's documented gate contract. C1 (the
 * Slack-reaction `ApprovalGate` that calls `recordLoopApproval` on a ✅) is not
 * yet landed on `harsha/swarm`; the persistence primitive it must call
 * (`recordLoopApproval`, which produces `decision=approved` + `shippedAt`) is
 * present and is what this test drives directly.
 */

import { recordLoopApproval } from '../loops/core/learning/approvalPersistence';
import { InMemoryLearningStore } from '../loops/core/learning/inMemoryLearningStore';
import { runAttribution } from '../loops/core/learning/attribution';
import { computeLoopHealth } from '../loops/core/health';
import type {
  EventSource,
  LoopId,
  LoopManifest,
  Mutation,
  MutationProposal,
  NormalizedEvent,
  TimeWindow,
} from '../loops/core/types';
import { asLoopId, asMutationId, asRunId } from '../loops/core/types';

const LOOP_ID: LoopId = asLoopId('c2-loop');
const RUN_ID = 'run:c2-abc';
const DAY_MS = 24 * 60 * 60 * 1000;
const SHIP_TS = new Date('2026-06-01T00:00:00.000Z');

function manifest(): LoopManifest {
  return {
    loopId: LOOP_ID,
    displayName: 'C2 Loop',
    paused: false,
    targetMetric: {
      name: 'win_rate',
      numeratorEvent: 'win',
      denominatorEvent: 'try',
      windowDays: 7,
    },
    allowedEventTypes: ['win', 'try'],
    mutationSurface: [{ key: 'hero', kind: 'copy' }],
    sensorImpl: 'c2:sensor',
    rulesetImpl: 'c2:rules',
    toolsImpl: 'c2:tools',
    gateImpl: 'c2:gate',
    learningImpl: 'c2:learning',
    thresholds: {
      promoteLiftPct: 10,
      promoteMinNPerArm: 4,
      retireLiftPct: -10,
      retireMinNPerArm: 4,
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

function proposal(slug: string): MutationProposal<unknown> {
  return {
    proposalId: asMutationId(`prop-${slug}`),
    sourceRuleId: `rule:${slug}`,
    hypothesis: `fix ${slug}`,
    kind: 'copy',
    payload: {},
    triggeringStats: {},
  };
}

function mutation(slug: string): Mutation {
  return {
    mutationId: asMutationId(`mut-${slug}`),
    proposalId: asMutationId(`prop-${slug}`),
    kind: 'copy',
    artifact: {},
  };
}

/** Seed the store the way the orchestrator does: an apply-time row + a gate-time
 * pending row, both before any human decision. */
async function seedPending(store: InMemoryLearningStore, slug: string) {
  await store.record({
    loopId: LOOP_ID,
    runId: asRunId(RUN_ID),
    ts: SHIP_TS,
    proposal: proposal(slug),
    mutation: mutation(slug),
  });
  await store.record({
    loopId: LOOP_ID,
    runId: asRunId(RUN_ID),
    ts: new Date(SHIP_TS.getTime() + 1),
    proposal: proposal(slug),
    mutation: mutation(slug),
    decision: { status: 'pending', decidedAt: SHIP_TS },
  });
}

/**
 * Fake sensor: before the ship the metric is low (1 win / 10 tries), after the
 * ship it's `afterWins` / 10 tries. afterWins=8 → strong positive lift →
 * `improved`; afterWins=0 → negative lift → `regressed`.
 */
function fakeSensor(afterWins: number): EventSource<NormalizedEvent> {
  return {
    async fetchEvents(window: TimeWindow): Promise<NormalizedEvent[]> {
      const isAfter = window.start.getTime() >= SHIP_TS.getTime();
      const tries = 10;
      const wins = isAfter ? afterWins : 1;
      const evs: NormalizedEvent[] = [];
      for (let i = 0; i < tries; i++) {
        evs.push({ subjectId: `s${i}` as never, eventType: 'try', ts: new Date(window.start.getTime() + 1000) });
      }
      for (let i = 0; i < wins; i++) {
        evs.push({ subjectId: `w${i}` as never, eventType: 'win', ts: new Date(window.start.getTime() + 1000) });
      }
      return evs;
    },
  };
}

async function approve(store: InMemoryLearningStore, slug: string) {
  return recordLoopApproval({
    runId: RUN_ID,
    items: [{ id: `rule:${slug}`, ok: true }],
    approver: 'slack:harsha',
    stores: [{ loopId: LOOP_ID, store }],
    now: SHIP_TS,
  });
}

async function attribute(store: InMemoryLearningStore, sensor: EventSource<NormalizedEvent>, now: Date) {
  return runAttribution({
    manifest: manifest(),
    sensor,
    learning: store,
    clock: { now: () => now },
  });
}

async function health(store: InMemoryLearningStore, now: Date) {
  // Reads with no status filter — exactly what loopHealthService does.
  const h = await store.queryHistory({ loopId: LOOP_ID });
  return computeLoopHealth(manifest(), h, now);
}

describe('C2 — approval → settle → verdict → health', () => {
  let store: InMemoryLearningStore;
  beforeEach(() => {
    store = new InMemoryLearningStore();
  });

  it('reports pending_approval while a proposal is still awaiting a human decision', async () => {
    await seedPending(store, 'cta');
    const h = await health(store, new Date(SHIP_TS.getTime() + 60 * 1000));
    expect(h.state).toBe('pending_approval');
    expect(h.counts.pendingApproval).toBe(1);
  });

  it('moves OFF pending_approval to in_flight once the proposal is approved + shipped', async () => {
    await seedPending(store, 'cta');
    await approve(store, 'cta');

    const h = await health(store, new Date(SHIP_TS.getTime() + 2 * 60 * 1000));

    // The whole point of C2: the loop must not stay stuck on pending_approval
    // after the human ✅ — the now-superseded pending row must stop counting.
    expect(h.state).not.toBe('pending_approval');
    expect(h.state).toBe('in_flight');
    expect(h.counts.inFlight).toBe(1);
    expect(h.counts.pendingApproval).toBe(0);
  });

  it('grades an improved verdict after the settle window and health becomes learned', async () => {
    await seedPending(store, 'cta');
    await approve(store, 'cta');

    const afterSettle = new Date(SHIP_TS.getTime() + 8 * DAY_MS);
    const summary = await attribute(store, fakeSensor(8), afterSettle);

    // 1. A verdict was graded + written to the learning store.
    expect(summary.evaluated).toBe(1);
    expect(summary.attributed).toBe(1);
    expect(summary.outcomes[0].verdict).toBe('improved');

    // 2. Health reflects it — off pending_approval, now learned.
    const h = await health(store, afterSettle);
    expect(h.state).not.toBe('pending_approval');
    expect(h.state).toBe('learned');
    expect(h.counts.improved).toBe(1);
    expect(h.counts.pendingApproval).toBe(0);
    expect(h.lastOutcome).toEqual(
      expect.objectContaining({ ruleId: 'rule:cta', verdict: 'improved' }),
    );
  });

  it('grades a regressed verdict and health surfaces regressed (most-urgent state)', async () => {
    await seedPending(store, 'cta');
    await approve(store, 'cta');

    const afterSettle = new Date(SHIP_TS.getTime() + 8 * DAY_MS);
    // after-window worse than before-window (0/10 vs 1/10) → regressed.
    const summary = await attribute(store, fakeSensor(0), afterSettle);
    expect(summary.outcomes[0].verdict).toBe('regressed');

    const h = await health(store, afterSettle);
    expect(h.state).toBe('regressed');
    expect(h.counts.regressed).toBe(1);
    expect(h.counts.pendingApproval).toBe(0);
  });

  it('attribution is idempotent — a second pass after grading writes no new outcome', async () => {
    await seedPending(store, 'cta');
    await approve(store, 'cta');
    const afterSettle = new Date(SHIP_TS.getTime() + 8 * DAY_MS);

    await attribute(store, fakeSensor(8), afterSettle);
    const second = await attribute(store, fakeSensor(8), afterSettle);

    expect(second.evaluated).toBe(0);
    expect(second.attributed).toBe(0);

    const h = await health(store, afterSettle);
    expect(h.counts.improved).toBe(1); // not double-counted
  });
});
