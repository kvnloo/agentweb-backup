/**
 * Offline eval suite + regression gate CLI (ENG-2145). The gate runs on Atem and staging; product
 * suites do not gate in GitHub CI (repo CLAUDE.md). A PR that touches prompt/model/skill/eval
 * sources runs `--target local` report-only through .github/workflows/offline-eval.yml (ENG-2195).
 *
 * Usage (from backend/):
 *   npx ts-node --transpile-only src/loops/scripts/runOfflineEvalSuite.ts --target local
 *   npx ts-node --transpile-only src/loops/scripts/runOfflineEvalSuite.ts --target staging \
 *     --baseline src/loops/eval/baselines/<file>.json --okareo-run <test-run-uuid> [--golden]
 *
 *   --target local|staging     required; production is refused (ENG-782)
 *   --baseline <file>          versioned baseline; default for local: baselines/local-deterministic.json
 *   --okareo-run <uuid>        a finished Okareo test run against the staging target (needs OKAREO_API_KEY, OPS-6)
 *   --golden                   add grader-vs-human agreement on the golden set (needs EVAL_GOLDEN_CASES_TABLE, OPS-2)
 *   --changes-since <iso>      list prompt/model/skill changes marked "needs eval" since then (read-only)
 *   --out <file>               write the full result as JSON (the run's evidence)
 *   --write-baseline <file> --baseline-id <id>
 *                              record a new baseline from this run instead of comparing (commit it via PR)
 *   --bypass-by <human> --bypass-reason <why> --bypass-ticket <ENG-n>
 *                              explicitly recorded emergency bypass of a blocking result
 *
 * Exit: 0 unless the gate blocks (1 regression, 2 unavailable); 64 for a usage error. The gate is
 * report-only — it never blocks — until EVAL_GATE_BLOCKING=true and a compared metric's grader
 * passes evalRegistry.mayGate.
 */

import AWS from 'aws-sdk';
import fs from 'fs';
import path from 'path';
import { listEvalChangeMarkers } from '../eval/evalChangeMarkers';
import { goldenSetStoreFromEnv } from '../eval/goldenSetStore';
import { okareoSource } from '../eval/okareoClient';
import {
  baselineFromObservations,
  exitCodeFor,
  gateConfigFromEnv,
  parseBaseline,
  parseBypass,
  renderReport,
  resolveTarget,
  runOfflineSuite,
  type BypassRecord,
  type EvalTarget,
  type MetricObservation,
  type SuiteSource,
} from '../eval/offlineSuite';
import { failureReplaySource, goldenSetSource, replayFixtureSource, storeBackedFixtureLoader } from '../eval/offlineSuiteSources';
import { defaultGoldenCaseGraders } from '../eval/runValidation';

export const DEFAULT_LOCAL_BASELINE = path.join(__dirname, '../eval/baselines/local-deterministic.json');
export const USAGE_ERROR_EXIT = 64;

export interface CliOptions {
  target: EvalTarget;
  baselineFile?: string;
  okareoRunId?: string;
  golden: boolean;
  changesSince?: string;
  out?: string;
  writeBaseline?: { file: string; baselineId: string };
  bypass: BypassRecord | null;
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export function parseArgs(argv: readonly string[], now: Date = new Date()): CliOptions {
  const value = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    if (i === -1) return undefined;
    const operand = argv[i + 1];
    if (operand === undefined || operand.startsWith('--')) throw new UsageError(`${flag} needs a value`);
    return operand;
  };
  let target: EvalTarget;
  try {
    target = resolveTarget(value('--target'));
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const changesSince = value('--changes-since');
  if (changesSince !== undefined && Number.isNaN(Date.parse(changesSince))) throw new UsageError('--changes-since must be an ISO date');
  const writeFile = value('--write-baseline');
  const baselineId = value('--baseline-id');
  if ((writeFile === undefined) !== (baselineId === undefined)) throw new UsageError('--write-baseline and --baseline-id go together');
  const baselineFile = value('--baseline') ?? (target === 'local' && !writeFile ? DEFAULT_LOCAL_BASELINE : undefined);
  if (!baselineFile && !writeFile) throw new UsageError('--baseline is required for a staging run');
  let bypass: BypassRecord | null;
  try {
    bypass = parseBypass({ by: value('--bypass-by'), reason: value('--bypass-reason'), ticket: value('--bypass-ticket') }, now);
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const okareoRunId = value('--okareo-run');
  const out = value('--out');
  return {
    target,
    ...(baselineFile ? { baselineFile } : {}),
    ...(okareoRunId ? { okareoRunId } : {}),
    golden: argv.includes('--golden'),
    ...(changesSince ? { changesSince } : {}),
    ...(out ? { out } : {}),
    ...(writeFile && baselineId ? { writeBaseline: { file: writeFile, baselineId } } : {}),
    bypass,
  };
}

/** The sources a run uses: always the deterministic replay pieces, plus Okareo and the golden set when asked. */
export function buildSources(opts: CliOptions, env: NodeJS.ProcessEnv = process.env): SuiteSource[] {
  const sources: SuiteSource[] = [failureReplaySource()];
  if (opts.golden) {
    const store = goldenSetStoreFromEnv(env);
    sources.push(replayFixtureSource({ load: storeBackedFixtureLoader(store) }));
    sources.push(goldenSetSource({ store, graders: defaultGoldenCaseGraders }));
  } else {
    sources.push(replayFixtureSource());
  }
  if (opts.target === 'staging' || opts.okareoRunId) sources.push(okareoSource({ env, testRunId: opts.okareoRunId }));
  return sources;
}

async function collectObservations(sources: readonly SuiteSource[]): Promise<MetricObservation[]> {
  const observations: MetricObservation[] = [];
  for (const source of sources) {
    const result = await source.run();
    if (result.status === 'failed') throw new Error(`cannot record a baseline: ${result.source} ${result.failure}: ${result.message}`);
    if (result.status === 'ok') observations.push(...result.observations);
  }
  return observations;
}

async function printChangesSince(since: string): Promise<void> {
  const doc = new AWS.DynamoDB.DocumentClient({ region: process.env.AWS_REGION || 'us-west-2' });
  const rows = await listEvalChangeMarkers((params) => doc.query(params).promise(), since);
  console.log(`\nChanges marked "needs eval" since ${since}: ${rows.length}`);
  for (const r of rows) console.log(`- ${r.ts} ${r.subjectId} ${JSON.stringify(r.dimensions)}`);
}

async function main(): Promise<number> {
  let opts: CliOptions;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return USAGE_ERROR_EXIT;
  }
  const sources = buildSources(opts);

  if (opts.writeBaseline) {
    const baseline = baselineFromObservations(await collectObservations(sources), {
      baselineId: opts.writeBaseline.baselineId,
      target: opts.target,
      source: `runOfflineEvalSuite ${opts.okareoRunId ? `okareo run ${opts.okareoRunId}` : 'local'}; review and commit via PR`,
      now: new Date(),
    });
    fs.writeFileSync(opts.writeBaseline.file, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
    console.log(`Wrote baseline ${baseline.baselineId} (${baseline.metrics.length} metrics) to ${opts.writeBaseline.file}`);
    return 0;
  }

  const baselineFile = opts.baselineFile;
  if (!baselineFile) throw new UsageError('--baseline is required');
  const baseline = parseBaseline(JSON.parse(fs.readFileSync(baselineFile, 'utf8')));
  const result = await runOfflineSuite({
    baseline,
    baselineFile: path.relative(process.cwd(), baselineFile),
    target: opts.target,
    sources,
    gate: gateConfigFromEnv(),
    bypass: opts.bypass,
  });
  console.log(renderReport(result));
  if (opts.out) fs.writeFileSync(opts.out, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  if (opts.changesSince) await printChangesSince(opts.changesSince);
  return exitCodeFor(result);
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      // An error inside the run is an unavailable evaluator: never exit 0 (fail closed).
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(2);
    },
  );
}
