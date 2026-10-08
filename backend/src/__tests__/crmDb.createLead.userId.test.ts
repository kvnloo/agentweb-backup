jest.mock('../services/orgLeadNotificationService', () => ({ dispatchLeadCreated: jest.fn(), dispatchLeadsCreated: jest.fn() }));
import { dispatchLeadCreated, dispatchLeadsCreated } from '../services/orgLeadNotificationService';
// Tests that crmDb.createLead writes the userId (derived from parent list)
// and nameCompanyKey attributes used by CRM-history Tier 0 GSIs.

const queryPromiseMock = jest.fn();
const getPromiseMock = jest.fn();
const putPromiseMock = jest.fn();
const batchWriteMock = jest.fn();
const putSpy: jest.Mock = jest.fn(() => ({ promise: putPromiseMock }));

jest.mock('aws-sdk', () => ({
  config: { update: jest.fn() },
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      query: jest.fn(() => ({ promise: queryPromiseMock })),
      get: jest.fn(() => ({ promise: getPromiseMock })),
      put: putSpy,
      update: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
      delete: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
      scan: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({ Items: [] }) })),
      batchGet: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
      batchWrite: jest.fn((params: unknown) => ({ promise: () => batchWriteMock(params) })),
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

import { crmDb } from '../services/db';

function lastPutItem(): any {
  const call = putSpy.mock.calls[putSpy.mock.calls.length - 1];
  if (!call) throw new Error('put was not called');
  return (call[0] as any).Item;
}

describe('crmDb.createLead — userId + nameCompanyKey', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    queryPromiseMock.mockResolvedValue({ Items: [] });
    putPromiseMock.mockResolvedValue({});
  });

  it('derives userId from the parent list and writes it on the new lead', async () => {
    getPromiseMock
      .mockResolvedValueOnce({ Item: { listId: 'list-1', userId: 'user-42' } })
      .mockResolvedValue({ Item: null });

    await crmDb.createLead('list-1', {
      email: 'jane@acme.com',
      firstName: 'Jane',
      lastName: 'Doe',
      company: 'Acme',
    });

    expect(lastPutItem().userId).toBe('user-42');
  });

  // F6: `phone: leadData.phone` in createLead's buildLeadCrmFields call was unpinned —
  // deleting it left 1,640 tests green. leadSchema tests buildLeadCrmFields in isolation
  // and the bulk-path test covers batchCreateLeads; nothing covered the WIRING between
  // them. createLead is the path landing-page capture and the lead-forwarding webhook use,
  // which is ENG-2082's entire motivation.
  it('stamps lifecycle inbox for a PHONE-ONLY lead (the ENG-2082 wiring)', async () => {
    getPromiseMock
      .mockResolvedValueOnce({ Item: { listId: 'list-1', userId: 'user-1' } })
      .mockResolvedValue({ Item: null });

    await crmDb.createLead('list-1', { phone: '2125550147', firstName: 'Grace' });

    const item = lastPutItem();
    expect(item.lifecycle).toBe('inbox');
    // No email, so no domain to derive.
    expect(item.domain).toBeUndefined();
  });

  it('still stamps inbox for an emailed lead, and derives its domain', async () => {
    getPromiseMock
      .mockResolvedValueOnce({ Item: { listId: 'list-1', userId: 'user-1' } })
      .mockResolvedValue({ Item: null });

    await crmDb.createLead('list-1', { email: 'Ada@Example.com', firstName: 'Ada' });

    const item = lastPutItem();
    expect(item.lifecycle).toBe('inbox');
    expect(item.domain).toBe('example.com');
  });

  it('stamps nothing for a lead with neither an email nor a phone', async () => {
    getPromiseMock
      .mockResolvedValueOnce({ Item: { listId: 'list-1', userId: 'user-1' } })
      .mockResolvedValue({ Item: null });

    await crmDb.createLead('list-1', { linkedin: 'https://linkedin.com/in/nobody' });

    const item = lastPutItem();
    expect(item.lifecycle).toBeUndefined();
    expect(item.domain).toBeUndefined();
  });

  it('writes nameCompanyKey when all of firstName/lastName/company are set', async () => {
    getPromiseMock
      .mockResolvedValueOnce({ Item: { listId: 'list-1', userId: 'user-1' } })
      .mockResolvedValue({ Item: null });

    await crmDb.createLead('list-1', {
      firstName: 'Jane',
      lastName: 'Doe',
      company: 'Acme Inc',
    });

    expect(lastPutItem().nameCompanyKey).toBe('jane|doe|acme inc');
  });

  it('omits nameCompanyKey when any of firstName/lastName/company is missing', async () => {
    getPromiseMock
      .mockResolvedValueOnce({ Item: { listId: 'list-1', userId: 'user-1' } })
      .mockResolvedValue({ Item: null });

    await crmDb.createLead('list-1', {
      firstName: 'Jane',
      lastName: 'Doe',
      // company missing
    });

    expect(lastPutItem().nameCompanyKey).toBeUndefined();
  });

  it('still creates the lead even if list lookup fails (userId omitted, not fatal)', async () => {
    // Reject only the first get call (my new userId-derive lookup); subsequent
    // gets (e.g., field-names sync) succeed with a null Item.
    getPromiseMock
      .mockRejectedValueOnce(new Error('list fetch threw'))
      .mockResolvedValue({ Item: null });

    await crmDb.createLead('list-1', {
      firstName: 'Jane',
      lastName: 'Doe',
      company: 'Acme',
    });

    const item = lastPutItem();
    expect(item.userId).toBeUndefined();
    expect(item.nameCompanyKey).toBe('jane|doe|acme');
  });

  it('honors caller-supplied userId (overrides list-derived)', async () => {
    getPromiseMock
      .mockResolvedValueOnce({ Item: { listId: 'list-1', userId: 'user-from-list' } })
      .mockResolvedValue({ Item: null });

    await crmDb.createLead('list-1', {
      firstName: 'Jane',
      lastName: 'Doe',
      company: 'Acme',
      userId: 'user-explicit',
    });

    expect(lastPutItem().userId).toBe('user-explicit');
  });

  it('keeps linkedin sparse and canonical: writes only a normalized non-empty value', async () => {
    getPromiseMock
      .mockResolvedValueOnce({ Item: { listId: 'list-1', userId: 'user-1' } })
      .mockResolvedValue({ Item: null });

    await crmDb.createLead('list-1', {
      firstName: 'Jane',
      lastName: 'Doe',
      company: 'Acme',
      linkedin: '   ',
    });
    expect(lastPutItem().linkedin).toBeUndefined();

    await crmDb.createLead('list-1', {
      firstName: 'Jane2',
      lastName: 'Doe2',
      company: 'Acme',
      linkedin: 'https://linkedin.com/in/jane',
    });
    // ENG-787: createLead now canonicalizes via normalizeLinkedInUrl (scheme + www)
    // so the LinkedinLookupIndex GSI stays canonical and dedup reads match.
    expect(lastPutItem().linkedin).toBe('https://www.linkedin.com/in/jane');
  });
});

// ENG-787: deterministic leadId + fail-if-exists conditional create, so two
// concurrent mirrors of the same invitee resolve to ONE lead (Greptile P1).
describe('crmDb.createLead — deterministic id + failIfExists', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    queryPromiseMock.mockResolvedValue({ Items: [] });
    putPromiseMock.mockResolvedValue({});
  });

  function lastPutParams(): any {
    const call = putSpy.mock.calls[putSpy.mock.calls.length - 1];
    if (!call) throw new Error('put was not called');
    return call[0];
  }

  it('uses the caller-supplied leadId and guards the put with attribute_not_exists', async () => {
    getPromiseMock.mockResolvedValueOnce({ Item: { listId: 'list-1', userId: 'user-1' } }).mockResolvedValue({ Item: null });

    const res = await crmDb.createLead('list-1', {
      firstName: 'Jane', lastName: 'Doe', company: 'Acme',
      leadId: 'lead_li_deadbeef', failIfExists: true,
    });

    expect((res as any).leadId).toBe('lead_li_deadbeef');
    expect(lastPutParams().Item.leadId).toBe('lead_li_deadbeef');
    expect(lastPutParams().ConditionExpression).toBe('attribute_not_exists(leadId)');
  });

  it('does NOT set a ConditionExpression when failIfExists is absent (default put unchanged)', async () => {
    getPromiseMock.mockResolvedValueOnce({ Item: { listId: 'list-1', userId: 'user-1' } }).mockResolvedValue({ Item: null });
    await crmDb.createLead('list-1', { firstName: 'Jane', lastName: 'Doe' });
    expect(lastPutParams().ConditionExpression).toBeUndefined();
  });

  it('throws a tagged leadAlreadyExists error when the conditional put loses the race', async () => {
    getPromiseMock.mockResolvedValueOnce({ Item: { listId: 'list-1', userId: 'user-1' } }).mockResolvedValue({ Item: null });
    const conditionErr: any = new Error('The conditional request failed');
    conditionErr.code = 'ConditionalCheckFailedException';
    putPromiseMock.mockRejectedValueOnce(conditionErr);

    await expect(
      crmDb.createLead('list-1', { firstName: 'Jane', leadId: 'lead_li_x', failIfExists: true }),
    ).rejects.toMatchObject({ leadAlreadyExists: true });
  });
});


describe('lead-created notification write boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    queryPromiseMock.mockResolvedValue({ Items: [] });
    getPromiseMock.mockResolvedValue({ Item: { listId: 'list-1', userId: 'owner' } });
    putPromiseMock.mockResolvedValue({});
  });
  it('threads only the explicit server origin and does not persist it on the lead', async () => {
    const lead = await crmDb.createLead('list-1', { firstName: 'Jane', customFields: { origin: 'form_fill' } }, 'linkedin');
    expect(dispatchLeadCreated).toHaveBeenCalledWith('list-1', lead.leadId, 'linkedin');
    expect(lead).not.toHaveProperty('origin');
  });
  it('returns the saved lead while Slack work remains pending', async () => {
    (dispatchLeadCreated as jest.Mock).mockReturnValue(new Promise(() => {}));
    const lead = await crmDb.createLead('list-1', { firstName: 'Jane', customFields: {} });
    expect(lead.leadId).toBeDefined();
    expect(dispatchLeadCreated).toHaveBeenCalledWith('list-1', lead.leadId, undefined);
  });
  it('contains a rejected notification without failing lead save', async () => {
    (dispatchLeadCreated as jest.Mock).mockRejectedValue(new Error('Slack down'));
    await expect(crmDb.createLead('list-1', { customFields: {} })).resolves.toHaveProperty('leadId');
    await new Promise(resolve => setImmediate(resolve));
  });
  it('does not notify when the lead write fails', async () => {
    putPromiseMock.mockRejectedValueOnce(new Error('write failed'));
    await expect(crmDb.createLead('list-1', { customFields: {} })).rejects.toThrow('write failed');
    expect(dispatchLeadCreated).not.toHaveBeenCalled();
  });
});


describe('batch notification write boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    queryPromiseMock.mockResolvedValue({ Items: [] });
    getPromiseMock.mockResolvedValue({ Item: { listId: 'list-1', userId: 'owner' } });
    batchWriteMock.mockReset().mockResolvedValue({});
    (dispatchLeadsCreated as jest.Mock).mockReset().mockResolvedValue(undefined);
  });
  it.each(['pending', 'rejected'])('returns all saved rows with a %s batch notification', async state => {
    (dispatchLeadsCreated as jest.Mock).mockImplementation(() => state === 'pending'
      ? new Promise(() => {}) : Promise.reject(new Error('Slack down')));
    const rows = Array.from({ length: 51 }, (_, i) => ({ email: `person${i}@example.com` }));
    const result = await crmDb.batchCreateLeads('list-1', rows, { origin: 'enrichment_import' });
    await new Promise(resolve => setImmediate(resolve));
    expect(result.successCount).toBe(51);
    expect(dispatchLeadsCreated).toHaveBeenCalledTimes(1);
    expect(dispatchLeadsCreated).toHaveBeenCalledWith('list-1', result.created.map(row => row.leadId), 'enrichment_import');
    expect(dispatchLeadCreated).not.toHaveBeenCalled();
  });

  it('notifies only persisted rows across failed and partially unprocessed chunks', async () => {
    batchWriteMock.mockReset().mockRejectedValueOnce(new Error('chunk failed'))
      .mockImplementationOnce(async ({ RequestItems }) => {
        const table = Object.keys(RequestItems)[0];
        return { UnprocessedItems: { [table]: [RequestItems[table][0]] } };
      }).mockResolvedValue({});
    const result = await crmDb.batchCreateLeads('list-1',
      Array.from({ length: 51 }, (_, i) => ({ email: `partial${i}@example.com` })));
    await new Promise(resolve => setImmediate(resolve));
    expect(result.created).toHaveLength(25);
    expect(dispatchLeadsCreated).toHaveBeenCalledTimes(1);
    expect(dispatchLeadsCreated).toHaveBeenCalledWith('list-1', result.created.map(row => row.leadId), undefined);
    expect(dispatchLeadCreated).not.toHaveBeenCalled();
  });

});
