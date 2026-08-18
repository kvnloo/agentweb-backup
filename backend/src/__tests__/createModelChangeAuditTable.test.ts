/**
 * ENG-1217 — the CreateTable call for the model-change audit store.
 *
 * This code had never executed anywhere: it is not covered by any test, and it
 * has not been run against an AWS account, yet it is the first thing an operator
 * does when rolling this feature out. A malformed request here fails at setup and
 * reads as an AWS problem rather than a code one.
 *
 * The assertion that matters most is not the shape — it is that the table this
 * script CREATES is the table the service READS. Each computes its name
 * independently from NODE_ENV, so they are two copies of one decision and can
 * drift. If they ever disagree, every audit write fails with
 * ResourceNotFoundException while the table sits there looking correct.
 *
 * The rest encode invariants DynamoDB enforces at request time, which is the only
 * place they would otherwise surface: every key attribute must be defined, every
 * definition must be used by a key, and there must be exactly one HASH.
 */

const createTable = jest.fn(() => ({ promise: async () => ({}) }));
const updateTimeToLive = jest.fn(() => ({ promise: async () => ({}) }));

jest.mock('aws-sdk', () => {
  class DynamoDB {
    createTable = createTable;
    updateTimeToLive = updateTimeToLive;
    static DocumentClient = class {
      put() {
        return { promise: async () => ({}) };
      }
    };
  }
  return {
    DynamoDB,
    S3: class {},
    config: { update: jest.fn() },
  };
});

import { createModelChangeAuditTable } from '../scripts/create-tables';
import { MODEL_CHANGE_AUDIT_TABLE } from '../services/llmModelChangeAuditDb';

beforeEach(() => {
  createTable.mockClear();
  updateTimeToLive.mockClear();
});

describe('createModelChangeAuditTable', () => {
  it('creates exactly the table the audit service reads from', async () => {
    // The drift guard. Two independent computations of one name.
    await createModelChangeAuditTable();

    expect(createTable).toHaveBeenCalledTimes(1);
    const params = (createTable.mock.calls[0] as unknown as [AWS.DynamoDB.CreateTableInput])[0];
    expect(params.TableName).toBe(MODEL_CHANGE_AUDIT_TABLE);
  });

  it('keys on the billing subject with a time-sortable range key', async () => {
    await createModelChangeAuditTable();
    const params = (createTable.mock.calls[0] as unknown as [AWS.DynamoDB.CreateTableInput])[0];

    expect(params.KeySchema).toEqual([
      { AttributeName: 'billingUserId', KeyType: 'HASH' },
      { AttributeName: 'sk', KeyType: 'RANGE' },
    ]);
  });

  it('defines every key attribute, and defines nothing it does not key on', async () => {
    // DynamoDB rejects both directions: an undefined key attribute, and a
    // definition unused by any key or index.
    await createModelChangeAuditTable();
    const params = (createTable.mock.calls[0] as unknown as [AWS.DynamoDB.CreateTableInput])[0];

    const defined = new Set((params.AttributeDefinitions || []).map((a) => a.AttributeName));
    const keyed = new Set((params.KeySchema || []).map((k) => k.AttributeName));
    for (const indexList of [params.GlobalSecondaryIndexes || [], params.LocalSecondaryIndexes || []]) {
      for (const index of indexList as { KeySchema: { AttributeName: string }[] }[]) {
        for (const key of index.KeySchema) keyed.add(key.AttributeName);
      }
    }

    expect([...keyed].filter((name) => !defined.has(name))).toEqual([]);
    expect([...defined].filter((name) => !keyed.has(name))).toEqual([]);
    expect((params.AttributeDefinitions || []).every((a) => a.AttributeType === 'S')).toBe(true);
  });

  it('declares exactly one HASH key', async () => {
    await createModelChangeAuditTable();
    const params = (createTable.mock.calls[0] as unknown as [AWS.DynamoDB.CreateTableInput])[0];

    expect((params.KeySchema || []).filter((k) => k.KeyType === 'HASH')).toHaveLength(1);
  });

  it('provisions on demand and carries no secondary index', async () => {
    // No GSI is a deliberate design property, not an omission: putting `changedAt`
    // first in the sort key is what makes the base table range-queryable, which is
    // the mistake llmChargeAuditDb had to add an index to correct.
    await createModelChangeAuditTable();
    const params = (createTable.mock.calls[0] as unknown as [AWS.DynamoDB.CreateTableInput])[0];

    expect(params.BillingMode).toBe('PAY_PER_REQUEST');
    expect(params.ProvisionedThroughput).toBeUndefined();
    expect(params.GlobalSecondaryIndexes).toBeUndefined();
  });

  it('treats an already-existing table as success, so setup is re-runnable', async () => {
    createTable.mockReturnValueOnce({
      promise: async () => {
        throw Object.assign(new Error('Table already exists'), { code: 'ResourceInUseException' });
      },
    } as never);

    await expect(createModelChangeAuditTable()).resolves.toBeUndefined();
  });

  it('surfaces any other failure rather than reporting a table that was not created', async () => {
    createTable.mockReturnValueOnce({
      promise: async () => {
        throw Object.assign(new Error('no permission'), { code: 'AccessDeniedException' });
      },
    } as never);

    await expect(createModelChangeAuditTable()).rejects.toThrow(/no permission/);
  });
});

/**
 * The TTL step. `recordModelChange` writes a 365-day `ttl`, and CreateTable does
 * not switch expiry on -- so without this call the attribute is decorative and the
 * table keeps every customer billing decision forever. Nothing at runtime reports
 * it missing, which is exactly why it needs a test rather than a runbook line.
 */
describe('createModelChangeAuditTable — retention', () => {
  it('enables native TTL on the attribute the rows actually carry', async () => {
    await createModelChangeAuditTable();

    expect(updateTimeToLive).toHaveBeenCalledTimes(1);
    const params = (updateTimeToLive.mock.calls[0] as unknown as [AWS.DynamoDB.UpdateTimeToLiveInput])[0];
    expect(params.TableName).toBe(MODEL_CHANGE_AUDIT_TABLE);
    // The attribute name must match what the writer sets, or expiry silently
    // never fires — the same class of miss as configuring no TTL at all.
    expect(params.TimeToLiveSpecification).toEqual({ Enabled: true, AttributeName: 'ttl' });
  });

  it('still enables TTL when the table already exists', async () => {
    // The common case in every environment after the first run. A table created
    // before this shipped has TTL off, and skipping the call on the
    // already-exists path would leave it off forever.
    createTable.mockReturnValueOnce({
      promise: async () => {
        throw Object.assign(new Error('Table already exists'), { code: 'ResourceInUseException' });
      },
    } as never);

    await createModelChangeAuditTable();
    expect(updateTimeToLive).toHaveBeenCalledTimes(1);
  });

  it('does not fail table setup when the role cannot enable TTL', async () => {
    // dynamodb:UpdateTimeToLive is not always granted. Refusing to finish setup
    // over a retention setting would be the wrong trade; the warning carries the
    // exact command instead.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    updateTimeToLive.mockReturnValueOnce({
      promise: async () => {
        throw Object.assign(new Error('not authorized'), { code: 'AccessDeniedException' });
      },
    } as never);

    await expect(createModelChangeAuditTable()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('update-time-to-live'));
    warn.mockRestore();
  });

  it('treats an already-enabled TTL as success', async () => {
    updateTimeToLive.mockReturnValueOnce({
      promise: async () => {
        throw Object.assign(new Error('TimeToLive is already enabled'), { code: 'ValidationException' });
      },
    } as never);

    await expect(createModelChangeAuditTable()).resolves.toBeUndefined();
  });
});
