/**
 * Migration script: settings-row → AW-HtmlTemplates table (Task 17).
 *
 * Scans AW-Settings for rows whose key begins with "templates_" and copies
 * each template object into the dedicated AW-HtmlTemplates DynamoDB table via
 * htmlTemplateService.createTemplate().
 *
 * Special keys:
 *   templates_public  → userId "__public__", isPublic "true"
 *   templates_{uid}   → userId = uid
 *
 * Idempotency:
 *   A marker row { key: "html_templates_migrated" } is written to AW-Settings
 *   after a successful run. Re-running is a no-op once the marker exists.
 *
 * Usage:
 *   NODE_ENV=development npx ts-node src/scripts/migrate-html-templates.ts
 *   NODE_ENV=production  npx ts-node src/scripts/migrate-html-templates.ts
 */

import AWS from "aws-sdk";
import { htmlTemplateService } from "../services/htmlTemplateService";

const TABLE_PREFIX = process.env.NODE_ENV === "production" ? "" : "Dev-";
const SETTINGS = `${TABLE_PREFIX}AW-Settings`;
const MIGRATED_KEY = "html_templates_migrated";

export async function runMigration(): Promise<void> {
  const ddb = new AWS.DynamoDB.DocumentClient({ region: process.env.AWS_REGION || "us-west-2" });

  // Idempotency check — skip if marker row already exists.
  const marker = await ddb.get({ TableName: SETTINGS, Key: { key: MIGRATED_KEY } }).promise();
  if (marker.Item) {
    console.log("Already migrated. Skipping.");
    return;
  }

  let lek: AWS.DynamoDB.DocumentClient.Key | undefined;
  let migratedCount = 0;

  do {
    const page = await ddb
      .scan({
        TableName: SETTINGS,
        FilterExpression: "begins_with(#k, :p)",
        ExpressionAttributeNames: { "#k": "key" },
        ExpressionAttributeValues: { ":p": "templates_" },
        ...(lek ? { ExclusiveStartKey: lek } : {}),
      })
      .promise();

    for (const row of page.Items || []) {
      const key: string = row.key;
      const isPublic = key === "templates_public";
      const userId = isPublic ? "__public__" : key.slice("templates_".length);
      const arr: any[] = Array.isArray(row.templates) ? row.templates : [];

      for (const t of arr) {
        const type: ("email" | "landing_page")[] = Array.isArray(t.type)
          ? t.type
          : t.type
          ? [t.type as "email" | "landing_page"]
          : ["email"];

        await htmlTemplateService.createTemplate({
          userId,
          type,
          name: t.name || "Untitled",
          subject: t.subject,
          html: t.html || "",
          ...(isPublic ? { isPublic: "true" as const } : {}),
        });
        migratedCount++;
      }
    }

    lek = page.LastEvaluatedKey;
  } while (lek);

  // Write idempotency marker.
  await ddb
    .put({
      TableName: SETTINGS,
      Item: { key: MIGRATED_KEY, migratedAt: new Date().toISOString(), count: migratedCount },
    })
    .promise();

  console.log("Migrated", migratedCount, "templates");
}

if (require.main === module) {
  runMigration()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
