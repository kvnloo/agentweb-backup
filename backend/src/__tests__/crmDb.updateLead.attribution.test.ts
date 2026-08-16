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

/**
 * ENG-926 §B — the match-quality signals that survive to the relay.
 *
 * `client_ip_address` and `client_user_agent` are, in Meta's own guidance, among the most
 * commonly skipped and most valuable Event Match Quality inputs. Both were already in hand
 * at capture (routes/webhooks.ts reads them off the request), were used for the immediate
 * Lead event, and were then thrown away — so every conversion §C relays WEEKS later, when a
 * deal closes, reached Meta with weaker identity than we held at the moment of capture.
 *
 * `metaFbp` is fixed here in the same pass, and its absence is the reason this file exists:
 * db.ts's own comment says a field missing from updateLead is "silently dropped with every
 * test still passing, which is exactly how §C's metaFbp shipped doing nothing." It was
 * added to createLead only, so a lead that first arrived WITHOUT an fbp and later submitted
 * WITH one never received it. Adding new fields to one path and not the other would have
 * repeated the bug this very file was written about.
 */
describe('crmDb.updateLead — match-quality fields persistence (ENG-926 §B)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    updatePromiseMock.mockResolvedValue({ Attributes: {} });
    getPromiseMock.mockResolvedValue({
      Item: { listId: 'list-1', leadId: 'lead-1', email: 'jane@acme.com' },
    });
  });

  it('SETs clientIp when supplied', async () => {
    await crmDb.updateLead('list-1', 'lead-1', { clientIp: '203.0.113.7' });
    const params = leadUpdateParams();
    expect(params.UpdateExpression).toMatch(/SET\b.*\bclientIp\b/);
    expect(params.ExpressionAttributeValues[':clientIp']).toBe('203.0.113.7');
  });

  it('SETs clientUserAgent when supplied', async () => {
    await crmDb.updateLead('list-1', 'lead-1', { clientUserAgent: 'Mozilla/5.0 (iPhone)' });
    const params = leadUpdateParams();
    expect(params.UpdateExpression).toMatch(/SET\b.*\bclientUserAgent\b/);
    expect(params.ExpressionAttributeValues[':clientUserAgent']).toBe('Mozilla/5.0 (iPhone)');
  });

  it('SETs metaFbp — the field db.ts documents as having shipped doing nothing', async () => {
    await crmDb.updateLead('list-1', 'lead-1', { metaFbp: 'fb.1.1754000000000.987654321' });
    const params = leadUpdateParams();
    expect(params.UpdateExpression).toMatch(/SET\b.*\bmetaFbp\b/);
    expect(params.ExpressionAttributeValues[':metaFbp']).toBe('fb.1.1754000000000.987654321');
  });

  it('SETs all three together, alongside the touch blobs', async () => {
    await crmDb.updateLead('list-1', 'lead-1', {
      firstTouch,
      metaFbp: 'fb.1.1754000000000.987654321',
      clientIp: '203.0.113.7',
      clientUserAgent: 'Mozilla/5.0 (iPhone)',
    });
    const params = leadUpdateParams();
    expect(params.ExpressionAttributeValues[':firstTouch']).toEqual(firstTouch);
    expect(params.ExpressionAttributeValues[':metaFbp']).toBe('fb.1.1754000000000.987654321');
    expect(params.ExpressionAttributeValues[':clientIp']).toBe('203.0.113.7');
    expect(params.ExpressionAttributeValues[':clientUserAgent']).toBe('Mozilla/5.0 (iPhone)');
  });

  it('does NOT include any of them when none are supplied', async () => {
    await crmDb.updateLead('list-1', 'lead-1', { firstName: 'Jane' });
    const params = leadUpdateParams();
    expect(params.ExpressionAttributeValues).not.toHaveProperty(':clientIp');
    expect(params.ExpressionAttributeValues).not.toHaveProperty(':clientUserAgent');
    expect(params.ExpressionAttributeValues).not.toHaveProperty(':metaFbp');
  });
});
