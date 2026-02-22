/**
 * Delete a chat session from the dev DynamoDB tables after testing.
 *
 * Removes both the session record from Dev-AW-ChatSessions and all
 * associated messages from Dev-AW-ChatMessages.
 *
 * Usage:
 *   npx ts-node src/scripts/delete-dev-session.ts <sessionId>
 *
 * Example:
 *   npx ts-node src/scripts/delete-dev-session.ts abc-123-def
 */
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

const DEV_SESSIONS_TABLE = "Dev-AW-ChatSessions";
const DEV_MESSAGES_TABLE = "Dev-AW-ChatMessages";

async function deleteDevSession(sessionId: string) {
  // 1. Check the session exists
  console.log(`Looking up session ${sessionId} in ${DEV_SESSIONS_TABLE}...`);
  const sessionResult = await dynamodb
    .get({
      TableName: DEV_SESSIONS_TABLE,
      Key: { sessionId },
    })
    .promise();

  if (!sessionResult.Item) {
    console.log(`Session ${sessionId} not found in ${DEV_SESSIONS_TABLE}. Nothing to delete.`);
    return;
  }

  console.log(`  Found session: "${sessionResult.Item.title || "(no title)"}" (userId: ${sessionResult.Item.userId})`);

  // 2. Query and delete all messages
  console.log(`Deleting messages from ${DEV_MESSAGES_TABLE}...`);
  let totalDeleted = 0;
  let lastKey: AWS.DynamoDB.DocumentClient.Key | undefined;

  do {
    const queryParams: AWS.DynamoDB.DocumentClient.QueryInput = {
      TableName: DEV_MESSAGES_TABLE,
      KeyConditionExpression: "sessionId = :sid",
      ExpressionAttributeValues: { ":sid": sessionId },
      ProjectionExpression: "sessionId, messageIndex",
    };
    if (lastKey) {
      queryParams.ExclusiveStartKey = lastKey;
    }
    const queryResult = await dynamodb.query(queryParams).promise();
    const items = queryResult.Items || [];

    if (items.length > 0) {
      // Delete in batches of 25
      for (let i = 0; i < items.length; i += 25) {
        const batch = items.slice(i, i + 25).map((item) => ({
          DeleteRequest: {
            Key: { sessionId: item.sessionId, messageIndex: item.messageIndex },
          },
        }));
        await dynamodb
          .batchWrite({
            RequestItems: { [DEV_MESSAGES_TABLE]: batch },
          })
          .promise();
        totalDeleted += batch.length;
      }
    }

    lastKey = queryResult.LastEvaluatedKey;
  } while (lastKey);

  console.log(`  Deleted ${totalDeleted} messages`);

  // 3. Delete the session record
  console.log(`Deleting session from ${DEV_SESSIONS_TABLE}...`);
  await dynamodb
    .delete({
      TableName: DEV_SESSIONS_TABLE,
      Key: { sessionId },
    })
    .promise();
  console.log("  Session deleted");

  console.log("\nDone! Cleaned up dev session.");
  console.log(`  Session ID: ${sessionId}`);
  console.log(`  Messages deleted: ${totalDeleted}`);
}

async function main() {
  const sessionId = process.argv[2];

  if (!sessionId) {
    console.error("Usage: npx ts-node src/scripts/delete-dev-session.ts <sessionId>");
    process.exit(1);
  }

  try {
    await deleteDevSession(sessionId);
    process.exit(0);
  } catch (error) {
    console.error("\nFailed to delete session:", error);
    process.exit(1);
  }
}

if (require.main === module) {
  void main();
}
