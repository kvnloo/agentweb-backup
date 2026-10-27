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
      await ensureCriticalTables(client as any, { sleep: async () => {} });
      expect(updated).toContain('AW-SpendEvents');
      const call = client.updateTable.mock.calls.find((c: any) => c[0].TableName === 'AW-SpendEvents');
      expect(call).toBeDefined();
      expect(call![0].DeletionProtectionEnabled).toBe(true);
    });

    it('does NOT write when protection is already on — describe-first, no churn', async () => {
      const { client } = existingLedgerDynamo({ protected: true });
      await ensureCriticalTables(client as any, { sleep: async () => {} });
      expect(client.updateTable).not.toHaveBeenCalled();
    });

    it('never throws when the role lacks UpdateTable — the flag is additive, startup must survive', async () => {
      const { client } = existingLedgerDynamo({ protected: false, canUpdate: false });
      await expect(ensureCriticalTables(client as any, { sleep: async () => {} })).resolves.toBeUndefined();
    });

    it('only reconciles tables whose spec requests protection', async () => {
      // The two money tables carry DeletionProtectionEnabled: the event ledger
      // and the §3b projection. Both are authoritative and hard to rebuild.
      // ENG-2105 adds the customer LLM key store: losing it makes every customer
      // re-enter their provider keys. ENG-2106 adds the customer-funded usage journal,
      // the history behind the per-connection usage bar.
      const guarded = CRITICAL_TABLE_SPECS.filter((s) => (s as any).DeletionProtectionEnabled);
      expect(guarded.map((s) => s.TableName).sort()).toEqual(['AW-AttemptUsage', 'AW-LlmConnections', 'AW-SpendEvents', 'AW-SpendProjection']);
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

  it('provisions AW-SpendProjection keyed billingUserId+billingMonth, delete-protected, no TTL', () => {
    const sp = CRITICAL_TABLE_SPECS.find((s) => s.TableName.endsWith('AW-SpendProjection'));
    expect(sp).toBeDefined();
    expect(sp!.KeySchema).toEqual([
      { AttributeName: 'billingUserId', KeyType: 'HASH' },
      { AttributeName: 'billingMonth', KeyType: 'RANGE' },
    ]);
    expect((sp as any).DeletionProtectionEnabled).toBe(true);
    expect(Object.keys(sp!)).not.toContain('TimeToLiveSpecification');
    // Admission reads by exact key — no GSI needed, and none should creep in.
    expect(sp!.GlobalSecondaryIndexes).toBeUndefined();
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
  describe('TTL and point-in-time recovery on the attempt journal (ENG-2106)', () => {
    const TABLE = 'AW-AttemptUsage';

    // Every table "already exists"; only the attempt journal's settings are modeled.
    function settingsDynamo(opts: {
      statuses?: string[]; // successive describeTable answers for the journal; last repeats
      ttl?: { status: string; attribute?: string };
      pitr?: string;
      ttlDenied?: boolean;
      pitrDenied?: boolean;
      describeFails?: boolean;
    }) {
      const calls: Record<string, any[]> = { updateTimeToLive: [], updateContinuousBackups: [] };
      let polls = 0;
      const denied = () => Object.assign(new Error('not authorized'), { code: 'AccessDeniedException' });
      const client = {
        createTable: jest.fn(() => ({ promise: async () => { throw Object.assign(new Error('exists'), { code: 'ResourceInUseException' }); } })),
        describeTable: jest.fn((p: any) => ({
          promise: async () => {
            if (opts.describeFails) throw denied();
            const statuses = opts.statuses ?? ['ACTIVE'];
            // Only the journal's answers are scripted; other guarded tables are ACTIVE.
            const status = p.TableName === TABLE ? statuses[Math.min(polls++, statuses.length - 1)] : 'ACTIVE';
            return { Table: { TableName: p.TableName, TableStatus: status, DeletionProtectionEnabled: true } };
          },
        })),
        updateTable: jest.fn(() => ({ promise: async () => ({}) })),
        describeTimeToLive: jest.fn(() => ({
          promise: async () => ({
            TimeToLiveDescription: { TimeToLiveStatus: opts.ttl?.status ?? 'DISABLED', AttributeName: opts.ttl?.attribute },
          }),
        })),
        // Only the journal's calls are modeled and recorded: other tables with settings (ENG-673 added one) just succeed.
        updateTimeToLive: jest.fn((p: any) => ({
          promise: async () => {
            if (p.TableName !== TABLE) return {};
            if (opts.ttlDenied) throw denied();
            calls.updateTimeToLive.push(p);
            return {};
          },
        })),
        describeContinuousBackups: jest.fn(() => ({
          promise: async () => ({
            ContinuousBackupsDescription: { PointInTimeRecoveryDescription: { PointInTimeRecoveryStatus: opts.pitr ?? 'DISABLED' } },
          }),
        })),
        updateContinuousBackups: jest.fn((p: any) => ({
          promise: async () => {
            if (p.TableName !== TABLE) return {};
            if (opts.pitrDenied) throw denied();
            calls.updateContinuousBackups.push(p);
            return {};
          },
        })),
      };
      return { client, calls };
    }

    const sleep = jest.fn(async () => undefined);
    let errorSpy: jest.SpyInstance;
    beforeEach(() => {
      sleep.mockClear();
      jest.spyOn(console, 'log').mockImplementation(() => {});
      errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => jest.restoreAllMocks());

    it('turns on TTL for the ttl attribute and point-in-time recovery when both are off', async () => {
      const { client, calls } = settingsDynamo({});
      await ensureCriticalTables(client as any, { sleep });
      expect(calls.updateTimeToLive).toEqual([
        { TableName: TABLE, TimeToLiveSpecification: { Enabled: true, AttributeName: 'ttl' } },
      ]);
      expect(calls.updateContinuousBackups).toEqual([
        { TableName: TABLE, PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true } },
      ]);
    });

    it('waits for a table that was just created to become ACTIVE before touching its settings', async () => {
      const { client, calls } = settingsDynamo({ statuses: ['ACTIVE', 'CREATING', 'CREATING', 'ACTIVE'] }) // first answer is the deletion-protection check;
      await ensureCriticalTables(client as any, { sleep });
      expect(sleep).toHaveBeenCalledTimes(2);
      expect(calls.updateTimeToLive).toHaveLength(1);
      expect(calls.updateContinuousBackups).toHaveLength(1);
    });

    it('does nothing, and writes nothing, when both are already on', async () => {
      const { client, calls } = settingsDynamo({ ttl: { status: 'ENABLED', attribute: 'ttl' }, pitr: 'ENABLED' });
      await ensureCriticalTables(client as any, { sleep });
      expect(calls.updateTimeToLive).toHaveLength(0);
      expect(calls.updateContinuousBackups).toHaveLength(0);
    });

    it('also treats TTL that is still switching on as done', async () => {
      const { client, calls } = settingsDynamo({ ttl: { status: 'ENABLING', attribute: 'ttl' } });
      await ensureCriticalTables(client as any, { sleep });
      expect(calls.updateTimeToLive).toHaveLength(0);
    });

    it('corrects TTL that is on for a different attribute', async () => {
      const { client, calls } = settingsDynamo({ ttl: { status: 'ENABLED', attribute: 'expiresAt' } });
      await ensureCriticalTables(client as any, { sleep });
      expect(calls.updateTimeToLive).toHaveLength(1);
    });

    it('says loudly, with the command to run, when the role may not enable TTL, and still tries recovery', async () => {
      const { client, calls } = settingsDynamo({ ttlDenied: true });
      await expect(ensureCriticalTables(client as any, { sleep })).resolves.toBeUndefined();
      const message = errorSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(message).toContain('could NOT enable TTL on AW-AttemptUsage');
      expect(message).toContain('aws dynamodb update-time-to-live --table-name AW-AttemptUsage');
      expect(calls.updateContinuousBackups).toHaveLength(1);
    });

    it('says loudly, with the command to run, when the role may not enable recovery, and still sets TTL', async () => {
      const { client, calls } = settingsDynamo({ pitrDenied: true });
      await expect(ensureCriticalTables(client as any, { sleep })).resolves.toBeUndefined();
      const message = errorSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(message).toContain('could NOT enable point-in-time recovery on AW-AttemptUsage');
      expect(message).toContain('aws dynamodb update-continuous-backups --table-name AW-AttemptUsage');
      expect(calls.updateTimeToLive).toHaveLength(1);
    });

    it('waits out the short window after creation when continuous backups are not available yet', async () => {
      const { client, calls } = settingsDynamo({});
      let n = 0;
      (client as any).describeContinuousBackups = jest.fn((p: any) => ({
        promise: async () => {
          // Only the journal is scripted; other tables with settings (ENG-673 added one) already have recovery on.
          if (p.TableName !== TABLE) return { ContinuousBackupsDescription: { PointInTimeRecoveryDescription: { PointInTimeRecoveryStatus: 'ENABLED' } } };
          if (n++ < 2) throw Object.assign(new Error('not yet'), { code: 'ContinuousBackupsUnavailableException' });
          return { ContinuousBackupsDescription: { PointInTimeRecoveryDescription: { PointInTimeRecoveryStatus: 'DISABLED' } } };
        },
      }));
      await ensureCriticalTables(client as any, { sleep });
      expect(calls.updateContinuousBackups).toHaveLength(1);
      const journalChecks = (client as any).describeContinuousBackups.mock.calls.filter((c: any[]) => c[0].TableName === TABLE);
      expect(journalChecks).toHaveLength(3);
    });

    it('gives up quietly for this boot, and retries next boot, if the table never becomes ACTIVE', async () => {
      const { client, calls } = settingsDynamo({ statuses: ['CREATING'] });
      await expect(ensureCriticalTables(client as any, { sleep })).resolves.toBeUndefined();
      expect(calls.updateTimeToLive).toHaveLength(0);
      expect(calls.updateContinuousBackups).toHaveLength(0);
      expect(errorSpy.mock.calls.map((c) => c.join(' ')).join('\n')).toContain('was not ACTIVE in time');
    });

    it('does not throw when the table cannot even be described', async () => {
      const { client } = settingsDynamo({ describeFails: true });
      await expect(ensureCriticalTables(client as any, { sleep })).resolves.toBeUndefined();
      expect(errorSpy.mock.calls.map((c) => c.join(' ')).join('\n')).toContain('could NOT check AW-AttemptUsage');
    });
  });
});
