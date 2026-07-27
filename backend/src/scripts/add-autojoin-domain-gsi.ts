import { DynamoDB } from "aws-sdk";
import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const TABLE_PREFIX = process.env.NODE_ENV === "production" ? "" : "Dev-";
const TABLE_NAME = `${TABLE_PREFIX}AW-Organizations`;

async function main() {
  const ddb = new DynamoDB({
    region: process.env.AWS_REGION || "us-west-2",
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  });

  const desc = await ddb.describeTable({ TableName: TABLE_NAME }).promise();
  const indexes = desc.Table?.GlobalSecondaryIndexes ?? [];

  if (indexes.some((i) => i.IndexName === "AutoJoinDomainIndex")) {
    console.log("AutoJoinDomainIndex already exists on", TABLE_NAME, "— nothing to do.");
    return;
  }

  const billingMode = desc.Table?.BillingModeSummary?.BillingMode;
  const isOnDemand = billingMode === "PAY_PER_REQUEST";

  console.log(
    "Creating AutoJoinDomainIndex on",
    TABLE_NAME,
    `(BillingMode: ${billingMode ?? "PROVISIONED"})`
  );

  const createSpec: DynamoDB.CreateGlobalSecondaryIndexAction = {
    IndexName: "AutoJoinDomainIndex",
    KeySchema: [{ AttributeName: "autoJoinDomain", KeyType: "HASH" }],
    Projection: { ProjectionType: "ALL" },
    ...(isOnDemand
      ? {}
      : {
          ProvisionedThroughput: {
            ReadCapacityUnits: 5,
            WriteCapacityUnits: 5,
          },
        }),
  };

  await ddb
    .updateTable({
      TableName: TABLE_NAME,
      AttributeDefinitions: [
        { AttributeName: "autoJoinDomain", AttributeType: "S" },
      ],
      GlobalSecondaryIndexUpdates: [{ Create: createSpec }],
    })
    .promise();

  console.log("Submitted. GSI will backfill in the background.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
