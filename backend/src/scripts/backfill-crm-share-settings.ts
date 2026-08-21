/**
 * ENG-686 backfill: add crm: { enabled: true, editors: [] } to the shareSettings
 * of every org that already has a shareSettings object but is missing the crm key.
 *
 * Orgs with NO shareSettings at all are handled by migrate-org-share-settings.ts
 * (which now includes crm in its defaults via defaultShareSettings()).
 *
 * Usage:
 *   # dry run (default — prints what would change, writes nothing)
 *   NODE_ENV=production npx ts-node src/scripts/backfill-crm-share-settings.ts
 *
 *   # live run
 *   NODE_ENV=production DRY_RUN=false npx ts-node src/scripts/backfill-crm-share-settings.ts
 */
import { DynamoDB } from "aws-sdk";
import type { Organization } from "../services/db";

const TABLE_PREFIX = process.env.NODE_ENV === "production" ? "" : "Dev-";
const TABLE = `${TABLE_PREFIX}AW-Organizations`;
const DRY_RUN = process.env.DRY_RUN !== "false";

const CRM_DEFAULT = { enabled: true, editors: [] as string[] };

async function run(): Promise<void> {
  const ddb = new DynamoDB.DocumentClient({ region: process.env.AWS_REGION || "us-west-2" });

  if (DRY_RUN) {
    console.log("[DRY RUN] No writes will be made. Set DRY_RUN=false to apply.");
  }
  console.log(`Table: ${TABLE}\n`);

  let lek: any | undefined;
  let scanned = 0;
  let patched = 0;
  let skippedAlreadyHasCrm = 0;
  let skippedNoShareSettings = 0;

  do {
    const page = await ddb.scan({
      TableName: TABLE,
      ...(lek ? { ExclusiveStartKey: lek } : {}),
    }).promise();

    for (const item of page.Items || []) {
      scanned++;
      const org = item as Organization;

      if (!org.shareSettings) {
        // Handled by migrate-org-share-settings.ts
        skippedNoShareSettings++;
        continue;
      }

      if (org.shareSettings.crm !== undefined) {
        skippedAlreadyHasCrm++;
        continue;
      }

      console.log(`${DRY_RUN ? "[DRY RUN] Would patch" : "Patching"} org: ${org.orgId}`);

      if (!DRY_RUN) {
        await ddb.update({
          TableName: TABLE,
          Key: { orgId: org.orgId },
          UpdateExpression: "SET shareSettings.crm = :crm, updatedAt = :ts",
          ExpressionAttributeValues: {
            ":crm": CRM_DEFAULT,
            ":ts": new Date().toISOString(),
          },
        }).promise();
      }

      patched++;
    }

    lek = page.LastEvaluatedKey;
  } while (lek);

  console.log(`\nDone.`);
  console.log(`  Scanned:                ${scanned}`);
  console.log(`  ${DRY_RUN ? "Would patch" : "Patched"}:               ${patched}`);
  console.log(`  Skipped (already has crm): ${skippedAlreadyHasCrm}`);
  console.log(`  Skipped (no shareSettings): ${skippedNoShareSettings}`);
}

run().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
