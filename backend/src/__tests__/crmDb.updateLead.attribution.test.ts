// Tests for updateLead persistence of Lead UTM attribution fields
// (firstTouch, lastTouch, utmSource, utmMedium).
//
// Bug: the public webhook merge path (routes/webhooks.ts) refreshes lastTouch
// on a repeat touch, but updateLead had no parameters for the attribution
// fields, so the SET expression silently dropped them — lastTouch was
// dead-on-arrival for any lead that came through the webhook more than once.
//
// Contract (mirrors the User schema, see utils/leadSchema.ts):
//   - firstTouch: AttributionTouch blob — set when supplied, never auto-mutated.
//   - lastTouch:  AttributionTouch blob — refreshed on any repeat touch.
//   - utmSource / utmMedium: denormalized strings for cheap channel filters.

const getPromiseMock = jest.fn();
const updatePromiseMock = jest.fn();
const getSpy: jest.Mock = jest.fn(() => ({ promise: getPromiseMock }));
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

import { crmDb } from '../services/db';

function leadUpdateParams(): any {
  for (const call of updateSpy.mock.calls) {
    const params = call[0];
    if (typeof params?.TableName === 'string' && params.TableName.endsWith('AW-Leads')) {
      return params;
    }
  }
  throw new Error('update on AW-Leads was not called');
}

const firstTouch = {
  timestamp: '2026-04-19T10:00:00.000Z',
  utm: { source: 'linkedin', medium: 'social', campaign: 'first' },
};
const secondTouch = {
  timestamp: '2026-04-20T10:00:00.000Z',
  utm: { source: 'google', medium: 'cpc', campaign: 'second' },
};

describe('crmDb.updateLead — attribution fields persistence', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    updatePromiseMock.mockResolvedValue({ Attributes: {} });
    getPromiseMock.mockResolvedValue({
      Item: { listId: 'list-1', leadId: 'lead-1', email: 'jane@acme.com' },
    });
  });

  it('SETs lastTouch when supplied (the DOA bug)', async () => {
    await crmDb.updateLead('list-1', 'lead-1', { lastTouch: secondTouch });
    const params = leadUpdateParams();
    expect(params.UpdateExpression).toMatch(/SET\b.*\blastTouch\b/);
    expect(params.ExpressionAttributeValues[':lastTouch']).toEqual(secondTouch);
  });

  it('SETs firstTouch when supplied (backfill path)', async () => {
    await crmDb.updateLead('list-1', 'lead-1', { firstTouch });
    const params = leadUpdateParams();
    expect(params.UpdateExpression).toMatch(/SET\b.*\bfirstTouch\b/);
    expect(params.ExpressionAttributeValues[':firstTouch']).toEqual(firstTouch);
  });

  it('SETs utmSource and utmMedium denorm strings when supplied', async () => {
    await crmDb.updateLead('list-1', 'lead-1', {
      utmSource: 'twitter',
      utmMedium: 'social',
    });
    const params = leadUpdateParams();
    expect(params.UpdateExpression).toMatch(/SET\b.*\butmSource\b/);
    expect(params.UpdateExpression).toMatch(/SET\b.*\butmMedium\b/);
    expect(params.ExpressionAttributeValues[':utmSource']).toBe('twitter');
    expect(params.ExpressionAttributeValues[':utmMedium']).toBe('social');
  });

  it('SETs all four attribution fields together (full backfill)', async () => {
    await crmDb.updateLead('list-1', 'lead-1', {
      firstTouch,
      lastTouch: firstTouch,
      utmSource: 'linkedin',
      utmMedium: 'social',
    });
    const params = leadUpdateParams();
    expect(params.ExpressionAttributeValues[':firstTouch']).toEqual(firstTouch);
    expect(params.ExpressionAttributeValues[':lastTouch']).toEqual(firstTouch);
    expect(params.ExpressionAttributeValues[':utmSource']).toBe('linkedin');
    expect(params.ExpressionAttributeValues[':utmMedium']).toBe('social');
  });

  it('does NOT include any attribution keys when none are supplied', async () => {
    await crmDb.updateLead('list-1', 'lead-1', { firstName: 'Jane' });
    const params = leadUpdateParams();
    expect(params.ExpressionAttributeValues).not.toHaveProperty(':firstTouch');
    expect(params.ExpressionAttributeValues).not.toHaveProperty(':lastTouch');
    expect(params.ExpressionAttributeValues).not.toHaveProperty(':utmSource');
    expect(params.ExpressionAttributeValues).not.toHaveProperty(':utmMedium');
  });
});
