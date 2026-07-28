/**
 * recordLoopApproval — persists a human ✅ into the learning store.
 *
 * The orchestrator writes a decision:'pending' record per gated mutation; the
 * Slack reaction handler dispatches the fixes but (before this module) never
 * wrote the approval back. That left every record's decision/shippedAt null,
 * which starved both CooldownRuleSet (re-proposed in-flight fixes) and the
 * attribution cron (nothing to grade). This is the missing Layer-4→5 write.
 *
 * Linkage: the digest DM carries the orchestrator runId, so we find that run's
 * pending records and append one approved record per proposal. Dispatched
 * digest items are matched to proposals by id when possible (AI Readiness
 * digests carry the analyst slug); unmatched proposals are marked shipped only
 * when every dispatch succeeded — when in doubt we leave a rule re-proposable
 * rather than wrongly suppress it for the cooldown window.
 */

import type { LearningRecord, LearningStore, LoopId } from '../types';

export interface DispatchedItem {
  /** Digest item id — analyst slug, Notion page id, or synthetic index id. */
  id: string;
  ok: boolean;
  error?: string;
}

export interface LoopApprovalStores {
  loopId: LoopId;
  store: LearningStore;
}

export interface ApprovalPersistenceResult {
  /** Loop whose run matched the digest's runId; null when none did. */
  loopId: LoopId | null;
  /** Approved records written. */
  approved: number;
  /** Of those, how many were marked shipped. */
  shipped: number;
  /** Items whose dispatch failed (recorded approved-but-not-shipped). */
  dispatchFailures: number;
}

export interface RecordLoopApprovalOptions {
  runId: string;
  items: DispatchedItem[];
  /** Audit string for decision.decidedBy, e.g. 'slack:U08TM4QFQ1L'. */
  approver: string;
  stores: LoopApprovalStores[];
  now?: Date;
}

export interface DenialPersistenceResult {
  /** Loop whose run matched the digest's runId; null when none did. */
  loopId: LoopId | null;
  /** Pending records resolved as denied. */
  denied: number;
}

export interface RecordLoopDenialOptions {
  runId: string;
  /** Audit string for decision.decidedBy, e.g. 'slack:U08TM4QFQ1L'. */
  denier: string;
  stores: LoopApprovalStores[];
  now?: Date;
}

export type LoopTerminalDecision = 'approved' | 'denied';

export interface ClaimLoopDecisionOptions {
  runId: string;
  decision: LoopTerminalDecision;
  decidedBy: string;
  stores: LoopApprovalStores[];
  now?: Date;
}

export interface LoopDecisionClaimResult {
  loopId: LoopId | null;
  decision: LoopTerminalDecision | null;
  /** True only when this reaction owns, or is replaying, the winning decision. */
  accepted: boolean;
  /** True only for the process that atomically created the run-level claim. */
  created: boolean;
  proposalIds: string[];
}

function itemMatchesRecord(item: DispatchedItem, record: LearningRecord): boolean {
  const ruleId = record.proposal?.sourceRuleId;
  const proposalId = record.proposal?.proposalId as string | undefined;
  const mutationId = record.mutation?.mutationId as string | undefined;
  return (
    ruleId === item.id
    || (ruleId != null && ruleId.endsWith(`:${item.id}`))
    || proposalId === item.id
    || mutationId === item.id
  );
}

function proposalKey(record: LearningRecord): string | undefined {
  return (
    record.proposal?.proposalId as string | undefined
  ) ?? (
    record.mutation?.proposalId as string | undefined
  );
}

function terminalDecision(record: LearningRecord): LoopTerminalDecision | null {
  if (record.decisionClaim) return record.decisionClaim;
  if (
    record.decision?.status === 'approved'
    || record.decision?.status === 'auto_shipped'
    || record.decision?.status === 'held'
  ) {
    return 'approved';
  }
  return record.decision?.status === 'denied' ? 'denied' : null;
}

/**
 * Atomically choose the first Slack terminal decision for a whole loop run.
 *
 * One deterministic learning-store row carries every still-pending proposal
 * ID. The conditional append is the cross-instance serialization point, and a
 * single row makes multi-proposal rejection all-or-nothing.
 */
export async function claimLoopDecision(
  options: ClaimLoopDecisionOptions,
): Promise<LoopDecisionClaimResult> {
  const now = options.now ?? new Date();

  for (const { loopId, store } of options.stores) {
    const history = await store.queryHistory({ loopId });
    const runRecords = history.filter((record) => (
      record.runId as unknown as string
    ) === options.runId);
    if (runRecords.length === 0) continue;

    const existingClaim = runRecords.find((record) => record.decisionClaim != null);
    if (existingClaim?.decisionClaim) {
      return {
        loopId,
        decision: existingClaim.decisionClaim,
        accepted: existingClaim.decisionClaim === options.decision,
        created: false,
        proposalIds: [...(existingClaim.decisionProposalIds ?? [])],
      };
    }

    const resolved = new Map<string, LoopTerminalDecision>();
    for (const record of runRecords) {
      const key = proposalKey(record);
      const decision = terminalDecision(record);
      if (key && decision) resolved.set(key, decision);
    }

    const proposalIds = [...new Set(
      runRecords
        .filter((record) => record.decision?.status === 'pending')
        .map(proposalKey)
        .filter((key): key is string => key != null && !resolved.has(key)),
    )];

    if (proposalIds.length === 0) {
      const existingDecision = [...resolved.values()][0] ?? null;
      return {
        loopId,
        decision: existingDecision,
        accepted: existingDecision === options.decision,
        created: false,
        proposalIds: [],
      };
    }

    const created = await store.recordDecisionIfAbsent({
      loopId,
      runId: runRecords[0].runId,
      ts: now,
      decision: {
        status: options.decision === 'denied' ? 'denied' : 'held',
        decidedAt: now,
        decidedBy: options.decidedBy,
        reason: `atomic Slack ${options.decision} decision`,
      },
      decisionClaim: options.decision,
      decisionProposalIds: proposalIds,
    }, `slack:${options.runId}`);

    return {
      loopId,
      decision: created ? options.decision : null,
      accepted: created,
      created,
      proposalIds: created ? proposalIds : [],
    };
  }

  return {
    loopId: null,
    decision: null,
    accepted: false,
    created: false,
    proposalIds: [],
  };
}

export async function recordLoopApproval(
  options: RecordLoopApprovalOptions,
): Promise<ApprovalPersistenceResult> {
  const now = options.now ?? new Date();
  const result: ApprovalPersistenceResult = {
    loopId: null,
    approved: 0,
    shipped: 0,
    dispatchFailures: options.items.filter((i) => !i.ok).length,
  };
  const allOk = options.items.length > 0 && options.items.every((i) => i.ok);

  const claim = await claimLoopDecision({
    runId: options.runId,
    decision: 'approved',
    decidedBy: options.approver,
    stores: options.stores,
    now,
  });
  result.loopId = claim.loopId;
  if (!claim.accepted || claim.decision !== 'approved' || claim.loopId == null) return result;

  const selected = options.stores.find(({ loopId }) => loopId === claim.loopId);
  if (!selected) return result;
  const history = await selected.store.queryHistory({ loopId: claim.loopId });
  const runRecords = history.filter((record) => (
    record.runId as unknown as string
  ) === options.runId);
  const pending = runRecords.filter((record) => record.decision?.status === 'pending');
  const alreadyResolved = new Set(
    runRecords
      .filter((record) => (
        record.decision?.status === 'approved'
        || record.decision?.status === 'denied'
        || record.decision?.status === 'auto_shipped'
      ))
      .map(proposalKey)
      .filter((id): id is string => id != null),
  );

  for (const record of pending) {
    const proposalId = proposalKey(record);
    if (proposalId && alreadyResolved.has(proposalId)) continue;
    if (proposalId) alreadyResolved.add(proposalId);

    const matched = options.items.find((item) => itemMatchesRecord(item, record));
    const shipped = matched ? matched.ok : allOk;
    const failureNote = matched && !matched.ok
      ? `dispatch failed: ${matched.error ?? 'unknown error'}`
      : undefined;

    await selected.store.record({
      loopId: claim.loopId,
      runId: record.runId,
      ts: now,
      proposal: record.proposal,
      mutation: failureNote && record.mutation
        ? { ...record.mutation, error: failureNote }
        : record.mutation,
      decision: { status: 'approved', decidedAt: now, decidedBy: options.approver },
      ...(shipped ? { shippedAt: now } : {}),
    });

    result.approved += 1;
    if (shipped) result.shipped += 1;
  }

  return result;
}

/**
 * Persist a human ❌ against every still-pending proposal in a loop run.
 *
 * Learning stores are append-only, so terminal decisions are detected by
 * proposal ID before writing. The first terminal decision wins: replays and a
 * later conflicting reaction cannot create a second decision for a proposal.
 */
export async function recordLoopDenial(
  options: RecordLoopDenialOptions,
): Promise<DenialPersistenceResult> {
  const claim = await claimLoopDecision({
    runId: options.runId,
    decision: 'denied',
    decidedBy: options.denier,
    stores: options.stores,
    now: options.now,
  });
  return {
    loopId: claim.loopId,
    denied: claim.accepted && claim.created ? claim.proposalIds.length : 0,
  };
}
