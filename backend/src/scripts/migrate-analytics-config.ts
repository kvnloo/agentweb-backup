/**
 * One-time migration: copy each org owner's analytics config onto the
 * Organization record. Idempotent. Run AFTER the Phase 1 backend deploy.
 *
 *   Dry run:  NODE_ENV=production npx ts-node src/scripts/migrate-analytics-config.ts --dry-run
 *   Apply:    NODE_ENV=production npx ts-node src/scripts/migrate-analytics-config.ts
 */
import { DynamoDB } from "aws-sdk";
import { migrateOrg } from "../services/analyticsConfigMigration";
import { userDb } from "../services/db";

const DRY_RUN = process.argv.includes("--dry-run");
// Mirror db.ts exactly so this script and userDb always target the same env's tables.
const TABLE_PREFIX = process.env.NODE_ENV === "development" ? "Dev-" : "";
const ORGS_TABLE = `${TABLE_PREFIX}AW-Organizations`;
const dynamodb = new DynamoDB.DocumentClient({ region: process.env.AWS_REGION || "us-west-2" });

async function run(): Promise<void> {
  console.log(`[migrate-analytics-config] table=${ORGS_TABLE} dryRun=${DRY_RUN}`);
  let lastKey: DynamoDB.DocumentClient.Key | undefined = undefined;
  let scanned = 0, changed = 0, skipped = 0;

  do {
    const page = await dynamodb
      .scan({ TableName: ORGS_TABLE, ...(lastKey ? { ExclusiveStartKey: lastKey } : {}) })
      .promise();

    for (const item of page.Items || []) {
      scanned++;
      const owner = item.ownerUserId ? await userDb.getUserById(item.ownerUserId as string) : null;
      const updates = migrateOrg(item as any, owner);
      if (!updates) {
        skipped++;
        continue;
      }

      changed++;
      console.log(`[org ${item.orgId as string}] ${Object.keys(updates).join(", ")}`);

      if (!DRY_RUN) {
        const names: Record<string, string> = {};
        const values: Record<string, any> = {};
        const sets: string[] = [];

        for (const [k, v] of Object.entries(updates)) {
          names[`#${k}`] = k;
          values[`:${k}`] = v;
          sets.push(`#${k} = :${k}`);
        }
        names["#u"] = "updatedAt";
        values[":u"] = new Date().toISOString();
        sets.push("#u = :u");

        await dynamodb
          .update({
            TableName: ORGS_TABLE,
            Key: { orgId: item.orgId },
            UpdateExpression: `SET ${sets.join(", ")}`,
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: values,
          })
          .promise();
      }
    }

    lastKey = page.LastEvaluatedKey;
  } while (lastKey);

  console.log(
    `[migrate-analytics-config] done — scanned=${scanned} changed=${changed} skipped=${skipped}`,
  );
}

if (require.main === module) {
  run().catch((e) => {
    console.error("Migration failed:", e);
    process.exit(1);
  });
}

export { run as runMigration };
