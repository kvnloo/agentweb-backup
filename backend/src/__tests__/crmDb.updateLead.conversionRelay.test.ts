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

const relaySpy = jest.fn().mockResolvedValue({ skipped: true, reason: 'test' });
jest.mock('../services/metaConversionRelay', () => ({
  relayLeadStatusEvent: (...args: any[]) => relaySpy(...args),
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

  it('does NOT dispatch when suppressConversionRelay is set — the relay\'s own bookkeeping write', async () => {
    await crmDb.updateLead('list-1', 'lead-1', {
      status: 'won',
      metaConversionsSent: ['Purchase'],
      suppressConversionRelay: true,
    });
    await flush();

    expect(relaySpy).not.toHaveBeenCalled();
  });

  it('persists metaConversionsSent', async () => {
    await crmDb.updateLead('list-1', 'lead-1', {
      metaConversionsSent: ['Purchase'],
      suppressConversionRelay: true,
    });

    const params = leadUpdateParams();
    expect(params.UpdateExpression).toContain('#metaConversionsSent = :metaConversionsSent');
    expect(params.ExpressionAttributeValues[':metaConversionsSent']).toEqual(['Purchase']);
  });

  it('keeps relay bookkeeping out of the list fieldNames (never a CSV/filter column)', async () => {
    await crmDb.updateLead('list-1', 'lead-1', {
      metaConversionsSent: ['Purchase'],
      suppressConversionRelay: true,
    });

    const listUpdates = updateSpy.mock.calls
      .map((c) => c[0])
      .filter((p) => typeof p?.TableName === 'string' && p.TableName.endsWith('AW-LeadLists'));
    const serialized = JSON.stringify(listUpdates);
    expect(serialized).not.toContain('metaConversionsSent');
    expect(serialized).not.toContain('suppressConversionRelay');
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
