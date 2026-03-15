/**
 * Migration: Create solo teams for existing users.
 *
 * Scans AW-Users, and for each user that does NOT already have a
 * corresponding AW-TeamMembers record, creates:
 *   1. A new AW-Teams row (solo team, user is owner)
 *   2. A new AW-TeamMembers row (role = owner, status = active)
 *
 * Idempotent — safe to run multiple times. Users who already have a
 * team membership are silently skipped.
 *
 * Usage:
 *   npx ts-node src/scripts/migrateUsersToTeams.ts          # production
 *   NODE_ENV=development npx ts-node src/scripts/migrateUsersToTeams.ts  # dev
 */

import AWS from 'aws-sdk';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const TABLE_PREFIX = process.env.NODE_ENV === 'development' ? 'Dev-' : '';
const USERS_TABLE = `${TABLE_PREFIX}AW-Users`;
const TEAMS_TABLE = `${TABLE_PREFIX}AW-Teams`;
const TEAM_MEMBERS_TABLE = `${TABLE_PREFIX}AW-TeamMembers`;

AWS.config.update({
  region: process.env.AWS_REGION || 'us-west-2',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
  },
});

const dynamodb = new AWS.DynamoDB.DocumentClient();

interface MigrationResult {
  scanned: number;
  created: number;
  skipped: number;
  errors: string[];
}

/**
 * Check if a user already has any team membership.
 */
async function userHasTeam(userId: string): Promise<boolean> {
  const result = await dynamodb
    .query({
      TableName: TEAM_MEMBERS_TABLE,
      IndexName: 'userId-index',
      KeyConditionExpression: 'userId = :userId',
      ExpressionAttributeValues: { ':userId': userId },
      Limit: 1,
    })
    .promise();

  return (result.Items?.length ?? 0) > 0;
}

/**
 * Create a solo team for a user: one Team row + one TeamMember row.
 */
async function createSoloTeam(userId: string, email: string): Promise<void> {
  const now = new Date().toISOString();
  const teamId = uuidv4();

  // Create the team
  await dynamodb
    .put({
      TableName: TEAMS_TABLE,
      Item: {
        teamId,
        name: `${email}'s Team`,
        ownerUserId: userId,
        createdAt: now,
        updatedAt: now,
        settings: { soloMigrated: true },
      },
    })
    .promise();

  // Add the owner as a member
  await dynamodb
    .put({
      TableName: TEAM_MEMBERS_TABLE,
      Item: {
        teamId,
        userId,
        role: 'owner',
        invitedBy: userId,
        joinedAt: now,
        status: 'active',
      },
    })
    .promise();
}

/**
 * Migrate all existing users to solo teams.
 */
export async function migrateUsersToTeams(): Promise<MigrationResult> {
  const result: MigrationResult = {
    scanned: 0,
    created: 0,
    skipped: 0,
    errors: [],
  };

  let lastEvaluatedKey: AWS.DynamoDB.DocumentClient.Key | undefined;

  do {
    const scanParams: AWS.DynamoDB.DocumentClient.ScanInput = {
      TableName: USERS_TABLE,
      ProjectionExpression: 'userId, email',
      ExclusiveStartKey: lastEvaluatedKey,
    };

    const scanResult = await dynamodb.scan(scanParams).promise();
    const users = scanResult.Items || [];
    lastEvaluatedKey = scanResult.LastEvaluatedKey;

    for (const user of users) {
      result.scanned++;

      if (!user.userId || !user.email) {
        result.errors.push(`User missing userId or email: ${JSON.stringify(user)}`);
        continue;
      }

      try {
        const hasTeam = await userHasTeam(user.userId);

        if (hasTeam) {
          result.skipped++;
          continue;
        }

        await createSoloTeam(user.userId, user.email);
        result.created++;
        console.log(`  ✓ Created solo team for ${user.email}`);
      } catch (error: any) {
        const msg = `Error migrating ${user.email}: ${error.message}`;
        result.errors.push(msg);
        console.error(`  ✗ ${msg}`);
      }
    }
  } while (lastEvaluatedKey);

  return result;
}

// ─── CLI entry point ──────────────────────────────────────────────────

if (require.main === module) {
  console.log(`\nMigrating users to solo teams...`);
  console.log(`Table prefix: "${TABLE_PREFIX}"\n`);

  migrateUsersToTeams()
    .then((result) => {
      console.log(`\n── Migration complete ──`);
      console.log(`  Scanned:  ${result.scanned}`);
      console.log(`  Created:  ${result.created}`);
      console.log(`  Skipped:  ${result.skipped}`);
      console.log(`  Errors:   ${result.errors.length}`);
      if (result.errors.length > 0) {
        console.log(`\nErrors:`);
        result.errors.forEach((e) => console.log(`  - ${e}`));
      }
      process.exit(result.errors.length > 0 ? 1 : 0);
    })
    .catch((err) => {
      console.error('Fatal migration error:', err);
      process.exit(1);
    });
}
