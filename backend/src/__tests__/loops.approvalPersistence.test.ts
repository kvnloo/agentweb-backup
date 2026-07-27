/**
 * Tests for recordLoopApproval — the Layer-4→5 write that was missing.
 *
 * Behavioral contract (the audit's "approval/dispatch writes" gap):
 *   1. After a Slack ✅ approval, each pending learning record for that run
 *      gets a new record with decision.status='approved' and shippedAt set
 *      (when its dispatch succeeded), preserving the original proposal.
 *   2. A dispatch failure is recorded — decision approved, NO shippedAt,
 *      mutation.error names the failure — so it is auditable but the rule
 *      stays re-proposable.
 *   3. With no pending records for the runId, nothing is written.
 *   4. Idempotent: a second ✅ on the same run writes nothing new.
 *   5. CooldownRuleSet suppresses a re-proposal of an approved+shipped rule
 *      (the in-flight case) — the actual point of the whole exercise.
 *   6. The written record satisfies the attribution cron's history filter
 *      (status approved, shippedAt set, verdict null) so outcomes get graded.
 */

import { recordLoopApproval } from '../loops/core/learning/approvalPersistence';
import { InMemoryLearningStore } from '../loops/core/learning/inMemoryLearningStore';
import { CooldownRuleSet } from '../loops/core/policy/cooldownRuleSet';
import type {
  LoopId,
  MutationProposal,
  Mutation,
  NormalizedEvent,
  RuleSet,
  TimeWindow,
} from '../loops/core/types';

const LOOP_ID = 'test-loop' as LoopId;
const RUN_ID = 'run:abc123';
const NOW = new Date('2026-06-12T08:00:00.000Z');

function proposal(slug: string): MutationProposal<unknown> {
  return {
    proposalId: `prop-${slug}` as MutationProposal<unknown>['proposalId'],
    sourceRuleId: `llm-analyst:${slug}`,
    hypothesis: `fix ${slug}`,
    kind: 'spec_output',
    payload: {},
    triggeringStats: {},
  };
}

function mutation(slug: string): Mutation {
  return {
    mutationId: `mut-${slug}` as Mutation['mutationId'],
    proposalId: `prop-${slug}` as Mutation['proposalId'],
    kind: 'spec_output',
    artifact: {},
  };
}

/** Seed the store the way the orchestrator does: apply-time + gate-time rows. */
async function seedPending(store: InMemoryLearningStore, slug: string, ts: Date) {
  await store.record({
    loopId: LOOP_ID,
    runId: RUN_ID as never,
    ts,
    proposal: proposal(slug),
    mutation: mutation(slug),
  });
  await store.record({
    loopId: LOOP_ID,
    runId: RUN_ID as never,
    ts: new Date(ts.getTime() + 1),
    proposal: proposal(slug),
    mutation: mutation(slug),
    decision: { status: 'pending', decidedAt: ts },
  });
}

describe('recordLoopApproval', () => {
  let store: InMemoryLearningStore;
  const stores = () => [{ loopId: LOOP_ID, store }];

  beforeEach(() => {
    store = new InMemoryLearningStore();
  });

  it('writes approved + shipped records for matched successful dispatches', async () => {
    await seedPending(store, 'fix-cta', new Date('2026-06-12T07:00:00.000Z'));

    const result = await recordLoopApproval({
      runId: RUN_ID,
      items: [{ id: 'fix-cta', ok: true }],
      approver: 'slack:harsha',
      stores: stores(),
      now: NOW,
    });

    expect(result.loopId).toBe(LOOP_ID);
    expect(result.approved).toBe(1);
    expect(result.shipped).toBe(1);

    const approved = await store.queryHistory({ loopId: LOOP_ID, status: ['approved'] });
    expect(approved).toHaveLength(1);
    expect(approved[0].proposal?.sourceRuleId).toBe('llm-analyst:fix-cta');
    expect(approved[0].shippedAt).toEqual(NOW);
    expect(approved[0].decision?.decidedBy).toBe('slack:harsha');
    expect(approved[0].runId).toBe(RUN_ID);
  });

  it('records a dispatch failure as approved-but-not-shipped with the error preserved', async () => {
    await seedPending(store, 'fix-cta', new Date('2026-06-12T07:00:00.000Z'));

    const result = await recordLoopApproval({
      runId: RUN_ID,
      items: [{ id: 'fix-cta', ok: false, error: 'launchEnvironment 500' }],
      approver: 'slack:harsha',
      stores: stores(),
      now: NOW,
    });

    expect(result.approved).toBe(1);
    expect(result.shipped).toBe(0);
    expect(result.dispatchFailures).toBe(1);

    const approved = await store.queryHistory({ loopId: LOOP_ID, status: ['approved'] });
    expect(approved).toHaveLength(1);
    expect(approved[0].shippedAt == null).toBe(true);
    expect(approved[0].mutation?.error).toContain('dispatch failed');
    expect(approved[0].mutation?.error).toContain('launchEnvironment 500');
  });

  it('ships unmatched pending records when every dispatched item succeeded', async () => {
    // Generic digests use synthetic item ids that never match sourceRuleId.
    await seedPending(store, 'tool-a', new Date('2026-06-12T07:00:00.000Z'));
    await seedPending(store, 'tool-b', new Date('2026-06-12T07:00:01.000Z'));

    const result = await recordLoopApproval({
      runId: RUN_ID,
      items: [
        { id: 'agent-mode-run-abc-1', ok: true },
        { id: 'agent-mode-run-abc-2', ok: true },
      ],
      approver: 'slack:harsha',
      stores: stores(),
      now: NOW,
    });

    expect(result.approved).toBe(2);
    expect(result.shipped).toBe(2);
  });

  it('does not ship unmatched records when any dispatch failed', async () => {
    await seedPending(store, 'tool-a', new Date('2026-06-12T07:00:00.000Z'));

    const result = await recordLoopApproval({
      runId: RUN_ID,
      items: [{ id: 'agent-mode-run-abc-1', ok: false, error: 'boom' }],
      approver: 'slack:harsha',
      stores: stores(),
      now: NOW,
    });

    expect(result.approved).toBe(1);
    expect(result.shipped).toBe(0);
  });

  it('ships only the successful sibling when a multi-item dispatch partially fails', async () => {
    await seedPending(store, 'tool-a', new Date('2026-06-12T07:00:00.000Z'));
    await seedPending(store, 'tool-b', new Date('2026-06-12T07:00:01.000Z'));

    const result = await recordLoopApproval({
      runId: RUN_ID,
      items: [
        { id: 'prop-tool-a', ok: true },
        { id: 'prop-tool-b', ok: false, error: 'Linear unavailable' },
      ],
      approver: 'slack:harsha',
      stores: stores(),
      now: NOW,
    });

    expect(result.approved).toBe(2);
    expect(result.shipped).toBe(1);
    expect(result.dispatchFailures).toBe(1);

    const approved = await store.queryHistory({ loopId: LOOP_ID, status: ['approved'] });
    expect(approved.find((record) => record.proposal?.proposalId === 'prop-tool-a')?.shippedAt)
      .toEqual(NOW);
    expect(approved.find((record) => record.proposal?.proposalId === 'prop-tool-b')?.shippedAt)
      .toBeUndefined();
  });

  it('writes nothing when no pending records exist for the run', async () => {
    const result = await recordLoopApproval({
      runId: 'run:unknown',
      items: [{ id: 'x', ok: true }],
      approver: 'slack:harsha',
      stores: stores(),
      now: NOW,
    });

    expect(result.loopId).toBeNull();
    expect(result.approved).toBe(0);
    expect(store.size).toBe(0);
  });

  it('is idempotent — a second approval of the same run writes nothing new', async () => {
    await seedPending(store, 'fix-cta', new Date('2026-06-12T07:00:00.000Z'));
    const opts = {
      runId: RUN_ID,
      items: [{ id: 'fix-cta', ok: true }],
      approver: 'slack:harsha',
      stores: stores(),
      now: NOW,
    };

    await recordLoopApproval(opts);
    const sizeAfterFirst = store.size;
    const second = await recordLoopApproval(opts);

    expect(second.approved).toBe(0);
    expect(store.size).toBe(sizeAfterFirst);
  });

  it('makes CooldownRuleSet suppress a re-proposal of the in-flight rule', async () => {
    await seedPending(store, 'fix-cta', new Date('2026-06-12T07:00:00.000Z'));
    await recordLoopApproval({
      runId: RUN_ID,
      items: [{ id: 'fix-cta', ok: true }],
      approver: 'slack:harsha',
      stores: stores(),
      now: NOW,
    });

    const inner: RuleSet<NormalizedEvent, unknown> = {
      evaluate: async () => [proposal('fix-cta'), proposal('fresh-rule')],
    };
    const cooldown = new CooldownRuleSet(inner, store, LOOP_ID);
    const window: TimeWindow = {
      start: new Date('2026-06-11T08:00:00.000Z'),
      end: new Date('2026-06-12T09:00:00.000Z'),
    };

    const surviving = await cooldown.evaluate([], window);

    expect(surviving.map((p) => p.sourceRuleId)).toEqual(['llm-analyst:fresh-rule']);
  });

  it('produces records the attribution cron will pick up (approved, shipped, ungraded)', async () => {
    await seedPending(store, 'fix-cta', new Date('2026-06-12T07:00:00.000Z'));
    await recordLoopApproval({
      runId: RUN_ID,
      items: [{ id: 'fix-cta', ok: true }],
      approver: 'slack:harsha',
      stores: stores(),
      now: NOW,
    });

    // Mirrors runAttribution's candidate filter: shipped, approved, no verdict.
    const candidates = (
      await store.queryHistory({ loopId: LOOP_ID, status: ['approved', 'auto_shipped'] })
    ).filter((r) => r.shippedAt && r.verdict == null);

    expect(candidates).toHaveLength(1);
    expect(candidates[0].proposal?.sourceRuleId).toBe('llm-analyst:fix-cta');
  });
});
