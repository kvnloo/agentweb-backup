/**
 * ENG-812: ENG-804 fixed the DEFAULT LLM fallback list for the 3 Gemini
 * models Google retired (gemini-2.5-pro-preview-05-06,
 * gemini-2.5-pro-preview-03-25, gemini-2.0-flash). But individual
 * tasks/templates can pin their own selectedLLMs list at creation time,
 * which overrides the default entirely - and a large number of existing
 * rows have one or more of those same 3 dead models baked into that
 * per-row list. Confirmed live: a task tries the dead model first, gets a
 * real failure, then falls back to the next entry - degraded
 * reliability/latency, same shape ENG-804 fixed for the default list.
 *
 * Replaces each dead entry with its tier-matched live replacement
 * (gemini-2.5-pro-preview-05-06 / -03-25 -> gemini-3.1-pro-preview,
 * gemini-2.0-flash -> gemini-3.5-flash) inside each row's own
 * selectedLLMs list, de-duplicating in case a row has both dead Pro
 * variants (which would otherwise collapse into two identical entries).
 * Order of remaining/replacement entries is preserved (first occurrence
 * wins the position).
 *
 * Idempotent: only ever touches rows whose selectedLLMs currently
 * contains a dead entry, and a ConditionExpression re-checks that at
 * write time.
 *
 * Dry-run (default): scans, prints each row's before/after list, writes nothing.
 *   NODE_ENV=development npx ts-node src/scripts/backfill-eng812-selectedllms-retired-gemini.ts
 * Apply:
 *   NODE_ENV=development npx ts-node src/scripts/backfill-eng812-selectedllms-retired-gemini.ts --apply
 *
 * Table prefix follows NODE_ENV like the rest of the app - set
 * NODE_ENV=production to target the real prod tables. Run against Dev first.
 */
import { DynamoDB } from 'aws-sdk';

const doc = new DynamoDB.DocumentClient({ region: process.env.AWS_REGION || 'us-west-2' });
const TABLE_PREFIX = process.env.NODE_ENV === 'development' ? 'Dev-' : '';
const APPLY = process.argv.includes('--apply');

const REPLACEMENTS: Record<string, string> = {
  'google->google->gemini-2.5-pro-preview-05-06': 'google->google->gemini-3.1-pro-preview',
  'google->google->gemini-2.5-pro-preview-03-25': 'google->google->gemini-3.1-pro-preview',
  'google->google->gemini-2.0-flash': 'google->google->gemini-3.5-flash',
};

interface TableSpec {
  table: string;
  keyName: string;
}

const TABLES: TableSpec[] = [
  { table: `${TABLE_PREFIX}AW-Tasks`, keyName: 'taskId' },
  { table: `${TABLE_PREFIX}AW-TaskTemplates`, keyName: 'templateId' },
];

function fixSelectedLLMs(selectedLLMs: string[]): { changed: boolean; fixed: string[] } {
  let changed = false;
  const seen = new Set<string>();
  const fixed: string[] = [];
  for (const entry of selectedLLMs) {
    const replacement = REPLACEMENTS[entry];
    const value = replacement ?? entry;
    if (replacement) changed = true;
    if (seen.has(value)) continue; // drop duplicate caused by two dead entries mapping to the same replacement
    seen.add(value);
    fixed.push(value);
  }
  return { changed, fixed };
}

async function backfillTable(spec: TableSpec): Promise<{ found: number; updated: number; skipped: number }> {
  let lastKey: DynamoDB.DocumentClient.Key | undefined;
  let found = 0;
  let updated = 0;
  let skipped = 0;
  const deadValues = Object.keys(REPLACEMENTS);

  do {
    const res = await doc
      .scan({
        TableName: spec.table,
        ExclusiveStartKey: lastKey,
      })
      .promise();

    for (const item of res.Items || []) {
      const selectedLLMs: string[] = Array.isArray(item.selectedLLMs) ? item.selectedLLMs : [];
      if (!selectedLLMs.some((v) => deadValues.includes(v))) continue;

      found++;
      const { fixed } = fixSelectedLLMs(selectedLLMs);
      const key = { [spec.keyName]: item[spec.keyName] };
      const label = `${spec.table} ${spec.keyName}=${item[spec.keyName]} (${item.name || 'unnamed'})`;

      if (!APPLY) {
        console.log(`[dry-run] would fix: ${label}`);
        console.log(`  before: ${JSON.stringify(selectedLLMs)}`);
        console.log(`  after:  ${JSON.stringify(fixed)}`);
        continue;
      }

      try {
        await doc
          .update({
            TableName: spec.table,
            Key: key,
            // Idempotent guard: only writes if the stored list still
            // contains what we read (nobody else changed it since the scan).
            ConditionExpression: 'selectedLLMs = :before',
            UpdateExpression: 'SET selectedLLMs = :after',
            ExpressionAttributeValues: { ':before': selectedLLMs, ':after': fixed },
          })
          .promise();
        updated++;
        console.log(`[applied] fixed: ${label}`);
      } catch (err) {
        if ((err as { code?: string }).code === 'ConditionalCheckFailedException') {
          skipped++; // row changed since scan (already fixed, or edited concurrently) - safe to skip
        } else {
          throw err;
        }
      }
    }
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);

  return { found, updated, skipped };
}

async function main(): Promise<void> {
  console.log(`Mode: ${APPLY ? 'APPLY' : 'dry-run'} | Table prefix: "${TABLE_PREFIX}" (NODE_ENV=${process.env.NODE_ENV || 'production'})`);

  const summary: Record<string, { found: number; updated: number; skipped: number }> = {};
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
  console.error('[backfill-eng812-selectedllms-retired-gemini] failed:', e);
  process.exit(1);
});
