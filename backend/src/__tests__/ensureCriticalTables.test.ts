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

  describe('deletion-protection reconcile on the money ledger', () => {
    // A mock that models an EXISTING table (createTable -> ResourceInUseException)
    // plus describe/update, so the already-exists reconcile path is exercised.
    function existingLedgerDynamo(opts: { protected: boolean; canUpdate?: boolean }) {
      const updated: string[] = [];
      const client = {
        createTable: jest.fn(() => ({
          promise: async () => {
            const err: any = new Error('exists');
            err.code = 'ResourceInUseException';
            throw err;
          },
        })),
        describeTable: jest.fn((p: any) => ({
          promise: async () => ({ Table: { TableName: p.TableName, DeletionProtectionEnabled: opts.protected } }),
        })),
        updateTable: jest.fn((p: any) => ({
          promise: async () => {
            if (opts.canUpdate === false) {
              const err: any = new Error('denied');
              err.code = 'AccessDeniedException';
              throw err;
            }
            updated.push(p.TableName);
            return {};
          },
        })),
      };
      return { client, updated };
    }

    it('enables protection on an existing unprotected ledger', async () => {
      const { client, updated } = existingLedgerDynamo({ protected: false });
      await ensureCriticalTables(client as any);
      expect(updated).toContain('AW-SpendEvents');
      const call = client.updateTable.mock.calls.find((c: any) => c[0].TableName === 'AW-SpendEvents');
      expect(call).toBeDefined();
      expect(call![0].DeletionProtectionEnabled).toBe(true);
    });

    it('does NOT write when protection is already on — describe-first, no churn', async () => {
      const { client } = existingLedgerDynamo({ protected: true });
      await ensureCriticalTables(client as any);
      expect(client.updateTable).not.toHaveBeenCalled();
    });

    it('never throws when the role lacks UpdateTable — the flag is additive, startup must survive', async () => {
      const { client } = existingLedgerDynamo({ protected: false, canUpdate: false });
      await expect(ensureCriticalTables(client as any)).resolves.toBeUndefined();
    });

    it('only reconciles tables whose spec requests protection', async () => {
      // AW-SpendEvents is the only critical spec with DeletionProtectionEnabled.
      const guarded = CRITICAL_TABLE_SPECS.filter((s) => (s as any).DeletionProtectionEnabled);
      expect(guarded.map((s) => s.TableName)).toEqual(['AW-SpendEvents']);
    });
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

  it('provisions AW-SpendEvents with the approved key shape, GSI, and no TTL', () => {
    // ENG-1250: Harsha approved these exact parameters on 2026-09-03. A drift
    // here is a data-plane change that never went back through the gate.
    const se = CRITICAL_TABLE_SPECS.find((s) => s.TableName.endsWith('AW-SpendEvents'));
    expect(se).toBeDefined();
    expect(se!.KeySchema).toEqual([
      { AttributeName: 'billingUserId', KeyType: 'HASH' },
      { AttributeName: 'eventId', KeyType: 'RANGE' },
    ]);
    expect(se!.GlobalSecondaryIndexes).toEqual([
      expect.objectContaining({
        IndexName: 'BillingUserOccurredAtIndex',
        KeySchema: [
          { AttributeName: 'billingUserId', KeyType: 'HASH' },
          { AttributeName: 'occurredAt', KeyType: 'RANGE' },
        ],
      }),
    ]);
    // No TTL was approved, and CreateTable cannot express one anyway — this
    // asserts nobody later adds a TimeToLiveSpecification believing it does.
    expect(Object.keys(se!)).not.toContain('TimeToLiveSpecification');
    // The money ledger must be delete-protected (spec, and enabled live).
    expect((se as any).DeletionProtectionEnabled).toBe(true);
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
