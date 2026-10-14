/**
 * Offline replay of the shadow outcome judge (ENG-2138, rubric B) against deterministic task
 * success (ENG-2137 `agent-task-success`, the ENG-1710 relaxed rule).
 *
 * It lists the sessions last active in [--from, --to] that have a work plan (AdminUpdatedAtIndex
 * query), draws a seeded uniform sample, grades each deterministically, and judges only the
 * sessions with a success/failure label (never-engaged, zero-tool and unfinished runs are
 * excluded by the grader). Each labelled session then goes through the same gates production
 * applies before a custom judge (judgeCohortExclusion, judgeScoringPath): cohort exclusions are
 * counted and dropped, and a failed run gets production's fixed score of 1 without a model call,
 * so the numbers describe the population the shadow judge scores in production.
 * It then prints how well the judge score separates them: ROC AUC with
 * a bootstrap CI, the share of 5s, the score histogram, mean score by label and per agent model.
 * The ticket's bar is AUC >= 0.75 and < 15% at 5 (ENG-1710 measured the original rubric B on
 * claude-sonnet-4.6 at 0.79 and 2.6%).
 *
 * READ-ONLY. It queries AW-ChatSessions, AW-ChatMessages and Dev-AW-LoopEvents and writes
 * nothing: no score is stored, and the judge is called on OpenRouter directly rather than through
 * `AgentModeService.callLLM`, whose usage metering would write spend rows. Output is aggregates
 * only: no session ids, user ids, transcript text or judge rationale.
 *
 * Usage (default AWS profile; NODE_ENV=development reads the Dev- tables):
 *   npx ts-node --transpile-only src/scripts/evalOutcomeJudge.ts --from 2026-09-14 --to 2026-09-27 \
 *     [--sample 150] [--seed eng-2138] [--model anthropic.claude-sonnet-4-6] [--prompt-file F] [--no-judge-clauses] [--dry-run]
 *   npx ts-node --transpile-only src/scripts/evalOutcomeJudge.ts --print-judge-row --sample-rate 0.33
 *
 *   --dry-run          grade and count, call no model
 *   --prompt-file F    replay a candidate system prompt read from F instead of the committed
 *                      rubric (ENG-2380: re-measure the recovered ENG-1710 text before adopting it)
 *   --print-judge-row  print the AW-Settings scoring-judges row for OPS-1 (ENG-2146) and exit
 */
import AWS from 'aws-sdk';
import { readFileSync } from 'node:fs';
import { argv, exit } from 'node:process';
import { bootstrapCI, rocAuc, type Interval, type LabelPair } from '../loops/eval/agreement';
import { gradeSession } from '../loops/eval/agentGraders';
import {
  listSessionsUpdatedBetween,
  loadSessionItems,
  orderedMessages,
  toGraderWorkPlan,
  type DocItem,
  type GraderTables,
  type ReadOnlyDocReader,
  type ReadRequest,
} from '../loops/eval/agentGraderLoader';
import { sampleUniform } from '../loops/eval/evalV2Sampler';
import { LOOP_EVENTS_TABLE } from '../loops/core/sensors/eventTableEventSource';
import { LLM_MODEL_REGISTRY } from '../services/agentMode/llmModelRegistry';
import type { ChatMessage, ChatSession } from '../services/chatbotService';
import { DEFAULT_OUTCOME_JUDGE_MODEL, buildOutcomeShadowJudgeRow } from '../services/outcomeJudge';
import {
  buildFailedRunResult,
  judgeCohortExclusion,
  judgeScoringPath,
  scoreSessionWithJudge,
  type ScoringLlmCall,
} from '../services/sessionScoringService';
import { SPEND_EVENTS_TABLE } from '../services/spendEventDb';

const USAGE =
  'Usage: evalOutcomeJudge.ts --from <date> --to <date> [--sample N] [--seed S] [--model ID] [--prompt-file F] [--no-judge-clauses] [--dry-run]\n' +
  '       evalOutcomeJudge.ts --print-judge-row --sample-rate <0..1> [--model ID]';

export const TARGET_AUC = 0.75;
export const TARGET_MAX_SHARE_AT_5 = 0.15;
/** A score at or above this counts as "a 5" (the ENG-1710 rule, applied to raw decimals). */
const SHARE_AT_5_MIN_SCORE = 4.95;
/** Per-model rows are printed only from this many judged sessions up. */
const MIN_MODEL_N = 5;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export type Args =
  | { mode: 'print-row'; sampleRate: number; model: string }
  | { mode: 'replay'; from: string; to: string; sample: number; seed: string; model: string; dryRun: boolean; promptFile?: string; noJudgeClauses?: boolean };

/** Strict: an unknown flag or a missing operand is an error, so a typo cannot start live judge calls. */
export function parseArgs(raw: readonly string[]): Args {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const withValue = new Set(['--from', '--to', '--sample', '--seed', '--model', '--sample-rate', '--prompt-file']);
  for (let i = 0; i < raw.length; i++) {
    const flag = raw[i];
    if (flag === '--dry-run' || flag === '--print-judge-row' || flag === '--no-judge-clauses') flags.add(flag);
    else if (withValue.has(flag)) {
      const operand = raw[++i];
      if (operand === undefined || operand.startsWith('--') || !operand.trim()) throw new Error(`${flag} needs a value.\n${USAGE}`);
      values.set(flag, operand.trim());
    } else throw new Error(`unknown argument "${flag}".\n${USAGE}`);
  }
  const model = values.get('--model') ?? DEFAULT_OUTCOME_JUDGE_MODEL;

  if (flags.has('--print-judge-row')) {
    const rate = Number(values.get('--sample-rate'));
    if (!values.has('--sample-rate') || !(rate > 0 && rate <= 1)) throw new Error(`--sample-rate must be in (0, 1].\n${USAGE}`);
    return { mode: 'print-row', sampleRate: rate, model };
  }

  const day = (flag: '--from' | '--to'): string => {
    const v = values.get(flag);
    if (!v || !DATE_ONLY.test(v) || new Date(`${v}T00:00:00.000Z`).toISOString().slice(0, 10) !== v) {
      throw new Error(`${flag} must be a date (YYYY-MM-DD).\n${USAGE}`);
    }
    return v;
  };
  const from = `${day('--from')}T00:00:00.000Z`;
  const to = `${day('--to')}T23:59:59.999Z`;
  if (from > to) throw new Error('--from must not be after --to');
  const sample = Number(values.get('--sample') ?? 150);
  if (!Number.isInteger(sample) || sample <= 0) throw new Error('--sample must be a positive integer');
  const promptFile = values.get('--prompt-file');
  return {
    mode: 'replay', from, to, sample, seed: values.get('--seed') ?? 'eng-2138', model, dryRun: flags.has('--dry-run'),
    ...(promptFile ? { promptFile } : {}),
    ...(flags.has('--no-judge-clauses') ? { noJudgeClauses: true } : {}),
  };
}

export interface JudgedSession {
  /** Deterministic label: task succeeded. */
  success: boolean;
  /** Judge score 1-5; a shadow judge keeps one decimal. */
  score: number;
  /** Agent model that ran the session. */
  model: string;
}

export interface ReplaySummary {
  judged: number;
  successes: number;
  auc: number | null;
  aucCI: Interval | null;
  /** Share of raw scores >= 4.95 (the target's definition of "at 5"). */
  shareAt5: number | null;
  /** Share of scores that round to 5, i.e. the histogram's 5 bucket; always >= shareAt5. */
  shareRoundingTo5: number | null;
  histogram: Record<1 | 2 | 3 | 4 | 5, number>;
  meanScore: { success: number | null; failure: number | null };
  perModel: Array<{ model: string; n: number; successRate: number; meanScore: number }>;
  meetsTarget: boolean;
}

const mean = (xs: readonly number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** Aggregates of a replay run. Pure; AUC needs both labels present. */
export function summarizeReplay(rows: readonly JudgedSession[]): ReplaySummary {
  const pairs: LabelPair<number>[] = rows.map((r) => ({ truth: r.success ? 1 : 0, predicted: r.score }));
  const successes = rows.filter((r) => r.success).length;
  const bothClasses = successes > 0 && successes < rows.length;
  const histogram: ReplaySummary['histogram'] = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const r of rows) histogram[Math.min(5, Math.max(1, Math.round(r.score))) as 1 | 2 | 3 | 4 | 5]++;

  const byModel = new Map<string, JudgedSession[]>();
  for (const r of rows) byModel.set(r.model, [...(byModel.get(r.model) ?? []), r]);
  const perModel = [...byModel.entries()]
    .filter(([, list]) => list.length >= MIN_MODEL_N)
    .map(([model, list]) => ({
      model,
      n: list.length,
      successRate: list.filter((r) => r.success).length / list.length,
      meanScore: mean(list.map((r) => r.score)) ?? 0,
    }))
    .sort((a, b) => b.meanScore - a.meanScore);

  const auc = bothClasses ? rocAuc(pairs) : null;
  const shareAt5 = rows.length ? rows.filter((r) => r.score >= SHARE_AT_5_MIN_SCORE).length / rows.length : null;
  return {
    judged: rows.length,
    successes,
    auc,
    aucCI: bothClasses ? bootstrapCI(pairs, rocAuc, { seed: 2138 }) : null,
    shareAt5,
    shareRoundingTo5: rows.length ? histogram[5] / rows.length : null,
    histogram,
    meanScore: {
      success: mean(rows.filter((r) => r.success).map((r) => r.score)),
      failure: mean(rows.filter((r) => !r.success).map((r) => r.score)),
    },
    perModel,
    meetsTarget: auc !== null && shareAt5 !== null && auc >= TARGET_AUC && shareAt5 < TARGET_MAX_SHARE_AT_5,
  };
}

export type ReplayOutcome =
  | { kind: 'scored'; score: number; failedRun: boolean }
  | { kind: 'cohort_excluded'; reason: string }
  | { kind: 'in_flight' }
  | { kind: 'judge_no_task' };

/**
 * One session through the same gates production applies before a custom judge scores it
 * (scoreSessionWithJudgeIfNeeded): the cohort exclusions, then in-flight / failed-run / judge.
 * A failed run takes production's deterministic score with no model call. Production-state
 * checks (shadow sample, already scored) are left out: the replay judges every labelled session.
 */
export async function replaySession(
  session: ChatSession,
  judge: (session: ChatSession) => Promise<{ score: number; taskRequested?: boolean }>,
): Promise<ReplayOutcome> {
  const exclusion = judgeCohortExclusion(session);
  if (exclusion) return { kind: 'cohort_excluded', reason: exclusion.reason };
  const path = judgeScoringPath(session);
  if (path === 'in-flight') return { kind: 'in_flight' };
  if (path === 'failed-run') {
    return { kind: 'scored', score: buildFailedRunResult(session.messages?.length ?? 0).score, failedRun: true };
  }
  const result = await judge(session);
  return result.taskRequested === false ? { kind: 'judge_no_task' } : { kind: 'scored', score: result.score, failedRun: false };
}

/** The AW-ChatSessions attributes the cohort gates read (no message text is printed from them). */
const GATE_ATTRIBUTES = ['sessionId', 'userId', 'createdAt', 'updatedAt', 'sessionType', 'pageIdentifier', 'title', 'publishAdmission'];

async function readGateFields(reader: ReadOnlyDocReader, table: string, sessionId: string): Promise<DocItem | undefined> {
  const page = await reader.query({
    TableName: table,
    KeyConditionExpression: '#k = :s',
    ProjectionExpression: GATE_ATTRIBUTES.map((_, i) => `#a${i}`).join(', '),
    ExpressionAttributeNames: { '#k': 'sessionId', ...Object.fromEntries(GATE_ATTRIBUTES.map((a, i) => [`#a${i}`, a])) },
    ExpressionAttributeValues: { ':s': sessionId },
  });
  return page.Items?.[0];
}

function documentReader(): ReadOnlyDocReader {
  const doc = new AWS.DynamoDB.DocumentClient({ region: process.env.AWS_REGION || 'us-west-2' });
  return {
    query: (request: ReadRequest) => doc.query(request as AWS.DynamoDB.DocumentClient.QueryInput).promise(),
    scan: (request: ReadRequest) => Promise.reject(new Error(`evalOutcomeJudge: scan of ${request.TableName} refused`)),
  };
}

async function readMessages(reader: ReadOnlyDocReader, table: string, sessionId: string): Promise<ChatMessage[]> {
  const rows: DocItem[] = [];
  let start: DocItem | undefined;
  do {
    const page = await reader.query({
      TableName: table,
      KeyConditionExpression: 'sessionId = :s',
      ExpressionAttributeValues: { ':s': sessionId },
      ...(start ? { ExclusiveStartKey: start } : {}),
    });
    rows.push(...(page.Items ?? []));
    start = page.LastEvaluatedKey;
  } while (start);
  return orderedMessages(rows) as unknown as ChatMessage[];
}

/**
 * OpenRouter without the usage ledger (this script writes nothing); adds each call's reported
 * cost to `cost.usd`. The client is created up front, so a missing key fails the run once
 * instead of once per session.
 */
async function unmeteredJudgeCall(cost: { usd: number }): Promise<ScoringLlmCall> {
  const { agentModeService } = await import('../services/agentModeService');
  const { resolveOpenRouterUpstreamModelId } = await import('../utils/openRouterGatewayContract');
  const client = await agentModeService.getOpenRouterClient();
  return async (model, messages, options) => {
    const res = await client.chat.completions.create({
      model: resolveOpenRouterUpstreamModelId(model),
      messages,
      // Sonnet 5 / Opus 5 reject temperature; callLLM drops it the same way.
      ...(LLM_MODEL_REGISTRY[model]?.supportsTemperature === false ? {} : { temperature: options.temperature }),
      max_tokens: options.max_completion_tokens,
      response_format: options.response_format,
    });
    const reported = (res.usage as { cost?: unknown } | undefined)?.cost;
    if (typeof reported === 'number' && Number.isFinite(reported)) cost.usd += reported;
    return res;
  };
}

/** A candidate prompt file must be non-empty; whitespace-only would silently judge with no rubric. */
export function loadPromptFile(path: string, read: (p: string) => string = (p) => readFileSync(p, 'utf8')): string {
  const text = read(path).trim();
  if (!text) throw new Error(`--prompt-file ${path} is empty`);
  return text;
}

const pct = (x: number | null) => (x === null ? '-' : `${(x * 100).toFixed(1)}%`);
const fixed = (x: number | null, d = 2) => (x === null ? '-' : x.toFixed(d));

async function replay(args: Extract<Args, { mode: 'replay' }>): Promise<void> {
  const prefix = process.env.NODE_ENV === 'development' ? 'Dev-' : '';
  const tables: GraderTables = {
    sessions: `${prefix}AW-ChatSessions`,
    messages: `${prefix}AW-ChatMessages`,
    loopEvents: LOOP_EVENTS_TABLE,
    spendEvents: SPEND_EVENTS_TABLE,
  };
  const reader = documentReader();
  const frame = await listSessionsUpdatedBetween(reader, tables.sessions, { from: args.from, to: args.to });
  const withPlan = frame.filter((item) => (toGraderWorkPlan(item.workPlan)?.steps.length ?? 0) > 0);
  const drawn = sampleUniform(withPlan, args.sample, args.seed, (item) => String(item.sessionId));
  const loaded = await loadSessionItems(reader, tables, drawn, { from: args.from, to: args.to, includeSpend: false });
  const graded = loaded.map((l) => gradeSession(l.session, l.model, undefined));
  const labelled = graded.filter((g) => g.task.verdict !== 'excluded');

  console.log(`Window ${args.from} .. ${args.to}: ${frame.length} sessions, ${withPlan.length} with a work plan, ${drawn.length} drawn (seed ${args.seed}).`);
  console.log(`Deterministic label: ${labelled.length} labelled (${labelled.filter((g) => g.task.verdict === 'success').length} success), ${graded.length - labelled.length} excluded.`);
  if (args.dryRun) {
    console.log(`Dry run: would judge ${labelled.length} sessions on ${args.model}.`);
    return;
  }

  const base = buildOutcomeShadowJudgeRow({ sampleRate: 1, model: args.model });
  const judge = args.promptFile ? { ...base, systemPrompt: loadPromptFile(args.promptFile) } : base;
  if (args.promptFile) console.log(`Judge prompt: ${args.promptFile} (${judge.systemPrompt.length} chars), not the committed rubric.`);
  // ENG-2483: serializer-only replay drops the six appended clauses; production keeps the default.
  const judgeOptions = args.noJudgeClauses ? { appendClauses: false } : undefined;
  if (judgeOptions) console.log('Judge clauses: off (serializer-only prompt).');
  const cost = { usd: 0 };
  const call = await unmeteredJudgeCall(cost);
  const rows: JudgedSession[] = [];
  const skipped: Record<string, number> = {};
  const note = (why: string) => { skipped[why] = (skipped[why] ?? 0) + 1; };
  let failedRuns = 0;
  for (const g of labelled) {
    try {
      const [item, messages] = await Promise.all([
        readGateFields(reader, tables.sessions, g.sessionId),
        readMessages(reader, tables.messages, g.sessionId),
      ]);
      const session = { ...item, sessionId: g.sessionId, messages, messageCount: messages.length } as unknown as ChatSession;
      const outcome = await replaySession(session, (s) =>
        scoreSessionWithJudge(messages, messages.length, judge, s.sessionType, { sessionId: g.sessionId }, call, judgeOptions));
      if (outcome.kind === 'scored') {
        if (outcome.failedRun) failedRuns++;
        rows.push({ success: g.task.verdict === 'success', score: outcome.score, model: g.model });
      } else note(outcome.kind === 'cohort_excluded' ? `cohort_excluded:${outcome.reason}` : outcome.kind);
    } catch (err) {
      // Error class only: a parse error message can quote the model's reply.
      note(err instanceof SyntaxError ? 'unparseable_reply' : err instanceof Error ? err.name : 'error');
    }
  }

  const s = summarizeReplay(rows);
  console.log(`\nScored ${s.judged} (${s.successes} success; ${failedRuns} failed runs at production's fixed 1, no model call) on ${args.model}; not scored: ${JSON.stringify(skipped)}; reported cost $${cost.usd.toFixed(2)}.`);
  console.log(`AUC vs deterministic success: ${fixed(s.auc)} ${s.aucCI ? `[95% CI ${fixed(s.aucCI.low)}-${fixed(s.aucCI.high)}]` : ''} (target >= ${TARGET_AUC})`);
  console.log(`Share of raw scores >= ${SHARE_AT_5_MIN_SCORE}: ${pct(s.shareAt5)} (target < ${TARGET_MAX_SHARE_AT_5 * 100}%)`);
  console.log(`Share of scores that round to 5: ${pct(s.shareRoundingTo5)} (the histogram's 5 bucket)   rounded-bucket histogram 1..5: ${JSON.stringify(s.histogram)}`);
  console.log(`Mean score: success ${fixed(s.meanScore.success)} / failure ${fixed(s.meanScore.failure)}`);
  console.log(`Per agent model (n >= ${MIN_MODEL_N}), by mean judge score:`);
  for (const m of s.perModel) console.log(`  ${m.model.padEnd(40)} n=${String(m.n).padStart(4)}  success ${pct(m.successRate).padStart(6)}  judge ${m.meanScore.toFixed(2)}`);
  console.log(`\nMeets the ENG-2138 bar: ${s.meetsTarget ? 'yes' : 'no'}. Unvalidated against human labels (evalRegistry mayGate=false).`);
}

async function main(): Promise<void> {
  const args = parseArgs(argv.slice(2));
  if (args.mode === 'print-row') {
    console.log(JSON.stringify(buildOutcomeShadowJudgeRow({ sampleRate: args.sampleRate, model: args.model }), null, 2));
    return;
  }
  await replay(args);
}

if (require.main === module) {
  main()
    .then(() => exit(0))
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      exit(1);
    });
}
