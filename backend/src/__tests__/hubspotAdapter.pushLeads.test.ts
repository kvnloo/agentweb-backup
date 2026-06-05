/**
 * Unit tests for HubspotAdapter.pushLeads — email validation.
 *
 * Regression coverage for the bug where a lead whose `email` field holds a URL
 * (e.g. "https://superdm.me/chessbaseindia") was pushed to HubSpot verbatim,
 * causing HubSpot to reject the upsert with INVALID_EMAIL and surface a
 * confusing per-lead error in the Sync Result.
 */

// Mock crmDb so persistence calls are no-ops
jest.mock('../services/db', () => ({
  crmDb: {
    updateLead: jest.fn().mockResolvedValue(undefined),
  },
}));

// Mock HubSpotService — fromToken returns a stub service we can assert on
const mockUpsertContact = jest.fn();
const mockEnsureContactProperty = jest.fn().mockResolvedValue('prop');
const mockEnsureDealProperty = jest.fn().mockResolvedValue('prop');
const mockSvc = {
  upsertContact: mockUpsertContact,
  ensureContactProperty: mockEnsureContactProperty,
  ensureDealProperty: mockEnsureDealProperty,
};
jest.mock('../services/hubspotService', () => ({
  HubSpotService: {
    fromToken: jest.fn(() => mockSvc),
    create: jest.fn(() => Promise.resolve(mockSvc)),
  },
}));

import { HubspotAdapter } from '../services/adapters/hubspotAdapter';
import { ExternalCrmSyncConfig, FieldMapping } from '../services/externalCrmSyncService';
import { CrmAuth } from '../services/adapters/crmAdapterTypes';

const auth: CrmAuth = { type: 'token', apiKey: 'pat-test' };

const contactMapping: FieldMapping[] = [
  { agentwebField: 'email', crmProperty: 'email', direction: 'both', enabled: true },
  { agentwebField: 'firstName', crmProperty: 'firstname', direction: 'both', enabled: true },
];

function makeConfig(): ExternalCrmSyncConfig {
  return {
    provider: 'hubspot',
    listId: 'list_1',
    userId: 'user_1',
    apiKeyEncrypted: 'enc',
    autoSyncEnabled: false,
    contactFieldMapping: contactMapping,
    dealFieldMapping: [],
    customFieldMapping: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('HubspotAdapter.pushLeads — email validation', () => {
  let adapter: HubspotAdapter;

  beforeEach(() => {
    jest.clearAllMocks();
    mockUpsertContact.mockResolvedValue({ contactId: 'c1', isNew: true });
    adapter = new HubspotAdapter();
  });

  it('skips a lead whose email is a URL and records a clear error (no upsert attempted)', async () => {
    const leads = [
      { leadId: 'l1', listId: 'list_1', email: 'https://superdm.me/chessbaseindia', firstName: 'Chess' },
    ];

    const result = await adapter.pushLeads(auth, leads, makeConfig());

    expect(mockUpsertContact).not.toHaveBeenCalled();
    expect(result.errorCount).toBe(1);
    expect(result.successCount).toBe(0);
    expect(result.newCount).toBe(0);
    expect(result.errors[0]).toContain('https://superdm.me/chessbaseindia');
    expect(result.errors[0]).toMatch(/invalid email/i);
  });

  it('skips a lead with a malformed email (no domain) without calling HubSpot', async () => {
    const leads = [{ leadId: 'l1', listId: 'list_1', email: 'notanemail', firstName: 'Foo' }];

    const result = await adapter.pushLeads(auth, leads, makeConfig());

    expect(mockUpsertContact).not.toHaveBeenCalled();
    expect(result.errorCount).toBe(1);
    expect(result.errors[0]).toMatch(/invalid email/i);
  });

  it('skips a lead whose email is only whitespace (treated as missing, no error)', async () => {
    const leads = [{ leadId: 'l1', listId: 'list_1', email: '   ', firstName: 'Foo' }];

    const result = await adapter.pushLeads(auth, leads, makeConfig());

    expect(mockUpsertContact).not.toHaveBeenCalled();
    expect(result.errorCount).toBe(0);
    expect(result.successCount).toBe(0);
  });

  it('still pushes a lead with a valid email', async () => {
    const leads = [{ leadId: 'l1', listId: 'list_1', email: 'real@example.com', firstName: 'Real' }];

    const result = await adapter.pushLeads(auth, leads, makeConfig());

    expect(mockUpsertContact).toHaveBeenCalledTimes(1);
    expect(mockUpsertContact).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'real@example.com' })
    );
    expect(result.successCount).toBe(1);
    expect(result.newCount).toBe(1);
    expect(result.errorCount).toBe(0);
  });

  it('processes a mixed batch: valid leads sync, invalid-email leads are skipped with errors', async () => {
    const leads = [
      { leadId: 'l1', listId: 'list_1', email: 'good@example.com', firstName: 'A' },
      { leadId: 'l2', listId: 'list_1', email: 'https://superdm.me/chessbaseindia', firstName: 'B' },
      { leadId: 'l3', listId: 'list_1', email: 'also.good@example.org', firstName: 'C' },
    ];

    const result = await adapter.pushLeads(auth, leads, makeConfig());

    expect(mockUpsertContact).toHaveBeenCalledTimes(2);
    expect(result.successCount).toBe(2);
    expect(result.errorCount).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('https://superdm.me/chessbaseindia');
  });
});
