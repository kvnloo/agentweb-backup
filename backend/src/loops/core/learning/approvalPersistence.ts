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

  for (const { loopId, store } of options.stores) {
    const history = await store.queryHistory({ loopId });
    const runRecords = history.filter((r) => (r.runId as unknown as string) === options.runId);
    if (runRecords.length === 0) continue;

    const pending = runRecords.filter((r) => r.decision?.status === 'pending');
    const alreadyApproved = new Set(
      runRecords
        .filter((r) => r.decision?.status === 'approved')
        .map((r) => r.proposal?.proposalId as string | undefined)
        .filter((id): id is string => id != null),
    );

    result.loopId = loopId;

    for (const record of pending) {
      const proposalId = record.proposal?.proposalId as string | undefined;
      if (proposalId && alreadyApproved.has(proposalId)) continue; // idempotent re-✅
      if (proposalId) alreadyApproved.add(proposalId);

      const matched = options.items.find((item) => itemMatchesRecord(item, record));
      const shipped = matched ? matched.ok : allOk;
      const failureNote = matched && !matched.ok
        ? `dispatch failed: ${matched.error ?? 'unknown error'}`
        : undefined;

      await store.record({
        loopId,
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

    // runIds are unique to one loop's run — no need to scan the rest.
    break;
  }

  return result;
}
