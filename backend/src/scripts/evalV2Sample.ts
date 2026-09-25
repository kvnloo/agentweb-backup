/**
 * Run the online eval sampler (ENG-2144) for one UTC day by hand.
 *
 * Dry run by default: lists the day's frame, draws the sample and grades it, printing counts
 * only (no session ids, no message text) and writing nothing. `--live` writes the scores and
 * snapshots exactly like the cron, and refuses unless EVAL_V2_SAMPLER_ENABLED=true.
 *
 * Usage (default AWS profile; NODE_ENV=development reads the Dev- session tables):
 *   npx ts-node --transpile-only src/scripts/evalV2Sample.ts [--date 2026-09-24] [--sample-size 50] [--live]
 */

import { awsDynamoAdapter } from '../loops/adapters/awsAdapters';
import {
  EVAL_V2_SAMPLER_FLAG,
  EVAL_V2_SAMPLE_SIZE_ENV,
  productionGraderTables,
  queryOnlyReader,
  resolveSampleSize,
  runEvalV2Sample,
  samplerEnabled,
} from '../cron/evalV2SamplerCron';

export interface CliOptions {
  sampleDate?: string;
  sampleSize: number;
  live: boolean;
}

export function parseArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): CliOptions {
  const value = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    if (i === -1) return undefined;
    const operand = argv[i + 1];
    if (operand === undefined || operand.startsWith('--')) throw new Error(`${flag} needs a value`);
    return operand;
  };
  const sampleDate = value('--date');
  return {
    ...(sampleDate ? { sampleDate } : {}),
    sampleSize: resolveSampleSize(value('--sample-size') ?? env[EVAL_V2_SAMPLE_SIZE_ENV]),
    live: argv.includes('--live'),
  };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const result = await runEvalV2Sample(
    { dynamo: awsDynamoAdapter(), reader: queryOnlyReader(), tables: productionGraderTables(), clock: { now: () => new Date() } },
    {
      enabled: samplerEnabled(process.env[EVAL_V2_SAMPLER_FLAG]),
      dryRun: !opts.live,
      sampleSize: opts.sampleSize,
      ...(opts.sampleDate ? { sampleDate: opts.sampleDate } : {}),
    },
  );
  console.log(JSON.stringify(result, null, 2));
  if (result.status === 'refused') process.exitCode = 1;
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
