/**
 * ENG-805 cleanup: deep research was deprecated in agent-engine on
 * 2026-01-01 (task_monitor.py commit e94a8e4a) - any task with
 * isDeepResearch: true now hits a hard RuntimeError on every attempt and
 * pages oncall every time, for a failure nobody can act on. A separate fix
 * (same ticket) stops new tasks/templates from ever getting the flag set
 * again; this script is the one-time cleanup for rows that already have it
 * stuck true from before that fix landed.
 *
 * Flips isDeepResearch: true -> false on AW-Tasks and AW-TaskTemplates.
 * Idempotent: only ever touches rows currently true, so re-runs are safe
 * and just find nothing left to do.
 *
 * Dry-run (default): scans, counts, prints what WOULD change, writes nothing.
 *   NODE_ENV=development npx ts-node src/scripts/backfill-eng805-deep-research-deprecated.ts
 * Apply:
 *   NODE_ENV=development npx ts-node src/scripts/backfill-eng805-deep-research-deprecated.ts --apply
 *
 * Table prefix follows NODE_ENV same as the rest of the app (Dev- in
 * development, none in production) - set NODE_ENV=production to target
 * the real prod tables. Run against Dev first.
 */
import { DynamoDB } from 'aws-sdk';

const doc = new DynamoDB.DocumentClient({ region: process.env.AWS_REGION || 'us-west-2' });
const TABLE_PREFIX = process.env.NODE_ENV === 'development' ? 'Dev-' : '';
const APPLY = process.argv.includes('--apply');

interface TableSpec {
  table: string;
  keyName: string;
}

const TABLES: TableSpec[] = [
  { table: `${TABLE_PREFIX}AW-Tasks`, keyName: 'taskId' },
  { table: `${TABLE_PREFIX}AW-TaskTemplates`, keyName: 'templateId' },
];

async function backfillTable(spec: TableSpec): Promise<{ found: number; updated: number; skippedArchived: number }> {
  let lastKey: DynamoDB.DocumentClient.Key | undefined;
  let found = 0;
  let updated = 0;
  let skippedArchived = 0;

  do {
    const res = await doc
      .scan({
        TableName: spec.table,
        FilterExpression: 'isDeepResearch = :t',
        ExpressionAttributeValues: { ':t': true },
        ExclusiveStartKey: lastKey,
      })
      .promise();

    for (const item of res.Items || []) {
      found++;
      const key = { [spec.keyName]: item[spec.keyName] };
      const label = `${spec.table} ${spec.keyName}=${item[spec.keyName]} (${item.name || item.status || 'unnamed'})`;

      if (!APPLY) {
        console.log(`[dry-run] would fix: ${label}`);
        continue;
      }

      try {
        await doc
          .update({
            TableName: spec.table,
            Key: key,
            // Idempotent guard: only writes if still true at update time,
            // so a concurrent run (or this script re-run) can't clobber a
            // row someone else already fixed or already re-set.
            ConditionExpression: 'isDeepResearch = :t',
            UpdateExpression: 'SET isDeepResearch = :f',
            ExpressionAttributeValues: { ':t': true, ':f': false },
          })
          .promise();
        updated++;
        console.log(`[applied] fixed: ${label}`);
      } catch (err) {
        if ((err as { code?: string }).code === 'ConditionalCheckFailedException') {
          skippedArchived++; // already fixed by a prior/concurrent run
        } else {
          throw err;
        }
      }
    }
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);

  return { found, updated, skippedArchived };
}

async function main(): Promise<void> {
  console.log(`Mode: ${APPLY ? 'APPLY' : 'dry-run'} | Table prefix: "${TABLE_PREFIX}" (NODE_ENV=${process.env.NODE_ENV || 'production'})`);

  const summary: Record<string, { found: number; updated: number; skippedArchived: number }> = {};
  for (const spec of TABLES) {
    summary[spec.table] = await backfillTable(spec);
  }

  console.log('\n=== Summary ===');
  console.log(JSON.stringify(summary, null, 2));
  if (!APPLY) {
    console.log('\nDry-run only - no writes made. Re-run with --apply to fix these rows.');
  }
}

main().catch((e) => {
  console.error('[backfill-eng805-deep-research-deprecated] failed:', e);
  process.exit(1);
});
