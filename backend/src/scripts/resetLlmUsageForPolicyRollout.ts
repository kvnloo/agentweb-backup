/**
 * Reset every current billing account's policy-visible usage to zero for the
 * one-time cost-policy rollout without erasing provider-cost history. Default
 * is dry-run; --apply is a production data-plane operation.
 *
 *   NODE_ENV=development npx ts-node src/scripts/resetLlmUsageForPolicyRollout.ts
 *   NODE_ENV=development npx ts-node src/scripts/resetLlmUsageForPolicyRollout.ts --apply
 */
import AWS, { DynamoDB } from 'aws-sdk';

// Configure credentials before dynamically loading service modules, several of
// which construct DynamoDB clients at import time. Production uses environment
// or instance-role credentials; local dry-runs may use the standard AWS profile.
if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
  AWS.config.credentials = new AWS.SharedIniFileCredentials({
    profile: process.env.AWS_PROFILE || 'default',
  });
}
AWS.config.update({ region: process.env.AWS_REGION || 'us-west-2' });

const doc = new DynamoDB.DocumentClient();
const tablePrefix = process.env.NODE_ENV === 'development' ? 'Dev-' : '';
const tableName = `${tablePrefix}AW-Users`;
const apply = process.argv.includes('--apply');
const requestedBillingUserId = process.argv
  .find((arg) => arg.startsWith('--billing-user-id='))
  ?.slice('--billing-user-id='.length)
  .trim() || null;

async function main() {
  const { getSubscriptionTypeConfig, getUserSubscriptionType } = await import('../services/subscriptionService');
  const { resolveBillingUserId } = await import('../services/tokenUsageService');
  const { userDb } = await import('../services/db');
  const {
    getCurrentUsageMonth,
    grantMonthlyLlmUsageCredit,
    planRolloutUsageReset,
  } = await import('../services/llmUsageCreditService');
  const currentMonth = getCurrentUsageMonth();
  const billingUsers = new Set<string>();
  let lastKey: DynamoDB.DocumentClient.Key | undefined;
  let scanned = 0;

  if (requestedBillingUserId) {
    // The targeted mode is used for a bounded pre-production proof. Avoid a
    // full-table scan and require the caller to pass the canonical billing ID.
    const target = await userDb.getUserById(requestedBillingUserId);
    if (target && !String(target.userId).startsWith('deleted_')) {
      billingUsers.add(requestedBillingUserId);
      scanned = 1;
    }
  } else {
    do {
      const page = await doc.scan({ TableName: tableName, ExclusiveStartKey: lastKey }).promise();
      for (const user of page.Items || []) {
        scanned++;
        if (!user.userId || String(user.userId).startsWith('deleted_')) continue;
        billingUsers.add(await resolveBillingUserId(user.userId));
      }
      lastKey = page.LastEvaluatedKey;
    } while (lastKey);
  }

  const summary = { scanned, billingUsers: billingUsers.size, eligible: 0, granted: 0, idempotent: 0, skipped: 0 };
  for (const billingUserId of billingUsers) {
    const scannedUser = await userDb.getUserById(billingUserId);
    if (!scannedUser) {
      summary.skipped++;
      continue;
    }
    const subscriptionType = await getUserSubscriptionType(billingUserId);
    const policy = (await getSubscriptionTypeConfig(subscriptionType))?.llmUsagePolicy;
    const plan = planRolloutUsageReset({
      usageMonth: scannedUser.tokenUsage?.month,
      rawCostUsedUsd: scannedUser.tokenUsage?.totalCost,
      currentMonth,
      policyVersion: policy?.version,
    });
    if (plan.action === 'skip') {
      summary.skipped++;
      continue;
    }
    summary.eligible++;
    const grantId = `${billingUserId}:${plan.grantIdSuffix}`;
    console.log(`${apply ? '[apply]' : '[dry-run]'} ${billingUserId} (${subscriptionType}) reset=${plan.amountMicroUsd}µUSD -> policy usage $0`);
    if (!apply) continue;
    const result = await grantMonthlyLlmUsageCredit({
      billingUserId,
      grantId,
      source: 'migration',
      amountMicroUsd: plan.amountMicroUsd,
    });
    if (result.granted) summary.granted++;
    else summary.idempotent++;
  }
  console.log(JSON.stringify({
    mode: apply ? 'apply' : 'dry-run', tableName, currentMonth,
    target: requestedBillingUserId || 'all-billing-users', summary,
  }, null, 2));
}

main().catch((error) => {
  console.error('[resetLlmUsageForPolicyRollout] failed', error);
  process.exit(1);
});
