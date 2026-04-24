/**
 * One-off Stripe subscription reconciliation backfill.
 *
 * For every user in AW-Users (or Dev-AW-Users) with a non-null
 * `stripe_customer_id`, fetch the ground-truth subscription from Stripe
 * and overwrite the 4 cached fields on the DynamoDB row:
 *
 *   - subscription_status
 *   - subscriptionType
 *   - current_period_end
 *   - has_payment_method
 *
 * Heals every user currently stuck in a half-state (e.g. subscription_status
 * = "trialing" while subscriptionType = "Free") without waiting for
 * individual webhook re-fires.
 *
 * Field-derivation logic mirrors
 *   backend/src/services/stripeService.ts :: reconcileAllStripeUsers()
 * so behavior is consistent with the live admin-triggered reconciliation.
 *
 * Usage:
 *   # Dry-run (default) against Dev-AW-Users
 *   npx ts-node backend/scripts/reconcile-stripe-subscriptions.ts
 *
 *   # Apply against Dev-AW-Users
 *   npx ts-node backend/scripts/reconcile-stripe-subscriptions.ts --apply
 *
 *   # Dry-run for a single user (fastest way to verify logic)
 *   npx ts-node backend/scripts/reconcile-stripe-subscriptions.ts --user-email foo@bar.com
 *
 *   # Apply against prod (CAREFUL — human green-light required)
 *   npx ts-node backend/scripts/reconcile-stripe-subscriptions.ts --env prod --apply
 *
 * Flags:
 *   --dry-run            (default — log diffs, no writes)
 *   --apply              actually write DynamoDB UpdateItems
 *   --env dev|prod       dev targets Dev-AW-Users (default), prod targets AW-Users
 *   --user-email <email> limit to a single user row (use for spot-checks)
 *
 * Safe to re-run any time — idempotent. A row already matching Stripe is a
 * no-op. Per-user errors (deleted Stripe customer, network blip) are logged
 * and the script continues.
 *
 * Related PR: fix/stripe-webhook-cancellation (the root-cause webhook fix).
 * This script heals pre-existing drift so we don't have to manually replay
 * every webhook.
 */

/* eslint-disable no-console */

import AWS from 'aws-sdk';
import Stripe from 'stripe';
import * as dotenv from 'dotenv';
import * as path from 'path';

// Load .env from backend/ root (script lives at backend/scripts/)
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

// ─── CLI args ─────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const envIdx = argv.indexOf('--env');
const ENV_MODE: 'dev' | 'prod' =
  envIdx >= 0 && argv[envIdx + 1] === 'prod' ? 'prod' : 'dev';
const userEmailIdx = argv.indexOf('--user-email');
const SINGLE_USER_EMAIL: string | null =
  userEmailIdx >= 0 ? (argv[userEmailIdx + 1] || null) : null;

// ─── Config ───────────────────────────────────────────────────────────────

const TABLE_PREFIX = ENV_MODE === 'dev' ? 'Dev-' : '';
const USERS_TABLE = `${TABLE_PREFIX}AW-Users`;

const STARTER_PRICE_ID = process.env.STRIPE_STARTER_PRICE_ID || '';
const COMPLETE_PRICE_ID = process.env.STRIPE_COMPLETE_PRICE_ID || '';

// Small pause between users to stay safely under Stripe rate limits
// (Stripe live-mode default: 100 req/s read, 25 req/s write -> 100ms = 10/s).
const SLEEP_MS_BETWEEN_USERS = 100;

// ─── Clients ──────────────────────────────────────────────────────────────

const stripeKey = process.env.STRIPE_SECRET_KEY;
if (!stripeKey) {
  console.error('[reconcile] FATAL: STRIPE_SECRET_KEY not set in env.');
  process.exit(1);
}

const stripe = new Stripe(stripeKey);

const dynamodb = new AWS.DynamoDB.DocumentClient({
  region: process.env.AWS_REGION || 'us-west-2',
});

// ─── Types ────────────────────────────────────────────────────────────────

interface UserRow {
  email: string;
  userId?: string;
  stripe_customer_id?: string;
  subscription_status?: string;
  subscriptionType?: string;
  current_period_end?: string;
  has_payment_method?: boolean;
}

interface DesiredState {
  subscription_status: string;
  subscriptionType: string | null;
  current_period_end: string | null;
  has_payment_method: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

const sleep = (ms: number) =>
  new Promise<void>(resolve => setTimeout(resolve, ms));

function deriveSubscriptionTypeFromPriceId(priceId: string | undefined): string | null {
  if (!priceId) return null;
  // Mirrors canonical deriveSubscriptionTypeFromPriceId in
  // backend/src/services/stripeService.ts:909-913. Tier names must match
  // what the live admin-reconcile path writes, otherwise this script
  // would flip every paid user's tier on a full sweep.
  if (priceId === STARTER_PRICE_ID) return 'Starter';
  if (priceId === COMPLETE_PRICE_ID) return 'Pro';
  return null;
}

function unixSecondsToIso(seconds: number | null | undefined): string | null {
  if (!seconds || typeof seconds !== 'number') return null;
  return new Date(seconds * 1000).toISOString();
}

/**
 * Scan AW-Users with pagination, filtered to rows that have a non-null,
 * non-empty stripe_customer_id.
 */
async function scanUsersWithStripeCustomer(): Promise<UserRow[]> {
  const out: UserRow[] = [];
  let lastKey: AWS.DynamoDB.DocumentClient.Key | undefined;
  let page = 0;
  do {
    page++;
    const res = await dynamodb
      .scan({
        TableName: USERS_TABLE,
        FilterExpression:
          'attribute_exists(stripe_customer_id) AND stripe_customer_id <> :empty',
        ExpressionAttributeValues: { ':empty': '' },
        ExclusiveStartKey: lastKey,
      })
      .promise();
    out.push(...((res.Items || []) as UserRow[]));
    lastKey = res.LastEvaluatedKey;
    console.log(
      `[reconcile] scan page ${page}: +${(res.Items || []).length} users (running total=${out.length})`
    );
  } while (lastKey);
  return out;
}

async function getUserByEmail(email: string): Promise<UserRow | null> {
  const res = await dynamodb
    .get({
      TableName: USERS_TABLE,
      Key: { email: email.toLowerCase() },
    })
    .promise();
  return (res.Item as UserRow) || null;
}

async function updateUserRow(
  email: string,
  updates: Partial<DesiredState>
): Promise<void> {
  const keys = Object.keys(updates);
  if (keys.length === 0) return;

  const expr: string[] = [];
  const names: Record<string, string> = {};
  const values: Record<string, any> = {};
  for (const k of keys) {
    expr.push(`#${k} = :${k}`);
    names[`#${k}`] = k;
    values[`:${k}`] = (updates as any)[k];
  }

  await dynamodb
    .update({
      TableName: USERS_TABLE,
      Key: { email },
      UpdateExpression: `SET ${expr.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    })
    .promise();
}

/**
 * Fetch the single source-of-truth Stripe subscription + payment method for
 * a customer and derive the target state for our 4 cached fields.
 */
async function deriveStripeState(
  customerId: string
): Promise<DesiredState> {
  // status: 'all' so we see canceled/incomplete/unpaid rows too. Sort by
  // relevance — active is the most authoritative, then trialing, etc.
  const subscriptions = await stripe.subscriptions.list({
    customer: customerId,
    status: 'all',
    limit: 10,
  });

  if (!subscriptions.data || subscriptions.data.length === 0) {
    // Customer exists in Stripe but has no subscription history. Treat as
    // Free-equivalent: canceled status, no tier beyond Free, no period_end,
    // check payment methods directly for has_payment_method.
    let hasPaymentMethod = false;
    try {
      const methods = await stripe.paymentMethods.list({
        customer: customerId,
        limit: 1,
      });
      hasPaymentMethod = (methods.data || []).length > 0;
    } catch {
      hasPaymentMethod = false;
    }
    return {
      subscription_status: 'canceled',
      subscriptionType: null,
      current_period_end: null,
      has_payment_method: hasPaymentMethod,
    };
  }

  // Pick the most authoritative subscription. Mirrors reconcileAllStripeUsers.
  const priority: Record<string, number> = {
    active: 0,
    trialing: 1,
    past_due: 2,
    unpaid: 3,
    incomplete: 4,
    incomplete_expired: 5,
    canceled: 6,
  };
  const sorted = [...subscriptions.data].sort(
    (a, b) => (priority[a.status] ?? 99) - (priority[b.status] ?? 99)
  );
  const sub = sorted[0];

  // Derive tier from the price. Mirrors reconcileAllStripeUsers at
  // stripeService.ts:840-868 — only overwrite subscriptionType when the
  // price maps to a known tier. Do NOT force-Free on canceled/incomplete_expired:
  // a canceled sub still has a price on it, so the tier reflects the user's
  // grandfathered access until an explicit webhook downgrades them. The
  // diffFields() helper below already skips subscriptionType when derivedType
  // is null (the `!== null` guard), so leaving the logic absent here is
  // strictly parity with the canonical admin-reconcile behavior.
  const priceId = sub.items?.data?.[0]?.price?.id;
  const subscriptionType = deriveSubscriptionTypeFromPriceId(priceId);

  // Payment method: prefer subscription's default; fall back to listing
  // customer's payment methods (covers users who rely on the default on
  // the customer, not the subscription).
  let hasPaymentMethod =
    !!sub.default_payment_method || !!(sub as any).default_source;
  if (!hasPaymentMethod) {
    try {
      const methods = await stripe.paymentMethods.list({
        customer: customerId,
        limit: 1,
      });
      hasPaymentMethod = (methods.data || []).length > 0;
    } catch {
      // non-fatal — leave false
    }
  }

  // Mirror reconcileAllStripeUsers' effectiveStatus derivation
  // (stripeService.ts:1047-1060): when a sub is active/trialing AND
  // cancel_at_period_end is set, we write the pseudo-status 'canceling'
  // so the UI "Canceling" badge survives. Without this, any full sweep
  // would clobber a canceling user back to 'active'.
  const effectiveStatus =
    sub.cancel_at_period_end &&
    (sub.status === 'active' || sub.status === 'trialing')
      ? 'canceling'
      : sub.status;

  return {
    subscription_status: effectiveStatus,
    subscriptionType,
    current_period_end: unixSecondsToIso((sub as any).current_period_end),
    has_payment_method: hasPaymentMethod,
  };
}

/**
 * Diff the user's DynamoDB row against Stripe ground truth. Only fields
 * that actually differ are returned for update.
 */
function diffFields(
  user: UserRow,
  desired: DesiredState
): Partial<DesiredState> {
  const updates: Partial<DesiredState> = {};
  if (user.subscription_status !== desired.subscription_status) {
    updates.subscription_status = desired.subscription_status;
  }
  if (
    desired.subscriptionType !== null &&
    user.subscriptionType !== desired.subscriptionType
  ) {
    updates.subscriptionType = desired.subscriptionType;
  }
  // current_period_end: null explicitly overwrites (no subscription)
  if ((user.current_period_end ?? null) !== desired.current_period_end) {
    updates.current_period_end = desired.current_period_end;
  }
  if (!!user.has_payment_method !== desired.has_payment_method) {
    updates.has_payment_method = desired.has_payment_method;
  }
  return updates;
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main() {
  console.log(
    `[reconcile] mode=${APPLY ? 'APPLY' : 'DRY-RUN'} env=${ENV_MODE} table=${USERS_TABLE}`
  );
  if (SINGLE_USER_EMAIL) {
    console.log(`[reconcile] single-user mode: ${SINGLE_USER_EMAIL}`);
  }

  let users: UserRow[];
  if (SINGLE_USER_EMAIL) {
    const u = await getUserByEmail(SINGLE_USER_EMAIL);
    if (!u) {
      console.error(
        `[reconcile] user not found in ${USERS_TABLE}: ${SINGLE_USER_EMAIL}`
      );
      process.exit(2);
    }
    if (!u.stripe_customer_id) {
      console.error(
        `[reconcile] user ${SINGLE_USER_EMAIL} has no stripe_customer_id — nothing to reconcile.`
      );
      process.exit(0);
    }
    users = [u];
  } else {
    users = await scanUsersWithStripeCustomer();
  }

  console.log(`[reconcile] ${users.length} users to process\n`);

  let withCustomer = 0;
  let noOp = 0;
  let wouldUpdate = 0;
  let updated = 0;
  let errors = 0;
  let stripeNotFound = 0;
  let noStripeSub = 0;

  for (let i = 0; i < users.length; i++) {
    const user = users[i];
    if (!user.stripe_customer_id) {
      // Shouldn't happen given the scan filter, but be defensive.
      continue;
    }
    withCustomer++;

    // Rate-limit: small pause between Stripe calls.
    if (i > 0) await sleep(SLEEP_MS_BETWEEN_USERS);

    try {
      const desired = await deriveStripeState(user.stripe_customer_id);

      if (!desired.current_period_end && desired.subscription_status === 'canceled') {
        // Helpful visibility: users with no active Stripe sub at all.
        noStripeSub++;
      }

      const updates = diffFields(user, desired);

      if (Object.keys(updates).length === 0) {
        noOp++;
        continue;
      }

      const diffStr = Object.entries(updates)
        .map(([k, v]) => {
          const before = (user as any)[k];
          return `${k}: ${JSON.stringify(before)} -> ${JSON.stringify(v)}`;
        })
        .join(' | ');

      if (!APPLY) {
        wouldUpdate++;
        console.log(
          `[reconcile] DRY-RUN would update email=${user.email} cust=${user.stripe_customer_id} :: ${diffStr}`
        );
        continue;
      }

      await updateUserRow(user.email, updates);
      updated++;
      console.log(
        `[reconcile] UPDATED email=${user.email} cust=${user.stripe_customer_id} :: ${diffStr}`
      );
    } catch (err: any) {
      const msg = err?.message || String(err);
      // Stripe's "No such customer" is a common, expected condition when user
      // rows carry prod customer IDs in the Dev table or when a Stripe
      // customer was deleted. Bucket it separately so the operator can tell
      // it apart from real errors.
      if (/no such customer/i.test(msg)) {
        stripeNotFound++;
      } else {
        errors++;
      }
      console.error(
        `[reconcile] ERROR email=${user.email} cust=${user.stripe_customer_id} :: ${msg}`
      );
    }
  }

  console.log('');
  console.log('=== SUMMARY ===');
  console.log(`  users scanned:                    ${users.length}`);
  console.log(`  with stripe_customer_id:          ${withCustomer}`);
  console.log(`  no-op (already correct):          ${noOp}`);
  console.log(`  no Stripe subscription at all:    ${noStripeSub}`);
  if (APPLY) {
    console.log(`  UPDATED:                          ${updated}`);
  } else {
    console.log(`  would update (dry-run):           ${wouldUpdate}`);
  }
  console.log(`  stripe "no such customer":        ${stripeNotFound}`);
  console.log(`  errors (other):                   ${errors}`);
  console.log('');
  console.log(
    `[reconcile] done. mode=${APPLY ? 'APPLY' : 'DRY-RUN'} env=${ENV_MODE}`
  );
  if (!APPLY && wouldUpdate > 0) {
    console.log('Re-run with --apply to persist.');
  }
}

main().catch(err => {
  console.error('[reconcile] FATAL:', err);
  process.exit(1);
});
