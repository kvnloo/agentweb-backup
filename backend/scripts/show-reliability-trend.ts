/**
 * Print the agent-mode daily reliability trend line — one command away.
 *
 * Reads the dated snapshot rows the daily cron persists (loopId
 * 'agent-reliability-daily' in Dev-AW-LoopEvents) and prints them oldest-first
 * so the reliability trend is visible at a glance.
 *
 * Usage:
 *   npx ts-node backend/scripts/show-reliability-trend.ts                 # last 14 days, 24h window
 *   npx ts-node backend/scripts/show-reliability-trend.ts --days=30       # last 30 days
 *   npx ts-node backend/scripts/show-reliability-trend.ts --window=7d     # 7d rolling window instead of 24h
 *   npx ts-node backend/scripts/show-reliability-trend.ts --json          # raw JSON
 *
 * Read-only. Touches only the snapshot rows, never the chat path.
 */

import { awsDynamoAdapter } from '../src/loops/adapters/awsAdapters';
import { readReliabilityTrend } from '../src/cron/agentReliabilitySnapshotCron';

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main(): Promise<void> {
  const days = Number(arg('days') ?? '14');
  const windowLabel = arg('window') ?? '24h';
  const dynamo = awsDynamoAdapter();

  const trend = await readReliabilityTrend(dynamo, { limit: days, windowLabel });

  if (flag('json')) {
    console.log(JSON.stringify(trend, null, 2));
    return;
  }

  if (trend.length === 0) {
    console.log(
      `No reliability snapshots found (window=${windowLabel}). ` +
        `Has the daily cron run yet? It is gated by AGENT_RELIABILITY_SNAPSHOT_ENABLED=true.`,
    );
    return;
  }

  console.log(`Agent-mode reliability trend — ${windowLabel} window, last ${trend.length} day(s)\n`);
  console.log(
    'date        tool_success  degraded   failed   runs   med_iter  p90_iter  top cluster',
  );
  console.log('-'.repeat(92));
  for (const s of trend) {
    const top = s.topClusters[0]
      ? `${s.topClusters[0].toolName}×${s.topClusters[0].errorClass} (${s.topClusters[0].count})`
      : '—';
    console.log(
      [
        s.date.padEnd(11),
        `${(s.toolSuccessRate * 100).toFixed(1)}%`.padStart(11),
        `${(s.degradedRunRate * 100).toFixed(1)}%`.padStart(9),
        `${(s.failedRunRate * 100).toFixed(1)}%`.padStart(8),
        String(s.runCount).padStart(6),
        String(s.medianIterations).padStart(9),
        String(s.p90Iterations).padStart(9),
        `  ${top}`,
      ].join(''),
    );
  }
}

main().catch((err) => {
  console.error('[show-reliability-trend] failed:', err);
  process.exit(1);
});
