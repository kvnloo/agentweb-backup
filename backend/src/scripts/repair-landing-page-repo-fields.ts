import AWS from "aws-sdk";
import dotenv from "dotenv";
import path from "path";
import "../config/aws";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const TABLE_PREFIX = process.env.NODE_ENV === "development" ? "Dev-" : "";

AWS.config.update({
  region: process.env.AWS_REGION,
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
});

const dynamodb = new AWS.DynamoDB.DocumentClient();
const TABLE_NAME = `${TABLE_PREFIX}AW-LandingPages`;

console.log("Repairing LandingPages missing githubRepoUrl/vercelProjectId with configuration:", {
  environment: process.env.NODE_ENV || "production",
  region: process.env.AWS_REGION,
  tablePrefix: TABLE_PREFIX,
  tableName: TABLE_NAME,
});

async function repairLandingPageRepoFields() {
  let lastEvaluatedKey: AWS.DynamoDB.DocumentClient.Key | undefined = undefined;
  let totalScanned = 0;
  let totalFixed = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  // First, build a map of userId -> list of pages with githubRepoUrl + vercelProjectId
  // keyed by deployedUrl origin (e.g. https://audit.agentweb.pro -> { githubRepoUrl, vercelProjectId })
  const donorMap: Record<string, { githubRepoUrl: string; vercelProjectId: string }> = {};

  console.log("Pass 1: collecting donor pages (pages that have both fields set)...\n");

  do {
    const scanResult = await dynamodb.scan({ TableName: TABLE_NAME, Limit: 100, ExclusiveStartKey: lastEvaluatedKey }).promise();
    lastEvaluatedKey = scanResult.LastEvaluatedKey;

    for (const item of scanResult.Items ?? []) {
      if (item.githubRepoUrl && item.vercelProjectId && item.deployedUrl) {
        try {
          const origin = new URL(item.deployedUrl).origin;
          if (!donorMap[origin]) {
            donorMap[origin] = { githubRepoUrl: item.githubRepoUrl, vercelProjectId: item.vercelProjectId };
          }
        } catch {
          // ignore unparseable URLs
        }
      }
    }
  } while (lastEvaluatedKey);

  console.log("Donor origins found:", Object.keys(donorMap));
  console.log("\nPass 2: fixing pages missing either field...\n");

  lastEvaluatedKey = undefined;

  do {
    const scanResult = await dynamodb.scan({ TableName: TABLE_NAME, Limit: 100, ExclusiveStartKey: lastEvaluatedKey }).promise();
    lastEvaluatedKey = scanResult.LastEvaluatedKey;
    totalScanned += scanResult.Items?.length ?? 0;

    for (const item of scanResult.Items ?? []) {
      if (item.githubRepoUrl && item.vercelProjectId) {
        totalSkipped++;
        continue;
      }

      if (!item.deployedUrl) {
        console.log(`  SKIP ${item.id} (${item.name}): no deployedUrl`);
        totalSkipped++;
        continue;
      }

      let origin: string;
      try {
        origin = new URL(item.deployedUrl).origin;
      } catch {
        console.log(`  SKIP ${item.id} (${item.name}): unparseable deployedUrl`);
        totalSkipped++;
        continue;
      }

      const donor = donorMap[origin];
      if (!donor) {
        console.log(`  SKIP ${item.id} (${item.name}): no donor found for origin ${origin}`);
        totalSkipped++;
        continue;
      }

      try {
        await dynamodb.update({
          TableName: TABLE_NAME,
          Key: { id: item.id },
          UpdateExpression: "SET githubRepoUrl = :repoUrl, vercelProjectId = :vercelId, updatedAt = :updatedAt",
          ConditionExpression: "attribute_not_exists(githubRepoUrl) OR attribute_not_exists(vercelProjectId)",
          ExpressionAttributeValues: {
            ":repoUrl": donor.githubRepoUrl,
            ":vercelId": donor.vercelProjectId,
            ":updatedAt": new Date().toISOString(),
          },
        }).promise();

        console.log(`  FIXED ${item.id} (${item.name}): set githubRepoUrl=${donor.githubRepoUrl}, vercelProjectId=${donor.vercelProjectId}`);
        totalFixed++;
      } catch (err: any) {
        if (err.code === "ConditionalCheckFailedException") {
          totalSkipped++;
        } else {
          console.error(`  ERROR ${item.id} (${item.name}):`, err.message);
          totalErrors++;
        }
      }
    }
  } while (lastEvaluatedKey);

  console.log("\n=== Repair Complete ===");
  console.log(`Total scanned: ${totalScanned}`);
  console.log(`Total fixed:   ${totalFixed}`);
  console.log(`Total skipped: ${totalSkipped}`);
  console.log(`Total errors:  ${totalErrors}`);
}

repairLandingPageRepoFields().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
