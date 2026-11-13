/**
 * One-shot migration: promote per-user ClickUp tokens to org-level storage.
 *
 * For each User with `secrets.clickup_access_token` and an `orgId`:
 *   - If the org already has `secrets.clickup_access_token`: leave it (admin's wins).
 *   - Otherwise: copy the user's encrypted token to the org record.
 *
 * When several members of one org have a personal token, the org owner's wins;
 * otherwise the first one found. Pass --org-id=<orgId> to touch a single org
 * (e.g. XCures: 3583d005-434b-449f-901d-1b250452d19d).
 *
 * Idempotent: safe to re-run. Org-level tokens are never overwritten (the write
 * itself is conditional on the key being absent, so a concurrent admin connect
 * cannot be clobbered).
 * Per-user tokens are left intact (they serve as a fallback until an admin
 * explicitly disconnects and reconnects at the org level).
 *
 * DO NOT run this in tests — it talks to real DynamoDB.
 *
 * Usage:
 *   NODE_ENV=development npx ts-node src/scripts/migrate-clickup-to-org.ts
 *   NODE_ENV=production  npx ts-node src/scripts/migrate-clickup-to-org.ts --dry-run
 *   NODE_ENV=production  npx ts-node src/scripts/migrate-clickup-to-org.ts --org-id=<orgId> --dry-run
 */

import AWS from 'aws-sdk';

const TABLE_PREFIX = process.env.NODE_ENV === 'production' ? '' : 'Dev-';
const USERS_TABLE = `${TABLE_PREFIX}AW-Users`;
const ORGS_TABLE = `${TABLE_PREFIX}AW-Organizations`;

const isDryRun = process.argv.includes('--dry-run');
const orgIdArg = process.argv.find((a) => a.startsWith('--org-id='))?.slice('--org-id='.length);
if (process.argv.some((a) => a.startsWith('--org-id')) && !orgIdArg) {
  console.error('[migrate-clickup-to-org] --org-id requires a value: --org-id=<orgId>');
  process.exit(1);
}

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
        'attribute_exists(#secrets) AND attribute_exists(#secrets.#key) AND attribute_exists(#orgId)' +
        (orgIdArg ? ' AND #orgId = :orgId' : ''),
      ExpressionAttributeNames: {
        '#secrets': 'secrets',
        '#key': 'clickup_access_token',
        '#orgId': 'orgId',
      },
      ...(orgIdArg ? { ExpressionAttributeValues: { ':orgId': orgIdArg } } : {}),
      ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
    }).promise();
    items.push(...(result.Items || []));
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

async function getOrg(orgId: string): Promise<{ ownerUserId?: string; secrets?: Record<string, string> } | undefined> {
  const result = await dynamodb.get({
    TableName: ORGS_TABLE,
    Key: { orgId },
    ProjectionExpression: 'ownerUserId, secrets',
  }).promise();
  return result.Item as any;
}

async function setOrgClickUpToken(orgId: string, encryptedToken: string): Promise<void> {
  // Attempt to update assuming secrets map already exists
  try {
    await dynamodb.update({
      TableName: ORGS_TABLE,
      Key: { orgId },
      UpdateExpression: 'SET #secrets.#key = :val, #updatedAt = :updatedAt',
      ExpressionAttributeNames: {
        '#secrets': 'secrets',
        '#key': 'clickup_access_token',
        '#updatedAt': 'updatedAt',
      },
      ExpressionAttributeValues: {
        ':val': encryptedToken,
        ':updatedAt': new Date().toISOString(),
      },
      ConditionExpression: 'attribute_exists(#secrets) AND attribute_not_exists(#secrets.#key)',
    }).promise();
  } catch (err: any) {
    if (err.code === 'ConditionalCheckFailedException') {
      // Either a token appeared concurrently (leave it) or the secrets map is missing.
      const current = await getOrg(orgId);
      if (current?.secrets?.clickup_access_token) return;
      await dynamodb.update({
        TableName: ORGS_TABLE,
        Key: { orgId },
        UpdateExpression: 'SET #secrets = :secretsMap, #updatedAt = :updatedAt',
        ExpressionAttributeNames: {
          '#secrets': 'secrets',
          '#updatedAt': 'updatedAt',
        },
        ExpressionAttributeValues: {
          ':secretsMap': { clickup_access_token: encryptedToken },
          ':updatedAt': new Date().toISOString(),
        },
        ConditionExpression: 'attribute_not_exists(#secrets)',
      }).promise();
    } else {
      throw err;
    }
  }
}

async function main(): Promise<void> {
  console.log(`[migrate-clickup-to-org] Starting (${isDryRun ? 'DRY RUN' : 'LIVE'}, env=${process.env.NODE_ENV || 'development'})`);

  const users = await scanAllUsers();
  console.log(`[migrate-clickup-to-org] Found ${users.length} user(s) with ClickUp token and orgId`);

  const usersByOrg = new Map<string, any[]>();
  for (const user of users) {
    if (!user.orgId || !user.secrets?.clickup_access_token) continue;
    usersByOrg.set(user.orgId, [...(usersByOrg.get(user.orgId) || []), user]);
  }

  let promoted = 0;
  let skipped = 0;

  for (const [orgId, orgUsers] of usersByOrg) {
    // Idempotency + admin-wins rule: never replace an existing org token
    const org = await getOrg(orgId);
    if (org?.secrets?.clickup_access_token) {
      console.log(`  SKIP  orgId=${orgId} — org already has a token (${orgUsers.length} personal token(s) ignored)`);
      skipped += orgUsers.length;
      continue;
    }

    const chosen = orgUsers.find((u) => u.userId === org?.ownerUserId) || orgUsers[0];
    console.log(
      `  ${isDryRun ? '[DRY] ' : ''}PROMOTE userId=${chosen.userId}${chosen.userId === org?.ownerUserId ? ' (owner)' : ''} → orgId=${orgId}`
    );
    skipped += orgUsers.length - 1;

    if (!isDryRun) {
      await setOrgClickUpToken(orgId, chosen.secrets.clickup_access_token);
    }
    promoted++;
  }

  console.log(`[migrate-clickup-to-org] Done. promoted=${promoted} skipped=${skipped}`);
}

main().catch((err) => {
  console.error('[migrate-clickup-to-org] Fatal error:', err);
  process.exit(1);
});
