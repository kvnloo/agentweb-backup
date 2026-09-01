/**
 * Unit tests for AttioAdapter.pullContacts — People pagination correctness.
 *
 * Live-caught gap (independent fresh-eyes review, ENG-1380): Attio's
 * POST /objects/{object}/records/query and POST /lists/{list}/entries/query
 * endpoints use limit/offset pagination, not cursor-based pagination —
 * confirmed against Attio's own docs (docs.attio.com/rest-api/guides/
 * pagination, which uses /objects/people/records/query as its own
 * offset-pagination example). There is no next_cursor field in the response
 * at all. AttioService.listPeople previously sent a `cursor` param (which
 * Attio's API silently ignores) and read `next_cursor` from the response
 * (which is never present), so every pull run's do/while loop always
 * terminated after exactly one page — any Attio-connected list with more
 * than 50 People silently only ever pulled its first 50, forever, for
 * every customer, with no error or warning surfaced anywhere.
 */

jest.mock('../services/db', () => ({
  crmDb: {
    batchCreateLeads: jest.fn().mockResolvedValue({ successCount: 0, newCount: 0, mergedCount: 0, errorCount: 0, errors: [] }),
  },
}));

const mockListPeople = jest.fn();
const mockGetPersonValues = jest.fn();
const mockLoadAttributeTypes = jest.fn();

const mockSvc = {
  listPeople: mockListPeople,
  getPersonValues: mockGetPersonValues,
  loadAttributeTypes: mockLoadAttributeTypes,
};

jest.mock('../services/attioService', () => ({
  AttioService: {
    fromToken: jest.fn(() => mockSvc),
    create: jest.fn(() => Promise.resolve(mockSvc)),
  },
}));

import { AttioAdapter } from '../services/adapters/attioAdapter';
import { ExternalCrmSyncConfig, FieldMapping } from '../services/externalCrmSyncService';
import { CrmAuth } from '../services/adapters/crmAdapterTypes';
import { crmDb } from '../services/db';

const auth: CrmAuth = { type: 'token', apiKey: 'attio-test-key' };

const contactMapping: FieldMapping[] = [
  { agentwebField: 'email', crmProperty: 'email_addresses', direction: 'both', enabled: true },
];

function makeConfig(): ExternalCrmSyncConfig {
  return {
    provider: 'attio',
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

function makePerson(recordId: string, email: string) {
  return { recordId, email };
}

describe('AttioAdapter.pullContacts — People pagination', () => {
  let adapter: AttioAdapter;

  beforeEach(() => {
    jest.clearAllMocks();
    adapter = new AttioAdapter();
    mockLoadAttributeTypes.mockResolvedValue(new Map([
      ['object:people:email_addresses', 'email_address'],
    ]));
    mockGetPersonValues.mockImplementation((recordId: string) =>
      Promise.resolve({ email_addresses: [{ email_address: `${recordId}@acme.com` }] })
    );
  });

  it('pulls people from a second page, not just the first 50', async () => {
    // Page 1: a full 50-person page (offset:0) — Attio's signal that more
    // pages may exist is getting back a full page, not a cursor field.
    const page1 = Array.from({ length: 50 }, (_, i) => makePerson(`p${i}`, `p${i}@acme.com`));
    const page2 = [makePerson('p50', 'p50@acme.com')];
    mockListPeople.mockImplementation((offset: number) => {
      if (offset === 0) return Promise.resolve({ people: page1, nextOffset: 50 });
      if (offset === 50) return Promise.resolve({ people: page2, nextOffset: undefined });
      throw new Error(`unexpected offset ${offset}`);
    });

    await adapter.pullContacts(auth, 'list_1', makeConfig());

    expect(mockListPeople).toHaveBeenCalledTimes(2);
    expect(mockListPeople).toHaveBeenNthCalledWith(1, 0);
    expect(mockListPeople).toHaveBeenNthCalledWith(2, 50);

    const allPulledEmails = (crmDb.batchCreateLeads as jest.Mock).mock.calls
      .flatMap(call => call[1])
      .map((lead: any) => lead.email);
    expect(allPulledEmails).toContain('p50@acme.com'); // the 51st person, on page 2
    expect(allPulledEmails).toHaveLength(51);
  });

  it('stops after a short page without requesting a further page', async () => {
    mockListPeople.mockResolvedValue({ people: [makePerson('p1', 'p1@acme.com')], nextOffset: undefined });

    await adapter.pullContacts(auth, 'list_1', makeConfig());

    expect(mockListPeople).toHaveBeenCalledTimes(1);
    expect(mockListPeople).toHaveBeenCalledWith(0);
  });

  it('starts pagination at offset 0, not with no argument', async () => {
    mockListPeople.mockResolvedValue({ people: [], nextOffset: undefined });

    await adapter.pullContacts(auth, 'list_1', makeConfig());

    expect(mockListPeople).toHaveBeenCalledWith(0);
  });
});
