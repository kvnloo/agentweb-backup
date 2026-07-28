import { DynamoDB } from "aws-sdk";
import type { Organization } from "../services/db";

// Backfills Organization.memberCount for orgs created before this field
// existed. New orgs are seeded with memberCount at creation time; existing
// members joining/leaving already atomically maintain it going forward (see
// userDb.joinOrgWithCapacityCheck / userDb.clearOrgMembership) — this script
// only needs to run once to give pre-existing orgs an accurate starting
// value. Safe to re-run: skips any org that already has memberCount set.

const TABLE_PREFIX = process.env.NODE_ENV === "production" ? "" : "Dev-";
const ORGS_TABLE = `${TABLE_PREFIX}AW-Organizations`;
const USERS_TABLE = `${TABLE_PREFIX}AW-Users`;

async function getRealMemberCount(ddb: DynamoDB.DocumentClient, orgId: string): Promise<number> {
  let total = 0;
  let lek: any | undefined;
  do {
    const result = await ddb
      .query({
        TableName: USERS_TABLE,
        IndexName: "OrgIdIndex",
        KeyConditionExpression: "orgId = :orgId",
        FilterExpression: "NOT begins_with(userId, :tombstone)",
        ExpressionAttributeValues: { ":orgId": orgId, ":tombstone": "deleted_" },
        Select: "COUNT",
        ...(lek ? { ExclusiveStartKey: lek } : {}),
      })
      .promise();
    total += result.Count || 0;
    lek = result.LastEvaluatedKey;
  } while (lek);
  return total;
}

export async function runBackfill(): Promise<void> {
  const ddb = new DynamoDB.DocumentClient({ region: process.env.AWS_REGION || "us-west-2" });
  let lek: any | undefined;
  do {
    const page = await ddb.scan({
      TableName: ORGS_TABLE,
      ...(lek ? { ExclusiveStartKey: lek } : {}),
    }).promise();

    for (const item of page.Items || []) {
      const org = item as Organization;
      if (org.memberCount !== undefined) continue;

      const realCount = await getRealMemberCount(ddb, org.orgId);
      await ddb
        .update({
          TableName: ORGS_TABLE,
          Key: { orgId: org.orgId },
          UpdateExpression: "SET memberCount = :count, updatedAt = :now",
          ExpressionAttributeValues: { ":count": realCount, ":now": new Date().toISOString() },
        })
        .promise();
      console.log(`Backfilled org ${org.orgId}: memberCount = ${realCount}`);
    }
    lek = page.LastEvaluatedKey;
  } while (lek);
}

if (require.main === module) {
  runBackfill().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
}
