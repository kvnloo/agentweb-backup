/**
 * ENG-2106 (A3): the AW-AttemptUsage table definition, in both places it is written.
 */
const createTable = jest.fn((_params: any) => ({ promise: async () => ({}) }));
const waitFor = jest.fn((_state: string, _params: any) => ({ promise: async () => ({}) }));
const updateTimeToLive = jest.fn((_params: any) => ({ promise: async () => ({}) }));
const updateContinuousBackups = jest.fn((_params: any) => ({ promise: async () => ({}) }));
jest.mock('aws-sdk', () => {
  class DynamoDB {
    createTable = createTable;
    waitFor = waitFor;
    updateTimeToLive = updateTimeToLive;
    updateContinuousBackups = updateContinuousBackups;
    static DocumentClient = class {};
  }
  const mod = { DynamoDB, S3: class {}, config: { update: jest.fn() } };
  return { __esModule: true, default: mod, ...mod };
});

import { CRITICAL_TABLE_SETTINGS, CRITICAL_TABLE_SPECS } from '../../ensureCriticalTables';
import {
  ATTEMPT_USAGE_CONNECTION_INDEX,
  ATTEMPT_USAGE_PRINCIPAL_INDEX,
  ATTEMPT_USAGE_RUN_INDEX,
  ATTEMPT_USAGE_TABLE,
  ATTEMPT_USAGE_TABLE_SPEC as SPEC,
} from '../dynamoAttemptUsageJournal';

describe('AW-AttemptUsage table definition', () => {
  it('defines every key attribute and nothing unused, which DynamoDB rejects at create time', () => {
    const defined = new Set(SPEC.AttributeDefinitions.map((a) => a.AttributeName));
    const used = new Set([
      ...SPEC.KeySchema.map((k) => k.AttributeName),
      ...(SPEC.GlobalSecondaryIndexes ?? []).flatMap((g) => g.KeySchema.map((k) => k.AttributeName)),
    ]);
    expect([...defined].sort()).toEqual([...used].sort());
    expect(SPEC.KeySchema).toEqual([{ AttributeName: 'attemptId', KeyType: 'HASH' }]);
  });

  it('has the run, connection and customer indexes, each ordered by start time', () => {
    const byName = Object.fromEntries((SPEC.GlobalSecondaryIndexes ?? []).map((g) => [g.IndexName, g.KeySchema.map((k) => k.AttributeName)]));
    expect(byName).toEqual({
      [ATTEMPT_USAGE_RUN_INDEX]: ['runId', 'startedAt'],
      [ATTEMPT_USAGE_CONNECTION_INDEX]: ['connectionId', 'startedAt'],
      [ATTEMPT_USAGE_PRINCIPAL_INDEX]: ['fundingPrincipalId', 'startedAt'],
    });
  });

  it('is delete-protected, on-demand and created at boot, with TTL and recovery applied as separate steps', () => {
    expect(SPEC.DeletionProtectionEnabled).toBe(true);
    expect(SPEC.BillingMode).toBe('PAY_PER_REQUEST');
    expect(CRITICAL_TABLE_SPECS).toContain(SPEC);
    expect(CRITICAL_TABLE_SETTINGS[ATTEMPT_USAGE_TABLE]).toEqual({ ttlAttribute: 'ttl', pointInTimeRecovery: true });
  });

  it('is exactly what scripts/create-tables.ts creates, and that script also turns on TTL and recovery', async () => {
    const { createAttemptUsageTable } = require('../../../scripts/create-tables');
    await createAttemptUsageTable();
    expect(createTable).toHaveBeenCalledTimes(1);
    expect(createTable.mock.calls[0][0]).toEqual(SPEC);
    // TTL and recovery need an ACTIVE table, so the script waits for it first.
    expect(waitFor).toHaveBeenCalledWith('tableExists', { TableName: SPEC.TableName });
    expect(updateTimeToLive).toHaveBeenCalledWith({
      TableName: SPEC.TableName,
      TimeToLiveSpecification: { Enabled: true, AttributeName: 'ttl' },
    });
    expect(updateContinuousBackups).toHaveBeenCalledWith({
      TableName: SPEC.TableName,
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
    });
  });
});
