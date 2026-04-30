import AWS from "aws-sdk";
import dotenv from "dotenv";
import path from "path";
import "../config/aws";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

AWS.config.update({
  region: process.env.AWS_REGION,
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
});

const dynamodb = new AWS.DynamoDB.DocumentClient();
const TABLE = "AW-LandingPages";
const OLD_ID = "prj_8MJIkLDVNod9XRj5Kbl0FIk7EhJ3";
const NEW_ID = "prj_lH8z68FO47QtpLrLa45FnFRc2xwV";

async function main() {
  const scan = await dynamodb.scan({
    TableName: TABLE,
    FilterExpression: "vercelProjectId = :old",
    ExpressionAttributeValues: { ":old": OLD_ID },
  }).promise();

  console.log(`Found ${scan.Items?.length ?? 0} pages with stale vercelProjectId`);
  for (const item of scan.Items ?? []) {
    console.log(`  - ${item.id} (${item.name})`);
  }

  for (const item of scan.Items ?? []) {
    await dynamodb.update({
      TableName: TABLE,
      Key: { id: item.id },
      UpdateExpression: "SET vercelProjectId = :new, updatedAt = :now",
      ExpressionAttributeValues: {
        ":new": NEW_ID,
        ":now": new Date().toISOString(),
      },
    }).promise();
    console.log(`Updated: ${item.id} (${item.name})`);
  }
  console.log("Done.");
}

main().catch((e) => { console.error(e); process.exit(1); });
