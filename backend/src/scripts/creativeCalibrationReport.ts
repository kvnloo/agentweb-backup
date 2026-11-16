/**
 * Weekly judge-vs-human agreement on the creative calibration pairs (ENG-2142, ENG-2128 T10).
 *
 * Usage:
 *   npx ts-node --transpile-only src/scripts/creativeCalibrationReport.ts --batch 2026-W39[,2026-W40] [--model <id>] [--no-judge] [--include-ai-labels]
 *
 * READ-ONLY. It reads the batch's pairwise cases from the golden-set store (EVAL_GOLDEN_CASES_TABLE)
 * and both creatives of every labelled pair from AW-HumanEvalQueue, runs the rubric judge's
 * pairwise mode (`judgeCreativePair`, A = the newer creative) on OpenRouter without the usage
 * ledger, and prints agreement with the human choice: n, observed agreement with a Wilson 95% CI,
 * Cohen's kappa with a bootstrap 95% CI, decisive-only agreement, and each side's A win rate
 * (loops/eval/creativeCalibration.ts `pairwiseAgreement`). Nothing is stored.
 *
 * Counts and rates only: no ids, copy, requests, rationales or image URLs.
 *
 *   --no-judge  call no model; report only how many pairs are labelled and the human choices.
 *   --include-ai-labels  also count choices an AI wrote (note starts with [AI-LABEL]); the report is then advisory,
 *               not human agreement. They are left out by default.
 */

import { argv, exit } from 'node:process';
import type { PairwiseChoice } from '../loops/eval/agreement';
import { isoWeekStart, pairwiseAgreement, type PairwiseAgreement, type PairwiseComparison } from '../loops/eval/creativeCalibration';
import { PAIRWISE_CRITERION, isAiLabelled, isPairwiseLabel, type GoldenCase } from '../loops/eval/goldenSet';
import { goldenSetStoreFromEnv, GOLDEN_CASES_TABLE_ENV } from '../loops/eval/goldenSetStore';
import { DEFAULT_RUBRIC_JUDGE_MODEL, type CreativeBrief, type judgeCreativePair as JudgeCreativePairImpl } from '../services/creativeRubricJudge';
import type { HumanEvalCandidate } from '../services/humanEvalService';

type JudgeCreativePair = typeof JudgeCreativePairImpl;

export interface ReportArgs {
  batches: string[];
  model: string;
  judge: boolean;
  /** Count pairs whose choice an AI wrote. Off by default: agreement with them is not human agreement. */
  includeAiLabels: boolean;
}

const USAGE = 'Usage: creativeCalibrationReport.ts --batch <YYYY-Www>[,...] [--model <id>] [--no-judge] [--include-ai-labels]';

export function parseReportArgs(raw: readonly string[]): ReportArgs {
  const args: ReportArgs = { batches: [], model: DEFAULT_RUBRIC_JUDGE_MODEL, judge: true, includeAiLabels: false };
  const operand = (i: number, flag: string): string => {
    const value = raw[i];
    if (value === undefined || value.startsWith('--') || !value.trim()) throw new Error(`${flag} needs a value. ${USAGE}`);
    return value.trim();
  };
  for (let i = 0; i < raw.length; i++) {
    const flag = raw[i];
    if (flag === '--batch') args.batches = operand(++i, flag).split(',').map((s) => s.trim()).filter(Boolean);
    else if (flag === '--model') args.model = operand(++i, flag);
    else if (flag === '--no-judge') args.judge = false;
    else if (flag === '--include-ai-labels') args.includeAiLabels = true;
    else throw new Error(`unknown argument "${flag}". ${USAGE}`);
  }
  if (args.batches.length === 0) throw new Error(`--batch is required. ${USAGE}`);
  for (const batch of args.batches) isoWeekStart(batch);
  return args;
}

/**
 * The batch's pairwise cases and, of those, the ones with a human choice. A choice an AI wrote is counted in
 * `aiLabelled` and left out of `labelled` unless `includeAiLabels` is set.
 */
export function labelledPairs(
  cases: readonly GoldenCase[],
  batches: readonly string[],
  includeAiLabels = false,
): { inBatch: GoldenCase[]; labelled: Array<{ c: GoldenCase; human: PairwiseChoice }>; aiLabelled: number } {
  const inBatch = cases.filter((c) => c.pair !== undefined && batches.includes(c.pair.batch));
  const labelled: Array<{ c: GoldenCase; human: PairwiseChoice }> = [];
  let aiLabelled = 0;
  for (const c of inBatch) {
    const human = c.labels[PAIRWISE_CRITERION];
    if (!isPairwiseLabel(human)) continue;
    if (isAiLabelled(c)) {
      aiLabelled++;
      if (!includeAiLabels) continue;
    }
    labelled.push({ c, human });
  }
  return { inBatch, labelled, aiLabelled };
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function tally(choices: readonly PairwiseChoice[]): string {
  const count = (v: PairwiseChoice) => choices.filter((c) => c === v).length;
  return `A (newer) ${count('A')} · B (prior) ${count('B')} · tie ${count('tie')}`;
}

/** The printed report. Counts and rates only. */
export function formatCalibrationReport(input: {
  batches: readonly string[];
  inBatch: number;
  humanChoices: readonly PairwiseChoice[];
  judgeErrors: number;
  agreement: PairwiseAgreement | null;
  model?: string;
  /** Pairs whose choice an AI wrote, and whether they are counted below (advisory) or left out. */
  aiLabelled?: { count: number; included: boolean };
}): string {
  const lines = [
    `Creative calibration ${input.batches.join(', ')}: ${input.humanChoices.length}/${input.inBatch} pairs labelled`,
    `Human: ${tally(input.humanChoices)}`,
  ];
  if (input.aiLabelled && input.aiLabelled.count > 0) {
    lines.push(
      input.aiLabelled.included
        ? `Includes ${input.aiLabelled.count} AI-written choice(s): ADVISORY, not human agreement`
        : `${input.aiLabelled.count} AI-written choice(s) left out (--include-ai-labels counts them as advisory)`,
    );
  }
  if (input.model) lines.push(`Judge: ${input.model} (pairwise, advisory); errors ${input.judgeErrors}`);
  const a = input.agreement;
  if (!a) {
    lines.push('Agreement: n/a (no pair has both a human choice and a judge verdict)');
    return lines.join('\n');
  }
  lines.push(
    `Agreement (A/B/tie): ${pct(a.agreement.rate)} of n=${a.n}, 95% CI ${pct(a.agreement.ci.low)}–${pct(a.agreement.ci.high)}`,
    `Cohen's kappa: ${a.kappa.kappa.toFixed(3)}, 95% CI ${a.kappa.kappaCI.low.toFixed(3)} to ${a.kappa.kappaCI.high.toFixed(3)}`,
    a.decisive
      ? `Decisive pairs only (no tie on either side): ${pct(a.decisive.rate)} of n=${a.decisive.n}, 95% CI ${pct(a.decisive.ci.low)}–${pct(a.decisive.ci.high)}`
      : 'Decisive pairs only: n=0',
    `A win rate (ties half): human ${pct(a.humanWinRateA)}, judge ${pct(a.judgeWinRateA)}`,
  );
  return lines.join('\n');
}

type JudgePairFn = (...args: Parameters<JudgeCreativePair>) => ReturnType<JudgeCreativePair>;

export interface PairJudgingDeps {
  getCandidate: (candidateId: string) => Promise<HumanEvalCandidate | null>;
  briefFor: (candidate: HumanEvalCandidate) => Promise<CreativeBrief>;
  judge: (a: Parameters<JudgeCreativePair>[0], b: Parameters<JudgeCreativePair>[1], brief: CreativeBrief) => ReturnType<JudgePairFn>;
}

/**
 * Judge each labelled pair. A failed lookup, brief or judge call on one pair counts as a judge
 * error for that pair and never stops the rest of the report (CodeRabbit on #3094).
 */
export async function judgeLabelledPairs(
  labelled: ReadonlyArray<{ c: GoldenCase; human: PairwiseChoice }>,
  deps: PairJudgingDeps,
): Promise<{ rows: PairwiseComparison[]; judgeErrors: number }> {
  const rows: PairwiseComparison[] = [];
  let judgeErrors = 0;
  for (const { c, human } of labelled) {
    // The pairwise judge compares images; landing-page pairs (ENG-2192) are human-labelled only.
    if (c.pair?.category === 'landing_page') continue;
    try {
      const [a, b] = await Promise.all([deps.getCandidate(c.sourceRef.id), deps.getCandidate(c.pair?.candidateIdB ?? '')]);
      if (!a?.artifactUrl || !b?.artifactUrl) {
        judgeErrors++;
        continue;
      }
      const verdict = await deps.judge(
        { image: { url: a.artifactUrl }, ...(a.creativeGates ? { gates: a.creativeGates } : {}) },
        { image: { url: b.artifactUrl }, ...(b.creativeGates ? { gates: b.creativeGates } : {}) },
        await deps.briefFor(a),
      );
      if (verdict.status === 'ok') rows.push({ human, judge: verdict.preference });
      else judgeErrors++;
    } catch (err: unknown) {
      judgeErrors++;
      console.warn(`[creative-calibration] pair ${c.caseId} could not be judged:`, err instanceof Error ? err.message : err);
    }
  }
  return { rows, judgeErrors };
}

async function main(): Promise<void> {
  const args = parseReportArgs(argv.slice(2));
  const store = goldenSetStoreFromEnv();
  if (!store.isProvisioned()) throw new Error(`Golden-set store not provisioned: set ${GOLDEN_CASES_TABLE_ENV} (OPS-2 / ENG-2147).`);
  const { inBatch, labelled, aiLabelled } = labelledPairs(await store.listCases('creative'), args.batches, args.includeAiLabels);
  const humanChoices = labelled.map((l) => l.human);
  const aiNote = { count: aiLabelled, included: args.includeAiLabels };
  if (!args.judge) {
    console.log(formatCalibrationReport({ batches: args.batches, inBatch: inBatch.length, humanChoices, judgeErrors: 0, agreement: null, aiLabelled: aiNote }));
    return;
  }

  const { humanEvalService } = await import('../services/humanEvalService');
  const { judgeCreativePair } = await import('../services/creativeRubricJudge');
  const { briefFor, unmeteredOpenRouterLlm } = await import('./scoreCreativeRubric');
  const { rows, judgeErrors } = await judgeLabelledPairs(labelled, {
    getCandidate: (id) => humanEvalService.getCandidate(id),
    briefFor,
    judge: (a, b, brief) => judgeCreativePair(a, b, brief, { model: args.model, llm: unmeteredOpenRouterLlm }),
  });
  console.log(
    formatCalibrationReport({
      batches: args.batches,
      inBatch: inBatch.length,
      humanChoices,
      judgeErrors,
      agreement: rows.length > 0 ? pairwiseAgreement(rows) : null,
      model: args.model,
      aiLabelled: aiNote,
    }),
  );
}

if (require.main === module) {
  main()
    .then(() => exit(0))
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      exit(1);
    });
}
