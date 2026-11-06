/**
 * Self-healing provisioning for the telemetry/loop tables.
 *
 * Three incidents in two days (AW-OnboardingMetrics, Dev-AW-LoopLearning, and
 * the loop-events table before them) shared one root cause: a table is defined
 * in scripts/create-tables.ts but the script is never run on deploy, and every
 * writer is best-effort (swallows ResourceNotFound) — so an absent table is
 * invisible until someone reads the data weeks later. For the loop/telemetry
 * tables that whole subsystem then runs as a no-op (gate write-back, attribution,
 * funnel) with zero signal.
 *
 * This module ensures those specific tables exist at server boot. createTable is
 * idempotent (ResourceInUseException = already there), and the whole sweep is
 * non-fatal: a failure logs loudly but never blocks startup. The table-name
 * constants are imported from the modules that WRITE them, so this can never
 * drift from what the writers expect.
 */

import AWS from 'aws-sdk';
import { LOOP_EVENTS_TABLE } from '../loops/core/sensors/eventTableEventSource';
import { LOOP_LEARNING_TABLE } from '../loops/core/learning/dynamoLearningStore';
import { LOOP_DISPATCHES_TABLE } from './loopDispatchTracker';
import { ONBOARDING_METRICS_TABLE, ONBOARDING_METRICS_STEP_INDEX } from './onboardingMetricsService';
import { CONTACT_EVENTS_TABLE, CONTACT_EVENTS_SOURCE_RECORD_INDEX } from './contactEventsDb';
import { LLM_CHARGE_EVENTS_TABLE, LLM_CHARGE_EVENTS_OCCURRED_AT_INDEX } from './llmChargeAuditDb';
import { SPEND_EVENTS_TABLE, SPEND_EVENTS_OCCURRED_AT_INDEX } from './spendEventDb';
import { SPEND_PROJECTION_TABLE } from './spendProjectionDb';
import { LLM_CONNECTIONS_TABLE_SPEC } from './funding/llmConnectionDb';
import { ATTEMPT_USAGE_TABLE_SPEC, ATTEMPT_USAGE_TABLE, ATTEMPT_USAGE_TTL_ATTRIBUTE } from './funding/dynamoAttemptUsageJournal';
import { SMARTLEAD_PUSH_RUNS_TABLE_SPEC, SMARTLEAD_PUSH_RUNS_TABLE, SMARTLEAD_PUSH_RUNS_TTL_ATTRIBUTE } from './smartleadPushRunDb';
import { SLACK_START_TABLE_SPEC, SLACK_START_TABLE, SLACK_START_TTL_ATTRIBUTE } from './slackStart/slackStartStore';

export const CRITICAL_TABLE_SPECS: AWS.DynamoDB.CreateTableInput[] = [
  {
    TableName: LLM_CHARGE_EVENTS_TABLE,
    AttributeDefinitions: [
      { AttributeName: 'billingUserId', AttributeType: 'S' },
      { AttributeName: 'eventId', AttributeType: 'S' },
      { AttributeName: 'occurredAt', AttributeType: 'S' },
    ],
    KeySchema: [
      { AttributeName: 'billingUserId', KeyType: 'HASH' },
      { AttributeName: 'eventId', KeyType: 'RANGE' },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: LLM_CHARGE_EVENTS_OCCURRED_AT_INDEX,
        KeySchema: [
          { AttributeName: 'billingUserId', KeyType: 'HASH' },
          { AttributeName: 'occurredAt', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
      },
    ],
    BillingMode: 'PAY_PER_REQUEST',
  },
  {
    // ENG-1250 §1 -- cross-vendor immutable spend ledger. Ensured at boot for
    // the same reason the tables below are: it is defined in
    // scripts/create-tables.ts, and that script is not run on deploy.
    // No TTL by design (see spendEventDb.ts).
    TableName: SPEND_EVENTS_TABLE,
    AttributeDefinitions: [
      { AttributeName: 'billingUserId', AttributeType: 'S' },
      { AttributeName: 'eventId', AttributeType: 'S' },
      { AttributeName: 'occurredAt', AttributeType: 'S' },
    ],
    KeySchema: [
      { AttributeName: 'billingUserId', KeyType: 'HASH' },
      { AttributeName: 'eventId', KeyType: 'RANGE' },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: SPEND_EVENTS_OCCURRED_AT_INDEX,
        KeySchema: [
          { AttributeName: 'billingUserId', KeyType: 'HASH' },
          { AttributeName: 'occurredAt', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
      },
    ],
    BillingMode: 'PAY_PER_REQUEST',
    // The immutable, no-TTL, seven-year money ledger is the one table where an
    // accidental console/API delete is unrecoverable. Guard it. Purely
    // additive protection -- it prevents a delete, it cannot orphan, expose or
    // lose data, so it is the opposite of what the data-plane gate guards.
    DeletionProtectionEnabled: true,
  },
  {
    // ENG-1250 §3b -- persisted monthly projection for fast admission. Keyed
    // exactly at the read shape (billingUserId + billingMonth), a single Get.
    // Delete-protected like the ledger; no TTL (authoritative for admission,
    // rebuildable from events).
    TableName: SPEND_PROJECTION_TABLE,
    AttributeDefinitions: [
      { AttributeName: 'billingUserId', AttributeType: 'S' },
      { AttributeName: 'billingMonth', AttributeType: 'S' },
    ],
    KeySchema: [
      { AttributeName: 'billingUserId', KeyType: 'HASH' },
      { AttributeName: 'billingMonth', KeyType: 'RANGE' },
    ],
    BillingMode: 'PAY_PER_REQUEST',
    DeletionProtectionEnabled: true,
  },
  // ENG-2105 -- customer LLM provider keys (KMS envelope-encrypted). Ensured at
  // boot like the tables above, because create-tables.ts is not run on deploy.
  LLM_CONNECTIONS_TABLE_SPEC,
  // ENG-2106 -- customer-funded usage journal (append-only, no secrets, 400-day TTL,
  // point-in-time recovery on). TTL and recovery are applied by reconcileTableSettings.
  ATTEMPT_USAGE_TABLE_SPEC,
  // ENG-673 -- Smartlead push runs (a run item and a lock item per list and campaign; no deletion protection until proven).
  SMARTLEAD_PUSH_RUNS_TABLE_SPEC,
  // ENG-2782 -- public Slack-start intakes, their domain-dedupe locks and rate-limit counters.
  SLACK_START_TABLE_SPEC,
  {
    TableName: LOOP_EVENTS_TABLE,
    AttributeDefinitions: [
      { AttributeName: 'loopId', AttributeType: 'S' },
      { AttributeName: 'tsSession', AttributeType: 'S' },
    ],
    KeySchema: [
      { AttributeName: 'loopId', KeyType: 'HASH' },
      { AttributeName: 'tsSession', KeyType: 'RANGE' },
    ],
    BillingMode: 'PAY_PER_REQUEST',
  },
  {
    TableName: LOOP_LEARNING_TABLE,
    AttributeDefinitions: [
      { AttributeName: 'loopId', AttributeType: 'S' },
      { AttributeName: 'sortKey', AttributeType: 'S' },
    ],
    KeySchema: [
      { AttributeName: 'loopId', KeyType: 'HASH' },
      { AttributeName: 'sortKey', KeyType: 'RANGE' },
    ],
    BillingMode: 'PAY_PER_REQUEST',
  },
  {
    TableName: LOOP_DISPATCHES_TABLE,
    AttributeDefinitions: [{ AttributeName: 'messageTs', AttributeType: 'S' }],
    KeySchema: [{ AttributeName: 'messageTs', KeyType: 'HASH' }],
    BillingMode: 'PAY_PER_REQUEST',
  },
  {
    TableName: ONBOARDING_METRICS_TABLE,
    AttributeDefinitions: [
      { AttributeName: 'metricId', AttributeType: 'S' },
      { AttributeName: 'step', AttributeType: 'S' },
      { AttributeName: 'startedAt', AttributeType: 'S' },
    ],
    KeySchema: [{ AttributeName: 'metricId', KeyType: 'HASH' }],
    GlobalSecondaryIndexes: [
      {
        IndexName: ONBOARDING_METRICS_STEP_INDEX,
        KeySchema: [
          { AttributeName: 'step', KeyType: 'HASH' },
          { AttributeName: 'startedAt', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
      },
    ],
    BillingMode: 'PAY_PER_REQUEST',
  },
  {
    TableName: CONTACT_EVENTS_TABLE,
    AttributeDefinitions: [
      { AttributeName: 'contactId', AttributeType: 'S' },
      { AttributeName: 'eventTimestamp', AttributeType: 'S' },
      { AttributeName: 'sourceRecordId', AttributeType: 'S' },
    ],
    KeySchema: [
      { AttributeName: 'contactId', KeyType: 'HASH' },
      { AttributeName: 'eventTimestamp', KeyType: 'RANGE' },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: CONTACT_EVENTS_SOURCE_RECORD_INDEX,
        KeySchema: [
          { AttributeName: 'sourceRecordId', KeyType: 'HASH' },
        ],
        Projection: { ProjectionType: 'ALL' },
      },
    ],
    BillingMode: 'PAY_PER_REQUEST',
  },
];

/**
 * Settings CreateTable cannot apply. DynamoDB TTL and point-in-time recovery are
 * separate calls, and nothing else in this codebase has ever made them at runtime (TTL
 * on the other boot-created tables was enabled by hand), so whether the backend's role
 * may is unverified. Each is attempted at boot, non-fatally and loudly, and has to be
 * checked after a deploy; see finding-boot-created-tables-need-manual-ttl.
 */
export const CRITICAL_TABLE_SETTINGS: Record<string, { ttlAttribute?: string; pointInTimeRecovery?: boolean }> = {
  [ATTEMPT_USAGE_TABLE]: { ttlAttribute: ATTEMPT_USAGE_TTL_ATTRIBUTE, pointInTimeRecovery: true },
  [SMARTLEAD_PUSH_RUNS_TABLE]: { ttlAttribute: SMARTLEAD_PUSH_RUNS_TTL_ATTRIBUTE, pointInTimeRecovery: true },
  [SLACK_START_TABLE]: { ttlAttribute: SLACK_START_TTL_ATTRIBUTE, pointInTimeRecovery: true },
};

const ACTIVE_POLL_MS = 3_000;
const ACTIVE_POLL_ATTEMPTS = 20;

/**
 * Ensure the critical telemetry tables exist. Idempotent and non-fatal —
 * intended to be called once (fire-and-forget) at server startup.
 */
export async function ensureCriticalTables(
  dynamo: AWS.DynamoDB = new AWS.DynamoDB({ region: process.env.AWS_REGION || 'us-west-2' }),
  opts: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<void> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (const spec of CRITICAL_TABLE_SPECS) {
    try {
      await dynamo.createTable(spec).promise();
      console.log(`[ensureCriticalTables] created missing table ${spec.TableName}`);
      // A freshly created table already carries the spec's protection flag, so
      // only the already-exists path below needs the reconcile.
    } catch (err: any) {
      if (err?.code === 'ResourceInUseException') {
        // Table exists. createTable never updates it, so a spec flag added
        // AFTER the table was created (e.g. DeletionProtectionEnabled on the
        // money ledger) would otherwise never reach production. Reconcile it.
        if (spec.DeletionProtectionEnabled) {
          await ensureDeletionProtection(dynamo, spec.TableName);
        }
        continue;
      }
      console.error(
        `[ensureCriticalTables] could NOT ensure ${spec.TableName} (telemetry for this loop will be lost until fixed):`,
        err?.message || err,
      );
    }
  }

  // After every table exists: the settings CreateTable cannot apply. A table just
  // created is still CREATING, so each is waited on until ACTIVE (bounded), and each
  // setting is checked first so a restart that finds it already on writes nothing.
  for (const [tableName, settings] of Object.entries(CRITICAL_TABLE_SETTINGS)) {
    await reconcileTableSettings(dynamo, tableName, settings, sleep);
  }
}

async function reconcileTableSettings(
  dynamo: AWS.DynamoDB,
  tableName: string,
  settings: { ttlAttribute?: string; pointInTimeRecovery?: boolean },
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  try {
    let active = false;
    for (let i = 0; i < ACTIVE_POLL_ATTEMPTS && !active; i++) {
      const described = await dynamo.describeTable({ TableName: tableName }).promise();
      active = described.Table?.TableStatus === 'ACTIVE';
      if (!active) await sleep(ACTIVE_POLL_MS);
    }
    if (!active) {
      console.error(`[ensureCriticalTables] ${tableName} was not ACTIVE in time; TTL and recovery settings will be retried at the next boot`);
      return;
    }
  } catch (err: any) {
    console.error(`[ensureCriticalTables] could NOT check ${tableName} before applying its settings:`, err?.message || err);
    return;
  }
  if (settings.ttlAttribute) await ensureTimeToLive(dynamo, tableName, settings.ttlAttribute);
  if (settings.pointInTimeRecovery) await ensurePointInTimeRecovery(dynamo, tableName, sleep);
}

/** Describe-first and fail-safe, like ensureDeletionProtection. A table with a `ttl` attribute but TTL off never expires. */
async function ensureTimeToLive(dynamo: AWS.DynamoDB, tableName: string, attribute: string): Promise<void> {
  try {
    const described = await dynamo.describeTimeToLive({ TableName: tableName }).promise();
    const status = described.TimeToLiveDescription?.TimeToLiveStatus;
    if ((status === 'ENABLED' || status === 'ENABLING') && described.TimeToLiveDescription?.AttributeName === attribute) return;
    await dynamo
      .updateTimeToLive({ TableName: tableName, TimeToLiveSpecification: { Enabled: true, AttributeName: attribute } })
      .promise();
    console.log(`[ensureCriticalTables] enabled TTL on ${tableName} (attribute: ${attribute})`);
  } catch (err: any) {
    console.error(
      `[ensureCriticalTables] could NOT enable TTL on ${tableName} (needs dynamodb:DescribeTimeToLive and dynamodb:UpdateTimeToLive). Rows will not expire until someone runs: ` +
        `aws dynamodb update-time-to-live --table-name ${tableName} --time-to-live-specification "Enabled=true,AttributeName=${attribute}"`,
      err?.message || err,
    );
  }
}

async function ensurePointInTimeRecovery(dynamo: AWS.DynamoDB, tableName: string, sleep: (ms: number) => Promise<void>): Promise<void> {
  try {
    // Right after a table turns ACTIVE, DynamoDB can briefly answer that continuous
    // backups are not available yet; that is transient, so wait it out a little.
    let described = await dynamo.describeContinuousBackups({ TableName: tableName }).promise().catch(async (err: any) => {
      if (err?.code !== 'ContinuousBackupsUnavailableException') throw err;
      for (let i = 0; i < 5; i++) {
        await sleep(ACTIVE_POLL_MS);
        try {
          return await dynamo.describeContinuousBackups({ TableName: tableName }).promise();
        } catch (again: any) {
          if (again?.code !== 'ContinuousBackupsUnavailableException') throw again;
        }
      }
      throw err;
    });
    if (described.ContinuousBackupsDescription?.PointInTimeRecoveryDescription?.PointInTimeRecoveryStatus === 'ENABLED') return;
    await dynamo
      .updateContinuousBackups({ TableName: tableName, PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true } })
      .promise();
    console.log(`[ensureCriticalTables] enabled point-in-time recovery on ${tableName}`);
  } catch (err: any) {
    console.error(
      `[ensureCriticalTables] could NOT enable point-in-time recovery on ${tableName} (needs dynamodb:DescribeContinuousBackups and dynamodb:UpdateContinuousBackups). Run: ` +
        `aws dynamodb update-continuous-backups --table-name ${tableName} --point-in-time-recovery-specification PointInTimeRecoveryEnabled=true`,
      err?.message || err,
    );
  }
}

/**
 * Turn on deletion protection for an existing table, idempotently and
 * fail-safe.
 *
 * Describe-first, so a table already protected costs one read and no write —
 * this runs on every boot and must not churn UpdateTable. Any failure
 * (including the EB role lacking dynamodb:UpdateTable) is logged and swallowed:
 * a missing safety flag must never take startup down, and the flag is purely
 * additive, so the worst case of not applying it is the status quo.
 */
async function ensureDeletionProtection(dynamo: AWS.DynamoDB, tableName: string): Promise<void> {
  try {
    const described = await dynamo.describeTable({ TableName: tableName }).promise();
    if (described.Table?.DeletionProtectionEnabled) return; // already on — no write
    await dynamo.updateTable({ TableName: tableName, DeletionProtectionEnabled: true }).promise();
    console.log(`[ensureCriticalTables] enabled deletion protection on ${tableName}`);
  } catch (err: any) {
    console.error(
      `[ensureCriticalTables] could NOT enable deletion protection on ${tableName} ` +
        `(needs dynamodb:UpdateTable; the table is unprotected until this succeeds):`,
      err?.message || err,
    );
  }
}
