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
    } catch (err: any) {
      if (err?.code === 'ResourceInUseException') continue; // already exists — normal
      console.error(
        `[ensureCriticalTables] could NOT ensure ${spec.TableName} (telemetry for this loop will be lost until fixed):`,
        err?.message || err,
      );
    }
  }
}
