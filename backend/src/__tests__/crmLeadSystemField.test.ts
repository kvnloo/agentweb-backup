// Tests for the lead.system top-level metadata field.
//
// system holds CRM-internal bookkeeping (findReason, freshUntil,
// scheduledRunAt, icpSource) that the Find Leads / scheduled-search /
// ICP-sourcing flows need to attach to imported leads — but which must
// NOT live in customFields (where it would leak into CSV exports,
// email-template variables, and the lead-filter UI as if it were a
// user-authored column).

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

jest.mock('../services/emailEventsDb', () => ({ emailEventsDb: {} }));
jest.mock('../services/resendService', () => ({ resendService: {} }));
jest.mock('../services/contactEventsDb', () => ({
  contactEventsDb: { logEvent: jest.fn().mockResolvedValue({ event: {}, deduplicated: false }) },
  normalizeContactId: (raw: string) => raw.trim().toLowerCase(),
}));

import { crmDb } from '../services/db';

beforeEach(() => {
  jest.clearAllMocks();
  Object.values(mockDocumentClientMethods).forEach((fn) => {
    (fn as jest.Mock).mockReset();
    (fn as jest.Mock).mockReturnValue({ promise: jest.fn().mockResolvedValue({}) });
  });
  // batchCreateLeads pre-fetches existing leads via getLeadsByListId(query),
  // and writes via batchWrite.
  mockDocumentClientMethods.query.mockReturnValue({
    promise: jest.fn().mockResolvedValue({ Items: [] }),
  });
  mockDocumentClientMethods.batchWrite.mockReturnValue({
    promise: jest.fn().mockResolvedValue({}),
  });
  mockDocumentClientMethods.update.mockReturnValue({
    promise: jest.fn().mockResolvedValue({ Attributes: {} }),
  });
});

describe('lead.system field — batchCreateLeads', () => {
  it('persists system map onto each lead item when provided', async () => {
    const leads = [
      {
        firstName: 'Alice',
        lastName: 'X',
        company: 'Acme',
        system: { findReason: 'title=CTO; company=Stripe', icpSource: 'RevOps Leaders' },
      },
    ];
    await crmDb.batchCreateLeads('list_a', leads as any);
    expect(mockDocumentClientMethods.batchWrite).toHaveBeenCalledTimes(1);
    const params = mockDocumentClientMethods.batchWrite.mock.calls[0][0];
    const written = Object.values(params.RequestItems)[0] as any[];
    expect(written).toHaveLength(1);
    const item = written[0].PutRequest.Item;
    expect(item.system).toEqual({
      findReason: 'title=CTO; company=Stripe',
      icpSource: 'RevOps Leaders',
    });
    // system MUST be top-level, NOT nested in customFields
    expect(item.customFields).toEqual({});
  });

  it('omits system field when not provided', async () => {
    const leads = [{ firstName: 'B', lastName: 'Y', company: 'Y' }];
    await crmDb.batchCreateLeads('list_b', leads as any);
    const params = mockDocumentClientMethods.batchWrite.mock.calls[0][0];
    const item = (Object.values(params.RequestItems)[0] as any[])[0].PutRequest.Item;
    expect(item.system).toBeUndefined();
  });

  it('does NOT include "system" in the user-facing field-name extraction', async () => {
    // batchCreateLeads accumulates `allFieldNames` for the list's column
    // metadata — `system` must be filtered out as an internal field, the
    // same way `customFields`, `enrichmentMetadata`, etc. are.
    const leads = [
      { firstName: 'C', lastName: 'Z', company: 'Z', system: { findReason: 'r' } },
    ];
    await crmDb.batchCreateLeads('list_c', leads as any);
    // The list-update call (if one happened) is the second update call.
    const updateCalls = mockDocumentClientMethods.update.mock.calls;
    const fieldUpdate = updateCalls.find((call) =>
      JSON.stringify(call[0]).includes('AW-LeadLists'),
    );
    if (fieldUpdate) {
      const serialized = JSON.stringify(fieldUpdate[0]);
      expect(serialized).not.toContain('"system"');
    }
  });
});

describe('lead.system field — updateLead', () => {
  it('sets system map when updates.system is provided', async () => {
    await crmDb.updateLead('list_d', 'lead_1', {
      system: { freshUntil: '2026-12-01T00:00:00Z' },
    } as any);
    const params = mockDocumentClientMethods.update.mock.calls[0][0];
    const updateExpr = params.UpdateExpression;
    expect(updateExpr).toContain('system = :system');
    expect(params.ExpressionAttributeValues[':system']).toEqual({
      freshUntil: '2026-12-01T00:00:00Z',
    });
  });

  it('removes system attribute when updates.system === null', async () => {
    await crmDb.updateLead('list_e', 'lead_2', { system: null as any });
    const params = mockDocumentClientMethods.update.mock.calls[0][0];
    expect(params.UpdateExpression).toContain('REMOVE');
    expect(params.UpdateExpression).toContain('system');
  });

  it('does not touch system when updates.system is undefined', async () => {
    await crmDb.updateLead('list_f', 'lead_3', { firstName: 'Q' });
    const params = mockDocumentClientMethods.update.mock.calls[0][0];
    const updateExpr = params.UpdateExpression as string;
    expect(updateExpr).not.toMatch(/\bsystem\b/);
  });
});
