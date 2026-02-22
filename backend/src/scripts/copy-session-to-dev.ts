/**
 * Copy a chat session from production to dev DynamoDB tables for testing.
 *
 * Copies both the session record (AW-ChatSessions → Dev-AW-ChatSessions)
 * and all associated messages (AW-ChatMessages → Dev-AW-ChatMessages),
 * remapping the userId to a dev user.
 *
 * Usage:
 *   npx ts-node src/scripts/copy-session-to-dev.ts <prodSessionId> <devUserId>
 *
 * Example:
 *   npx ts-node src/scripts/copy-session-to-dev.ts abc-123-def dev-user-456
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

const PROD_SESSIONS_TABLE = "AW-ChatSessions";
const PROD_MESSAGES_TABLE = "AW-ChatMessages";
const DEV_SESSIONS_TABLE = "Dev-AW-ChatSessions";
const DEV_MESSAGES_TABLE = "Dev-AW-ChatMessages";

async function copySessionToDev(prodSessionId: string, devUserId: string) {
  // 1. Read the session from production
  console.log(`Reading session ${prodSessionId} from ${PROD_SESSIONS_TABLE}...`);
  const sessionResult = await dynamodb
    .get({
      TableName: PROD_SESSIONS_TABLE,
      Key: { sessionId: prodSessionId },
    })
    .promise();

  if (!sessionResult.Item) {
    throw new Error(`Session ${prodSessionId} not found in ${PROD_SESSIONS_TABLE}`);
  }

  const session = sessionResult.Item;
  console.log(`  Found session: "${session.title || "(no title)"}" (userId: ${session.userId})`);

  // 2. Read all messages from production
  console.log(`Reading messages from ${PROD_MESSAGES_TABLE}...`);
  let messages: AWS.DynamoDB.DocumentClient.ItemList = [];
  let lastKey: AWS.DynamoDB.DocumentClient.Key | undefined;

  do {
    const msgParams: AWS.DynamoDB.DocumentClient.QueryInput = {
      TableName: PROD_MESSAGES_TABLE,
      KeyConditionExpression: "sessionId = :sid",
      ExpressionAttributeValues: { ":sid": prodSessionId },
    };
    if (lastKey) {
      msgParams.ExclusiveStartKey = lastKey;
    }
    const msgResult = await dynamodb.query(msgParams).promise();
    messages = messages.concat(msgResult.Items || []);
    lastKey = msgResult.LastEvaluatedKey;
  } while (lastKey);

  console.log(`  Found ${messages.length} messages`);

  // 3. Write session to dev table with remapped userId
  // Remove the legacy messages array if present (messages are in the separate table)
  const { messages: _legacyMessages, ...sessionWithoutMessages } = session;
  const devSession = {
    ...sessionWithoutMessages,
    userId: devUserId,
    adminListPartition: "all",
  };

  console.log(`Writing session to ${DEV_SESSIONS_TABLE} (userId → ${devUserId})...`);
  await dynamodb
    .put({
      TableName: DEV_SESSIONS_TABLE,
      Item: devSession,
    })
    .promise();
  console.log("  Session written");

  // 4. Write messages to dev table in batches of 25
  if (messages.length > 0) {
    console.log(`Writing ${messages.length} messages to ${DEV_MESSAGES_TABLE}...`);
    const batches: AWS.DynamoDB.DocumentClient.WriteRequest[][] = [];
    for (let i = 0; i < messages.length; i += 25) {
      batches.push(
        messages.slice(i, i + 25).map((msg) => ({
          PutRequest: { Item: msg },
        }))
      );
    }

    for (let i = 0; i < batches.length; i++) {
      await dynamodb
        .batchWrite({
          RequestItems: { [DEV_MESSAGES_TABLE]: batches[i] },
        })
        .promise();
      if ((i + 1) % 4 === 0 || i === batches.length - 1) {
        console.log(`  Wrote batch ${i + 1}/${batches.length} (${Math.min((i + 1) * 25, messages.length)}/${messages.length} messages)`);
      }
    }
  }

  console.log("\nDone! Session copied to dev.");
  console.log(`  Session ID: ${prodSessionId}`);
  console.log(`  Dev user:   ${devUserId}`);
  console.log(`  Messages:   ${messages.length}`);
}

async function main() {
  const [prodSessionId, devUserId] = process.argv.slice(2);

  if (!prodSessionId || !devUserId) {
    console.error("Usage: npx ts-node src/scripts/copy-session-to-dev.ts <prodSessionId> <devUserId>");
    process.exit(1);
  }

  try {
    await copySessionToDev(prodSessionId, devUserId);
    process.exit(0);
  } catch (error) {
    console.error("\nFailed to copy session:", error);
    process.exit(1);
  }
}

if (require.main === module) {
  void main();
}
