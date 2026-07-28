import { DynamoDB } from "aws-sdk";
import type { Organization } from "../services/db";

// ENG-512 default-on change: auto-join is opt-out going forward (new orgs are
// seeded with autoJoinEnabled: true, see routes/org.ts create handler). This
// backfills existing orgs created before that change, which have no
// autoJoinEnabled field at all. Per-request owner approval is unaffected —
// this only flips the default an org starts from.

const TABLE_PREFIX = process.env.NODE_ENV === "production" ? "" : "Dev-";
const ORGS_TABLE = `${TABLE_PREFIX}AW-Organizations`;
const USERS_TABLE = `${TABLE_PREFIX}AW-Users`;

function deriveDomainFromEmail(email: string): string | undefined {
  return email.split("@")[1]?.toLowerCase() || undefined;
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
      if (org.autoJoinEnabled !== undefined) continue;

      const ownerResult = await ddb.query({
        TableName: USERS_TABLE,
        IndexName: "UserIdIndex",
        KeyConditionExpression: "userId = :uid",
        ExpressionAttributeValues: { ":uid": org.ownerUserId },
      }).promise();
      const owner = (ownerResult.Items || [])[0] as { email?: string } | undefined;
      const domain = owner?.email ? deriveDomainFromEmail(owner.email) : undefined;

      await ddb.update({
        TableName: ORGS_TABLE,
        Key: { orgId: org.orgId },
        UpdateExpression: "SET autoJoinEnabled = :e, autoJoinDomain = :d, updatedAt = :u",
        ExpressionAttributeValues: {
          ":e": true,
          ":d": domain,
          ":u": new Date().toISOString(),
        },
      }).promise();
      console.log("Backfilled org:", org.orgId, "domain:", domain ?? "(none — owner email had no domain)");
    }
    lek = page.LastEvaluatedKey;
  } while (lek);
}

if (require.main === module) {
  runBackfill().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
}
