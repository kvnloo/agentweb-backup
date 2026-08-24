/**
 * Backfill a system-selected optimized backup on existing scheduled chats.
 *
 * Default is dry-run. Apply only after the versioned tier policies have been
 * saved and verified in the same environment:
 *   NODE_ENV=development npx ts-node src/scripts/backfillScheduledChatModelBackups.ts --user-id=<id>
 *   NODE_ENV=development npx ts-node src/scripts/backfillScheduledChatModelBackups.ts --user-ids-file=./users.txt --apply
 *
 * The conditional update is idempotent and will never overwrite a backup that
 * a user or another process selected after the query.
 */
import fs from 'fs';
import { DynamoDB } from 'aws-sdk';
import { agentModeService } from '../services/agentModeService';
import { getSubscriptionTypeConfig, getUserSubscriptionType } from '../services/subscriptionService';
import { planScheduleBackupBackfill } from '../services/scheduledChatBackupBackfillService';

const doc = new DynamoDB.DocumentClient({ region: process.env.AWS_REGION || 'us-west-2' });
const tablePrefix = process.env.NODE_ENV === 'development' ? 'Dev-' : '';
const tableName = `${tablePrefix}AW-TaskSchedules`;
const apply = process.argv.includes('--apply');

function readTargetUserIds(): string[] {
  const direct = process.argv
    .filter((arg) => arg.startsWith('--user-id='))
    .map((arg) => arg.slice('--user-id='.length).trim());
  const fileArg = process.argv.find((arg) => arg.startsWith('--user-ids-file='));
  const fromFile = fileArg
    ? fs.readFileSync(fileArg.slice('--user-ids-file='.length), 'utf8').split(/[\n,]/).map((id) => id.trim())
    : [];
  return [...new Set([...direct, ...fromFile].filter(Boolean))];
}

async function main() {
  const userIds = readTargetUserIds();
  if (userIds.length === 0) {
    throw new Error('Pass at least one --user-id=<id> or --user-ids-file=<path>; unrestricted scans are forbidden');
  }
  const supportedModelIds = await agentModeService.getSupportedModels(false);
  const summary = { users: userIds.length, queried: 0, eligible: 0, updated: 0, raced: 0, skipped: 0 };

  for (const userId of userIds) {
    let lastKey: DynamoDB.DocumentClient.Key | undefined;
    do {
      const page = await doc.query({
        TableName: tableName,
        IndexName: 'UserIdIndex',
        KeyConditionExpression: '#userId = :userId',
        ExpressionAttributeNames: { '#userId': 'userId' },
        ExpressionAttributeValues: { ':userId': userId },
        ExclusiveStartKey: lastKey,
      }).promise();
      for (const schedule of page.Items || []) {
        summary.queried++;
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
  }

  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', tableName, summary }, null, 2));
}

main().catch((error) => {
  console.error('[backfillScheduledChatModelBackups] failed', error);
  process.exit(1);
});
