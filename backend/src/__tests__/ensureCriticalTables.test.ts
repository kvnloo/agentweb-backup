/**
 * ensureCriticalTables — self-healing provisioning for telemetry/loop tables.
 *
 * Root cause it addresses (three incidents: AW-OnboardingMetrics 2026-06-12,
 * Dev-AW-LoopLearning 2026-06-13, and the loop tables before that): tables are
 * defined in create-tables.ts but the script is never run on deploy, and every
 * writer swallows ResourceNotFound, so an absent table is invisible for months.
 * This ensures the critical tables exist at boot — idempotent, non-fatal.
 */

import { ensureCriticalTables, CRITICAL_TABLE_SPECS } from '../services/ensureCriticalTables';

function fakeDynamo(existing: string[] = []) {
  const created: string[] = [];
  const client = {
    createTable: jest.fn((params: any) => ({
      promise: async () => {
        if (existing.includes(params.TableName)) {
          const err: any = new Error('exists');
          err.code = 'ResourceInUseException';
          throw err;
        }
        created.push(params.TableName);
        return { TableDescription: { TableName: params.TableName } };
      },
    })),
  };
  return { client, created };
}

describe('ensureCriticalTables', () => {
  it('creates every critical table when none exist', async () => {
    const { client, created } = fakeDynamo([]);
    await ensureCriticalTables(client as any);
    expect(created.sort()).toEqual(CRITICAL_TABLE_SPECS.map((s) => s.TableName).sort());
  });

  it('is idempotent — swallows ResourceInUseException for existing tables', async () => {
    const allNames = CRITICAL_TABLE_SPECS.map((s) => s.TableName);
    const { client, created } = fakeDynamo(allNames);
    await expect(ensureCriticalTables(client as any)).resolves.toBeUndefined();
    expect(created).toEqual([]);
  });

  it('continues past a failing table and never throws (non-fatal at boot)', async () => {
    const { created } = fakeDynamo([]);
    const client = {
      createTable: jest.fn((params: any) => ({
        promise: async () => {
          if (params.TableName === CRITICAL_TABLE_SPECS[0].TableName) {
            throw new Error('AccessDenied');
          }
          created.push(params.TableName);
          return {};
        },
      })),
    };
    await expect(ensureCriticalTables(client as any)).resolves.toBeUndefined();
    // every other table still attempted
    expect(created.length).toBe(CRITICAL_TABLE_SPECS.length - 1);
  });

  it('covers the loop + onboarding telemetry tables by name', () => {
    const names = CRITICAL_TABLE_SPECS.map((s) => s.TableName);
    expect(names).toEqual(expect.arrayContaining([
      'Dev-AW-LoopEvents',
      'Dev-AW-LoopLearning',
      'Dev-AW-LoopDispatches',
    ]));
    expect(names.some((n) => n.endsWith('AW-OnboardingMetrics'))).toBe(true);
    expect(names.some((n) => n.endsWith('AW-LlmChargeEvents'))).toBe(true);
  });

  it('onboarding metrics spec carries the StepStartedAtIndex GSI', () => {
    const om = CRITICAL_TABLE_SPECS.find((s) => s.TableName.endsWith('AW-OnboardingMetrics'))!;
    expect((om.GlobalSecondaryIndexes ?? []).some((g: any) => g.IndexName === 'StepStartedAtIndex')).toBe(true);
  });

  it('provisions AW-ContactEvents with contactId/eventTimestamp keys and the sourceRecordId-index GSI', () => {
    const ce = CRITICAL_TABLE_SPECS.find((s) => s.TableName.endsWith('AW-ContactEvents'));
    expect(ce).toBeDefined();
    expect(ce!.KeySchema).toEqual([
      { AttributeName: 'contactId', KeyType: 'HASH' },
      { AttributeName: 'eventTimestamp', KeyType: 'RANGE' },
    ]);
    expect(ce!.AttributeDefinitions).toEqual(expect.arrayContaining([
      { AttributeName: 'contactId', AttributeType: 'S' },
      { AttributeName: 'eventTimestamp', AttributeType: 'S' },
      { AttributeName: 'sourceRecordId', AttributeType: 'S' },
    ]));
    const gsi = (ce!.GlobalSecondaryIndexes ?? []).find((g: any) => g.IndexName === 'sourceRecordId-index');
    expect(gsi).toBeDefined();
    expect(gsi!.KeySchema).toEqual([{ AttributeName: 'sourceRecordId', KeyType: 'HASH' }]);
    expect(gsi!.Projection).toEqual({ ProjectionType: 'ALL' });
    expect(ce!.BillingMode).toBe('PAY_PER_REQUEST');
  });
});
