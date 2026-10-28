/**
 * ENG-673: the AW-SmartleadPushRuns table definition, in both places it is written, and its registration at boot.
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

import { CRITICAL_TABLE_SETTINGS, CRITICAL_TABLE_SPECS } from '../ensureCriticalTables';
import {
  ACTIVE_RUNS_INDEX,
  LIST_RUNS_INDEX,
  OWNER_RUNS_INDEX,
  RUNS_BY_TIME_INDEX,
  SMARTLEAD_PUSH_RUNS_TABLE,
  SMARTLEAD_PUSH_RUNS_TABLE_SPEC as SPEC,
} from '../smartleadPushRunDb';

describe('AW-SmartleadPushRuns table definition (ENG-673)', () => {
  it('defines every key attribute and nothing unused, which DynamoDB rejects at create time', () => {
    const defined = new Set(SPEC.AttributeDefinitions.map(a => a.AttributeName));
    const used = new Set([
      ...SPEC.KeySchema.map(k => k.AttributeName),
      ...(SPEC.GlobalSecondaryIndexes ?? []).flatMap(g => g.KeySchema.map(k => k.AttributeName)),
    ]);
    expect([...defined].sort()).toEqual([...used].sort());
    expect(SPEC.KeySchema).toEqual([{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: 'sk', KeyType: 'RANGE' }]);
  });

  it('has exactly the four indexes, each with the keys the design promises (indexes cannot be added later)', () => {
    const byName = Object.fromEntries((SPEC.GlobalSecondaryIndexes ?? []).map(g => [g.IndexName, g.KeySchema.map(k => k.AttributeName)]));
    expect(byName).toEqual({
      [LIST_RUNS_INDEX]: ['listId', 'createdAt'],
      [OWNER_RUNS_INDEX]: ['ownerId', 'createdAt'],
      [RUNS_BY_TIME_INDEX]: ['kind', 'createdAt'],
      [ACTIVE_RUNS_INDEX]: ['active', 'leaseUntil'],
    });
  });

  it('projects a summary, never a key attribute (DynamoDB rejects a key listed as non-key) and never everything', () => {
    for (const g of SPEC.GlobalSecondaryIndexes ?? []) {
      expect(g.Projection.ProjectionType).toBe('INCLUDE');
      const keys = new Set([...g.KeySchema.map(k => k.AttributeName), 'pk', 'sk']);
      for (const attr of g.Projection.NonKeyAttributes ?? []) expect(keys.has(attr)).toBe(false);
    }
  });

  it('is on-demand, created at boot, with TTL and recovery applied as separate steps, and not delete-protected yet', () => {
    expect(SPEC.BillingMode).toBe('PAY_PER_REQUEST');
    expect((SPEC as any).DeletionProtectionEnabled).toBeUndefined();
    expect(CRITICAL_TABLE_SPECS).toContain(SPEC);
    expect(CRITICAL_TABLE_SETTINGS[SMARTLEAD_PUSH_RUNS_TABLE]).toEqual({ ttlAttribute: 'ttl', pointInTimeRecovery: true });
  });

  it('is exactly what scripts/create-tables.ts creates, and that script also turns on TTL and recovery', async () => {
    const { createSmartleadPushRunsTable } = require('../../scripts/create-tables');
    await createSmartleadPushRunsTable();
    expect(createTable).toHaveBeenCalledTimes(1);
    expect(createTable.mock.calls[0][0]).toEqual(SPEC);
    expect(waitFor).toHaveBeenCalledWith('tableExists', { TableName: SPEC.TableName });
    expect(updateTimeToLive).toHaveBeenCalledWith({ TableName: SPEC.TableName, TimeToLiveSpecification: { Enabled: true, AttributeName: 'ttl' } });
    expect(updateContinuousBackups).toHaveBeenCalledWith({ TableName: SPEC.TableName, PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true } });
  });
});
