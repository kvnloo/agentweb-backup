/**
 * Grader validation runner (ENG-2135, ENG-2128 principle 2).
 *
 * For one eval-registry grader: load its surface's golden cases (test split) from the store, get
 * the grader's verdict per case and criterion, pair it with the human label, and report Cohen's
 * kappa, precision/recall and CIs per criterion (agreement.ts) plus the `validation` record the
 * registry would take for the grader's primary criterion. It prints; it never edits the registry
 * — recording a validation stays a reviewed code change with its evidence link.
 *
 * Pairs use binary labels only: a case is left out of a criterion when the human label is `na`
 * or missing (counted as `humanNa` / `unlabelled`), or when the grader gives no pass/fail for it
 * (`graderAbstained`), so abstentions never count as agreement.
 */

import AWS from 'aws-sdk';
import { agreementReport, toGraderValidation, type AgreementReport, type LabelPair, type ValidationRecord } from './agreement';
import { getGrader, type EvalSurface } from './evalRegistry';
import type { GoldenCase, GoldenCriterion, GoldenSplit, LabelValue } from './goldenSet';
import type { GoldenSetStore } from './goldenSetStore';

export type GraderPrediction = Partial<Record<GoldenCriterion, LabelValue>>;

/** Adapter from a registry grader to golden-case criteria. */
export interface GoldenCaseGrader {
  graderId: string;
  surface: EvalSurface;
  /** Criteria the grader decides; the rest of the surface's criteria are not scored for it. */
  criteria: GoldenCriterion[];
  /** The criterion whose agreement becomes the registry validation record. */
  primaryCriterion: GoldenCriterion;
  grade(goldenCase: GoldenCase): Promise<GraderPrediction>;
}

export interface CriterionAgreement {
  criterion: GoldenCriterion;
  /** null when no case has both a human and a grader pass/fail for this criterion. */
  report: AgreementReport | null;
  humanNa: number;
  unlabelled: number;
  graderAbstained: number;
}

export interface ValidationRun {
  graderId: string;
  surface: EvalSurface;
  split: GoldenSplit;
  cases: number;
  /** Cases the grader threw on (their criteria count as abstained). */
  gradeErrors: number;
  criteria: CriterionAgreement[];
  primaryCriterion: GoldenCriterion;
  /** For the primary criterion; null when it has no pairs. Qualifies for gating only if the
   * registry's isQualifyingValidation accepts it (kappa, n and an http(s) evidence link). */
  validation: ValidationRecord | null;
}

type Binary = 'pass' | 'fail';
const isBinary = (v: LabelValue | undefined): v is Binary => v === 'pass' || v === 'fail';

/** Pure: per-criterion agreement between human labels and grader predictions. */
export function computeCriterionAgreement(
  cases: readonly GoldenCase[],
  predictions: ReadonlyMap<string, GraderPrediction>,
  criterion: GoldenCriterion,
  bootstrap: { iterations?: number; seed?: number } = {},
): CriterionAgreement {
  const pairs: LabelPair<Binary>[] = [];
  let humanNa = 0;
  let unlabelled = 0;
  let graderAbstained = 0;
  for (const c of cases) {
    const truth = c.labels[criterion];
    if (truth === undefined) {
      unlabelled++;
      continue;
    }
    if (!isBinary(truth)) {
      humanNa++;
      continue;
    }
    const predicted = predictions.get(c.caseId)?.[criterion];
    if (!isBinary(predicted)) {
      graderAbstained++;
      continue;
    }
    pairs.push({ truth, predicted });
  }
  return {
    criterion,
    report: pairs.length > 0 ? agreementReport(pairs, bootstrap) : null,
    humanNa,
    unlabelled,
    graderAbstained,
  };
}

export async function runValidation(opts: {
  graderId: string;
  store: GoldenSetStore;
  graders: readonly GoldenCaseGrader[];
  evidence?: string;
  split?: GoldenSplit;
  now?: Date;
  bootstrap?: { iterations?: number; seed?: number };
}): Promise<ValidationRun> {
  const entry = getGrader(opts.graderId);
  if (!entry) throw new Error(`Unknown eval-registry grader: ${opts.graderId}`);
  const grader = opts.graders.find((g) => g.graderId === opts.graderId);
  if (!grader) throw new Error(`No golden-case adapter for ${opts.graderId} yet (have: ${opts.graders.map((g) => g.graderId).join(', ') || 'none'})`);
  if (grader.surface !== entry.surface) throw new Error(`${opts.graderId}: adapter surface ${grader.surface} != registry surface ${entry.surface}`);

  const split = opts.split ?? 'test';
  const cases = await opts.store.listCases(entry.surface, { split });
  const predictions = new Map<string, GraderPrediction>();
  let gradeErrors = 0;
  for (const c of cases) {
    try {
      predictions.set(c.caseId, await grader.grade(c));
    } catch (error) {
      gradeErrors++;
      console.warn(`[runValidation] ${opts.graderId} failed on ${c.caseId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const criteria = grader.criteria.map((criterion) => computeCriterionAgreement(cases, predictions, criterion, opts.bootstrap));
  const primary = criteria.find((c) => c.criterion === grader.primaryCriterion);
  return {
    graderId: opts.graderId,
    surface: entry.surface,
    split,
    cases: cases.length,
    gradeErrors,
    criteria,
    primaryCriterion: grader.primaryCriterion,
    validation: primary?.report ? toGraderValidation(primary.report, opts.evidence ?? 'unpublished', opts.now) : null,
  };
}

// ---------------------------------------------------------------------------
// Adapters for graders on main
// ---------------------------------------------------------------------------

/** 1-5 judge dimension at or above this counts as pass (the satisfied half of the scale). */
export const JUDGE_PASS_THRESHOLD = 4;

export interface StoredJudgeDimensions {
  goalCompletion?: number;
  dataAccuracy?: number;
  instructionCompliance?: number;
}

/** Reads a session judge's stored dimensions; undefined when that judge never scored the session. */
export type StoredJudgeReader = (sessionId: string) => Promise<StoredJudgeDimensions | undefined>;

function dimensionLabel(value: number | undefined): LabelValue {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'na';
  return value >= JUDGE_PASS_THRESHOLD ? 'pass' : 'fail';
}

/** Maps a session judge's stored 1-5 dimensions onto agent criteria. It has no tool-correctness dimension. */
export function sessionJudgePrediction(dims: StoredJudgeDimensions | undefined): GraderPrediction {
  return {
    task_success: dimensionLabel(dims?.goalCompletion),
    groundedness: dimensionLabel(dims?.dataAccuracy),
    instruction_compliance: dimensionLabel(dims?.instructionCompliance),
  };
}

export function sessionJudgeGrader(graderId: string, read: StoredJudgeReader): GoldenCaseGrader {
  return {
    graderId,
    surface: 'agent',
    criteria: ['task_success', 'groundedness', 'instruction_compliance'],
    primaryCriterion: 'task_success',
    grade: async (c) => sessionJudgePrediction(await read(c.sourceRef.id)),
  };
}

/** AW-Settings scoring-judges ids of the custom judges (evalRegistry.ts). */
export const CUSTOM_JUDGE_IDS: Record<string, string> = {
  'session-judge-fangfang': 'judge_1774188403681_idctslwzu',
  'session-judge-matt': 'judge_1779822633705_027n0uoio',
};

interface StoredScores {
  satisfactionScore?: { dimensions?: StoredJudgeDimensions };
  judgeScores?: Record<string, { dimensions?: StoredJudgeDimensions }>;
}

/** Read-only: the stored verdicts on AW-ChatSessions. Validates what production recorded, so no
 * judge is re-run and nothing is written. */
export function storedSessionJudgeGraders(client: AWS.DynamoDB.DocumentClient = new AWS.DynamoDB.DocumentClient()): GoldenCaseGrader[] {
  const table = `${process.env.NODE_ENV === 'development' ? 'Dev-' : ''}AW-ChatSessions`;
  const readScores = async (sessionId: string): Promise<StoredScores | undefined> => {
    const out = await client
      .get({ TableName: table, Key: { sessionId }, ProjectionExpression: 'satisfactionScore, judgeScores' })
      .promise();
    return out.Item as StoredScores | undefined;
  };
  return [
    sessionJudgeGrader('session-judge-general', async (id) => (await readScores(id))?.satisfactionScore?.dimensions),
    ...Object.entries(CUSTOM_JUDGE_IDS).map(([graderId, judgeId]) =>
      sessionJudgeGrader(graderId, async (id) => (await readScores(id))?.judgeScores?.[judgeId]?.dimensions),
    ),
  ];
}
