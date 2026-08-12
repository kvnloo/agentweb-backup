/**
 * Backfill a system-selected optimized backup on existing scheduled chats.
 *
 * Default is dry-run. Apply only after the versioned tier policies have been
 * saved and verified in the same environment:
 *   NODE_ENV=development npx ts-node src/scripts/backfillScheduledChatModelBackups.ts
 *   NODE_ENV=development npx ts-node src/scripts/backfillScheduledChatModelBackups.ts --apply
 *
 * The conditional update is idempotent and will never overwrite a backup that
 * a user or another process selected after the scan.
 */
import { DynamoDB } from 'aws-sdk';
import { agentModeService } from '../services/agentModeService';
import { getSubscriptionTypeConfig, getUserSubscriptionType } from '../services/subscriptionService';
import { planScheduleBackupBackfill } from '../services/scheduledChatBackupBackfillService';

const doc = new DynamoDB.DocumentClient({ region: process.env.AWS_REGION || 'us-west-2' });
const tablePrefix = process.env.NODE_ENV === 'development' ? 'Dev-' : '';
const tableName = `${tablePrefix}AW-TaskSchedules`;
const apply = process.argv.includes('--apply');

async function main() {
  const supportedModelIds = await agentModeService.getSupportedModels(false);
  let lastKey: DynamoDB.DocumentClient.Key | undefined;
  const summary = { scanned: 0, eligible: 0, updated: 0, raced: 0, skipped: 0 };

  do {
    const page = await doc.scan({ TableName: tableName, ExclusiveStartKey: lastKey }).promise();
    for (const schedule of page.Items || []) {
      summary.scanned++;
      if (
        schedule.type !== 'scheduled_chat' ||
        (typeof schedule.llmBackupModel === 'string' && schedule.llmBackupModel.trim())
      ) {
        summary.skipped++;
        continue;
      }
      const subscriptionType = await getUserSubscriptionType(schedule.userId);
      const config = await getSubscriptionTypeConfig(subscriptionType);
      const plan = planScheduleBackupBackfill({
        schedule,
        policy: config?.llmUsagePolicy,
        supportedModelIds,
      });
      if (plan.action === 'skip') {
        summary.skipped++;
        continue;
      }
      summary.eligible++;
      console.log(`${apply ? '[apply]' : '[dry-run]'} ${schedule.scheduleId} (${subscriptionType}) -> ${plan.llmBackupModel}`);
      if (!apply) continue;

      try {
        const now = new Date().toISOString();
        await doc.update({
          TableName: tableName,
          Key: { scheduleId: schedule.scheduleId },
          ConditionExpression: '#type = :scheduledChat AND (attribute_not_exists(#backup) OR #backup = :empty)',
          UpdateExpression: 'SET #backup = :model, #source = :source, #needs = :needs, #policyVersion = :policyVersion, #backfilledAt = :now, #updatedAt = :now',
          ExpressionAttributeNames: {
            '#type': 'type', '#backup': 'llmBackupModel', '#source': 'llmBackupSource',
            '#needs': 'llmBackupNeedsConfirmation', '#policyVersion': 'llmBackupPolicyVersion',
            '#backfilledAt': 'llmBackupBackfilledAt', '#updatedAt': 'updatedAt',
          },
          ExpressionAttributeValues: {
            ':scheduledChat': 'scheduled_chat', ':empty': '', ':model': plan.llmBackupModel,
            ':source': plan.llmBackupSource, ':needs': plan.llmBackupNeedsConfirmation,
            ':policyVersion': plan.usagePolicyVersion, ':now': now,
          },
        }).promise();
        summary.updated++;
      } catch (error: any) {
        if (error?.code === 'ConditionalCheckFailedException') summary.raced++;
        else throw error;
      }
    }
    lastKey = page.LastEvaluatedKey;
  } while (lastKey);

  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', tableName, summary }, null, 2));
}

main().catch((error) => {
  console.error('[backfillScheduledChatModelBackups] failed', error);
  process.exit(1);
});
