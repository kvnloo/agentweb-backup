/**
 * Tests for the attribution activation: durable DynamoLearningStore + the
 * CooldownRuleSet read-back that makes the loop self-aware of in-flight + failed
 * fixes (won't re-propose a fix it already dispatched or one that already failed).
 */

import { DynamoLearningStore } from '../loops/core/learning/dynamoLearningStore';
import { CooldownRuleSet } from '../loops/core/policy/cooldownRuleSet';
import { InMemoryLearningStore } from '../loops/core/learning/inMemoryLearningStore';
import type { DynamoAttributeMap, DynamoPort } from '../loops/core/ports';
import type {
  LearningEvent,
  MutationProposal,
  NormalizedEvent,
  RuleSet,
  TimeWindow,
} from '../loops/core/types';
import { asLoopId, asMutationId, asRunId } from '../loops/core/types';

const LOOP = asLoopId('onboarding');
const DAY = 24 * 60 * 60 * 1000;
const WINDOW = (now: number): TimeWindow => ({ start: new Date(now - 30 * DAY), end: new Date(now) });

function proposal(ruleId: string): MutationProposal<unknown> {
  return {
    proposalId: asMutationId(`p-${ruleId}`),
    sourceRuleId: ruleId,
    hypothesis: `issue ${ruleId}`,
    kind: 'code_change',
    payload: {},
    triggeringStats: {},
  };
}

function shippedEvent(ruleId: string, shippedAt: Date, verdict: LearningEvent['verdict'] = null): LearningEvent {
  return {
    loopId: LOOP,
    runId: asRunId('r'),
    ts: shippedAt,
    proposal: proposal(ruleId) as MutationProposal<unknown>,
    mutation: { mutationId: asMutationId(`m-${ruleId}`), proposalId: asMutationId(`p-${ruleId}`), kind: 'code_change', artifact: {} },
    decision: { status: 'auto_shipped', decidedAt: shippedAt } as never,
    shippedAt,
    verdict,
  };
}

// ---------------------------------------------------------------------------
// DynamoLearningStore
// ---------------------------------------------------------------------------

function mockDynamo(): DynamoPort & { store: DynamoAttributeMap[] } {
  const store: DynamoAttributeMap[] = [];
  return {
    store,
    putItem: jest.fn(async (_t: string, item: DynamoAttributeMap) => { store.push(item); }),
    getItem: jest.fn(),
    query: jest.fn(async () => ({ items: store })),
  };
}

describe('DynamoLearningStore', () => {
  it('records and reads back an event (durable round-trip, dates revived)', async () => {
    const dyn = mockDynamo();
    const store = new DynamoLearningStore(dyn);
    const shippedAt = new Date('2026-06-01T00:00:00Z');
    await store.record(shippedEvent('rule-x', shippedAt, 'regressed'));

    const hist = await store.queryHistory({ loopId: LOOP });
    expect(hist).toHaveLength(1);
    expect(hist[0].proposal?.sourceRuleId).toBe('rule-x');
    expect(hist[0].verdict).toBe('regressed');
    expect(hist[0].shippedAt instanceof Date).toBe(true);
    expect((hist[0].shippedAt as Date).toISOString()).toBe(shippedAt.toISOString());
  });

  it('lastOutcomeForRule returns the most recent graded record for a rule', async () => {
    const dyn = mockDynamo();
    const store = new DynamoLearningStore(dyn);
    await store.record(shippedEvent('r1', new Date('2026-06-01T00:00:00Z'), 'no_change'));
    await store.record(shippedEvent('r1', new Date('2026-06-03T00:00:00Z'), 'improved'));
    await store.record(shippedEvent('r2', new Date('2026-06-02T00:00:00Z'), 'regressed'));

    const last = await store.lastOutcomeForRule(LOOP, 'r1');
    expect(last?.verdict).toBe('improved'); // most recent for r1
  });
});

// ---------------------------------------------------------------------------
// CooldownRuleSet
// ---------------------------------------------------------------------------

class StubRuleSet implements RuleSet<NormalizedEvent, unknown> {
  constructor(private readonly ruleIds: string[]) {}
  async evaluate(): Promise<MutationProposal<unknown>[]> {
    return this.ruleIds.map(proposal);
  }
}

describe('CooldownRuleSet', () => {
  const NOW = new Date('2026-06-06T00:00:00Z').getTime();

  async function seeded(events: LearningEvent[]): Promise<InMemoryLearningStore> {
    const s = new InMemoryLearningStore();
    for (const e of events) await s.record(e);
    return s;
  }

  it('suppresses a rule whose fix is in flight (shipped, not yet graded)', async () => {
    const learning = await seeded([shippedEvent('r1', new Date(NOW - 2 * DAY), null)]);
    const rs = new CooldownRuleSet(new StubRuleSet(['r1', 'r2']), learning, LOOP);
    const out = await rs.evaluate([], WINDOW(NOW));
    expect(out.map((p) => p.sourceRuleId)).toEqual(['r2']); // r1 in-flight → dropped
  });

  it('suppresses a rule whose last fix regressed within the cooldown window', async () => {
    const learning = await seeded([shippedEvent('r1', new Date(NOW - 3 * DAY), 'regressed')]);
    const rs = new CooldownRuleSet(new StubRuleSet(['r1', 'r2']), learning, LOOP, { cooldownDays: 14 });
    const out = await rs.evaluate([], WINDOW(NOW));
    expect(out.map((p) => p.sourceRuleId)).toEqual(['r2']);
  });

  it('does NOT suppress once the cooldown has elapsed', async () => {
    const learning = await seeded([shippedEvent('r1', new Date(NOW - 30 * DAY), 'no_change')]);
    const rs = new CooldownRuleSet(new StubRuleSet(['r1']), learning, LOOP, { cooldownDays: 14 });
    const out = await rs.evaluate([], WINDOW(NOW));
    expect(out.map((p) => p.sourceRuleId)).toEqual(['r1']); // cooldown passed
  });

  it('does NOT suppress a rule whose last fix IMPROVED the metric', async () => {
    const learning = await seeded([shippedEvent('r1', new Date(NOW - 2 * DAY), 'improved')]);
    const rs = new CooldownRuleSet(new StubRuleSet(['r1']), learning, LOOP);
    const out = await rs.evaluate([], WINDOW(NOW));
    expect(out.map((p) => p.sourceRuleId)).toEqual(['r1']); // a win doesn't lock the rule out
  });

  it('does NOT suppress a rule with no shipped history', async () => {
    const learning = new InMemoryLearningStore();
    const rs = new CooldownRuleSet(new StubRuleSet(['fresh']), learning, LOOP);
    const out = await rs.evaluate([], WINDOW(NOW));
    expect(out.map((p) => p.sourceRuleId)).toEqual(['fresh']);
  });
});
