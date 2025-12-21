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
const TABLE_NAME = `${TABLE_PREFIX}AW-ChatSessions`;

console.log("Repairing ChatSessions admin index attributes with configuration:", {
  environment: process.env.NODE_ENV || "production",
  region: process.env.AWS_REGION,
  tablePrefix: TABLE_PREFIX,
  tableName: TABLE_NAME,
});

async function repairChatSessionsAdminIndex() {
  let lastEvaluatedKey: AWS.DynamoDB.DocumentClient.Key | undefined = undefined;
  let totalScanned = 0;
  let totalUpdated = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  console.log("Starting repair process...\n");

  do {
    const scanParams: AWS.DynamoDB.DocumentClient.ScanInput = {
      TableName: TABLE_NAME,
      Limit: 100,
    };

    if (lastEvaluatedKey) {
      scanParams.ExclusiveStartKey = lastEvaluatedKey;
    }

    try {
      const result = await dynamodb.scan(scanParams).promise();
      const items = result.Items || [];
      totalScanned += items.length;

      console.log(`Processing batch: ${items.length} items (Total scanned: ${totalScanned})`);

      const updatePromises = items.map(async (item) => {
        if (item.adminListPartition === "all") {
          totalSkipped++;
          return;
        }

        try {
          await dynamodb
            .update({
              TableName: TABLE_NAME,
              Key: {
                sessionId: item.sessionId,
              },
              UpdateExpression: "SET adminListPartition = :adminListPartition",
              ExpressionAttributeValues: {
                ":adminListPartition": "all",
              },
            })
            .promise();
          totalUpdated++;
          if (totalUpdated % 25 === 0) {
            console.log(`  ✓ Updated ${totalUpdated} records so far...`);
          }
        } catch (error: any) {
          console.error(`  ✗ Error updating session ${item.sessionId}:`, error.message);
          totalErrors++;
        }
      });

      await Promise.all(updatePromises);
      lastEvaluatedKey = result.LastEvaluatedKey;

      if (lastEvaluatedKey) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    } catch (error: any) {
      console.error("Error scanning table:", error);
      throw error;
    }
  } while (lastEvaluatedKey);

  console.log("\n" + "=".repeat(50));
  console.log("Repair process completed!");
  console.log("=".repeat(50));
  console.log(`Total records scanned: ${totalScanned}`);
  console.log(`Total records updated: ${totalUpdated}`);
  console.log(`Total records skipped: ${totalSkipped} (already had adminListPartition)`);
  console.log(`Total errors: ${totalErrors}`);
  console.log("=".repeat(50));
}

const main = async () => {
  try {
    await repairChatSessionsAdminIndex();
    console.log("\n✅ Repair completed successfully!");
    process.exit(0);
  } catch (error) {
    console.error("\n❌ Repair failed:", error);
    process.exit(1);
  }
};

if (require.main === module) {
  void main();
}
