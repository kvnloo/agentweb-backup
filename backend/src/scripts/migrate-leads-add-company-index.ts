/**
 * Migration: add companyId-index GSI to AW-Leads table.
 *
 * Run with:
 *   NODE_ENV=development npx ts-node src/scripts/migrate-leads-add-company-index.ts
 *   NODE_ENV=production  npx ts-node src/scripts/migrate-leads-add-company-index.ts
 */

import AWS from 'aws-sdk';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const TABLE_PREFIX = process.env.NODE_ENV === 'development' ? 'Dev-' : '';
const TABLE_NAME = `${TABLE_PREFIX}AW-Leads`;
const INDEX_NAME = 'companyId-index';

AWS.config.update({
  region: process.env.AWS_REGION,
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
});

const dynamodb = new AWS.DynamoDB();
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function indexExists(): Promise<boolean> {
  const desc = await dynamodb.describeTable({ TableName: TABLE_NAME }).promise();
  const gsis = desc.Table?.GlobalSecondaryIndexes ?? [];
  return gsis.some((g) => g.IndexName === INDEX_NAME);
}

async function waitForActive(): Promise<void> {
  for (let i = 0; i < 120; i++) {
    const desc = await dynamodb.describeTable({ TableName: TABLE_NAME }).promise();
    const status = desc.Table?.TableStatus;
    const gsi = desc.Table?.GlobalSecondaryIndexes?.find((g) => g.IndexName === INDEX_NAME);
    if (status === 'ACTIVE' && (!gsi || gsi.IndexStatus === 'ACTIVE')) return;
    console.log(`Waiting… table=${status} gsi=${gsi?.IndexStatus ?? 'not found'} (${i + 1}/120)`);
    await wait(5000);
  }
  throw new Error('Timed out waiting for index to become ACTIVE');
}

async function main() {
  console.log(`Target table: ${TABLE_NAME}`);

  if (await indexExists()) {
    console.log(`${INDEX_NAME} already exists — nothing to do.`);
    return;
  }

  console.log(`Creating ${INDEX_NAME} GSI…`);
  await dynamodb.updateTable({
    TableName: TABLE_NAME,
    AttributeDefinitions: [
      { AttributeName: 'companyId', AttributeType: 'S' },
      { AttributeName: 'leadId', AttributeType: 'S' },
    ],
    GlobalSecondaryIndexUpdates: [
      {
        Create: {
          IndexName: INDEX_NAME,
          KeySchema: [
            { AttributeName: 'companyId', KeyType: 'HASH' },
            { AttributeName: 'leadId', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
      },
    ],
  }).promise();

  console.log('Waiting for index to become ACTIVE…');
  await waitForActive();
  console.log(`${INDEX_NAME} is now ACTIVE on ${TABLE_NAME}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
