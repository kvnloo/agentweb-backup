import { DynamoDB } from "aws-sdk";
import type { OrgShareSettings, Organization } from "../services/db";

const TABLE_PREFIX = process.env.NODE_ENV === "production" ? "" : "Dev-";
const TABLE = `${TABLE_PREFIX}AW-Organizations`;

const defaults: OrgShareSettings = {
  knowledgeBase:     { enabled: false, editors: [] },
  htmlTemplates:     { enabled: false, editors: [] },
  landingPages:      { enabled: false, editors: [] },
  workPlans:         { enabled: true,  editors: [] },
  skills:            { enabled: true,  editors: [] },
  funnels:           { enabled: false, editors: [] },
  brandGuidelines:   { editors: [] },
  marketingStrategy: { editors: [] },
};

export async function runMigration(): Promise<void> {
  const ddb = new DynamoDB.DocumentClient({ region: process.env.AWS_REGION || "us-west-2" });
  let lek: any | undefined;
  do {
    const page = await ddb.scan({
      TableName: TABLE,
      ...(lek ? { ExclusiveStartKey: lek } : {}),
    }).promise();
    for (const item of page.Items || []) {
      const org = item as Organization;
      if (org.shareSettings) continue;
      await ddb.update({
        TableName: TABLE,
        Key: { orgId: org.orgId },
        UpdateExpression: "SET shareSettings = :s, updatedAt = :u",
        ExpressionAttributeValues: {
          ":s": defaults,
          ":u": new Date().toISOString(),
        },
      }).promise();
      console.log("Migrated org:", org.orgId);
    }
    lek = page.LastEvaluatedKey;
  } while (lek);
}

if (require.main === module) {
  runMigration().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
}
