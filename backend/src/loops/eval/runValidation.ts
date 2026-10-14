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
 *
 * Adapters on this branch: the session judges' stored verdicts (general, Fangfang, Matt), the
 * ENG-2137 agent graders run live on the case's session, the ENG-2139 creative deterministic
 * gates (stored gate result on the human-eval candidate) and the ENG-2143 account-health
 * classifier (classified live from the account's current signals). All adapters read only.
 */

import AWS from 'aws-sdk';
import { agreementReport, toGraderValidation, type AgreementReport, type LabelPair, type ValidationRecord } from './agreement';
import { getGrader, type EvalSurface } from './evalRegistry';
import { isAiLabelled, type GoldenCase, type GoldenCriterion, type GoldenSplit, type LabelValue } from './goldenSet';
import type { GoldenSetStore } from './goldenSetStore';
import {
  gradeFormatAdherence,
  gradeGroundedness,
  gradeLengthAdherence,
  gradePermissionAdherence,
  gradeTaskSuccess,
  gradeToolCorrectness,
  type AdherenceResult,
  type SessionForGrading,
} from './agentGraders';
import { buildLoadedSession, groupEventsBySession, type DocItem, type ReadOnlyDocReader, type ReadRequest } from './agentGraderLoader';
import { LOOP_EVENTS_TABLE } from '../core/sensors/eventTableEventSource';
import { OUTCOME_SHADOW_JUDGE_ID } from '../../services/outcomeJudge';
import { CREATIVE_GATES_GRADER_ID, type CreativeGateResult } from '../../services/creativeGates';
import type { AccountHealthState } from '../../services/accountHealthClassifier';
import type { AccountHealthUser } from '../../cron/accountHealthClassifierCron';

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

/** A class needs at least this many examples (of the rarer truth label) before its kappa means anything. */
export const MIN_CLASS_EXAMPLES = 5;

export interface CriterionAgreement {
  criterion: GoldenCriterion;
  /** null when no case has both a human and a grader pass/fail for this criterion. */
  report: AgreementReport | null;
  humanNa: number;
  unlabelled: number;
  graderAbstained: number;
  /** The rarer of the two truth labels among the pairs. Under MIN_CLASS_EXAMPLES a kappa is not reported as reliable. */
  minorityN: number;
  reliable: boolean;
}

export interface ValidationRun {
  graderId: string;
  surface: EvalSurface;
  split: GoldenSplit;
  cases: number;
  /** Cases the grader was actually run on: only those with a human pass/fail label on one of its criteria. */
  graded: number;
  /** Cases the grader threw on (their criteria count as abstained). */
  gradeErrors: number;
  criteria: CriterionAgreement[];
  primaryCriterion: GoldenCriterion;
  /** Cases in the split whose label an AI wrote (note starts with AI_LABEL_NOTE_PREFIX); left out unless asked. */
  aiLabelledCases: number;
  /** `human+ai` only when AI-written labels were included on request; that run is advisory. */
  labelSource: 'human' | 'human+ai';
  /** For the primary criterion; null when it has no pairs, or when AI-written labels were included (an advisory run
   * is never a registry record). Qualifies for gating only if the registry's isQualifyingValidation accepts it
   * (kappa, n and an http(s) evidence link). */
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
  const positives = pairs.filter((p) => p.truth === 'pass').length;
  const minorityN = Math.min(positives, pairs.length - positives);
  return {
    criterion,
    report: pairs.length > 0 ? agreementReport(pairs, bootstrap) : null,
    humanNa,
    unlabelled,
    graderAbstained,
    minorityN,
    reliable: pairs.length > 0 && minorityN >= MIN_CLASS_EXAMPLES,
  };
}

export async function runValidation(opts: {
  graderId: string;
  store: GoldenSetStore;
  graders: readonly GoldenCaseGrader[];
  evidence?: string;
  split?: GoldenSplit;
  /** Count cases whose label an AI wrote. Off by default: agreement with them is not human agreement. */
  includeAiLabels?: boolean;
  now?: Date;
  bootstrap?: { iterations?: number; seed?: number };
}): Promise<ValidationRun> {
  const entry = getGrader(opts.graderId);
  if (!entry) throw new Error(`Unknown eval-registry grader: ${opts.graderId}`);
  const grader = opts.graders.find((g) => g.graderId === opts.graderId);
  if (!grader) throw new Error(`No golden-case adapter for ${opts.graderId} yet (have: ${opts.graders.map((g) => g.graderId).join(', ') || 'none'})`);
  if (grader.surface !== entry.surface) throw new Error(`${opts.graderId}: adapter surface ${grader.surface} != registry surface ${entry.surface}`);

  const split = opts.split ?? 'test';
  // Pairwise creative cases (ENG-2142) carry an A/B/tie preference, not these binary criteria;
  // their agreement is reported by scripts/creativeCalibrationReport.ts.
  const listed = (await opts.store.listCases(entry.surface, { split })).filter((c) => c.pair === undefined);
  const aiLabelledCases = listed.filter(isAiLabelled).length;
  const labelSource = opts.includeAiLabels && aiLabelledCases > 0 ? 'human+ai' : 'human';
  const cases = opts.includeAiLabels ? listed : listed.filter((c) => !isAiLabelled(c));
  const predictions = new Map<string, GraderPrediction>();
  let gradeErrors = 0;
  let graded = 0;
  for (const c of cases) {
    // A prediction is only ever compared with a human pass/fail label, so a case without one cannot change the
    // result. Skipping it also keeps graders that read live state (the account-health adapter calls Meta with the
    // customer's token) from running on cases that cannot contribute.
    if (!grader.criteria.some((criterion) => isBinary(c.labels[criterion]))) continue;
    graded++;
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
    graded,
    gradeErrors,
    criteria,
    primaryCriterion: grader.primaryCriterion,
    aiLabelledCases,
    labelSource,
    // No record for a class too rare to measure: a kappa on a handful of examples would read as evidence.
    validation: labelSource === 'human' && primary?.report && primary.reliable ? toGraderValidation(primary.report, opts.evidence ?? 'unpublished', opts.now, 'human') : null,
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
  /** ENG-2189: the outcome rubric's binary criteria (true = it happened). */
  arguedWithInstruction?: boolean;
  escalatedWhenNotRequired?: boolean;
  failedToEscalate?: boolean;
}

/** Reads a session judge's stored dimensions; undefined when that judge never scored the session. */
export type StoredJudgeReader = (sessionId: string) => Promise<StoredJudgeDimensions | undefined>;

function dimensionLabel(value: number | undefined): LabelValue {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'na';
  return value >= JUDGE_PASS_THRESHOLD ? 'pass' : 'fail';
}

/** A behaviour criterion's label: `pass` = it happened (golden-set convention for these criteria). */
function flagLabel(value: boolean | undefined): LabelValue {
  return typeof value === 'boolean' ? (value ? 'pass' : 'fail') : 'na';
}

/** Maps a session judge's stored dimensions onto agent criteria. It has no tool-correctness dimension. */
export function sessionJudgePrediction(dims: StoredJudgeDimensions | undefined): GraderPrediction {
  return {
    task_success: dimensionLabel(dims?.goalCompletion),
    groundedness: dimensionLabel(dims?.dataAccuracy),
    instruction_compliance: dimensionLabel(dims?.instructionCompliance),
    argued_with_instruction: flagLabel(dims?.arguedWithInstruction),
    escalated_when_not_required: flagLabel(dims?.escalatedWhenNotRequired),
    failed_to_escalate: flagLabel(dims?.failedToEscalate),
  };
}

const SESSION_JUDGE_CRITERIA: GoldenCriterion[] = ['task_success', 'groundedness', 'instruction_compliance'];
/** Only the outcome rubric asks for these (ENG-2189); the other judges would abstain on every case. */
const OUTCOME_RUBRIC_CRITERIA: GoldenCriterion[] = ['argued_with_instruction', 'escalated_when_not_required', 'failed_to_escalate'];

export function sessionJudgeGrader(graderId: string, read: StoredJudgeReader): GoldenCaseGrader {
  return {
    graderId,
    surface: 'agent',
    criteria: graderId === 'session-judge-outcome-b-shadow' ? [...SESSION_JUDGE_CRITERIA, ...OUTCOME_RUBRIC_CRITERIA] : SESSION_JUDGE_CRITERIA,
    primaryCriterion: 'task_success',
    grade: async (c) => sessionJudgePrediction(await read(c.sourceRef.id)),
  };
}

/** AW-Settings scoring-judges ids of the custom judges (evalRegistry.ts). */
export const CUSTOM_JUDGE_IDS: Record<string, string> = {
  'session-judge-fangfang': 'judge_1774188403681_idctslwzu',
  'session-judge-matt': 'judge_1779822633705_027n0uoio',
  'session-judge-outcome-b-shadow': OUTCOME_SHADOW_JUDGE_ID,
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

// Agent graders (ENG-2137), run live on the case's session ------------------------------------

/** Loop events older than this before the session's last update are not read (as agentGraderLoader). */
const MAX_EVENT_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;

async function readAll(reader: ReadOnlyDocReader, request: ReadRequest): Promise<DocItem[]> {
  const items: DocItem[] = [];
  let start: DocItem | undefined;
  do {
    const page = await reader.query({ ...request, ...(start ? { ExclusiveStartKey: start } : {}) });
    items.push(...(page.Items ?? []));
    start = page.LastEvaluatedKey;
  } while (start);
  return items;
}

export interface AgentGraderTables {
  sessions: string;
  messages: string;
  loopEvents: string;
}

/** Read-only: one session's work plan, messages and agent-mode loop events, as the agent graders take them. */
export async function loadSessionForGrading(reader: ReadOnlyDocReader, tables: AgentGraderTables, sessionId: string): Promise<SessionForGrading | undefined> {
  const [item] = await readAll(reader, {
    TableName: tables.sessions,
    KeyConditionExpression: 'sessionId = :s',
    ProjectionExpression: 'sessionId, createdAt, updatedAt, workPlan',
    ExpressionAttributeValues: { ':s': sessionId },
  });
  if (!item) return undefined;
  const messageRows = await readAll(reader, {
    TableName: tables.messages,
    KeyConditionExpression: 'sessionId = :s',
    ExpressionAttributeValues: { ':s': sessionId },
  });
  const updatedAt = typeof item.updatedAt === 'string' ? item.updatedAt : new Date().toISOString();
  const floor = new Date(Date.parse(updatedAt) - MAX_EVENT_LOOKBACK_MS).toISOString();
  const createdAt = typeof item.createdAt === 'string' ? item.createdAt : floor;
  const eventRows = await readAll(reader, {
    TableName: tables.loopEvents,
    KeyConditionExpression: 'loopId = :l AND tsSession BETWEEN :from AND :to',
    // tsSession is the sort key and cannot be filtered on; the session id is also a dimension.
    FilterExpression: '#dims.sessionId = :s',
    ExpressionAttributeNames: { '#dims': 'dimensions' },
    ExpressionAttributeValues: { ':l': 'agent-mode', ':from': createdAt < floor ? floor : createdAt, ':to': `${updatedAt}\uffff`, ':s': sessionId },
  });
  return buildLoadedSession(item, messageRows, groupEventsBySession(eventRows).get(sessionId) ?? [], undefined).session;
}

const adherenceLabel = ({ verdict }: AdherenceResult): LabelValue => (verdict === 'not_applicable' ? 'na' : verdict);

/** Maps each agent grader's verdict onto its criterion; `excluded` / `no_claims` / not applicable abstain. */
export function agentGraderPrediction(graderId: string, session: SessionForGrading | undefined): GraderPrediction {
  if (!session) return {};
  const turns = session.turns ?? [];
  switch (graderId) {
    case 'agent-task-success': {
      const { verdict } = gradeTaskSuccess(session);
      return { task_success: verdict === 'success' ? 'pass' : verdict === 'failure' ? 'fail' : 'na' };
    }
    case 'agent-tool-correctness':
      return { tool_correctness: gradeToolCorrectness(session).verdict };
    case 'agent-groundedness-offline': {
      const { verdict } = gradeGroundedness(session.finalReply, session.ledger);
      return { groundedness: verdict === 'grounded' ? 'pass' : verdict === 'ungrounded' ? 'fail' : 'na' };
    }
    case 'agent-reply-length-adherence':
      return { instruction_compliance: adherenceLabel(gradeLengthAdherence(turns)) };
    case 'agent-format-adherence':
      return { instruction_compliance: adherenceLabel(gradeFormatAdherence(turns)) };
    case 'agent-act-without-asking':
      return { instruction_compliance: adherenceLabel(gradePermissionAdherence(turns)) };
    default:
      throw new Error(`not an agent grader: ${graderId}`);
  }
}

const AGENT_GRADER_CRITERIA: Record<string, GoldenCriterion> = {
  'agent-task-success': 'task_success',
  'agent-tool-correctness': 'tool_correctness',
  'agent-groundedness-offline': 'groundedness',
  // ENG-2189: each is one explicit-instruction check, compared with the human instruction_compliance label.
  'agent-reply-length-adherence': 'instruction_compliance',
  'agent-format-adherence': 'instruction_compliance',
  'agent-act-without-asking': 'instruction_compliance',
};

export function liveAgentGraders(load: (sessionId: string) => Promise<SessionForGrading | undefined>): GoldenCaseGrader[] {
  return Object.entries(AGENT_GRADER_CRITERIA).map(([graderId, criterion]) => ({
    graderId,
    surface: 'agent' as const,
    criteria: [criterion],
    primaryCriterion: criterion,
    grade: async (c: GoldenCase) => agentGraderPrediction(graderId, await load(c.sourceRef.id)),
  }));
}

// Creative deterministic gates (ENG-2139/2187), read from the candidate's stored gate result ---

/**
 * The one golden criterion the gates decide: `format_readiness` (ENG-421's launch-ready floor
 * for decode/blank-render/aspect/size/file-size — the same things `evaluateCreativeGates` checks;
 * hook, offer, proof, brand, policy and buyer-usefulness are the rubric judge's, not this grader's).
 */
export const CREATIVE_GATES_CRITERION: GoldenCriterion = 'format_readiness';

/**
 * The checks that decide `format_readiness`: ENG-421's launch-ready floor (decode, blank render, aspect, size,
 * file size). Since ENG-2193 the stored result also carries advisory CONTENT checks (OCR text ratio and
 * legibility, spelling, brand colour, logo, policy keywords) and `appendCreativeGateChecks` recomputes the
 * result's overall `passed` across all of them, so `passed` is no longer a format verdict: a launch-ready
 * image with a failing brand-colour check has `passed: false`.
 */
const FORMAT_READINESS_CHECK_IDS: ReadonlySet<string> = new Set([
  'decode',
  'blank_render',
  'aspect_ratio',
  'dimensions',
  'file_size',
  'aspect_fallback',
]);

/**
 * Maps the stored gate result onto `format_readiness`: fail when a structural check failed, pass when at
 * least one structural check ran and none failed. Abstains (no verdict) when this candidate has no stored
 * gate result at all (an older candidate, a non-image one, or one whose gates never ran), when the gates
 * were recorded as not checked, or when every structural check was skipped: a skipped check measured
 * nothing, so it cannot support "pass".
 */
export function creativeGatesPrediction(gates: CreativeGateResult | undefined): GraderPrediction {
  if (!gates || gates.notChecked) return {};
  const structural = gates.checks.filter((c) => FORMAT_READINESS_CHECK_IDS.has(c.id));
  if (structural.some((c) => c.status === 'fail')) return { [CREATIVE_GATES_CRITERION]: 'fail' };
  if (structural.some((c) => c.status === 'pass')) return { [CREATIVE_GATES_CRITERION]: 'pass' };
  return {};
}

export type CreativeGateReader = (candidateId: string) => Promise<CreativeGateResult | undefined>;

export function creativeGatesGrader(read: CreativeGateReader): GoldenCaseGrader {
  return {
    graderId: CREATIVE_GATES_GRADER_ID,
    surface: 'creative',
    criteria: [CREATIVE_GATES_CRITERION],
    primaryCriterion: CREATIVE_GATES_CRITERION,
    grade: async (c) => creativeGatesPrediction(await read(c.sourceRef.id)),
  };
}

/**
 * Read-only: the gate result `humanEvalService` stored on the candidate at generation time
 * (`createCandidate`'s `creativeGates` input, extended by `appendCreativeGateChecks`). Dynamic
 * import keeps humanEvalService's own dependencies (Slack, S3, chatbot, learning) out of this
 * module's static graph, as the other offline creative scripts already do (scoreCreativeRubric.ts,
 * creativeCalibrationReport.ts).
 */
async function readStoredCreativeGates(candidateId: string): Promise<CreativeGateResult | undefined> {
  const { humanEvalService } = await import('../../services/humanEvalService');
  const candidate = await humanEvalService.getCandidate(candidateId);
  return candidate?.creativeGates;
}

// Account-health classifier (ENG-2143), classified live from the account's current signals -----

/** Matches evalRegistry.ts's `account-health-classifier` entry id and the cron's ACCOUNT_HEALTH_GRADER_ID. */
export const ACCOUNT_HEALTH_GRADER_ID = 'account-health-classifier';

const ACCOUNT_HEALTH_CRITERIA: GoldenCriterion[] = ['activation_incomplete', 'at_risk', 'healthy'];

/**
 * Maps the classifier's one mutually-exclusive state onto the three golden criteria: the
 * matching state's criterion is `pass`, the other two are `fail`. `insufficient_evidence` (a
 * signal the classifier needed could not be read) and no classification at all abstain on every
 * criterion instead of guessing, same as the classifier's own ENG-2016 AC2 rule.
 */
export function accountHealthPrediction(state: AccountHealthState | undefined): GraderPrediction {
  if (state === undefined || state === 'insufficient_evidence') return {};
  const prediction: GraderPrediction = {};
  for (const criterion of ACCOUNT_HEALTH_CRITERIA) prediction[criterion] = criterion === state ? 'pass' : 'fail';
  return prediction;
}

export type AccountHealthClassifyFn = (userId: string) => Promise<AccountHealthState | undefined>;

export function accountHealthGrader(classify: AccountHealthClassifyFn): GoldenCaseGrader {
  return {
    graderId: ACCOUNT_HEALTH_GRADER_ID,
    surface: 'account_health',
    criteria: ACCOUNT_HEALTH_CRITERIA,
    // at_risk is the criterion mayGate(ACCOUNT_HEALTH_GRADER_ID) actually unlocks: it is what
    // moves the cron's at-risk path from a needs-review log line to an oncall page.
    primaryCriterion: 'at_risk',
    grade: async (c) => accountHealthPrediction(await classify(c.sourceRef.id)),
  };
}

/**
 * Read-only: rebuilds the account's current signals the way the live sweep does
 * (`gatherAccountHealthSignals` in accountHealthClassifierCron.ts — payments, ad days, feedback,
 * tracking; campaigns stays null there too, since no per-campaign delivery source exists yet) and
 * classifies it. Dynamic import for the same reason as readStoredCreativeGates: the cron module's
 * own dependencies (email, Slack, oncall alerting) never need to load for a validation run that
 * only calls its read helper. Undefined when the user no longer exists.
 */
async function classifyAccountHealthForUser(userId: string): Promise<AccountHealthState | undefined> {
  const [{ userDb }, { gatherAccountHealthSignals }, { classifyAccountHealth }] = await Promise.all([
    import('../../services/db'),
    import('../../cron/accountHealthClassifierCron'),
    import('../../services/accountHealthClassifier'),
  ]);
  const user = (await userDb.getUserById(userId)) as AccountHealthUser | undefined;
  if (!user?.userId) return undefined;
  const { signals } = await gatherAccountHealthSignals(user, Date.now());
  return classifyAccountHealth(signals).state;
}

/** Every golden-case adapter available on this branch, reading production (or `Dev-`) tables read-only. */
export function defaultGoldenCaseGraders(): GoldenCaseGrader[] {
  const doc = new AWS.DynamoDB.DocumentClient({ region: process.env.AWS_REGION || 'us-west-2' });
  const prefix = process.env.NODE_ENV === 'development' ? 'Dev-' : '';
  const reader: ReadOnlyDocReader = {
    query: (request) => doc.query(request as AWS.DynamoDB.DocumentClient.QueryInput).promise(),
    scan: (request) => doc.scan(request as AWS.DynamoDB.DocumentClient.ScanInput).promise(),
  };
  const tables: AgentGraderTables = { sessions: `${prefix}AW-ChatSessions`, messages: `${prefix}AW-ChatMessages`, loopEvents: LOOP_EVENTS_TABLE };
  return [
    ...storedSessionJudgeGraders(doc),
    ...liveAgentGraders((sessionId) => loadSessionForGrading(reader, tables, sessionId)),
    creativeGatesGrader(readStoredCreativeGates),
    accountHealthGrader(classifyAccountHealthForUser),
  ];
}
