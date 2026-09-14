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
 * Ensure the critical telemetry tables exist. Idempotent and non-fatal —
 * intended to be called once (fire-and-forget) at server startup.
 */
export async function ensureCriticalTables(
  dynamo: AWS.DynamoDB = new AWS.DynamoDB({ region: process.env.AWS_REGION || 'us-west-2' }),
): Promise<void> {
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
