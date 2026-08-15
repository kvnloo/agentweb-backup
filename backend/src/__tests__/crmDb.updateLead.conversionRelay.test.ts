/**
 * ENG-926 §C — updateLead's CRM → Meta conversion relay hook.
 *
 * The relay is hooked inside updateLead rather than at the ~25 individual call sites
 * because the transition that matters most (a closed-won arriving from an external-CRM
 * webhook, not a human clicking a dropdown) does not go through the CRM UI route. These
 * tests pin the trigger conditions, since a hook this central is exactly the kind that
 * silently starts firing on writes it was never meant to see.
 */

// Keyed on TableName, not call order: updateLead reads AW-Leads once up front AND
// AW-LeadLists again for the fieldNames update, so an ordered mock queue silently feeds
// the wrong row to the relay dispatch and the test fails for a reason that has nothing to
// do with the code under test.
const getPromiseMock = jest.fn();
const updatePromiseMock = jest.fn();
const getSpy: jest.Mock = jest.fn((params: any) => ({
  promise: () => getPromiseMock(params),
}));
const updateSpy: jest.Mock = jest.fn(() => ({ promise: updatePromiseMock }));

jest.mock('aws-sdk', () => ({
  config: { update: jest.fn() },
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      get: getSpy,
      update: updateSpy,
      createSet: (values: string[]) => ({ values, type: 'String' }),
      query: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({ Items: [] }) })),
      put: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
      delete: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
      scan: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({ Items: [] }) })),
      batchGet: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
      batchWrite: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
    })),
  },
  S3: jest.fn(() => ({
    upload: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({ Location: '', Key: '' }) }),
    getObject: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
    getSignedUrl: jest.fn(),
  })),
  SecretsManager: jest.fn(() => ({
    getSecretValue: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({ SecretString: '{}' }) }),
  })),
}));

// db.ts dispatches through the DURABLE entry point (enqueue-then-process), not the raw
// relay — mocking the raw relay here would leave the hook calling an unmocked queue path.
const relaySpy = jest.fn().mockResolvedValue(undefined);
jest.mock('../services/metaConversionRelay', () => ({
  dispatchLeadStatusConversion: (...args: any[]) => relaySpy(...args),
}));

import { crmDb } from '../services/db';

/** The relay is dispatched fire-and-forget, so it lands after updateLead resolves. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

function leadUpdateParams(): any {
  for (const call of updateSpy.mock.calls) {
    const params = call[0];
    if (typeof params?.TableName === 'string' && params.TableName.endsWith('AW-Leads')) {
      return params;
    }
  }
  throw new Error('update on AW-Leads was not called');
}

const EXISTING_LEAD = { listId: 'list-1', leadId: 'lead-1', email: 'buyer@example.com', status: 'new' };
const LEAD_LIST = {
  listId: 'list-1',
  userId: 'user-1',
  statusConfig: [
    { value: 'new', label: 'New', color: 'gray', type: 'active' },
    { value: 'won', label: 'Won', color: 'green', type: 'won' },
  ],
};

/** Lets a single test swap in a different lead-list row (e.g. one with no owner). */
let leadListRow: any = LEAD_LIST;

beforeEach(() => {
  jest.clearAllMocks();
  leadListRow = LEAD_LIST;
  getPromiseMock.mockImplementation(async (params: any) =>
    String(params?.TableName).endsWith('AW-LeadLists')
      ? { Item: leadListRow }
      : { Item: EXISTING_LEAD },
  );
  updatePromiseMock.mockResolvedValue({ Attributes: { ...EXISTING_LEAD, status: 'won' } });
});

describe('updateLead → conversion relay dispatch', () => {
  it('dispatches on a real status transition', async () => {
    await crmDb.updateLead('list-1', 'lead-1', { status: 'won' });
    await flush();

    expect(relaySpy).toHaveBeenCalledTimes(1);
    expect(relaySpy.mock.calls[0][0]).toMatchObject({
      listId: 'list-1',
      userId: 'user-1',
      previousStatus: 'new',
    });
    expect(relaySpy.mock.calls[0][0].lead.status).toBe('won');
  });

  it('does NOT dispatch when the write does not touch status', async () => {
    updatePromiseMock.mockResolvedValue({ Attributes: { ...EXISTING_LEAD, firstName: 'Jane' } });

    await crmDb.updateLead('list-1', 'lead-1', { firstName: 'Jane' });
    await flush();

    expect(relaySpy).not.toHaveBeenCalled();
  });

  it('does NOT dispatch when status is re-written to the same value', async () => {
    updatePromiseMock.mockResolvedValue({ Attributes: { ...EXISTING_LEAD, status: 'new' } });

    await crmDb.updateLead('list-1', 'lead-1', { status: 'new' });
    await flush();

    expect(relaySpy).not.toHaveBeenCalled();
  });

  it('does NOT dispatch when suppressConversionRelay is set — the backfill seam', async () => {
    await crmDb.updateLead('list-1', 'lead-1', {
      status: 'won',
      suppressConversionRelay: true,
    });
    await flush();

    expect(relaySpy).not.toHaveBeenCalled();
  });

  it('records a relayed conversion atomically, never as a whole-array overwrite', async () => {
    // A read-modify-write here is what let two concurrent relays erase each other's
    // marker (Greptile P1 on #2412), so the append and its idempotence guard are the
    // behaviour under test — not merely that the field gets written.
    await crmDb.appendMetaConversionSent('list-1', 'lead-1', 'Purchase');

    const params = leadUpdateParams();
    expect(params.UpdateExpression).toContain('list_append(if_not_exists(#m, :empty), :new)');
    expect(params.ConditionExpression).toContain('NOT contains(#m, :event)');
    expect(params.ExpressionAttributeValues[':new']).toEqual(['Purchase']);
    expect(params.ExpressionAttributeValues[':event']).toBe('Purchase');
  });

  it('does not touch updatedAt — it is a GSI range key, and this is not a user edit', async () => {
    // Writing updatedAt forces DynamoDB to re-project the three sparse lookup GSIs, which
    // throws ValidationException on a legacy row carrying "" for email/linkedin/
    // nameCompanyKey — the hazard updateLead has self-heal logic for and this leaner write
    // does not. It would also reorder the customer's CRM list under an updatedAt sort
    // because a Meta event fired, which is not something they did.
    await crmDb.appendMetaConversionSent('list-1', 'lead-1', 'Purchase');

    const params = leadUpdateParams();
    expect(params.UpdateExpression).not.toContain('updatedAt');
    expect(params.ExpressionAttributeValues).not.toHaveProperty(':now');
  });

  it('treats the idempotence guard firing as success, not an error', async () => {
    const err: any = new Error('conditional check failed');
    err.code = 'ConditionalCheckFailedException';
    updatePromiseMock.mockRejectedValueOnce(err);

    await expect(crmDb.appendMetaConversionSent('list-1', 'lead-1', 'Purchase')).resolves.toBeUndefined();
  });

  it('keeps the backfill seam out of the list fieldNames (never a CSV/filter column)', async () => {
    await crmDb.updateLead('list-1', 'lead-1', {
      firstName: 'Jane',
      suppressConversionRelay: true,
    });

    const listUpdates = updateSpy.mock.calls
      .map((c) => c[0])
      .filter((p) => typeof p?.TableName === 'string' && p.TableName.endsWith('AW-LeadLists'));
    const serialized = JSON.stringify(listUpdates);
    expect(serialized).not.toContain('suppressConversionRelay');
  });

  it('dispatches BOTH an owed conversion and the live transition, not one or the other', async () => {
    // A lead can owe a qualified from an earlier queue outage and then legitimately win.
    // Treating these as alternatives silently dropped the owed one and left its marker.
    updatePromiseMock.mockResolvedValue({
      Attributes: {
        ...EXISTING_LEAD,
        status: 'won',
        metaConversionPending: { values: ['qualified'], type: 'String' },
      },
    });

    await crmDb.updateLead('list-1', 'lead-1', { status: 'won' });
    await flush();

    expect(relaySpy).toHaveBeenCalledTimes(2);
    const kinds = relaySpy.mock.calls.map((c) => c[0].conversionKind);
    expect(kinds).toContain('qualified');   // the owed one, by recorded kind
    expect(kinds).toContain(undefined);     // the live transition, derived from status
  });

  it('reads a legacy scalar pending marker as well as a set', async () => {
    updatePromiseMock.mockResolvedValue({
      Attributes: { ...EXISTING_LEAD, status: 'lost', metaConversionPending: 'won' },
    });

    await crmDb.updateLead('list-1', 'lead-1', { firstName: 'Jane' });
    await flush();

    expect(relaySpy).toHaveBeenCalledTimes(1);
    expect(relaySpy.mock.calls[0][0].conversionKind).toBe('won');
  });

  it('clears ONLY the conversion just sent, never an unrelated owed one', async () => {
    await crmDb.appendMetaConversionSent('list-1', 'lead-1', 'won');

    const params = leadUpdateParams();
    expect(params.UpdateExpression).toContain('DELETE metaConversionPending :kinds');
    expect(params.UpdateExpression).not.toContain('REMOVE metaConversionPending');
    expect(params.ExpressionAttributeValues[':kinds']).toEqual({ values: ['won'], type: 'String' });
  });

  it('recovery keeps an UNRELATED owed conversion instead of erasing it', async () => {
    // Scalar marker owes 'qualified'; a 'won' just succeeded. A blanket REMOVE would drop
    // the qualified that was never sent.
    const err: any = new Error('type mismatch');
    err.code = 'ValidationException';
    updatePromiseMock.mockRejectedValueOnce(err).mockResolvedValue({});
    getPromiseMock.mockImplementation(async (params: any) =>
      String(params?.TableName).endsWith('AW-LeadLists')
        ? { Item: leadListRow }
        : { Item: { ...EXISTING_LEAD, metaConversionPending: 'qualified' } },
    );

    await crmDb.appendMetaConversionSent('list-1', 'lead-1', 'won');

    const leadWrites = updateSpy.mock.calls
      .map((c) => c[0])
      .filter((p) => typeof p?.TableName === 'string' && p.TableName.endsWith('AW-Leads'));
    const recovery = leadWrites[leadWrites.length - 1];
    expect(recovery.UpdateExpression).toContain('metaConversionPending = :survivors');
    expect(recovery.UpdateExpression).not.toContain('REMOVE metaConversionPending');
    expect(recovery.ExpressionAttributeValues[':survivors']).toEqual({
      values: ['qualified'],
      type: 'String',
    });
  });

  it('recovers when a lead still carries the legacy SCALAR marker (set ops would reject)', async () => {
    // DynamoDB rejects the whole update with ValidationException if ADD/DELETE hit a scalar
    // attribute. Left unhandled, the send goes unrecorded and reconciliation re-dispatches
    // the same conversion forever.
    const err: any = new Error('type mismatch');
    err.code = 'ValidationException';
    updatePromiseMock.mockRejectedValueOnce(err).mockResolvedValue({});
    getPromiseMock.mockImplementation(async (params: any) =>
      String(params?.TableName).endsWith('AW-LeadLists')
        ? { Item: leadListRow }
        : { Item: { ...EXISTING_LEAD, metaConversionPending: 'won' } },
    );

    await crmDb.appendMetaConversionSent('list-1', 'lead-1', 'won');

    const leadWrites = updateSpy.mock.calls
      .map((c) => c[0])
      .filter((p) => typeof p?.TableName === 'string' && p.TableName.endsWith('AW-Leads'));
    // Nothing else owed, so the attribute goes entirely — via REMOVE, which works on any type.
    const recovery = leadWrites[leadWrites.length - 1];
    expect(recovery.UpdateExpression).toContain('REMOVE metaConversionPending');
    expect(recovery.UpdateExpression).not.toContain('DELETE metaConversionPending');
    expect(recovery.UpdateExpression).toContain('list_append');
  });

  it('pending-marker recovery UNIONS with what the scalar already owed', async () => {
    // Scalar owes 'qualified'; a 'won' becomes owed too. Repairing by dropping and adding
    // only the new kind would discard the qualified that was never sent.
    const err: any = new Error('type mismatch');
    err.code = 'ValidationException';
    updatePromiseMock.mockRejectedValueOnce(err).mockResolvedValue({});
    getPromiseMock.mockImplementation(async (params: any) =>
      String(params?.TableName).endsWith('AW-LeadLists')
        ? { Item: leadListRow }
        : { Item: { ...EXISTING_LEAD, metaConversionPending: 'qualified' } },
    );

    await crmDb.markConversionRelayPending('list-1', 'lead-1', 'won');

    const leadWrites = updateSpy.mock.calls
      .map((c) => c[0])
      .filter((p) => typeof p?.TableName === 'string' && p.TableName.endsWith('AW-Leads'));
    const repair = leadWrites[leadWrites.length - 1];
    expect(repair.UpdateExpression).toBe('SET metaConversionPending = :kinds');
    expect(new Set(repair.ExpressionAttributeValues[':kinds'].values)).toEqual(
      new Set(['qualified', 'won']),
    );
  });

  it('recovers the pending-marker write against a legacy scalar too', async () => {
    const err: any = new Error('type mismatch');
    err.code = 'ValidationException';
    updatePromiseMock.mockRejectedValueOnce(err).mockResolvedValue({});

    await crmDb.markConversionRelayPending('list-1', 'lead-1', 'won');

    const exprs = updateSpy.mock.calls
      .map((c) => c[0])
      .filter((p) => typeof p?.TableName === 'string' && p.TableName.endsWith('AW-Leads'))
      .map((p) => p.UpdateExpression);
    // First attempt is the set ADD; the repair rewrites the attribute in the correct shape.
    expect(exprs).toContain('ADD metaConversionPending :kinds');
    expect(exprs).toContain('SET metaConversionPending = :kinds');
  });

  it('adds to the pending set rather than overwriting it', async () => {
    await crmDb.markConversionRelayPending('list-1', 'lead-1', 'qualified');

    const params = leadUpdateParams();
    expect(params.UpdateExpression).toBe('ADD metaConversionPending :kinds');
    expect(params.ExpressionAttributeValues[':kinds']).toEqual({ values: ['qualified'], type: 'String' });
  });

  it('a relay failure never breaks the lead write', async () => {
    relaySpy.mockRejectedValueOnce(new Error('Meta exploded'));

    await expect(crmDb.updateLead('list-1', 'lead-1', { status: 'won' })).resolves.toMatchObject({
      status: 'won',
    });
    await flush();
  });

  it('does not dispatch when the list has no owner to resolve a pixel from', async () => {
    leadListRow = { listId: 'list-1' };

    await crmDb.updateLead('list-1', 'lead-1', { status: 'won' });
    await flush();

    expect(relaySpy).not.toHaveBeenCalled();
  });
});
