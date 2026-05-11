// Tests that the new `companyLinkedin` standard field is preserved through
// createLead, batchCreateLeads, and updateLead, and that it lands in the
// resulting Dynamo Item.
const mockDocumentClientMethods = {
  put: jest.fn(),
  get: jest.fn(),
  query: jest.fn(),
  scan: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
  batchWrite: jest.fn(),
};

jest.mock('aws-sdk', () => ({
  config: { update: jest.fn() },
  DynamoDB: { DocumentClient: jest.fn(() => mockDocumentClientMethods) },
  S3: jest.fn(() => ({ upload: jest.fn(), getObject: jest.fn(), deleteObject: jest.fn() })),
}));

jest.mock('../services/emailEventsDb', () => ({
  emailEventsDb: {
    getEventsByEmailDomainAndLeadEmail: jest.fn(),
    updateEmailEventContent: jest.fn(),
  },
}));

jest.mock('../services/resendService', () => ({
  resendService: {
    getReceivedEmailContent: jest.fn(),
    getDeliveredEmailContent: jest.fn(),
  },
}));

const mockLogEvent = jest.fn().mockResolvedValue({ event: {}, deduplicated: false });
jest.mock('../services/contactEventsDb', () => ({
  contactEventsDb: { logEvent: (...args: any[]) => mockLogEvent(...args) },
  normalizeContactId: (raw: string) => raw.trim().toLowerCase(),
}));

import { crmDb } from '../services/db';

describe('Lead.companyLinkedin standard field', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Object.keys(mockDocumentClientMethods).forEach((method) => {
      (mockDocumentClientMethods as any)[method].mockReturnValue({
        promise: jest.fn().mockResolvedValue({}),
      });
    });
    mockDocumentClientMethods.get.mockReturnValue({
      promise: jest.fn().mockResolvedValue({ Item: { listId: 'l1', fieldNames: [] } }),
    });
  });

  it('createLead persists companyLinkedin into the Dynamo Item', async () => {
    await crmDb.createLead('l1', {
      email: 'a@b.com',
      companyLinkedin: 'https://linkedin.com/company/acme',
    } as any);

    const putCall = mockDocumentClientMethods.put.mock.calls.find(
      (c: any[]) => c[0]?.TableName?.endsWith('AW-Leads'),
    );
    expect(putCall).toBeDefined();
    expect(putCall![0].Item.companyLinkedin).toBe('https://linkedin.com/company/acme');
  });

  it('createLead leaves companyLinkedin as empty string when not provided', async () => {
    await crmDb.createLead('l1', { email: 'a@b.com' } as any);

    const putCall = mockDocumentClientMethods.put.mock.calls.find(
      (c: any[]) => c[0]?.TableName?.endsWith('AW-Leads'),
    );
    expect(putCall![0].Item.companyLinkedin).toBe('');
  });

  it('batchCreateLeads writes companyLinkedin into each Item', async () => {
    // Existing-leads pagination — no existing items.
    mockDocumentClientMethods.query.mockReturnValue({
      promise: jest.fn().mockResolvedValue({ Items: [], LastEvaluatedKey: undefined }),
    });

    await crmDb.batchCreateLeads('l1', [
      {
        email: 'lead1@example.com',
        companyLinkedin: 'https://linkedin.com/company/foo',
      } as any,
      {
        email: 'lead2@example.com',
        companyLinkedin: 'https://linkedin.com/company/bar',
      } as any,
    ]);

    const batchCall = mockDocumentClientMethods.batchWrite.mock.calls[0];
    expect(batchCall).toBeDefined();
    const tableKey = Object.keys(batchCall[0].RequestItems)[0];
    const items = batchCall[0].RequestItems[tableKey].map((r: any) => r.PutRequest.Item);
    expect(items[0].companyLinkedin).toBe('https://linkedin.com/company/foo');
    expect(items[1].companyLinkedin).toBe('https://linkedin.com/company/bar');
  });

  it('updateLead sets companyLinkedin when provided', async () => {
    await crmDb.updateLead('l1', 'lead_1', {
      companyLinkedin: 'https://linkedin.com/company/newco',
    } as any);

    const updateCall = mockDocumentClientMethods.update.mock.calls.find(
      (c: any[]) => c[0]?.Key?.leadId === 'lead_1',
    );
    expect(updateCall).toBeDefined();
    expect(updateCall![0].UpdateExpression).toContain('companyLinkedin');
    expect(updateCall![0].ExpressionAttributeValues[':companyLinkedin']).toBe(
      'https://linkedin.com/company/newco',
    );
  });
});
