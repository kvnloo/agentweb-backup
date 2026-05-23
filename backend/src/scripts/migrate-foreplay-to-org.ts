/**
 * One-shot migration: promote per-user Foreplay tokens to org-level storage.
 *
 * For each User with `secrets.foreplay_api_token` and an `orgId`:
 *   - If the org already has `secrets.foreplay_api_token`: leave it (admin's wins).
 *   - Otherwise: copy the user's encrypted token to the org record.
 *
 * Idempotent: safe to re-run. Org-level tokens are never overwritten.
 * Per-user tokens are left intact (they serve as a fallback until an admin
 * explicitly disconnects and reconnects at the org level).
 *
 * DO NOT run this in tests — it talks to real DynamoDB.
 *
 * Usage:
 *   NODE_ENV=development npx ts-node src/scripts/migrate-foreplay-to-org.ts
 *   NODE_ENV=production  npx ts-node src/scripts/migrate-foreplay-to-org.ts --dry-run
 */

import AWS from 'aws-sdk';

const TABLE_PREFIX = process.env.NODE_ENV === 'production' ? '' : 'Dev-';
const USERS_TABLE = `${TABLE_PREFIX}AW-Users`;
const ORGS_TABLE = `${TABLE_PREFIX}AW-Organizations`;

const isDryRun = process.argv.includes('--dry-run');

const dynamodb = new AWS.DynamoDB.DocumentClient({
  region: process.env.AWS_REGION || 'us-west-2',
});

async function scanAllUsers(): Promise<any[]> {
  const items: any[] = [];
  let lastKey: AWS.DynamoDB.DocumentClient.Key | undefined;
  do {
    const result = await dynamodb.scan({
      TableName: USERS_TABLE,
      FilterExpression:
        'attribute_exists(#secrets) AND attribute_exists(#secrets.#key) AND attribute_exists(#orgId)',
      ExpressionAttributeNames: {
        '#secrets': 'secrets',
        '#key': 'foreplay_api_token',
        '#orgId': 'orgId',
      },
      ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
    }).promise();
    items.push(...(result.Items || []));
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

async function getOrgSecrets(orgId: string): Promise<Record<string, string> | undefined> {
  const result = await dynamodb.get({
    TableName: ORGS_TABLE,
    Key: { orgId },
    ProjectionExpression: 'secrets',
  }).promise();
  return (result.Item as any)?.secrets;
}

async function setOrgForeplayToken(orgId: string, encryptedToken: string): Promise<void> {
  // Attempt to update assuming secrets map already exists
  try {
    await dynamodb.update({
      TableName: ORGS_TABLE,
      Key: { orgId },
      UpdateExpression: 'SET #secrets.#key = :val, #updatedAt = :updatedAt',
      ExpressionAttributeNames: {
        '#secrets': 'secrets',
        '#key': 'foreplay_api_token',
        '#updatedAt': 'updatedAt',
      },
      ExpressionAttributeValues: {
        ':val': encryptedToken,
        ':updatedAt': new Date().toISOString(),
      },
      ConditionExpression: 'attribute_exists(#secrets)',
    }).promise();
  } catch (err: any) {
    if (err.code === 'ConditionalCheckFailedException') {
      // secrets map doesn't exist yet — initialise it
      await dynamodb.update({
        TableName: ORGS_TABLE,
        Key: { orgId },
        UpdateExpression: 'SET #secrets = :secretsMap, #updatedAt = :updatedAt',
        ExpressionAttributeNames: {
          '#secrets': 'secrets',
          '#updatedAt': 'updatedAt',
        },
        ExpressionAttributeValues: {
          ':secretsMap': { foreplay_api_token: encryptedToken },
          ':updatedAt': new Date().toISOString(),
        },
      }).promise();
    } else {
      throw err;
    }
  }
}

async function main(): Promise<void> {
  console.log(`[migrate-foreplay-to-org] Starting (${isDryRun ? 'DRY RUN' : 'LIVE'}, env=${process.env.NODE_ENV || 'development'})`);

  const users = await scanAllUsers();
  console.log(`[migrate-foreplay-to-org] Found ${users.length} user(s) with Foreplay token and orgId`);

  const promotedOrgs = new Set<string>();
  let promoted = 0;
  let skipped = 0;

  for (const user of users) {
    const { userId, orgId, secrets } = user;
    const encryptedToken: string | undefined = secrets?.foreplay_api_token;
    if (!encryptedToken || !orgId) continue;

    // Check if org already has a token (idempotency + admin-wins rule)
    const orgSecrets = await getOrgSecrets(orgId);
    if (orgSecrets?.foreplay_api_token) {
      console.log(`  SKIP  userId=${userId} orgId=${orgId} — org already has a token`);
      skipped++;
      continue;
    }

    // Promote only once per org (first eligible user wins)
    if (promotedOrgs.has(orgId)) {
      console.log(`  SKIP  userId=${userId} orgId=${orgId} — already promoted by another user in this run`);
      skipped++;
      continue;
    }

    console.log(`  ${isDryRun ? '[DRY]' : ''} PROMOTE userId=${userId} → orgId=${orgId}`);

    if (!isDryRun) {
      await setOrgForeplayToken(orgId, encryptedToken);
      promotedOrgs.add(orgId);
    }
    promoted++;
  }

  console.log(`[migrate-foreplay-to-org] Done. promoted=${promoted} skipped=${skipped}`);
}

main().catch((err) => {
  console.error('[migrate-foreplay-to-org] Fatal error:', err);
  process.exit(1);
});
