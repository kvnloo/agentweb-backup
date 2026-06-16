/**
 * Loop health — turns a manifest + its durable learning history into a single
 * lifecycle state an operator can read at a glance.
 *
 * The audit's missing piece (#6): "add loop health endpoints so Fangfang/Rui
 * can see: empty, blocked, pending approval, in flight, learned, or regressed."
 * Without this, a loop can silently stall (sensor empty, gate never resolving,
 * attribution never grading) and the only way to notice is to read logs.
 *
 * This module is PURE — no I/O, no clock-of-its-own (the caller injects `now`).
 * That keeps it inside the `loops/core/` package boundary and makes every
 * state exhaustively unit-testable. The route handler does the DynamoDB read
 * and hands the records here.
 *
 * State precedence (most urgent first): a loop is summarized by its single most
 * actionable state, while `counts` always carries the full breakdown so the UI
 * can show the long tail.
 *
 *   blocked          — manifest.paused (operator halted it)
 *   regressed        — a shipped fix made the metric worse (needs a human NOW)
 *   pending_approval — a proposal is waiting on a human decision
 *   in_flight        — a fix shipped, attribution hasn't graded it yet
 *   learned          — a shipped fix improved the metric (the happy path)
 *   idle             — records exist but only no_change/inconclusive remain
 *   empty            — no learning history at all (sensor dry or never ran)
 */

import type { LearningRecord, LoopManifest, OutcomeVerdict } from './types';

export type LoopHealthState =
  | 'empty'
  | 'blocked'
  | 'pending_approval'
  | 'in_flight'
  | 'learned'
  | 'regressed'
  | 'idle';

export interface LoopHealthCounts {
  total: number;
  pendingApproval: number;
  inFlight: number;
  improved: number;
  regressed: number;
  noChange: number;
  inconclusive: number;
}

export interface LoopHealthLastOutcome {
  ruleId: string;
  verdict: OutcomeVerdict;
  observedLiftPct: number | null;
  ts: string;
}

export interface LoopHealth {
  loopId: string;
  displayName: string;
  state: LoopHealthState;
  paused: boolean;
  pauseReason?: string;
  targetMetric: string;
  counts: LoopHealthCounts;
  /** ISO timestamp of the most recent learning record, or null if none. */
  lastActivityAt: string | null;
  /** The most recent record that carries a verdict, or null. */
  lastOutcome: LoopHealthLastOutcome | null;
}

/** Stable identity for the proposal a record concerns. Used to tell whether a
 * later record has superseded an earlier `pending` row for the same proposal. */
function proposalKey(r: LearningRecord): string | null {
  const p = r.proposal?.proposalId as string | undefined;
  const m = r.mutation?.mutationId as string | undefined;
  return p ?? m ?? null;
}

/** A record "resolves" its proposal once a human ✅ lands (approved /
 * auto_shipped), the mutation ships (`shippedAt`), or attribution grades it
 * (`verdict`). The learning store is append-only, so the original `pending`
 * row for a proposal lives forever alongside its later approved/shipped/graded
 * rows — without de-duping, a loop would report `pending_approval` even after
 * the ✅ and even after a verdict landed, which is exactly the C2 stall. */
function resolvesProposal(r: LearningRecord): boolean {
  return (
    r.decision?.status === 'approved'
    || r.decision?.status === 'auto_shipped'
    || !!r.shippedAt
    || r.verdict != null
  );
}

/** A record counts as "pending approval" when it carries a pending decision and
 * has not yet shipped. */
function isPendingApproval(r: LearningRecord): boolean {
  return r.decision?.status === 'pending' && !r.shippedAt;
}

/** Shipped but not yet graded by attribution → in flight. */
function isInFlight(r: LearningRecord): boolean {
  return !!r.shippedAt && r.verdict == null;
}

/** A graded verdict supersedes the earlier shipped-but-ungraded row for the
 * same mutation: the same proposal can't be both `in_flight` and `learned`. */
function isGraded(r: LearningRecord): boolean {
  return r.verdict != null;
}

export function computeLoopHealth(
  manifest: LoopManifest,
  history: readonly LearningRecord[],
  now: Date,
): LoopHealth {
  const counts: LoopHealthCounts = {
    total: history.length,
    pendingApproval: 0,
    inFlight: 0,
    improved: 0,
    regressed: 0,
    noChange: 0,
    inconclusive: 0,
  };

  let lastActivityMs = -Infinity;
  let lastActivityAt: string | null = null;
  let lastOutcome: LoopHealthLastOutcome | null = null;
  let lastOutcomeKey = '';

  // The learning store is append-only: one logical proposal accumulates a
  // pending row, then an approved+shipped row, then a graded row. To report the
  // loop's CURRENT state we count each proposal by its furthest-progressed row
  // only, otherwise an early row keeps the loop stuck on a stale state (the C2
  // stall: `pending_approval` after the ✅, or `in_flight` after a verdict).
  const resolvedProposals = new Set<string>(); // approved/shipped/graded exists
  const gradedProposals = new Set<string>(); // a verdict exists
  for (const r of history) {
    const key = proposalKey(r);
    if (!key) continue;
    if (resolvesProposal(r)) resolvedProposals.add(key);
    if (isGraded(r)) gradedProposals.add(key);
  }

  for (const r of history) {
    if (isPendingApproval(r)) {
      const key = proposalKey(r);
      if (!key || !resolvedProposals.has(key)) counts.pendingApproval++;
    }
    if (isInFlight(r)) {
      const key = proposalKey(r);
      if (!key || !gradedProposals.has(key)) counts.inFlight++;
    }
    switch (r.verdict) {
      case 'improved':
        counts.improved++;
        break;
      case 'regressed':
        counts.regressed++;
        break;
      case 'no_change':
        counts.noChange++;
        break;
      case 'inconclusive':
        counts.inconclusive++;
        break;
      default:
        break;
    }

    const ms = r.ts.getTime();
    if (ms > lastActivityMs) {
      lastActivityMs = ms;
      lastActivityAt = r.ts.toISOString();
    }

    // Track the most recent record carrying a verdict (sortKey is chronological
    // + unique, so it's a stable "latest" tiebreaker).
    if (r.verdict != null && r.sortKey > lastOutcomeKey) {
      lastOutcomeKey = r.sortKey;
      lastOutcome = {
        ruleId: r.proposal?.sourceRuleId ?? 'unknown',
        verdict: r.verdict,
        observedLiftPct: r.observedLiftPct ?? null,
        ts: r.ts.toISOString(),
      };
    }
  }

  void now; // reserved for future "stale loop" detection; kept for signature stability

  const state = deriveState(manifest, counts, history.length);

  return {
    loopId: manifest.loopId,
    displayName: manifest.displayName,
    state,
    paused: manifest.paused,
    ...(manifest.pauseReason ? { pauseReason: manifest.pauseReason } : {}),
    targetMetric: manifest.targetMetric.name,
    counts,
    lastActivityAt,
    lastOutcome,
  };
}

function deriveState(
  manifest: LoopManifest,
  counts: LoopHealthCounts,
  total: number,
): LoopHealthState {
  if (manifest.paused) return 'blocked';
  if (total === 0) return 'empty';
  if (counts.regressed > 0) return 'regressed';
  if (counts.pendingApproval > 0) return 'pending_approval';
  if (counts.inFlight > 0) return 'in_flight';
  if (counts.improved > 0) return 'learned';
  return 'idle';
}
