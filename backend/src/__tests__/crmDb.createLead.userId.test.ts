// Tests that crmDb.createLead writes the userId (derived from parent list)
// and nameCompanyKey attributes used by CRM-history Tier 0 GSIs.

const queryPromiseMock = jest.fn();
const getPromiseMock = jest.fn();
const putPromiseMock = jest.fn();
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

  it('keeps linkedin sparse: writes only when non-empty after trim', async () => {
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
    expect(lastPutItem().linkedin).toBe('https://linkedin.com/in/jane');
  });
});
