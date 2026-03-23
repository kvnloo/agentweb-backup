/**
 * Bot Account Cleanup Script
 *
 * Identifies accounts that match known bot/spam patterns and optionally deletes them.
 *
 * Usage:
 *   npx ts-node src/scripts/cleanupBotAccounts.ts             # Dry-run (list only)
 *   npx ts-node src/scripts/cleanupBotAccounts.ts --execute    # Actually delete
 *
 * IMPORTANT: Only touches Dev-AW-Users (NODE_ENV must be "development").
 */

import AWS from 'aws-sdk';
import dotenv from 'dotenv';
import path from 'path';

// Load environment variables
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

// ── Safety: force Dev table prefix ────────────────────────────────────────
const TABLE_PREFIX = process.env.NODE_ENV === 'development' ? 'Dev-' : '';
const USERS_TABLE = `${TABLE_PREFIX}AW-Users`;

if (!TABLE_PREFIX) {
  console.error(
    '❌  NODE_ENV is not "development". This script only runs against Dev tables. Aborting.'
  );
  process.exit(1);
}

// ── AWS setup ─────────────────────────────────────────────────────────────
AWS.config.update({
  region: process.env.AWS_REGION || 'us-west-2',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
  },
});

const dynamodb = new AWS.DynamoDB.DocumentClient();

// ── Bot Detection Patterns ────────────────────────────────────────────────

/**
 * Returns true if the email looks like a bot/spam account.
 *
 * Patterns detected:
 * 1. Excessive dots in the local part (e.g., l.i.j.o.ba.yug.ido.4.7@gmail.com)
 *    Normal gmail dot-trick uses 1-2 dots; 4+ consecutive dot-separated single chars is suspicious
 * 2. Random-looking strings with many numbers mixed with chars (e.g., abc123def456@tempmail.com)
 * 3. Known disposable email domains
 */
export function isBotEmail(email: string): boolean {
  if (!email || typeof email !== 'string') return false;

  const lower = email.toLowerCase().trim();
  const [localPart, domain] = lower.split('@');
  if (!localPart || !domain) return false;

  // Pattern 1: Excessive dots — 5+ dot-separated segments in local part
  // where most segments are short (<=3 chars). Normal emails rarely have this many dots.
  const dotSegments = localPart.split('.');
  if (dotSegments.length >= 5) {
    const shortSegments = dotSegments.filter((s) => s.length <= 3);
    // If 60%+ of segments are short, it's a bot pattern
    if (shortSegments.length / dotSegments.length >= 0.6) {
      return true;
    }
  }

  // Pattern 2: Local part has interleaved letters and digits (e.g., "a1b2c3d4e5", "x123456")
  // At least 6 chars and >40% digits with letters present too
  const cleanLocal = localPart.replace(/\./g, '');
  if (cleanLocal.length >= 6) {
    const digitCount = (cleanLocal.match(/\d/g) || []).length;
    const letterCount = (cleanLocal.replace(/[^a-z]/gi, '') || '').length;
    if (digitCount > 0 && letterCount > 0 && digitCount / cleanLocal.length >= 0.4 && digitCount >= 4) {
      return true;
    }
  }

  // Pattern 3: Known disposable/temporary email domains
  const disposableDomains = [
    'tempmail.com',
    'throwaway.email',
    'guerrillamail.com',
    'mailinator.com',
    'yopmail.com',
    'sharklasers.com',
    'guerrillamailblock.com',
    'grr.la',
    'dispostable.com',
    'trashmail.com',
    'fakeinbox.com',
    'tempail.com',
    'temp-mail.org',
  ];
  if (disposableDomains.includes(domain)) {
    return true;
  }

  return false;
}

// ── Helpers ───────────────────────────────────────────────────────────────

async function scanAllUsers(): Promise<any[]> {
  const users: any[] = [];
  let lastKey: AWS.DynamoDB.DocumentClient.Key | undefined;

  do {
    const result = await dynamodb
      .scan({
        TableName: USERS_TABLE,
        ExclusiveStartKey: lastKey,
      })
      .promise();

    users.push(...(result.Items || []));
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  return users;
}

async function deleteUser(email: string): Promise<void> {
  await dynamodb
    .delete({
      TableName: USERS_TABLE,
      Key: { email },
    })
    .promise();
}

// ── Main ──────────────────────────────────────────────────────────────────

export async function cleanupBotAccounts(
  execute = false
): Promise<{ total: number; botCount: number; deleted: number; errors: number }> {
  console.log(`\nScanning for bot accounts in table: ${USERS_TABLE}`);
  console.log(`Mode: ${execute ? '🔴 EXECUTE (will delete)' : '🟢 DRY-RUN (list only)'}\n`);

  const users = await scanAllUsers();
  console.log(`Found ${users.length} total users.\n`);

  const botUsers: any[] = [];

  for (const user of users) {
    if (isBotEmail(user.email)) {
      botUsers.push(user);
    }
  }

  console.log(`Detected ${botUsers.length} bot account(s):\n`);
  for (const bot of botUsers) {
    console.log(
      `  - ${bot.email} (created: ${bot.createdAt || 'unknown'}, ` +
      `status: ${bot.subscription_status || 'none'}, admin: ${bot.isAdmin || false})`
    );
  }

  let deleted = 0;
  let errors = 0;

  if (execute && botUsers.length > 0) {
    console.log('\nDeleting bot accounts...');
    for (const bot of botUsers) {
      // Safety: never delete admin accounts
      if (bot.isAdmin) {
        console.log(`  SKIPPED (admin): ${bot.email}`);
        continue;
      }
      try {
        await deleteUser(bot.email);
        deleted++;
        console.log(`  DELETED: ${bot.email}`);
      } catch (err) {
        errors++;
        console.error(`  ERROR deleting ${bot.email}:`, err);
      }
    }
  }

  const summary = { total: users.length, botCount: botUsers.length, deleted, errors };
  console.log(
    `\nSummary: ${botUsers.length} bots found, ${deleted} deleted, ${errors} errors.`
  );
  return summary;
}

// Run if called directly
if (require.main === module) {
  const execute = process.argv.includes('--execute');
  cleanupBotAccounts(execute)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Cleanup failed:', err);
      process.exit(1);
    });
}
