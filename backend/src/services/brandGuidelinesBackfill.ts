import { DynamoDB } from 'aws-sdk';
import { planBrandGuidelinesPopulation, applyBrandGuidelinesPopulation } from './brandGuidelinesPopulation';

/** Scan and optionally fill missing brand fields. Dry-run unless args contains --apply. */
export async function runBrandGuidelinesBackfill(args: string[], nodeEnv = process.env.NODE_ENV) {
  if (args.some(arg => arg !== '--apply')) throw new Error('Only --apply is supported; default is DRY-RUN');
  const apply = args.includes('--apply');
  if (!['development', 'production'].includes(nodeEnv || '')) {
    throw new Error('Set NODE_ENV explicitly to development or production');
  }
  const db = new DynamoDB.DocumentClient();
  const table = `${nodeEnv === 'development' ? 'Dev-' : ''}AW-Users`;
  console.log(`${apply ? 'APPLY' : 'DRY-RUN'}: ${table}`);
  let cursor: DynamoDB.DocumentClient.Key | undefined;
  let failures = 0;
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
      const plan = await planBrandGuidelinesPopulation(userId);
      await applyBrandGuidelinesPopulation(plan);
      console.log(JSON.stringify({ applied: userId, fields: plan.filledFields }));
    }
  }
  if (failures) throw new Error(`${failures} accounts could not be inspected`);
  console.log(`${targets.size} distinct owners with fillable fields; ${apply ? 'applied' : 'no writes performed'}`);
}
