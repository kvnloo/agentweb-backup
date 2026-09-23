/**
 * DRY-RUN by default. Harsha approval is required before merge and before --apply.
 * From backend: NODE_ENV=production npx ts-node --transpile-only scripts/backfill-brand-guidelines.ts
 * Add --apply only after approval. NODE_ENV=development selects Dev-* tables.
 * Lists every user account with any empty core field, including accounts with
 * no derivable values. Does not read arbitrary KB prose or invent missing copy.
 * Re-read/conditional writes preserve concurrent edits, founders and attachments.
 */
import 'dotenv/config';
import { DynamoDB } from 'aws-sdk';
import { planBrandGuidelinesPopulation, applyBrandGuidelinesPopulation } from '../src/services/brandGuidelinesPopulation';

async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--apply')) throw new Error('Only --apply is supported; default is DRY-RUN');
  const apply = args.includes('--apply');
  if (!['development', 'production'].includes(process.env.NODE_ENV || '')) {
    throw new Error('Set NODE_ENV explicitly to development or production');
  }
  const db = new DynamoDB.DocumentClient();
  const table = `${process.env.NODE_ENV === 'development' ? 'Dev-' : ''}AW-Users`;
  console.log(`${apply ? 'APPLY' : 'DRY-RUN'}: ${table}`);
  let cursor: DynamoDB.DocumentClient.Key | undefined;
  let failures = 0;
  // Two passes keep the report complete even when accounts share an org/owner.
  const targets = new Set<string>();
  do {
    const page = await db.scan({ TableName: table, ExclusiveStartKey: cursor,
      ProjectionExpression: 'userId',
      FilterExpression: 'NOT begins_with(userId, :deleted)',
      ExpressionAttributeValues: { ':deleted': 'deleted_' } }).promise();
    for (const account of page.Items || []) {
      try {
        if (typeof account.userId !== 'string') throw new Error('Missing userId');
        const plan = await planBrandGuidelinesPopulation(account.userId);
        if (!plan.emptyFields.length) continue;
        console.log(JSON.stringify({ userId: account.userId,
          target: plan.orgId || plan.userId, emptyFields: plan.emptyFields, fillableFields: plan.filledFields }));
        if (plan.filledFields.length) targets.add(plan.userId);
      } catch (error) {
        failures++;
        console.error('Inspection failed', account.userId, error);
      }
    }
    cursor = page.LastEvaluatedKey;
  } while (cursor);
  if (apply && failures) throw new Error(`Inspection failed for ${failures} accounts; no writes performed`);
  if (apply) {
    for (const userId of targets) {
      // Fresh plan just before each write; conflict/error aborts, never retries stale data.
      const plan = await planBrandGuidelinesPopulation(userId);
      await applyBrandGuidelinesPopulation(plan);
      console.log(JSON.stringify({ applied: userId, fields: plan.filledFields }));
    }
  }
  if (failures) throw new Error(`${failures} accounts could not be inspected`);
  console.log(`${targets.size} distinct owners with fillable fields; ${apply ? 'applied' : 'no writes performed'}`);
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
