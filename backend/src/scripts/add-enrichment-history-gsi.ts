/**
 * One-time migration: adds userId-createdAt-index and jobType-createdAt-index
 * GSIs to AW-EnrichmentHistory (or Dev-AW-EnrichmentHistory in development).
 *
 * Run once per environment:
 *   NODE_ENV=development npx ts-node src/scripts/add-enrichment-history-gsi.ts
 *   NODE_ENV=production  npx ts-node src/scripts/add-enrichment-history-gsi.ts
 *
 * DynamoDB adds GSIs online — table stays available during backfill.
 * Delete this file after running in both environments.
 */

import AWS from 'aws-sdk';
import dotenv from 'dotenv';
import path from 'path';
import '../config/aws';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const TABLE_PREFIX = process.env.NODE_ENV === 'development' ? 'Dev-' : '';
const TABLE_NAME = `${TABLE_PREFIX}AW-EnrichmentHistory`;

const dynamodb = new AWS.DynamoDB();

async function addGsi(indexName: string, hashKey: string, rangeKey: string) {
  console.log(`Adding GSI ${indexName} to ${TABLE_NAME}...`);
  try {
    await dynamodb.updateTable({
      TableName: TABLE_NAME,
      AttributeDefinitions: [
        { AttributeName: hashKey, AttributeType: 'S' },
        { AttributeName: rangeKey, AttributeType: 'S' },
      ],
      GlobalSecondaryIndexUpdates: [
        {
          Create: {
            IndexName: indexName,
            KeySchema: [
              { AttributeName: hashKey, KeyType: 'HASH' },
              { AttributeName: rangeKey, KeyType: 'RANGE' },
            ],
            Projection: { ProjectionType: 'ALL' },
          },
        },
      ],
    }).promise();
    console.log(`✓ ${indexName} creation initiated (backfill running in background)`);
  } catch (err: any) {
    if (err.code === 'ValidationException' && err.message?.includes('already exists')) {
      console.log(`✓ ${indexName} already exists, skipping`);
    } else {
      throw err;
    }
  }
}

async function waitForActive(indexName: string) {
  console.log(`Waiting for ${indexName} to become ACTIVE...`);
  while (true) {
    const desc = await dynamodb.describeTable({ TableName: TABLE_NAME }).promise();
    const gsi = desc.Table?.GlobalSecondaryIndexes?.find(g => g.IndexName === indexName);
    if (gsi?.IndexStatus === 'ACTIVE') {
      console.log(`✓ ${indexName} is ACTIVE`);
      return;
    }
    console.log(`  ${indexName} status: ${gsi?.IndexStatus ?? 'unknown'} — waiting 5s...`);
    await new Promise(r => setTimeout(r, 5000));
  }
}

async function main() {
  console.log(`Environment: ${process.env.NODE_ENV || 'production'}`);
  console.log(`Table: ${TABLE_NAME}\n`);

  // DynamoDB only allows one GSI creation per updateTable call
  await addGsi('userId-createdAt-index', 'userId', 'createdAt');
  await waitForActive('userId-createdAt-index');

  await addGsi('jobType-createdAt-index', 'jobType', 'createdAt');
  await waitForActive('jobType-createdAt-index');

  console.log('\nDone. Both GSIs are active.');
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
