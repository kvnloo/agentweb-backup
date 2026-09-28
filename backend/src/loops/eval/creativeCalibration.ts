/**
 * Weekly creative calibration sampler (ENG-2142, ENG-2128 T10).
 *
 * Replaces the #eval-queue firehose as the source of creative human labels: once a week, about 20
 * pairs of generated ad creatives are drawn for a reviewer to compare with one click (A / B / tie).
 * Each pair becomes a pairwise golden case (goldenSet.ts `CreativePairRef`), so the choices land in
 * the golden set and validate the rubric judge's pairwise mode (creativeRubricJudge.ts), not the
 * gating path.
 *
 * A pair is a creative made in the week before the batch (A) and the prior creative of the same
 * account it would be judged against (B): `selectPriorBest` (same placement) when the placement is
 * known, otherwise the prior creative of the same account and category with no placement either.
 * That is the comparison `judgeCreativePair` makes, so human and judge answer the same question.
 *
 * Selection is deterministic per batch (ISO week): ties are broken by a hash of the batch and the
 * pair, never by Math.random, so every instance and every re-run draws the same batch and the
 * idempotent store write never duplicates it. Pairs are spread round-robin over strata
 * (human-eval category x placement) with a per-account cap, and inside that preference goes to
 * the pairs whose stored judge results are least settled (`PairSignal`).
 *
 * Pure: no IO. The loader and writer are in cron/creativeCalibrationCron.ts.
 */

import { createHash } from 'crypto';
import { isEvaluationUser } from '../../services/evaluationPolicy';
import { selectPriorBest, type PriorCandidateLike } from '../../services/creativeRubricJudgeRuntime';
import {
  agreementReport,
  pairwiseWinRate,
  wilsonInterval,
  type AgreementReport,
  type Interval,
  type PairwiseChoice,
} from './agreement';
import { buildPairCaseId, newCreativePairCase, type GoldenCase, type PairSignal } from './goldenSet';

export const DEFAULT_CALIBRATION_BATCH_SIZE = 20;

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

// ── ISO weeks ────────────────────────────────────────────────────────────────

const ISO_WEEK_PATTERN = /^(\d{4})-W(\d{2})$/;

/** ISO-8601 week of `date` in UTC, e.g. `2026-W39`. */
export function isoWeekOf(date: Date): string {
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const weekday = day.getUTCDay() || 7;
  // The Thursday of this week decides the ISO year.
  day.setUTCDate(day.getUTCDate() + 4 - weekday);
  const yearStart = Date.UTC(day.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((day.getTime() - yearStart) / DAY_MS + 1) / 7);
  return `${day.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** Monday 00:00 UTC of an ISO week. Throws on a malformed or out-of-range week. */
export function isoWeekStart(week: string): Date {
  const match = ISO_WEEK_PATTERN.exec(week);
  if (!match) throw new Error(`"${week}" is not an ISO week like 2026-W39`);
  const year = Number(match[1]);
  const n = Number(match[2]);
  // Week 1 is the week with 4 January in it.
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const week1Monday = jan4.getTime() - ((jan4.getUTCDay() || 7) - 1) * DAY_MS;
  const start = new Date(week1Monday + (n - 1) * WEEK_MS);
  if (n < 1 || isoWeekOf(start) !== week) throw new Error(`"${week}" is not a week of ${year}`);
  return start;
}

/** The creatives a batch draws from: those made in the ISO week before it (a closed week, so the
 * pool no longer changes while instances draw it). */
export function calibrationWindow(batch: string): { start: Date; end: Date } {
  const end = isoWeekStart(batch);
  return { start: new Date(end.getTime() - WEEK_MS), end };
}

// ── pairs ────────────────────────────────────────────────────────────────────

/** The AW-HumanEvalQueue fields the sampler reads. Feedback is only counted, never read. */
export interface CalibrationCandidate extends PriorCandidateLike {
  category?: string;
  feedback?: readonly unknown[];
}

export interface CalibrationPair<C extends CalibrationCandidate = CalibrationCandidate> {
  a: C;
  b: C;
  userId: string;
  category: string;
  placement: string;
  signal: PairSignal;
}

const UNKNOWN_PLACEMENT = 'unknown';

function placementOf(c: CalibrationCandidate): string | undefined {
  return c.creativeGates?.placement ?? c.creativeGates?.requestedSize;
}

function categoryOf(c: CalibrationCandidate): string {
  return c.category === 'ad' || c.category === 'organic_post' ? c.category : 'uncategorized';
}

function rubricPasses(c: CalibrationCandidate): number | null {
  return c.creativeRubric?.status === 'ok' ? c.creativeRubric.passedCount : null;
}

/** B for creative A, or null. Same placement when A's is known; otherwise the latest earlier
 * creative of the same account and category whose placement is unknown too. */
export function priorFor<C extends CalibrationCandidate>(a: C, pool: readonly C[]): C | null {
  if (placementOf(a)) return selectPriorBest(a, pool);
  if (!a.userId) return null;
  const priors = pool.filter(
    (c) =>
      c.candidateId !== a.candidateId &&
      c.reviewType === 'creative_image' &&
      c.userId === a.userId &&
      !!c.artifactUrl &&
      !placementOf(c) &&
      categoryOf(c) === categoryOf(a) &&
      c.createdAt < a.createdAt,
  );
  priors.sort((x, y) => (rubricPasses(y) ?? -1) - (rubricPasses(x) ?? -1) || y.createdAt.localeCompare(x.createdAt));
  return priors[0] ?? null;
}

/**
 * How settled the judge's stored single-creative results already make the pair, strongest
 * reason to ask a human first:
 *  - `disagree`: the judge passed a creative in the pair (all 7 criteria) that a reviewer still
 *    replied to in #eval-queue — the judge and a human already differ on it;
 *  - `uncertain`: both judged, pass counts within one of each other;
 *  - `unscored`: at least one was never judged (the judge is sampled, and off by default);
 *  - `clear`: both judged, two or more passes apart.
 * The pairwise verdict itself is not stored anywhere, so these are the signals available before
 * a pair is shown; the report script runs the pairwise judge on the labelled pairs.
 */
export function pairSignal(a: CalibrationCandidate, b: CalibrationCandidate): PairSignal {
  const judgedPassWithReply = (c: CalibrationCandidate) =>
    c.creativeRubric?.status === 'ok' && c.creativeRubric.passed && (c.feedback?.length ?? 0) > 0;
  if (judgedPassWithReply(a) || judgedPassWithReply(b)) return 'disagree';
  const pa = rubricPasses(a);
  const pb = rubricPasses(b);
  if (pa === null || pb === null) return 'unscored';
  return Math.abs(pa - pb) <= 1 ? 'uncertain' : 'clear';
}

/** Every eligible pair whose A was made inside `window`; B may be older. Evaluation accounts are left out. */
export function buildCalibrationPairs<C extends CalibrationCandidate>(
  candidates: readonly C[],
  window: { start: Date; end: Date },
): CalibrationPair<C>[] {
  const start = window.start.toISOString();
  const end = window.end.toISOString();
  const byUser = new Map<string, C[]>();
  for (const c of candidates) {
    if (c.reviewType !== 'creative_image' || !c.userId || !c.artifactUrl || isEvaluationUser(c.userId)) continue;
    const list = byUser.get(c.userId) ?? [];
    list.push(c);
    byUser.set(c.userId, list);
  }
  const pairs: CalibrationPair<C>[] = [];
  for (const [userId, pool] of byUser) {
    for (const a of pool) {
      if (a.createdAt < start || a.createdAt >= end) continue;
      const b = priorFor(a, pool);
      if (!b) continue;
      pairs.push({ a, b, userId, category: categoryOf(a), placement: placementOf(a) ?? UNKNOWN_PLACEMENT, signal: pairSignal(a, b) });
    }
  }
  return pairs;
}

// ── selection ────────────────────────────────────────────────────────────────

const SIGNAL_PRIORITY: Record<PairSignal, number> = { disagree: 0, uncertain: 1, unscored: 2, clear: 3 };

function seededRank(seed: string, key: string): number {
  return createHash('sha256').update(`${seed}|${key}`).digest().readUInt32BE(0);
}

export interface SelectOptions {
  /** The batch id (ISO week); it seeds every tie-break. */
  batch: string;
  target?: number;
  /** Case ids already in the golden set from other batches; never drawn again. */
  excludeCaseIds?: ReadonlySet<string>;
}

/**
 * Deterministic stratified draw of up to `target` pairs. Rounds go over the strata (category x
 * placement) taking one pair from each, strata with a stronger signal first; inside a stratum the
 * strongest signal, then the seeded order. First with a cap of ceil(target / accounts) pairs per
 * account, then, if that leaves the batch short, without it.
 */
export function selectCalibrationPairs<P extends CalibrationPair>(pairs: readonly P[], opts: SelectOptions): P[] {
  const target = opts.target ?? DEFAULT_CALIBRATION_BATCH_SIZE;
  if (!Number.isInteger(target) || target < 1) throw new Error('selectCalibrationPairs: target must be a positive integer');
  const seed = opts.batch;
  const ranked = pairs
    .filter((p) => !opts.excludeCaseIds?.has(pairCaseKey(p)))
    .map((p) => ({ p, rank: seededRank(seed, pairCaseKey(p)) }))
    .sort((x, y) => SIGNAL_PRIORITY[x.p.signal] - SIGNAL_PRIORITY[y.p.signal] || x.rank - y.rank);

  const strata = new Map<string, Array<{ p: P; rank: number }>>();
  for (const entry of ranked) {
    const key = `${entry.p.category}|${entry.p.placement}`;
    const list = strata.get(key) ?? [];
    list.push(entry);
    strata.set(key, list);
  }
  const strataKeys = [...strata.keys()];
  const stratumRank = new Map(strataKeys.map((k) => [k, seededRank(seed, `stratum:${k}`)]));
  const accounts = new Set(ranked.map((e) => e.p.userId)).size;
  const cap = Math.max(1, Math.ceil(target / Math.max(1, accounts)));

  const picked: P[] = [];
  const perAccount = new Map<string, number>();
  const nextFrom = (key: string, capped: boolean): number => {
    const list = strata.get(key) ?? [];
    return list.findIndex((e) => !capped || (perAccount.get(e.p.userId) ?? 0) < cap);
  };
  for (const capped of [true, false]) {
    let progressed = true;
    while (picked.length < target && progressed) {
      progressed = false;
      const round = strataKeys
        .map((key) => ({ key, index: nextFrom(key, capped) }))
        .filter((r) => r.index >= 0)
        .sort((x, y) => {
          const sx = SIGNAL_PRIORITY[(strata.get(x.key) ?? [])[x.index].p.signal];
          const sy = SIGNAL_PRIORITY[(strata.get(y.key) ?? [])[y.index].p.signal];
          return sx - sy || (stratumRank.get(x.key) ?? 0) - (stratumRank.get(y.key) ?? 0);
        });
      for (const { key } of round) {
        if (picked.length >= target) break;
        // Re-check: an earlier pick in this round may have filled the account's cap.
        const index = nextFrom(key, capped);
        if (index < 0) continue;
        const [entry] = (strata.get(key) ?? []).splice(index, 1);
        picked.push(entry.p);
        perAccount.set(entry.p.userId, (perAccount.get(entry.p.userId) ?? 0) + 1);
        progressed = true;
      }
    }
  }
  return picked;
}

/** The golden case id a pair gets. */
export function pairCaseKey(p: CalibrationPair): string {
  return buildPairCaseId(p.a.candidateId, p.b.candidateId);
}

/** The pairwise golden cases for a drawn batch, in draw order. */
export function toCalibrationCases(selected: readonly CalibrationPair[], batch: string, now: Date): GoldenCase[] {
  return selected.map((p, position) =>
    newCreativePairCase({
      candidateIdA: p.a.candidateId,
      pair: {
        candidateIdB: p.b.candidateId,
        batch,
        position,
        batchSize: selected.length,
        category: p.category,
        placement: p.placement,
        signal: p.signal,
      },
      now,
    }),
  );
}

// ── agreement ────────────────────────────────────────────────────────────────

export interface PairwiseComparison {
  human: PairwiseChoice;
  judge: PairwiseChoice;
}

export interface PairwiseAgreement {
  n: number;
  /** Share of pairs where the judge made the human's choice (A, B or tie), Wilson 95% CI. */
  agreement: { rate: number; ci: Interval };
  /** Cohen's kappa over the three choices, bootstrap 95% CI. */
  kappa: AgreementReport;
  /** Only pairs where neither the human nor the judge said tie. */
  decisive: { n: number; rate: number; ci: Interval } | null;
  /** How often each side preferred A (the newer creative); ties count half. */
  humanWinRateA: number;
  judgeWinRateA: number;
}

/** Judge-vs-human agreement on the same pairs (agreement.ts math). */
export function pairwiseAgreement(
  rows: readonly PairwiseComparison[],
  bootstrap: { iterations?: number; seed?: number } = {},
): PairwiseAgreement {
  if (rows.length === 0) throw new Error('pairwiseAgreement: at least one labelled pair is required');
  const agreed = rows.filter((r) => r.human === r.judge).length;
  const decisiveRows = rows.filter((r) => r.human !== 'tie' && r.judge !== 'tie');
  const decisiveAgreed = decisiveRows.filter((r) => r.human === r.judge).length;
  return {
    n: rows.length,
    agreement: { rate: agreed / rows.length, ci: wilsonInterval(agreed, rows.length) },
    kappa: agreementReport(
      rows.map((r) => ({ truth: r.human, predicted: r.judge })),
      bootstrap,
    ),
    decisive:
      decisiveRows.length > 0
        ? { n: decisiveRows.length, rate: decisiveAgreed / decisiveRows.length, ci: wilsonInterval(decisiveAgreed, decisiveRows.length) }
        : null,
    humanWinRateA: pairwiseWinRate(rows.map((r) => r.human)).winRateA,
    judgeWinRateA: pairwiseWinRate(rows.map((r) => r.judge)).winRateA,
  };
}
