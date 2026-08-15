/**
 * Reset specified billing accounts' policy-visible usage to zero for the
 * one-time cost-policy rollout without erasing provider-cost history. Default
 * is dry-run; --apply is a production data-plane operation.
 *
 *   NODE_ENV=development npx ts-node src/scripts/resetLlmUsageForPolicyRollout.ts --billing-user-id=<id>
 *   NODE_ENV=development npx ts-node src/scripts/resetLlmUsageForPolicyRollout.ts --billing-user-ids-file=./users.txt --apply
 */
import fs from 'fs';
import AWS from 'aws-sdk';

// Keep the SDK's default provider chain intact: environment credentials,
// shared profiles, workload identity, and instance roles remain available.
AWS.config.update({ region: process.env.AWS_REGION || 'us-west-2' });

const apply = process.argv.includes('--apply');
const allBillingUsers = process.argv.includes('--all-billing-users');

function readTargetBillingUserIds(): string[] {
  const direct = process.argv
    .filter((arg) => arg.startsWith('--billing-user-id='))
    .map((arg) => arg.slice('--billing-user-id='.length).trim());
  const fileArg = process.argv.find((arg) => arg.startsWith('--billing-user-ids-file='));
  const fromFile = fileArg
    ? fs.readFileSync(fileArg.slice('--billing-user-ids-file='.length), 'utf8').split(/[\n,]/).map((id) => id.trim())
    : [];
  return [...new Set([...direct, ...fromFile].filter(Boolean))];
}

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
  const requestedBillingUserIds = readTargetBillingUserIds();
  if (allBillingUsers && !process.argv.includes('--confirm-all-billing-users')) {
    throw new Error('--all-billing-users requires --confirm-all-billing-users');
  }
  if (!allBillingUsers && requestedBillingUserIds.length === 0) {
    throw new Error('Pass a billing user target or --all-billing-users --confirm-all-billing-users');
  }
  const billingUsers = new Set<string>();
  let inspected = 0;

  const requestedIds = allBillingUsers
    ? (await userDb.getAllUsers()).map((user) => String(user.userId))
    : requestedBillingUserIds;
  for (const requestedBillingUserId of requestedIds) {
    const canonicalBillingUserId = await resolveBillingUserId(requestedBillingUserId);
    const target = await userDb.getUserById(canonicalBillingUserId);
    if (target && !String(target.userId).startsWith('deleted_')) {
      billingUsers.add(canonicalBillingUserId);
      inspected++;
    }
  }

  const summary = { inspected, billingUsers: billingUsers.size, eligible: 0, granted: 0, idempotent: 0, skipped: 0 };
  for (const billingUserId of billingUsers) {
    const billingUser = await userDb.getUserById(billingUserId);
    if (!billingUser) {
      summary.skipped++;
      continue;
    }
    const subscriptionType = await getUserSubscriptionType(billingUserId);
    const policy = (await getSubscriptionTypeConfig(subscriptionType))?.llmUsagePolicy;
    const plan = planRolloutUsageReset({
      usageMonth: billingUser.tokenUsage?.month,
      rawCostUsedUsd: billingUser.tokenUsage?.totalCost,
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
    mode: apply ? 'apply' : 'dry-run', currentMonth,
    targets: allBillingUsers ? 'all billing users' : requestedBillingUserIds, summary,
  }, null, 2));
}

main().catch((error) => {
  console.error('[resetLlmUsageForPolicyRollout] failed', error);
  process.exit(1);
});
