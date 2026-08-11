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
 *
 * IMPORTANT - this is not a purely cosmetic flag flip. Once isDeepResearch
 * is false, the row's execute_task() branch changes from an immediate,
 * guaranteed failure to a REAL run (real browser automation, real LLM
 * calls) using the row's stored prompt on the standard (non-deep-research)
 * agent. For tasks that were genuinely written for a deep-research agent
 * (broad, multi-source, no single concrete URL to visit), that real run
 * can produce a shallow or misleading result presented as a normal
 * "completed" task, rather than the loud failure it produces today.
 * Rows below are tagged [HIGH-RISK] via a simple heuristic (prompt
 * mentions "deep research", or has no http(s) URL at all) so this is
 * visible before you apply, not discovered after. Spot-check those
 * specifically - the heuristic is not exhaustive.
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

// Heuristic only, not exhaustive - flags rows worth a human glance before
// they're allowed to actually execute for the first time in ~7 months.
function isHighRisk(item: Record<string, unknown>): boolean {
  const prompt = typeof item.prompt === 'string' ? item.prompt : '';
  const mentionsDeepResearch = /deep research/i.test(prompt);
  const hasUrl = /https?:\/\//i.test(prompt);
  return mentionsDeepResearch || !hasUrl;
}

async function backfillTable(spec: TableSpec): Promise<{ found: number; updated: number; skippedArchived: number; highRisk: number }> {
  let lastKey: DynamoDB.DocumentClient.Key | undefined;
  let found = 0;
  let updated = 0;
  let skippedArchived = 0;
  let highRisk = 0;

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
      const risky = isHighRisk(item);
      if (risky) highRisk++;
      const tag = risky ? '[HIGH-RISK] ' : '';
      const label = `${tag}${spec.table} ${spec.keyName}=${item[spec.keyName]} (${item.name || item.status || 'unnamed'})`;

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

  return { found, updated, skippedArchived, highRisk };
}

async function main(): Promise<void> {
  console.log(`Mode: ${APPLY ? 'APPLY' : 'dry-run'} | Table prefix: "${TABLE_PREFIX}" (NODE_ENV=${process.env.NODE_ENV || 'production'})`);

  const summary: Record<string, { found: number; updated: number; skippedArchived: number; highRisk: number }> = {};
  for (const spec of TABLES) {
    summary[spec.table] = await backfillTable(spec);
  }

  console.log('\n=== Summary ===');
  console.log(JSON.stringify(summary, null, 2));
  const totalHighRisk = Object.values(summary).reduce((sum, s) => sum + s.highRisk, 0);
  if (totalHighRisk > 0) {
    console.log(`\n${totalHighRisk} row(s) tagged [HIGH-RISK] above - once fixed, these will actually execute for the`);
    console.log('first time in ~7 months, with a prompt written for a deep-research agent that no longer exists.');
    console.log('Worth a human glance at those specific rows before/after applying.');
  }
  if (!APPLY) {
    console.log('\nDry-run only - no writes made. Re-run with --apply to fix these rows.');
  }
}

main().catch((e) => {
  console.error('[backfill-eng805-deep-research-deprecated] failed:', e);
  process.exit(1);
});
