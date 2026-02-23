import AWS from "aws-sdk";
import dotenv from "dotenv";
import path from "path";
import "../config/aws";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const TABLE_PREFIX = process.env.NODE_ENV === "development" ? "Dev-" : "";
const TABLE_NAME = `${TABLE_PREFIX}AW-Leads`;

AWS.config.update({
  region: process.env.AWS_REGION,
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
});

const dynamodb = new AWS.DynamoDB();

const INDEX_NAME = "listId-status-index";
const ATTRIBUTE_NAME = "status";

console.log("Repairing AW-Leads status index with configuration:", {
  environment: process.env.NODE_ENV || "production",
  region: process.env.AWS_REGION,
  tablePrefix: TABLE_PREFIX,
  tableName: TABLE_NAME,
  targetIndex: INDEX_NAME,
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const describeTable = async () => {
  return dynamodb.describeTable({ TableName: TABLE_NAME }).promise();
};

const waitForTableActive = async () => {
  const maxAttempts = 120;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const description = await describeTable();
    const status = description.Table?.TableStatus || "UNKNOWN";
    if (status === "ACTIVE") {
      return;
    }
    console.log(`Table status: ${status} (attempt ${attempt}/${maxAttempts})`);
    await wait(5000);
  }
  throw new Error(`Timed out waiting for ${TABLE_NAME} to become ACTIVE`);
};

const waitForIndexActive = async (indexName: string) => {
  const maxAttempts = 120;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const description = await describeTable();
    const indexes = description.Table?.GlobalSecondaryIndexes || [];
    const target = indexes.find((idx) => idx.IndexName === indexName);
    const status = target?.IndexStatus || "UNKNOWN";
    if (status === "ACTIVE") {
      console.log(`✓ ${indexName} is ACTIVE`);
      return;
    }
    console.log(`Index ${indexName} status: ${status} (attempt ${attempt}/${maxAttempts})`);
    await wait(5000);
  }
  throw new Error(`Timed out waiting for index ${indexName} to become ACTIVE`);
};

const ensureStatusIndex = async () => {
  await waitForTableActive();
  const description = await describeTable();
  const indexes = description.Table?.GlobalSecondaryIndexes || [];
  const existing = indexes.find((idx) => idx.IndexName === INDEX_NAME);

  if (existing?.IndexStatus === "ACTIVE") {
    console.log(`✓ ${INDEX_NAME} already exists and is ACTIVE`);
    return;
  }
  if (existing?.IndexStatus === "CREATING" || existing?.IndexStatus === "UPDATING") {
    console.log(`ℹ ${INDEX_NAME} already exists with status ${existing.IndexStatus}; waiting...`);
    await waitForIndexActive(INDEX_NAME);
    return;
  }

  console.log(`Creating ${INDEX_NAME} on ${TABLE_NAME}...`);
  const updateParams: AWS.DynamoDB.UpdateTableInput = {
    TableName: TABLE_NAME,
    AttributeDefinitions: [
      { AttributeName: "listId", AttributeType: "S" },
      { AttributeName: ATTRIBUTE_NAME, AttributeType: "S" },
    ],
    GlobalSecondaryIndexUpdates: [
      {
        Create: {
          IndexName: INDEX_NAME,
          KeySchema: [
            { AttributeName: "listId", KeyType: "HASH" },
            { AttributeName: ATTRIBUTE_NAME, KeyType: "RANGE" },
          ],
          Projection: {
            ProjectionType: "ALL",
          },
        },
      },
    ],
  };

  try {
    await dynamodb.updateTable(updateParams).promise();
  } catch (error: any) {
    if (error.code === "ResourceInUseException") {
      console.log(`ℹ Table is busy while creating ${INDEX_NAME}; waiting and retrying once...`);
      await waitForTableActive();
      await dynamodb.updateTable(updateParams).promise();
    } else {
      throw error;
    }
  }

  await waitForIndexActive(INDEX_NAME);
};

const main = async () => {
  try {
    console.log("Starting AW-Leads status index repair...\n");
    await ensureStatusIndex();
    console.log("\n" + "=".repeat(50));
    console.log("✅ AW-Leads status index is ready.");
    console.log("=".repeat(50));
    process.exit(0);
  } catch (error) {
    console.log("\n" + "=".repeat(50));
    console.error("❌ Failed to repair AW-Leads status index:", error);
    console.log("=".repeat(50));
    process.exit(1);
  }
};

if (require.main === module) {
  void main();
}

export { ensureStatusIndex };
