/**
 * ENG-185: offline judge-accuracy eval for the finalize guard
 * (services/agentMode/core/finalizeGuard.ts).
 *
 * Each labeled case is a final assistant reply + the run's tool ledger + the
 * ground-truth set of claim classes that are GENUINELY false (claimed as done,
 * but no successful tool call backs them). The eval runs the real guard
 * pipeline in detect-only (shadow) mode — prefilter → judge → ledger match —
 * and scores the classes it would correct against that ground truth.
 *
 * Two judge modes:
 *  - recorded (CI, deterministic): each case's `recordedJudge` is replayed.
 *    It is the human-labeled set of completed-action claims in the reply, so
 *    CI numbers isolate prefilter + ledger-matcher error, not judge error.
 *  - live (opt-in script backend/scripts/eval-finalize-judge.ts): the real
 *    production judge prompt against gemini-3.1-flash-lite; adds judge error.
 *
 * This measures; it decides nothing. AGENT_FINALIZE_GUARD /
 * AGENT_FINALIZE_GUARD_SHADOW defaults are untouched — flipping either is a
 * Harsha decision informed by these numbers (2026-07-27 contract: ≥98%
 * precision, ≥90% recall, zero high-severity false corrections).
 */

import {
  CLAIM_CLASSES,
  runFinalizeGuard,
  type ClaimClass,
  type FinalizeGuardPorts,
  type FinalizeLedgerEntry,
  type JudgedClaim,
} from '../../services/agentMode/core/finalizeGuard';

export type JudgeCaseKind = 'true_mismatch' | 'true_backed' | 'ambiguous_loose' | 'no_claim' | 'adversarial';

export interface JudgeAccuracyCase {
  id: string;
  kind: JudgeCaseKind;
  finalText: string;
  ledger: FinalizeLedgerEntry[];
  /** ground truth: classes the guard SHOULD flag as unbacked (would-correct) */
  expectedMismatch: ClaimClass[];
  /** human-labeled completed-action claims in the reply (recorded judge replay) */
  recordedJudge: JudgedClaim[];
}

export type JudgeFn = (finalText: string, candidates: readonly ClaimClass[]) => Promise<JudgedClaim[]>;

export interface ClassMetrics {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  /** null when undefined (no predicted / no actual positives) */
  precision: number | null;
  recall: number | null;
  falsePositiveRate: number | null;
}

export interface CaseResult {
  id: string;
  kind: JudgeCaseKind;
  expected: ClaimClass[];
  predicted: ClaimClass[];
  judgeError: boolean;
}

export interface JudgeAccuracyReport {
  cases: number;
  judgeErrors: number;
  perClass: Record<ClaimClass, ClassMetrics>;
  overall: ClassMetrics;
  failures: CaseResult[];
  results: CaseResult[];
}

const ratio = (num: number, den: number): number | null => (den === 0 ? null : num / den);

function metrics(tp: number, fp: number, fn: number, tn: number): ClassMetrics {
  return {
    tp, fp, fn, tn,
    precision: ratio(tp, tp + fp),
    recall: ratio(tp, tp + fn),
    falsePositiveRate: ratio(fp, fp + tn),
  };
}

/** Replays each case's recordedJudge — deterministic, no network. */
export function recordedJudgeFor(cases: readonly JudgeAccuracyCase[]): JudgeFn {
  const byText = new Map(cases.map((c) => [c.finalText, c.recordedJudge]));
  return async (finalText) => {
    const hit = byText.get(finalText);
    if (!hit) throw new Error('no recorded judge output for this case');
    return hit;
  };
}

/** Production-equivalent encoded-failure check, kept minimal for fixtures. */
function fixtureToolResultError(result: any): any {
  return result && typeof result === 'object' && (result.success === false || result.error) ? result : null;
}
/** Fixture asset check: a paused confirmation gate is not a produced asset. */
function fixtureMediaGenProducedAsset(_tool: string, result: any): boolean {
  return !(result && typeof result === 'object' && result.awaitingUserConfirmation);
}

export async function scoreFinalizeJudge(
  cases: readonly JudgeAccuracyCase[],
  judge: JudgeFn,
  portOverrides: Partial<Pick<FinalizeGuardPorts, 'toolResultError' | 'mediaGenProducedAsset'>> = {},
): Promise<JudgeAccuracyReport> {
  const results: CaseResult[] = [];
  let judgeErrors = 0;
  for (const c of cases) {
    let judgeError = false;
    const ports: FinalizeGuardPorts = {
      judgeExtractClaims: judge,
      requestCorrection: async () => { throw new Error('eval runs detect-only'); },
      toolResultError: portOverrides.toolResultError ?? fixtureToolResultError,
      mediaGenProducedAsset: portOverrides.mediaGenProducedAsset ?? fixtureMediaGenProducedAsset,
      recordClaimCheckError: () => { judgeError = true; },
    };
    const outcome = await runFinalizeGuard({ finalText: c.finalText, ledger: c.ledger, ports, detectOnly: true });
    if (judgeError) judgeErrors += 1;
    results.push({ id: c.id, kind: c.kind, expected: [...c.expectedMismatch], predicted: outcome.mismatchedClaimClasses, judgeError });
  }

  const perClass = {} as Record<ClaimClass, ClassMetrics>;
  let T = 0; let F = 0; let N = 0; let TN = 0;
  for (const cls of CLAIM_CLASSES) {
    let tp = 0; let fp = 0; let fn = 0; let tn = 0;
    for (const r of results) {
      const e = r.expected.includes(cls);
      const p = r.predicted.includes(cls);
      if (e && p) tp += 1; else if (!e && p) fp += 1; else if (e && !p) fn += 1; else tn += 1;
    }
    perClass[cls] = metrics(tp, fp, fn, tn);
    T += tp; F += fp; N += fn; TN += tn;
  }
  const failures = results.filter((r) =>
    r.expected.length !== r.predicted.length || r.expected.some((x) => !r.predicted.includes(x)));
  return { cases: cases.length, judgeErrors, perClass, overall: metrics(T, F, N, TN), failures, results };
}

const pct = (v: number | null): string => (v === null ? '  n/a' : `${(v * 100).toFixed(1).padStart(5)}%`);

export function formatJudgeAccuracyReport(report: JudgeAccuracyReport): string {
  const row = (name: string, m: ClassMetrics) =>
    `${name.padEnd(24)} P=${pct(m.precision)} R=${pct(m.recall)} FPR=${pct(m.falsePositiveRate)}  (tp=${m.tp} fp=${m.fp} fn=${m.fn} tn=${m.tn})`;
  const lines = [`finalize-guard judge accuracy — ${report.cases} cases, ${report.judgeErrors} judge errors`];
  for (const cls of CLAIM_CLASSES) lines.push(row(cls, report.perClass[cls]));
  lines.push(row('OVERALL', report.overall));
  for (const f of report.failures) {
    lines.push(`  MISS ${f.id} [${f.kind}] expected=[${f.expected.join(',')}] predicted=[${f.predicted.join(',')}]${f.judgeError ? ' (judge_error)' : ''}`);
  }
  return lines.join('\n');
}
