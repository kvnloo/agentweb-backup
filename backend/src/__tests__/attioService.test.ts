/**
 * Unit tests for AttioService
 * Tests cover: People CRUD, Companies CRUD, Webhook management
 * All Attio API calls are mocked via axios
 */

process.env.JWT_SECRET = 'test-secret';
process.env.BACKEND_URL = 'https://api.agentweb.pro';

jest.mock('axios');
jest.mock('../services/connectedAccountsDb', () => ({
  getAccountsByUserId: jest.fn(),
  getAccountById: jest.fn(),
  updateAccountConfig: jest.fn(),
}));

import axios from 'axios';
import { AttioService } from '../services/attioService';
import {
  getAccountsByUserId,
  getAccountById,
  updateAccountConfig,
} from '../services/connectedAccountsDb';

const mockAxiosPost = axios.post as jest.Mock;
const mockAxiosGet = axios.get as jest.Mock;
const mockAxiosPatch = axios.patch as jest.Mock;
const mockAxiosDelete = axios.delete as jest.Mock;
const mockAxiosPut = (axios as any).put as jest.Mock;
const mockGetAccountsByUserId = getAccountsByUserId as jest.MockedFunction<typeof getAccountsByUserId>;
const mockGetAccountById = getAccountById as jest.MockedFunction<typeof getAccountById>;
const mockUpdateAccountConfig = updateAccountConfig as jest.MockedFunction<typeof updateAccountConfig>;

const MOCK_ACCOUNT = {
  platform: 'attio' as const,
  account_id: 'ws-123',
  account_name: 'Test Workspace',
  config: { account_type: 'oauth' as const, access_token: 'test-token', token_expires_at: 9999999999999, workspace_id: 'ws-123', workspace_name: 'Test Workspace' },
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
  userId: 'user-1',
};

const MOCK_PERSON_RECORD = {
  id: { record_id: 'rec-person-1' },
  values: {
    name: [{ first_name: 'John', last_name: 'Doe' }],
    email_addresses: [{ email_address: 'john@acme.com' }],
    phone_numbers: [{ phone_number: '+1234567890' }],
    job_title: [{ value: 'CTO' }],
    linkedin: [{ value: 'https://linkedin.com/in/johndoe' }],
    company: [{ target_record_id: 'rec-company-1' }],
  },
};

const MOCK_COMPANY_RECORD = {
  id: { record_id: 'rec-company-1' },
  values: {
    name: [{ value: 'Acme Corp' }],
    domains: [{ domain: 'acme.com' }],
  },
};

describe('AttioService', () => {
  // Most tests use fromToken to skip the DB lookup — tests the API call behaviour.
  // Factory / account resolution tests use AttioService.create() directly.
  let service: AttioService;

  beforeEach(() => {
    service = AttioService.fromToken('test-token');
    jest.clearAllMocks();
    mockGetAccountsByUserId.mockResolvedValue([MOCK_ACCOUNT]);
    mockGetAccountById.mockResolvedValue(MOCK_ACCOUNT);
    mockUpdateAccountConfig.mockResolvedValue(undefined);
  });

  // ─── Factory / account resolution ────────────────────────────────

  describe('AttioService.create()', () => {
    it('throws if no Attio account connected', async () => {
      mockGetAccountsByUserId.mockResolvedValue([]);
      await expect(AttioService.create('user-1')).rejects.toThrow('Attio account not connected');
    });

    it('throws if multiple Attio accounts and no accountId specified', async () => {
      mockGetAccountsByUserId.mockResolvedValue([MOCK_ACCOUNT, { ...MOCK_ACCOUNT, account_id: 'ws-456' }]);
      await expect(AttioService.create('user-1')).rejects.toThrow('Multiple Attio accounts');
    });

    it('throws if accountId not found', async () => {
      mockGetAccountById.mockResolvedValue(null);
      await expect(AttioService.create('user-1', 'bad-id')).rejects.toThrow('not found');
    });

    it('returns service instance with token from account config', async () => {
      const svc = await AttioService.create('user-1');
      // Verify the resolved token is used in API calls
      mockAxiosPost.mockResolvedValue({ data: { data: [] } });
      await svc.listPeople();
      expect(mockAxiosPost).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Object),
        expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer test-token' }) })
      );
    });
  });

  // ─── People ──────────────────────────────────────────────────────

  describe('listPeople', () => {
    // Attio's /objects/{object}/records/query endpoints use limit/offset
    // pagination, not cursor — confirmed against Attio's own docs. There is
    // no next_cursor in the response envelope at all; end-of-results is
    // inferred purely from getting back fewer than `limit` records.
    it('returns mapped people array, sending offset:0 on the first page', async () => {
      mockAxiosPost.mockResolvedValue({ data: { data: [MOCK_PERSON_RECORD] } });

      const result = await service.listPeople();

      expect(mockAxiosPost).toHaveBeenCalledWith(
        'https://api.attio.com/v2/objects/people/records/query',
        { limit: 50, offset: 0 },
        expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer test-token' }) })
      );
      expect(result.people).toHaveLength(1);
      expect(result.people[0]).toMatchObject({ recordId: 'rec-person-1', email: 'john@acme.com', firstName: 'John' });
    });

    it('passes an explicit offset for a later page', async () => {
      mockAxiosPost.mockResolvedValue({ data: { data: [] } });

      await service.listPeople(50);

      expect(mockAxiosPost).toHaveBeenCalledWith(
        expect.any(String),
        { limit: 50, offset: 50 },
        expect.any(Object)
      );
    });

    it('reports nextOffset when a full page comes back (there may be more)', async () => {
      const fullPage = Array.from({ length: 50 }, () => MOCK_PERSON_RECORD);
      mockAxiosPost.mockResolvedValue({ data: { data: fullPage } });

      const result = await service.listPeople(0);

      expect(result.nextOffset).toBe(50);
    });

    it('reports nextOffset:undefined for a short page (end of results)', async () => {
      mockAxiosPost.mockResolvedValue({ data: { data: [MOCK_PERSON_RECORD] } });

      const result = await service.listPeople(100);

      expect(result.nextOffset).toBeUndefined();
    });

    it('returns empty array when no records', async () => {
      mockAxiosPost.mockResolvedValue({ data: { data: [] } });
      const result = await service.listPeople();
      expect(result.people).toHaveLength(0);
      expect(result.nextOffset).toBeUndefined();
    });
  });

  describe('findPersonByEmail', () => {
    it('returns person with recordId when found', async () => {
      mockAxiosPost.mockResolvedValue({
        data: { data: [{ id: { record_id: 'rec-person-1' } }] },
      });

      const person = await service.findPersonByEmail('john@acme.com');

      expect(person).not.toBeNull();
      expect(person?.recordId).toBe('rec-person-1');
      expect(mockAxiosGet).not.toHaveBeenCalled();
    });

    it('returns null when search returns no results', async () => {
      mockAxiosPost.mockResolvedValue({ data: { data: [] } });
      const person = await service.findPersonByEmail('nobody@nowhere.com');
      expect(person).toBeNull();
    });
  });

  describe('createPerson', () => {
    it('creates person and returns mapped record', async () => {
      mockAxiosPost.mockResolvedValue({ data: { data: MOCK_PERSON_RECORD } });

      const person = await service.createPerson({
        firstName: 'John',
        lastName: 'Doe',
        email: 'john@acme.com',
        phone: '+1234567890',
        jobTitle: 'CTO',
        linkedinUrl: 'https://linkedin.com/in/johndoe',
      });

      expect(mockAxiosPost).toHaveBeenCalledWith(
        'https://api.attio.com/v2/objects/people/records',
        expect.objectContaining({ data: expect.objectContaining({ values: expect.any(Object) }) }),
        expect.any(Object)
      );
      expect(person.recordId).toBe('rec-person-1');
      expect(person.email).toBe('john@acme.com');
    });

    it('handles person with no email gracefully', async () => {
      mockAxiosPost.mockResolvedValue({ data: { data: { id: { record_id: 'rec-2' }, values: { name: [{ first_name: 'No', last_name: 'Email' }] } } } });

      const person = await service.createPerson({ firstName: 'No', lastName: 'Email' });
      expect(person.recordId).toBe('rec-2');
      expect(person.email).toBe('');
    });

    it('throws on API error', async () => {
      mockAxiosPost.mockRejectedValue(new Error('API error'));
      await expect(service.createPerson({ email: 'x@x.com' })).rejects.toThrow('API error');
    });
  });

  describe('updatePerson', () => {
    it('calls patch with correct record id and values', async () => {
      mockAxiosPatch.mockResolvedValue({ data: { data: MOCK_PERSON_RECORD } });

      const person = await service.updatePerson('rec-person-1', { jobTitle: 'CEO' });

      expect(mockAxiosPatch).toHaveBeenCalledWith(
        'https://api.attio.com/v2/objects/people/records/rec-person-1',
        expect.objectContaining({ data: expect.objectContaining({ values: expect.objectContaining({ job_title: expect.any(Array) }) }) }),
        expect.any(Object)
      );
      expect(person.recordId).toBe('rec-person-1');
    });

    it('throws on invalid record id', async () => {
      mockAxiosPatch.mockRejectedValue({ response: { status: 404 } });
      await expect(service.updatePerson('bad-id', { jobTitle: 'X' })).rejects.toBeDefined();
    });
  });

  describe('deletePerson', () => {
    it('calls delete with correct record id', async () => {
      mockAxiosDelete.mockResolvedValue({ data: {} });

      await service.deletePerson('rec-person-1');

      expect(mockAxiosDelete).toHaveBeenCalledWith(
        'https://api.attio.com/v2/objects/people/records/rec-person-1',
        expect.any(Object)
      );
    });

    it('throws on API error', async () => {
      mockAxiosDelete.mockRejectedValue(new Error('Not found'));
      await expect(service.deletePerson('bad-id')).rejects.toThrow('Not found');
    });
  });

  describe('getAllLists parent_object normalisation (ENG-2631)', () => {
    it('treats the raw array shape ["companies"] as a company list', async () => {
      mockAxiosGet.mockResolvedValue({ data: { data: [
        { id: { list_id: 'l1' }, name: 'Accounts', parent_object: ['companies'] },
        { id: { list_id: 'l2' }, name: 'Leads', parent_object: ['people'] },
        { id: { list_id: 'l3' }, name: 'Legacy', parent_object: ['people', 'companies'] },
      ] } });
      const lists = await service.getAllLists();
      expect(lists.map(l => l.parentObject)).toEqual(['companies', 'people', 'companies']);
    });

    it('maps object UUIDs to slugs via getObjectSlug', async () => {
      const uuid = '11111111-2222-3333-4444-555555555555';
      mockAxiosGet.mockImplementation(async (url: string) => url.endsWith('/objects')
        ? { data: { data: [{ id: { object_id: uuid }, api_slug: 'companies' }] } }
        : { data: { data: [{ id: { list_id: 'l1' }, name: 'Accounts', parent_object: [uuid] }] } });
      const lists = await service.getAllLists();
      expect(lists[0].parentObject).toBe('companies');
    });
  });

  describe('list entry dedupe (ENG-2632)', () => {
    it('upsertListEntry uses PUT, never POST', async () => {
      mockAxiosPut.mockResolvedValue({ data: { data: { id: { entry_id: 'e1' } } } });
      await expect(service.upsertListEntry('list-abc', 'rec-1', 'companies')).resolves.toBe('e1');
      expect(mockAxiosPut).toHaveBeenCalledWith(
        'https://api.attio.com/v2/lists/list-abc/entries',
        { data: { parent_record_id: 'rec-1', parent_object: 'companies', entry_values: {} } },
        expect.any(Object)
      );
      expect(mockAxiosPost).not.toHaveBeenCalled();
    });

    it('upsertListEntry falls back to an existing entry on MULTIPLE_MATCH_RESULTS', async () => {
      mockAxiosPut.mockRejectedValue({ response: { data: { code: 'MULTIPLE_MATCH_RESULTS' } } });
      mockAxiosGet.mockResolvedValue({ data: { data: [
        { id: { list_id: 'list-abc', entry_id: 'e1' } }, { id: { list_id: 'list-abc', entry_id: 'e2' } },
      ] } });
      await expect(service.upsertListEntry('list-abc', 'rec-1', 'people')).resolves.toBe('e1');
    });

    it('findListEntries returns every entry in the list and pages', async () => {
      const page1 = Array.from({ length: 500 }, (_, i) => ({ id: { list_id: i === 3 ? 'list-abc' : 'other', entry_id: `a${i}` } }));
      mockAxiosGet
        .mockResolvedValueOnce({ data: { data: page1 } })
        .mockResolvedValueOnce({ data: { data: [{ id: { list_id: 'list-abc', entry_id: 'b1' } }] } });
      await expect(service.findListEntries('list-abc', 'rec-1')).resolves.toEqual(['a3', 'b1']);
      expect(mockAxiosGet).toHaveBeenCalledTimes(2);
    });
  });

  describe('deleteListEntry', () => {
    it('calls delete with the correct list and entry id', async () => {
      mockAxiosDelete.mockResolvedValue({ data: {} });

      await service.deleteListEntry('list-abc', 'entry-1');

      expect(mockAxiosDelete).toHaveBeenCalledWith(
        'https://api.attio.com/v2/lists/list-abc/entries/entry-1',
        expect.any(Object)
      );
    });

    it('throws on API error', async () => {
      mockAxiosDelete.mockRejectedValue(new Error('Not found'));
      await expect(service.deleteListEntry('list-abc', 'bad-entry')).rejects.toThrow('Not found');
    });
  });

  // ─── Companies ───────────────────────────────────────────────────

  describe('listCompanies', () => {
    it('returns mapped companies array', async () => {
      mockAxiosPost.mockResolvedValue({ data: { data: [MOCK_COMPANY_RECORD] } });

      const result = await service.listCompanies();

      expect(result.companies).toHaveLength(1);
      expect(result.companies[0]).toMatchObject({ recordId: 'rec-company-1', name: 'Acme Corp' });
    });

    it('returns empty array when no companies', async () => {
      mockAxiosPost.mockResolvedValue({ data: { data: [] } });
      const result = await service.listCompanies();
      expect(result.companies).toHaveLength(0);
    });
  });

  describe('findCompanyByName', () => {
    it('returns company when found', async () => {
      mockAxiosPost.mockResolvedValue({ data: { data: [MOCK_COMPANY_RECORD] } });
      const company = await service.findCompanyByName('Acme Corp');
      expect(company?.name).toBe('Acme Corp');
    });

    it('returns null when not found', async () => {
      mockAxiosPost.mockResolvedValue({ data: { data: [] } });
      const company = await service.findCompanyByName('Unknown Co');
      expect(company).toBeNull();
    });
  });

  describe('createCompany', () => {
    it('creates company with name and returns mapped record', async () => {
      mockAxiosPost.mockResolvedValue({ data: { data: MOCK_COMPANY_RECORD } });

      const company = await service.createCompany('Acme Corp');

      expect(mockAxiosPost).toHaveBeenCalledWith(
        'https://api.attio.com/v2/objects/companies/records',
        expect.objectContaining({ data: expect.objectContaining({ values: expect.objectContaining({ name: expect.any(Array) }) }) }),
        expect.any(Object)
      );
      expect(company.name).toBe('Acme Corp');
    });
  });

  // ─── List entry attributes ────────────────────────────────────────

  describe('listListAttributes', () => {
    it('fetches attributes for the given list', async () => {
      mockAxiosGet.mockResolvedValue({
        data: {
          data: [
            { api_slug: 'industry', title: 'Industry' },
            { api_slug: 'notes', title: 'Notes' },
          ],
        },
      });

      const attrs = await service.listListAttributes('list-abc');

      expect(mockAxiosGet).toHaveBeenCalledWith(
        'https://api.attio.com/v2/lists/list-abc/attributes',
        expect.any(Object)
      );
      expect(attrs).toHaveLength(2);
      expect(attrs[0].api_slug).toBe('industry');
    });

    it('returns empty array when list has no custom attributes', async () => {
      mockAxiosGet.mockResolvedValue({ data: { data: [] } });
      const attrs = await service.listListAttributes('list-abc');
      expect(attrs).toHaveLength(0);
    });
  });

  describe('ensureListAttribute', () => {
    it('returns existing slug without creating if attribute already exists', async () => {
      mockAxiosGet.mockResolvedValue({
        data: { data: [{ api_slug: 'industry', title: 'Industry' }] },
      });

      const slug = await service.ensureListAttribute('list-abc', 'industry', 'Industry');

      expect(slug).toBe('industry');
      expect(mockAxiosPost).not.toHaveBeenCalled();
    });

    it('creates attribute when it does not exist', async () => {
      mockAxiosGet.mockResolvedValue({ data: { data: [] } });
      mockAxiosPost.mockResolvedValue({ data: { data: { api_slug: 'revenue_arr' } } });

      const slug = await service.ensureListAttribute('list-abc', 'revenue_arr', 'Revenue ARR');

      expect(mockAxiosPost).toHaveBeenCalledWith(
        'https://api.attio.com/v2/lists/list-abc/attributes',
        expect.objectContaining({
          data: expect.objectContaining({
            api_slug: 'revenue_arr',
            title: 'Revenue ARR',
            type: 'text',
            is_required: false,
            is_unique: false,
            is_multiselect: false,
            config: {},
          }),
        }),
        expect.any(Object)
      );
      expect(slug).toBe('revenue_arr');
    });

    it('normalises camelCase key to snake_case slug', async () => {
      mockAxiosGet.mockResolvedValue({ data: { data: [] } });
      mockAxiosPost.mockResolvedValue({ data: { data: { api_slug: 'lead_source' } } });

      const slug = await service.ensureListAttribute('list-abc', 'leadSource', 'Lead Source');

      expect(mockAxiosPost).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          data: expect.objectContaining({ api_slug: 'lead_source' }),
        }),
        expect.any(Object)
      );
      expect(slug).toBe('lead_source');
    });
  });

  describe('addPersonToList with entry values', () => {
    it('passes entry_values when provided', async () => {
      mockAxiosPost.mockResolvedValue({ data: {} });

      await service.addPersonToList('list-abc', 'rec-person-1', {
        industry: [{ value: 'SaaS' }],
        notes: [{ value: 'Hot lead' }],
      });

      expect(mockAxiosPost).toHaveBeenCalledWith(
        'https://api.attio.com/v2/lists/list-abc/entries',
        {
          data: {
            parent_record_id: 'rec-person-1',
            parent_object: 'people',
            entry_values: {
              industry: [{ value: 'SaaS' }],
              notes: [{ value: 'Hot lead' }],
            },
          },
        },
        expect.any(Object)
      );
    });

    it('sends empty entry_values when none provided', async () => {
      mockAxiosPost.mockResolvedValue({ data: {} });

      await service.addPersonToList('list-abc', 'rec-person-1');

      expect(mockAxiosPost).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          data: expect.objectContaining({ entry_values: {} }),
        }),
        expect.any(Object)
      );
    });

    it('returns undefined when the response has no entry id', async () => {
      mockAxiosPost.mockResolvedValue({ data: {} });

      const entryId = await service.addPersonToList('list-abc', 'rec-person-1');

      expect(entryId).toBeUndefined();
    });

    it('returns the new entry id extracted from the response', async () => {
      mockAxiosPost.mockResolvedValue({ data: { data: { id: { entry_id: 'entry-1' } } } });

      const entryId = await service.addPersonToList('list-abc', 'rec-person-1', {
        industry: [{ value: 'SaaS' }],
      });

      expect(entryId).toBe('entry-1');
    });
  });

  describe('countListEntries', () => {
    it('propagates an error from the underlying request (e.g. invalid/unknown list)', async () => {
      mockAxiosPost.mockRejectedValue(new Error('Not Found'));
      await expect(service.countListEntries('bad-list')).rejects.toThrow('Not Found');
    });

    it('returns 0 for an empty list', async () => {
      mockAxiosPost.mockResolvedValue({ data: { data: [] } });
      const result = await service.countListEntries('list-abc');
      expect(result).toEqual({ count: 0, capped: false });
    });

    it('sums entries across multiple pages, advancing offset by page size (limit/offset, not cursor)', async () => {
      const fullPage = Array.from({ length: 50 }, (_, i) => ({ id: i }));
      mockAxiosPost
        .mockResolvedValueOnce({ data: { data: fullPage } })
        .mockResolvedValueOnce({ data: { data: [{ id: 51 }] } });

      const result = await service.countListEntries('list-abc');

      expect(result).toEqual({ count: 51, capped: false });
      expect(mockAxiosPost).toHaveBeenCalledTimes(2);
      expect(mockAxiosPost).toHaveBeenNthCalledWith(1, expect.any(String), { limit: 50, offset: 0 }, expect.any(Object));
      expect(mockAxiosPost).toHaveBeenNthCalledWith(2, expect.any(String), { limit: 50, offset: 50 }, expect.any(Object));
    });

    it('stops after 200 pages and reports capped:true for a pathologically large list', async () => {
      const fullPage = Array.from({ length: 50 }, (_, i) => ({ id: i }));
      mockAxiosPost.mockImplementation(() => Promise.resolve({ data: { data: fullPage } }));

      const result = await service.countListEntries('huge-list');

      expect(result).toEqual({ count: 10000, capped: true });
      expect(mockAxiosPost).toHaveBeenCalledTimes(200);
    });
  });

  describe('listListEntriesDetailed', () => {
    it('filters out an entry missing parent_record_id', async () => {
      mockAxiosPost.mockResolvedValue({
        data: {
          data: [
            { id: { entry_id: 'entry-1' }, entry_values: { deal_value: [{ value: '100' }] } },
          ],
        },
      });
      const { entries } = await service.listListEntriesDetailed('list-abc');
      expect(entries).toHaveLength(0);
    });

    it('filters out an entry missing id.entry_id', async () => {
      mockAxiosPost.mockResolvedValue({
        data: { data: [{ parent_record_id: 'person-1', entry_values: {} }] },
      });
      const { entries } = await service.listListEntriesDetailed('list-abc');
      expect(entries).toHaveLength(0);
    });

    it('extracts entryId, personRecordId, and values from a well-formed entry', async () => {
      mockAxiosPost.mockResolvedValue({
        data: {
          data: [
            {
              id: { entry_id: 'entry-1' },
              parent_record_id: 'person-1',
              entry_values: { deal_value: [{ value: '100' }], deal_status: [{ status: 'open' }] },
            },
          ],
        },
      });

      const { entries, nextOffset } = await service.listListEntriesDetailed('list-abc');

      expect(entries).toEqual([
        {
          entryId: 'entry-1',
          personRecordId: 'person-1',
          values: { deal_value: [{ value: '100' }], deal_status: [{ status: 'open' }] },
        },
      ]);
      // A 1-entry page is short of the 50-entry limit — end of results.
      expect(nextOffset).toBeUndefined();
    });

    it('defaults values to {} when entry_values is absent', async () => {
      mockAxiosPost.mockResolvedValue({
        data: { data: [{ id: { entry_id: 'entry-1' }, parent_record_id: 'person-1' }] },
      });
      const { entries } = await service.listListEntriesDetailed('list-abc');
      expect(entries[0].values).toEqual({});
    });

    it('passes the offset through to the underlying request', async () => {
      mockAxiosPost.mockResolvedValue({ data: { data: [] } });
      await service.listListEntriesDetailed('list-abc', 100);
      expect(mockAxiosPost).toHaveBeenCalledWith(
        expect.any(String),
        { limit: 50, offset: 100 },
        expect.any(Object)
      );
    });

    it('reports nextOffset when a full page comes back (there may be more)', async () => {
      const fullPage = Array.from({ length: 50 }, (_, i) => ({
        id: { entry_id: `entry-${i}` },
        parent_record_id: `person-${i}`,
        entry_values: {},
      }));
      mockAxiosPost.mockResolvedValue({ data: { data: fullPage } });

      const { nextOffset } = await service.listListEntriesDetailed('list-abc', 0);

      expect(nextOffset).toBe(50);
    });
  });
});
