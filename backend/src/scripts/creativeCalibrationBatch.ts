/**
 * Draw the weekly creative calibration batch (ENG-2142) — the same run the daily cron makes.
 *
 * Usage:
 *   npx ts-node --transpile-only src/scripts/creativeCalibrationBatch.ts [--batch 2026-W39] [--target 20] [--write]
 *
 * Default is a DRY RUN: it scans AW-HumanEvalQueue (creative_image candidates; `Dev-` when
 * NODE_ENV=development) and, when EVAL_GOLDEN_CASES_TABLE is set, reads the golden set to leave
 * out pairs from earlier batches. It prints counts only (pairs, strata, signals, accounts) — no
 * ids, copy, requests or URLs.
 *
 * `--write` makes the live run: it needs CREATIVE_CALIBRATION_ENABLED=true and the store, writes
 * the batch's pairwise cases (never overwriting one), and posts the weekly Slack message only when
 * CREATIVE_CALIBRATION_SLACK_ENABLED=true and this run created the batch.
 */

import { argv, exit } from 'node:process';
import { runCreativeCalibration } from '../cron/creativeCalibrationCron';
import { DEFAULT_CALIBRATION_BATCH_SIZE, isoWeekStart } from '../loops/eval/creativeCalibration';

export interface BatchArgs {
  batch?: string;
  target: number;
  write: boolean;
}

const USAGE = 'Usage: creativeCalibrationBatch.ts [--batch <YYYY-Www>] [--target <n>] [--write]';

/** Strict, so a typo can never turn a dry run into a write. */
export function parseBatchArgs(raw: readonly string[]): BatchArgs {
  const args: BatchArgs = { target: DEFAULT_CALIBRATION_BATCH_SIZE, write: false };
  const operand = (i: number, flag: string): string => {
    const value = raw[i];
    if (value === undefined || value.startsWith('--') || !value.trim()) throw new Error(`${flag} needs a value. ${USAGE}`);
    return value.trim();
  };
  for (let i = 0; i < raw.length; i++) {
    const flag = raw[i];
    if (flag === '--batch') {
      args.batch = operand(++i, flag);
      isoWeekStart(args.batch);
    } else if (flag === '--target') {
      const target = Number(operand(++i, flag));
      if (!Number.isInteger(target) || target < 1 || target > 100) throw new Error(`--target must be an integer from 1 to 100. ${USAGE}`);
      args.target = target;
    } else if (flag === '--write') {
      args.write = true;
    } else {
      throw new Error(`unknown argument "${flag}". ${USAGE}`);
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseBatchArgs(argv.slice(2));
  const summary = await runCreativeCalibration({ dryRun: !args.write, target: args.target, ...(args.batch ? { batch: args.batch } : {}) });
  console.log(JSON.stringify(summary, null, 2));
  if (args.write && summary.status !== 'written' && summary.status !== 'already_complete' && summary.status !== 'no_pairs') exit(1);
}

if (require.main === module) {
  main()
    .then(() => exit(0))
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      exit(1);
    });
}
