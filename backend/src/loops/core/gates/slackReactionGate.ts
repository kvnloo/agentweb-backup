/**
 * slackReactionGate — the real production ApprovalGate (Layer 4) that resolves
 * a decision from a Slack reaction (✅ approve / ❌ reject) on the proposal DM
 * and stamps the Layer-5 `shippedAt` on approval.
 *
 * Why this exists (INCREMENT C1 — the dev.md-named #1 gap, 2026-06-09):
 * production loops are still wired to `CaptureGate`, whose `pollDecision()`
 * always returns `pending`, so `shippedAt` is never stamped and no loop ever
 * reaches a `learned`/`regressed` verdict. This gate closes Layer 4→5:
 *
 *   requestApproval(mutation) -> posts a DM, returns a handle (channel+ts)
 *   pollDecision(record)      -> reads reactions, resolves approved/denied/pending
 *   settleDecision(store, …)  -> on a resolved decision, appends the Layer-5
 *                                record (approved => shippedAt stamped; denied
 *                                => no ship), exactly the shape the attribution
 *                                cron grades. Pending is a no-op.
 *
 * Reaction convention matches the rest of the codebase (awsAdapters.getReactions
 * + slack.aiEvalReaction handler): ✅ = `white_check_mark`, ❌ = `x`. A reject
 * reaction wins over an approve when both are present (safety-first).
 *
 * Package boundary: this lives in `loops/core/` so it only depends on the
 * injected `SlackPort` + `ClockPort` and the framework types — no agentweb host
 * imports. It is NOT auto-wired into any prod manifest; a loop opts in by
 * registering it as its `gateImpl` behind an explicit flag (see
 * instances/agent-mode/index.ts). This PR adds the capability + tests, not a
 * prod flip of CaptureGate.
 */

import type { ApprovalGate, ApprovalRecord, Decision, LearningStore, LoopId, Mutation } from '../types';
import type { ClockPort, SlackPort, SlackReaction } from '../ports';

/** Slack reaction shortcodes the gate keys off. */
export const APPROVE_REACTION = 'white_check_mark';
export const REJECT_REACTION = 'x';

export interface SlackReactionGateConfig {
  slack: SlackPort;
  /** Slack user id whose reaction is authoritative. Only this user's ✅/❌
   * counts; reactions from anyone else are ignored. */
  approver: string;
  clock: ClockPort;
  /** Channel/user the DM is posted to. Defaults to the approver (DM). */
  channel?: string;
  /** First line of the approval DM. The mutation summary is appended. */
  dmTitle?: string;
}

/**
 * Pure resolver: given the reactions on the DM, the authoritative approver, and
 * the current time, produce a Decision. Reject wins over approve. Reactions
 * from non-approvers are ignored. No reaction => pending.
 */
export function resolveReactionDecision(
  reactions: readonly SlackReaction[],
  approver: string,
  now: Date,
): Decision {
  const hasFromApprover = (name: string): boolean =>
    reactions.some((r) => r.name === name && r.users.includes(approver));

  if (hasFromApprover(REJECT_REACTION)) {
    return { status: 'denied', decidedAt: now, decidedBy: `slack:${approver}`, reason: 'slack ❌ reaction' };
  }
  if (hasFromApprover(APPROVE_REACTION)) {
    return { status: 'approved', decidedAt: now, decidedBy: `slack:${approver}`, reason: 'slack ✅ reaction' };
  }
  return { status: 'pending', decidedAt: now };
}

export class SlackReactionGate implements ApprovalGate {
  private readonly slack: SlackPort;
  private readonly approver: string;
  private readonly clock: ClockPort;
  private readonly channel: string;
  private readonly dmTitle: string;
  /** Proposal ids already settled (approved/denied) — keeps settleDecision
   * idempotent so a repeated reaction poll never double-ships. */
  private readonly settled = new Set<string>();

  constructor(config: SlackReactionGateConfig) {
    this.slack = config.slack;
    this.approver = config.approver;
    this.clock = config.clock;
    this.channel = config.channel ?? config.approver;
    this.dmTitle = config.dmTitle ?? 'Loop proposal awaiting approval';
  }

  async requestApproval(mutation: Mutation): Promise<ApprovalRecord> {
    const body = `${this.dmTitle}\nProposal: ${mutation.mutationId} (${mutation.kind})\nReact ✅ to approve  |  ❌ to reject`;
    const handle = await this.slack.postMessage(this.channel, body);
    return {
      mutationId: mutation.mutationId,
      handle: { channel: handle.channel, ts: handle.ts, approver: this.approver },
      requestedAt: this.clock.now(),
    };
  }

  async pollDecision(record: ApprovalRecord): Promise<Decision> {
    const reactions = await this.slack.getReactions({ channel: record.handle.channel, ts: record.handle.ts });
    const approver = record.handle.approver ?? this.approver;
    return resolveReactionDecision(reactions, approver, this.clock.now());
  }

  /**
   * Settle a resolved decision into the learning store (Layer 4→5 write).
   *
   * - `approved`  => append a record with decision.status='approved' and
   *                  `shippedAt` stamped (the value the attribution cron grades).
   * - `denied`    => append a record with decision.status='denied' and NO
   *                  `shippedAt` (no ship).
   * - `pending`/other => no-op.
   *
   * Idempotent per proposal: a second settle for the same mutation writes
   * nothing. Returns true iff a record was written.
   */
  async settleDecision(
    store: LearningStore,
    loopId: LoopId,
    mutation: Mutation,
    decision: Decision,
  ): Promise<boolean> {
    if (decision.status !== 'approved' && decision.status !== 'denied') return false;
    const key = mutation.proposalId as unknown as string;
    if (this.settled.has(key)) return false;

    // Recover the run this mutation belongs to from the pending gate-time row,
    // so the settled record shares the same runId the attribution cron groups by.
    const history = await store.queryHistory({ loopId });
    const pending = history.find(
      (r) => (r.mutation?.mutationId as unknown as string) === (mutation.mutationId as unknown as string)
        && r.decision?.status === 'pending',
    );

    const now = this.clock.now();
    await store.record({
      loopId,
      runId: pending?.runId ?? (mutation.proposalId as never),
      ts: now,
      proposal: pending?.proposal,
      mutation,
      decision,
      ...(decision.status === 'approved' ? { shippedAt: now } : {}),
    });

    this.settled.add(key);
    return true;
  }

  /** Test seam — clear the idempotency set. */
  resetForTesting(): void {
    this.settled.clear();
  }
}
