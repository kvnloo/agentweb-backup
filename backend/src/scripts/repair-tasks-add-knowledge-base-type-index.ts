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

const dynamodb = new AWS.DynamoDB();
const TABLE_NAME = `${TABLE_PREFIX}AW-Tasks`;
const INDEX_NAME = "KnowledgeBaseTypeIndex";

console.log("Adding KnowledgeBaseTypeIndex to Tasks table with configuration:", {
  environment: process.env.NODE_ENV || "production",
  region: process.env.AWS_REGION,
  tablePrefix: TABLE_PREFIX,
  tableName: TABLE_NAME,
  indexName: INDEX_NAME,
});

async function addKnowledgeBaseTypeIndex() {
  console.log("Starting index creation process...\n");

  try {
    // First, check if the index already exists
    const describeTableParams = {
      TableName: TABLE_NAME,
    };

    const tableDescription = await dynamodb.describeTable(describeTableParams).promise();
    const existingIndexes = tableDescription.Table?.GlobalSecondaryIndexes || [];
    const indexExists = existingIndexes.some((index) => index.IndexName === INDEX_NAME);

    if (indexExists) {
      console.log(`✓ Index ${INDEX_NAME} already exists on ${TABLE_NAME}`);
      return;
    }

    // Add the new GSI
    const updateParams: AWS.DynamoDB.UpdateTableInput = {
      TableName: TABLE_NAME,
      AttributeDefinitions: [
        { AttributeName: "knowledgeBaseType", AttributeType: "S" },
        { AttributeName: "knowledgeBaseUpdatedAt", AttributeType: "S" },
      ],
      GlobalSecondaryIndexUpdates: [
        {
          Create: {
            IndexName: INDEX_NAME,
            KeySchema: [
              { AttributeName: "knowledgeBaseType", KeyType: "HASH" },
              { AttributeName: "knowledgeBaseUpdatedAt", KeyType: "RANGE" },
            ],
            Projection: {
              ProjectionType: "ALL",
            },
          },
        },
      ],
    };

    console.log(`Creating index ${INDEX_NAME} on ${TABLE_NAME}...`);
    await dynamodb.updateTable(updateParams).promise();

    console.log(`\n✓ Index creation initiated. The index is being built in the background.`);
    console.log(`  This may take several minutes depending on the table size.`);

    // Wait for the index to become active
    console.log(`\nWaiting for index to become active...`);
    let indexStatus = "CREATING";
    let attempts = 0;
    const maxAttempts = 60; // Wait up to 5 minutes (60 attempts * 5 seconds)

    while (indexStatus !== "ACTIVE" && attempts < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, 5000)); // Wait 5 seconds
      attempts++;

      const statusResult = await dynamodb.describeTable(describeTableParams).promise();
      const currentIndexes = statusResult.Table?.GlobalSecondaryIndexes || [];
      const currentIndex = currentIndexes.find((index) => index.IndexName === INDEX_NAME);

      if (currentIndex) {
        indexStatus = currentIndex.IndexStatus || "UNKNOWN";
        console.log(`  Status: ${indexStatus} (attempt ${attempts}/${maxAttempts})`);
      }
    }

    if (indexStatus === "ACTIVE") {
      console.log(`\n✓ Index ${INDEX_NAME} is now ACTIVE and ready to use!`);
    } else {
      console.log(`\n⚠ Index creation is still in progress. Current status: ${indexStatus}`);
      console.log(`  You can check the status later using AWS Console or CLI.`);
    }
  } catch (error: any) {
    if (error.code === "ResourceInUseException") {
      console.log(`⚠ Table ${TABLE_NAME} is currently being modified. Please try again later.`);
    } else if (error.code === "LimitExceededException") {
      console.log(`⚠ Too many simultaneous table operations. Please try again later.`);
    } else {
      console.error("Error adding index:", error);
      throw error;
    }
  }
}

const main = async () => {
  try {
    await addKnowledgeBaseTypeIndex();
    console.log("\n" + "=".repeat(50));
    console.log("✅ Index creation completed successfully!");
    console.log("=".repeat(50));
    process.exit(0);
  } catch (error) {
    console.log("\n" + "=".repeat(50));
    console.error("❌ Index creation failed:", error);
    console.log("=".repeat(50));
    process.exit(1);
  }
};

if (require.main === module) {
  void main();
}
