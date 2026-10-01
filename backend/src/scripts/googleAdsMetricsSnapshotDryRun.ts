/**
 * Standalone runner for the Google Ads metrics snapshot cron (ENG-2215).
 *
 * Usage:
 *   npx ts-node --transpile-only src/scripts/googleAdsMetricsSnapshotDryRun.ts [--write]
 *
 * Default is a DRY RUN: it enumerates connected Google Ads accounts, pulls campaign-level
 * performance from the real Google Ads API for each date in the cron's re-pull window, runs it
 * through the exact same micros-to-currency conversion and row-shaping code the live cron uses,
 * and logs what WOULD be written — without ever calling adsMetricsDb.putSnapshot. This is meant
 * to be run against real prod data (real connected accounts, real API calls) BEFORE
 * GOOGLE_ADS_METRICS_SNAPSHOT_ENABLED is ever turned on, precisely so the read side can be
 * verified independently of the write side.
 *
 * `--write` makes the live run: it writes rows to AW-AdsMetricsSnapshots exactly as the
 * scheduled cron would. It does NOT require GOOGLE_ADS_METRICS_SNAPSHOT_ENABLED to be set in the
 * environment this script runs in — the flag governs the SCHEDULED cron in server.ts, not this
 * script — so `--write` is itself the confirmation gate here. Treat it with the same caution as
 * flipping the env var in production.
 */

import { argv, exit } from 'node:process';
import { runGoogleAdsMetricsSnapshot } from '../cron/googleAdsMetricsSnapshotCron';

export interface DryRunArgs {
  write: boolean;
}

const USAGE = 'Usage: googleAdsMetricsSnapshotDryRun.ts [--write]';

/** Strict, so a typo can never turn a dry run into a write. */
export function parseDryRunArgs(raw: readonly string[]): DryRunArgs {
  const args: DryRunArgs = { write: false };
  for (const flag of raw) {
    if (flag === '--write') {
      args.write = true;
    } else {
      throw new Error(`unknown argument "${flag}". ${USAGE}`);
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseDryRunArgs(argv.slice(2));
  if (args.write) {
    console.log('[googleAdsMetricsSnapshotDryRun] --write set: this WILL write rows to AW-AdsMetricsSnapshots.');
  } else {
    console.log('[googleAdsMetricsSnapshotDryRun] Dry run (default): reading only, nothing will be written.');
  }
  const summary = await runGoogleAdsMetricsSnapshot({ enabled: args.write, dryRun: !args.write });
  console.log(JSON.stringify(summary, null, 2));
  if (summary.status === 'refused') exit(1);
}

if (require.main === module) {
  main()
    .then(() => exit(0))
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      exit(1);
    });
}
