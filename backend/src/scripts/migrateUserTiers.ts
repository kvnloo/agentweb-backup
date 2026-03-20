/**
 * Migration script: Assign subscriptionType + allowedPages to existing users.
 *
 * Logic:
 *   - Already has subscriptionType → only back-fill allowedPages if missing
 *   - subscription_status=active AND has stripe_subscription_id → "Basic"
 *   - subscription_status in {canceled, past_due}                → "Free"
 *   - No subscription_status at all                              → "Free"
 *
 * Safe & idempotent — can be run multiple times.
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

// ── Tier definitions ─────────────────────────────────────────────────────
// Uses getSubscriptionTypeConfig from subscriptionService to read from DynamoDB.
// Falls back to minimal defaults if DB config is unavailable.
import { getSubscriptionTypeConfig, DEFAULT_PAGES } from '../services/subscriptionService';

// In-memory cache populated at migration start from DynamoDB
let tierCache: Record<string, { allowedPages: string[]; allowedSkills: string[] }> = {};

async function loadTierConfigs(): Promise<void> {
  const tierNames = ['Free', 'Basic', 'Super Premium'];
  for (const name of tierNames) {
    const config = await getSubscriptionTypeConfig(name);
    if (config) {
      tierCache[name] = {
        allowedPages: config.allowedPages,
        allowedSkills: config.allowedSkills,
      };
    }
  }
  // Ensure Free fallback always exists
  if (!tierCache['Free']) {
    tierCache['Free'] = {
      allowedPages: [...DEFAULT_PAGES],
      allowedSkills: [],
    };
  }
}

function getTierAllowedPages(tier: string): string[] {
  return tierCache[tier]?.allowedPages ?? tierCache['Free']?.allowedPages ?? [...DEFAULT_PAGES];
}

function getTierAllowedSkills(tier: string): string[] {
  return tierCache[tier]?.allowedSkills ?? tierCache['Free']?.allowedSkills ?? [];
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

function determineTier(user: any): string {
  const status = user.subscription_status;
  const hasStripeSubscription = !!user.stripe_subscription_id;

  if ((status === 'active' || status === 'trialing' || status === 'canceling') && hasStripeSubscription) return 'Basic';
  if (status === 'canceled' || status === 'past_due') return 'Free';
  // No subscription status at all → Free
  return 'Free';
}

async function updateUser(
  email: string,
  updates: Record<string, any>
): Promise<void> {
  const expressions: string[] = [];
  const names: Record<string, string> = {};
  const values: Record<string, any> = {};

  for (const [key, value] of Object.entries(updates)) {
    expressions.push(`#${key} = :${key}`);
    names[`#${key}`] = key;
    values[`:${key}`] = value;
  }

  await dynamodb
    .update({
      TableName: USERS_TABLE,
      Key: { email },
      UpdateExpression: `SET ${expressions.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    })
    .promise();
}

// ── Main ──────────────────────────────────────────────────────────────────

export async function migrateUserTiers(): Promise<{
  total: number;
  migrated: number;
  backfilled: number;
  skipped: number;
  freeCount: number;
  basicCount: number;
  errors: number;
}> {
  console.log(`\nMigrating user tiers in table: ${USERS_TABLE}`);

  // Load tier configs from DynamoDB (with fallbacks)
  await loadTierConfigs();
  console.log(`Loaded tier configs: ${Object.keys(tierCache).join(', ')}`);

  const users = await scanAllUsers();
  console.log(`Found ${users.length} total users.`);

  let migrated = 0;
  let backfilled = 0;
  let skipped = 0;
  let freeCount = 0;
  let basicCount = 0;
  let errors = 0;

  for (const user of users) {
    try {
      const email = user.email;
      if (!email) {
        skipped++;
        continue;
      }

      const hasSubscriptionType = !!user.subscriptionType;
      const hasAllowedPages =
        Array.isArray(user.allowedPages) && user.allowedPages.length > 0;

      if (hasSubscriptionType && hasAllowedPages) {
        // Already fully configured
        skipped++;
        continue;
      }

      if (!hasSubscriptionType) {
        // Determine tier from subscription status
        const tier = determineTier(user);
        const allowedPages = getTierAllowedPages(tier);
        const allowedSkills = getTierAllowedSkills(tier);

        await updateUser(email, {
          subscriptionType: tier,
          allowedPages,
          allowedSkills,
        });

        migrated++;
        if (tier === 'Free') freeCount++;
        if (tier === 'Basic') basicCount++;
      } else {
        // Has subscriptionType but missing allowedPages → back-fill
        const tier = user.subscriptionType;
        const allowedPages = getTierAllowedPages(tier);
        const allowedSkills = getTierAllowedSkills(tier);

        await updateUser(email, { allowedPages, allowedSkills });
        backfilled++;
      }
    } catch (err) {
      console.error(`Error migrating user ${user.email}:`, err);
      errors++;
    }
  }

  const summary = { total: users.length, migrated, backfilled, skipped, freeCount, basicCount, errors };
  console.log(
    `\nMigration complete: ${migrated} migrated (${freeCount}→Free, ${basicCount}→Basic), ` +
    `${backfilled} back-filled allowedPages, ${skipped} already up-to-date, ${errors} errors.`
  );
  return summary;
}

// Run if called directly
if (require.main === module) {
  migrateUserTiers()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Migration failed:', err);
      process.exit(1);
    });
}
