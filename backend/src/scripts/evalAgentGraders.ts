/**
 * Run the agent graders (ENG-2137) over a date range and print results per model × task type.
 *
 * Read-only: it queries AW-ChatSessions, AW-ChatMessages, Dev-AW-LoopEvents and AW-SpendEvents
 * and writes nothing, anywhere. Output carries session ids, tool names and counts only, never
 * message text or work-plan titles.
 *
 * ENG-2189 adds the instruction-adherence checks (pass rate over the sessions each applies to,
 * with n and a 95% Wilson CI) and the shadow outcome judge's binary criteria (share of its
 * scored sessions where each behaviour happened), read from judgeScores[outcome-judge-b-shadow].
 *
 * Usage (default AWS profile; NODE_ENV=development reads the Dev- tables):
 *   npx ts-node --transpile-only src/scripts/evalAgentGraders.ts --from 2026-09-18 --to 2026-09-25 \
 *     [--limit 500] [--per-session] [--json]
 *
 *   --per-session  one JSON line per session: verdicts and reasons
 *   --json         print the grouped report as JSON instead of a table
 */

import AWS from 'aws-sdk';
import {
  adherenceRates,
  aggregateByModelAndTaskType,
  gradeSession,
  type AdherenceRate,
  type GradedSession,
  type GroupReport,
} from '../loops/eval/agentGraders';
import { loadSessionsForGrading, type DocItem, type ReadOnlyDocReader, type ReadRequest } from '../loops/eval/agentGraderLoader';
import { wilsonInterval, type Interval } from '../loops/eval/agreement';
import { OUTCOME_SHADOW_JUDGE_ID } from '../services/outcomeJudge';
import { LOOP_EVENTS_TABLE } from '../loops/core/sensors/eventTableEventSource';
import { SPEND_EVENTS_TABLE } from '../services/spendEventDb';

const TABLE_PREFIX = process.env.NODE_ENV === 'development' ? 'Dev-' : '';

interface CliOptions {
  from: string;
  to: string;
  limit?: number;
  perSession: boolean;
  json: boolean;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `--from`/`--to` accept an ISO timestamp or a date. A date-only `--to` covers that whole day
 * (inclusive), matching how the documented usage reads. A flag given without an operand is an
 * error, not a silent default.
 */
export function parseArgs(argv: readonly string[], now: Date = new Date()): CliOptions {
  const value = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    if (i === -1) return undefined;
    const operand = argv[i + 1];
    if (operand === undefined || operand.startsWith('--')) throw new Error(`${flag} needs a value`);
    return operand;
  };
  const toDate = (flag: string, fallback: Date, endOfDay: boolean): Date => {
    const raw = value(flag);
    if (raw === undefined) return fallback;
    const d = new Date(raw);
    // Date-only input must round-trip: new Date('2026-02-30') silently becomes March 2.
    const invalid = Number.isNaN(d.getTime()) || (DATE_ONLY.test(raw) && d.toISOString().slice(0, 10) !== raw);
    if (invalid) throw new Error(`${flag} must be a date, got "${raw}"`);
    if (endOfDay && DATE_ONLY.test(raw)) d.setUTCHours(23, 59, 59, 999);
    return d;
  };
  const limitRaw = value('--limit');
  const limit = limitRaw !== undefined ? Number(limitRaw) : undefined;
  if (limit !== undefined && !(Number.isInteger(limit) && limit > 0)) throw new Error('--limit must be a positive integer');
  const from = toDate('--from', new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000), false);
  const to = toDate('--to', now, true);
  if (from.getTime() > to.getTime()) throw new Error('--from must not be after --to');
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    limit,
    perSession: argv.includes('--per-session'),
    json: argv.includes('--json'),
  };
}

function documentReader(): ReadOnlyDocReader {
  const doc = new AWS.DynamoDB.DocumentClient({ region: process.env.AWS_REGION || 'us-west-2' });
  return {
    query: (request: ReadRequest) => doc.query(request as AWS.DynamoDB.DocumentClient.QueryInput).promise(),
    scan: (request: ReadRequest) => doc.scan(request as AWS.DynamoDB.DocumentClient.ScanInput).promise(),
  };
}

const pct = (x: number | null) => (x == null ? '-' : `${(x * 100).toFixed(0)}%`);
const num = (x: number | null, digits = 1) => (x == null ? '-' : x.toFixed(digits));

function formatRow(g: GroupReport): string {
  const ci = g.successRateCI ? `[${pct(g.successRateCI.low)}-${pct(g.successRateCI.high)}]` : '';
  return [
    g.model.padEnd(36).slice(0, 36),
    g.taskType.padEnd(12),
    String(g.sessions).padStart(5),
    String(g.graded).padStart(6),
    `${pct(g.successRate)} ${ci}`.padEnd(16),
    String(g.successWithUnverifiedWrite).padStart(7),
    String(g.toolFailSessions).padStart(8),
    String(g.writeWithoutReadBackSessions).padStart(6),
    String(g.ungroundedSessions).padStart(7),
    `$${num(g.costPerSuccessUsd, 2)}`.padStart(9),
    `${g.gradedWithSpend}/${g.graded}`.padStart(8),
    num(g.meanTurnsPerSuccess).padStart(6),
    num(g.meanTokensPerSuccess, 0).padStart(10),
    `${num(g.toolLatencyP50Ms, 0)}/${num(g.toolLatencyP95Ms, 0)}`.padStart(13),
  ].join(' ');
}

const HEADER = [
  'model'.padEnd(36),
  'task'.padEnd(12),
  'n'.padStart(5),
  'graded'.padStart(6),
  'success [95% CI]'.padEnd(16),
  'ok+wwr'.padStart(7),
  'toolFail'.padStart(8),
  'wwrb'.padStart(6),
  'ungrnd'.padStart(7),
  '$/success'.padStart(9),
  'spend'.padStart(8),
  'turns'.padStart(6),
  'tokens'.padStart(10),
  'tool p50/p95'.padStart(13),
].join(' ');

/** The outcome rubric's binary criteria (ENG-2189), as stored in the shadow judge's dimensions. */
export const JUDGE_CRITERIA = ['arguedWithInstruction', 'escalatedWhenNotRequired', 'failedToEscalate'] as const;

export interface JudgeCriterionRate {
  criterion: (typeof JUDGE_CRITERIA)[number];
  /** Scored sessions with a boolean for this criterion. */
  n: number;
  /** Of those, sessions where the behaviour happened (true). */
  happened: number;
  rate: number | null;
  ci: Interval | null;
}

/** Share of shadow-judged sessions where each behaviour happened, with n and a Wilson CI. */
export function judgeCriteriaRates(dimensions: ReadonlyArray<Record<string, unknown> | undefined>): JudgeCriterionRate[] {
  return JUDGE_CRITERIA.map((criterion) => {
    const answers = dimensions.flatMap((d) => (typeof d?.[criterion] === 'boolean' ? [d[criterion] as boolean] : []));
    const happened = answers.filter(Boolean).length;
    const n = answers.length;
    return { criterion, n, happened, rate: n ? happened / n : null, ci: n ? wilsonInterval(happened, n) : null };
  });
}

/** Read-only: the shadow judge's stored dimensions on sessions updated in the window. */
async function readShadowJudgeDimensions(reader: ReadOnlyDocReader, sessionsTable: string, window: { from: string; to: string }): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  let start: DocItem | undefined;
  do {
    const page = await reader.query({
      TableName: sessionsTable,
      IndexName: 'AdminUpdatedAtIndex',
      KeyConditionExpression: 'adminListPartition = :p AND updatedAt BETWEEN :from AND :to',
      FilterExpression: 'attribute_exists(judgeScores.#judge)',
      ProjectionExpression: 'judgeScores.#judge.dimensions',
      ExpressionAttributeNames: { '#judge': OUTCOME_SHADOW_JUDGE_ID },
      ExpressionAttributeValues: { ':p': 'all', ':from': window.from, ':to': window.to },
      ...(start ? { ExclusiveStartKey: start } : {}),
    });
    for (const item of page.Items ?? []) {
      const scores = item.judgeScores as Record<string, { dimensions?: Record<string, unknown> }> | undefined;
      out.push(scores?.[OUTCOME_SHADOW_JUDGE_ID]?.dimensions ?? {});
    }
    start = page.LastEvaluatedKey;
  } while (start);
  return out;
}

const rateWithCI = (r: { rate: number | null; ci: Interval | null; n: number }) =>
  `${pct(r.rate)}${r.ci ? ` [${pct(r.ci.low)}-${pct(r.ci.high)}]` : ''} n=${r.n}`;

function printAdherence(graded: readonly GradedSession[], groups: readonly GroupReport[]): void {
  console.log('\nInstruction adherence (ENG-2189): pass rate over the sessions each check applied to, 95% Wilson CI.');
  for (const r of adherenceRates(graded.map((s) => s.adherence))) {
    console.log(`  ${r.graderId.padEnd(30)} ${rateWithCI(r).padEnd(24)} fail=${r.n - r.passes} not_applicable=${r.notApplicable}`);
  }
  console.log('Adherence reasons:', tally(graded.flatMap((s) => [
    `length:${s.adherence.length.reason}`,
    `format:${s.adherence.format.reason}`,
    `permission:${s.adherence.permission.reason}`,
  ])));
  const short = (r: AdherenceRate) => (r.n ? rateWithCI(r) : '-');
  for (const g of groups.filter((x) => x.adherence.some((r) => r.n > 0))) {
    console.log(`  ${g.model.padEnd(36).slice(0, 36)} ${g.taskType.padEnd(12)} ${g.adherence.map(short).join(' | ')}`);
  }
}

function printJudgeCriteria(rates: readonly JudgeCriterionRate[]): void {
  console.log(`\nShadow judge criteria (${OUTCOME_SHADOW_JUDGE_ID}, ENG-2189): share of its scored sessions where the behaviour happened.`);
  for (const r of rates) console.log(`  ${r.criterion.padEnd(26)} ${r.n ? `${rateWithCI(r)} happened=${r.happened}` : 'n=0 (no shadow scores in the window)'}`);
}

function tally<T extends string>(values: readonly T[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}

function printSummary(graded: readonly GradedSession[], groups: readonly GroupReport[], opts: CliOptions): void {
  console.log(`Agent graders ${opts.from} .. ${opts.to}: ${graded.length} sessions\n`);
  console.log('Task success reasons:', tally(graded.map((s) => `${s.task.verdict}:${s.task.reason}`)));
  console.log('Tool findings:', tally(graded.flatMap((s) => s.tools.findings.map((f) => f.kind))));
  console.log('Groundedness:', tally(graded.map((s) => s.groundedness.verdict)));
  console.log('Unbacked claim classes:', tally(graded.flatMap((s) => s.groundedness.unbackedClaimClasses)));
  console.log('\nok+wwr = successes with an ad-platform write never read back; wwrb = sessions with one (write_read_back_unconfirmed not counted); spend = graded sessions with AW-SpendEvents rows.');
  console.log('$/success = spend of graded sessions with spend data / their successes. Graders are unvalidated (evalRegistry mayGate=false).\n');
  console.log(HEADER);
  for (const g of groups) console.log(formatRow(g));
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const reader = documentReader();
  const sessionsTable = `${TABLE_PREFIX}AW-ChatSessions`;
  const loaded = await loadSessionsForGrading(
    reader,
    {
      sessions: sessionsTable,
      messages: `${TABLE_PREFIX}AW-ChatMessages`,
      loopEvents: LOOP_EVENTS_TABLE,
      spendEvents: SPEND_EVENTS_TABLE,
    },
    { from: opts.from, to: opts.to, limit: opts.limit },
  );
  const graded = loaded.map((l) => gradeSession(l.session, l.model, l.spend));
  const groups = aggregateByModelAndTaskType(graded);

  if (opts.perSession) {
    for (const s of graded) {
      console.log(JSON.stringify({
        sessionId: s.sessionId,
        model: s.model,
        taskType: s.taskType,
        task: s.task,
        tools: { verdict: s.tools.verdict, toolCalls: s.tools.toolCalls, mutations: s.tools.mutations, findings: s.tools.findings },
        groundedness: s.groundedness,
        adherence: s.adherence,
      }));
    }
    return;
  }
  const judgeCriteria = judgeCriteriaRates(await readShadowJudgeDimensions(reader, sessionsTable, opts));
  if (opts.json) {
    const adherence = adherenceRates(graded.map((s) => s.adherence));
    console.log(JSON.stringify({ from: opts.from, to: opts.to, sessions: graded.length, adherence, judgeCriteria, groups }, null, 2));
    return;
  }
  printSummary(graded, groups, opts);
  printAdherence(graded, groups);
  printJudgeCriteria(judgeCriteria);
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
