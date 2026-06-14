/**
 * Tests for SlackReactionGate — the real Layer-4 approval gate that resolves a
 * decision from a Slack reaction on the proposal DM and stamps the Layer-5
 * shippedAt (INCREMENT C1, closes the dev.md-named #1 gap).
 *
 * Behavioral contract (HUMAN-WRITTEN — see loop-agentmode-restructure.md §C1.
 * The AC is the spec; these assertions must NOT be modified):
 *   1. Given an APPROVED proposal (✅ from the approver on the DM), the gate
 *      resolves decision.status='approved' AND, when settled into the store,
 *      the pending learning record becomes decision=approved with shippedAt set.
 *   2. Given a REJECT (❌), the gate resolves decision.status='denied' AND the
 *      settled record is decision=denied with NO shippedAt (no ship).
 *   3. Given NO reaction, the gate resolves status='pending' AND nothing is
 *      shipped — the record stays pending.
 *
 * The SlackPort + LearningStore are mocked; the test asserts all three
 * transitions end-to-end (poll the reaction -> settle into the store).
 */

import { SlackReactionGate, resolveReactionDecision } from '../loops/core/gates/slackReactionGate';
import { InMemoryLearningStore } from '../loops/core/learning/inMemoryLearningStore';
import type {
  ApprovalRecord,
  LoopId,
  Mutation,
} from '../loops/core/types';
import type {
  SlackMessageHandle,
  SlackPort,
  SlackReaction,
  ClockPort,
} from '../loops/core/ports';

const LOOP_ID = 'agent-mode' as LoopId;
const RUN_ID = 'run:c1';
const APPROVER = 'U08TM4QFQ1L';
const NOW = new Date('2026-06-14T08:00:00.000Z');

const fixedClock: ClockPort = { now: () => NOW };

function mutation(slug: string): Mutation {
  return {
    mutationId: `mut-${slug}` as Mutation['mutationId'],
    proposalId: `prop-${slug}` as Mutation['proposalId'],
    kind: 'spec_output',
    artifact: { slug },
  };
}

/** A SlackPort stub that records postMessage calls and returns a scripted set
 * of reactions from getReactions. */
function makeSlack(reactions: SlackReaction[]): SlackPort & { posted: { channel: string; text: string }[] } {
  const posted: { channel: string; text: string }[] = [];
  return {
    posted,
    async postMessage(channelOrUserId: string, markdown: string): Promise<SlackMessageHandle> {
      posted.push({ channel: channelOrUserId, text: markdown });
      return { channel: channelOrUserId, ts: '1700000000.000100' };
    },
    async getReactions(): Promise<readonly SlackReaction[]> {
      return reactions;
    },
    async getReplies() {
      return [];
    },
  };
}

/** Seed the store the way the orchestrator does: a pending gate-time row. */
async function seedPending(store: InMemoryLearningStore, mut: Mutation): Promise<void> {
  await store.record({
    loopId: LOOP_ID,
    runId: RUN_ID as never,
    ts: new Date('2026-06-14T07:00:00.000Z'),
    mutation: mut,
    decision: { status: 'pending', decidedAt: new Date('2026-06-14T07:00:00.000Z') },
  });
}

describe('resolveReactionDecision (pure resolver)', () => {
  it('maps ✅ from the approver to approved', () => {
    const d = resolveReactionDecision([{ name: 'white_check_mark', users: [APPROVER] }], APPROVER, NOW);
    expect(d.status).toBe('approved');
    expect(d.decidedBy).toBe(`slack:${APPROVER}`);
  });

  it('maps ❌ from the approver to denied', () => {
    const d = resolveReactionDecision([{ name: 'x', users: [APPROVER] }], APPROVER, NOW);
    expect(d.status).toBe('denied');
  });

  it('maps no reactions to pending', () => {
    const d = resolveReactionDecision([], APPROVER, NOW);
    expect(d.status).toBe('pending');
  });

  it('ignores reactions from non-approvers', () => {
    const d = resolveReactionDecision([{ name: 'white_check_mark', users: ['U_SOMEONE_ELSE'] }], APPROVER, NOW);
    expect(d.status).toBe('pending');
  });

  it('denies when both ✅ and ❌ are present (reject wins — safety)', () => {
    const d = resolveReactionDecision(
      [
        { name: 'white_check_mark', users: [APPROVER] },
        { name: 'x', users: [APPROVER] },
      ],
      APPROVER,
      NOW,
    );
    expect(d.status).toBe('denied');
  });
});

describe('SlackReactionGate — three AC transitions', () => {
  it('AC1: ✅ approval -> decision approved + shippedAt stamped on the learning record', async () => {
    const slack = makeSlack([{ name: 'white_check_mark', users: [APPROVER] }]);
    const store = new InMemoryLearningStore();
    const mut = mutation('approve');
    await seedPending(store, mut);

    const gate = new SlackReactionGate({ slack, approver: APPROVER, clock: fixedClock, dmTitle: 'Approve me?' });

    const record: ApprovalRecord = await gate.requestApproval(mut);
    expect(slack.posted).toHaveLength(1);

    const decision = await gate.pollDecision(record);
    expect(decision.status).toBe('approved');

    const settled = await gate.settleDecision(store, LOOP_ID, mut, decision);
    expect(settled).toBe(true);

    const history = await store.queryHistory({ loopId: LOOP_ID });
    const approved = history.filter((r) => r.decision?.status === 'approved');
    expect(approved).toHaveLength(1);
    expect(approved[0].shippedAt).toBeInstanceOf(Date);
    expect(approved[0].shippedAt).toEqual(NOW);
    // Original mutation provenance preserved.
    expect(approved[0].mutation?.mutationId).toBe(mut.mutationId);
  });

  it('AC2: ❌ reject -> decision denied, NO shippedAt (no ship)', async () => {
    const slack = makeSlack([{ name: 'x', users: [APPROVER] }]);
    const store = new InMemoryLearningStore();
    const mut = mutation('reject');
    await seedPending(store, mut);

    const gate = new SlackReactionGate({ slack, approver: APPROVER, clock: fixedClock, dmTitle: 'Approve me?' });
    const record = await gate.requestApproval(mut);

    const decision = await gate.pollDecision(record);
    expect(decision.status).toBe('denied');

    const settled = await gate.settleDecision(store, LOOP_ID, mut, decision);
    expect(settled).toBe(true);

    const history = await store.queryHistory({ loopId: LOOP_ID });
    const denied = history.filter((r) => r.decision?.status === 'denied');
    expect(denied).toHaveLength(1);
    expect(denied[0].shippedAt == null).toBe(true);
    // No approved/shipped record exists.
    expect(history.some((r) => r.shippedAt != null)).toBe(false);
  });

  it('AC3: no reaction -> stays pending, nothing shipped', async () => {
    const slack = makeSlack([]);
    const store = new InMemoryLearningStore();
    const mut = mutation('pending');
    await seedPending(store, mut);
    const before = store.size;

    const gate = new SlackReactionGate({ slack, approver: APPROVER, clock: fixedClock, dmTitle: 'Approve me?' });
    const record = await gate.requestApproval(mut);

    const decision = await gate.pollDecision(record);
    expect(decision.status).toBe('pending');

    // Settling a pending decision is a no-op: nothing new written, nothing shipped.
    const settled = await gate.settleDecision(store, LOOP_ID, mut, decision);
    expect(settled).toBe(false);
    expect(store.size).toBe(before);

    const history = await store.queryHistory({ loopId: LOOP_ID });
    expect(history.every((r) => r.decision?.status === 'pending')).toBe(true);
    expect(history.some((r) => r.shippedAt != null)).toBe(false);
  });

  it('AC4 (no prod flip): the gate is gated behind AGENT_MODE_SLACK_REACTION_GATE and does NOT replace CaptureGate by default', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('../loops/instances/agent-mode/index');
    const prev = process.env.AGENT_MODE_SLACK_REACTION_GATE;
    try {
      delete process.env.AGENT_MODE_SLACK_REACTION_GATE;
      expect(mod.isSlackReactionGateEnabled()).toBe(false);
      expect(mod.buildAgentModeSlackReactionGate()).toBeNull();

      process.env.AGENT_MODE_SLACK_REACTION_GATE = 'true';
      expect(mod.isSlackReactionGateEnabled()).toBe(true);
      const gate = mod.buildAgentModeSlackReactionGate();
      expect(gate).toBeInstanceOf(SlackReactionGate);
    } finally {
      if (prev === undefined) delete process.env.AGENT_MODE_SLACK_REACTION_GATE;
      else process.env.AGENT_MODE_SLACK_REACTION_GATE = prev;
    }
  });

  it('settle is idempotent: a second approved settle does not double-ship', async () => {
    const slack = makeSlack([{ name: 'white_check_mark', users: [APPROVER] }]);
    const store = new InMemoryLearningStore();
    const mut = mutation('idem');
    await seedPending(store, mut);

    const gate = new SlackReactionGate({ slack, approver: APPROVER, clock: fixedClock, dmTitle: 'Approve me?' });
    const record = await gate.requestApproval(mut);
    const decision = await gate.pollDecision(record);

    await gate.settleDecision(store, LOOP_ID, mut, decision);
    const secondWrote = await gate.settleDecision(store, LOOP_ID, mut, decision);
    expect(secondWrote).toBe(false);

    const history = await store.queryHistory({ loopId: LOOP_ID });
    expect(history.filter((r) => r.decision?.status === 'approved')).toHaveLength(1);
  });
});
