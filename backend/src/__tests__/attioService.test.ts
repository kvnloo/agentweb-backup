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
  let service: AttioService;

  beforeEach(() => {
    service = new AttioService();
    jest.clearAllMocks();
    mockGetAccountsByUserId.mockResolvedValue([MOCK_ACCOUNT]);
    mockGetAccountById.mockResolvedValue(MOCK_ACCOUNT);
    mockUpdateAccountConfig.mockResolvedValue(undefined);
  });

  // ─── Account resolution ──────────────────────────────────────────

  describe('account resolution', () => {
    it('throws if no Attio account connected', async () => {
      mockGetAccountsByUserId.mockResolvedValue([]);
      await expect(service.listPeople('user-1')).rejects.toThrow('Attio account not connected');
    });

    it('throws if multiple Attio accounts and no accountId specified', async () => {
      mockGetAccountsByUserId.mockResolvedValue([MOCK_ACCOUNT, { ...MOCK_ACCOUNT, account_id: 'ws-456' }]);
      await expect(service.listPeople('user-1')).rejects.toThrow('Multiple Attio accounts');
    });

    it('throws if accountId not found', async () => {
      mockGetAccountById.mockResolvedValue(null);
      await expect(service.listPeople('user-1', 'bad-id')).rejects.toThrow('not found');
    });
  });

  // ─── People ──────────────────────────────────────────────────────

  describe('listPeople', () => {
    it('returns mapped people array', async () => {
      mockAxiosPost.mockResolvedValue({ data: { data: [MOCK_PERSON_RECORD], next_cursor: undefined } });

      const result = await service.listPeople('user-1');

      expect(mockAxiosPost).toHaveBeenCalledWith(
        'https://api.attio.com/v2/objects/people/records/query',
        { limit: 50 },
        expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer test-token' }) })
      );
      expect(result.people).toHaveLength(1);
      expect(result.people[0]).toMatchObject({ recordId: 'rec-person-1', email: 'john@acme.com', firstName: 'John' });
    });

    it('passes cursor for pagination', async () => {
      mockAxiosPost.mockResolvedValue({ data: { data: [], next_cursor: 'next-page' } });

      const result = await service.listPeople('user-1', undefined, 'some-cursor');

      expect(mockAxiosPost).toHaveBeenCalledWith(
        expect.any(String),
        { limit: 50, cursor: 'some-cursor' },
        expect.any(Object)
      );
      expect(result.nextCursor).toBe('next-page');
    });

    it('returns empty array when no records', async () => {
      mockAxiosPost.mockResolvedValue({ data: { data: [] } });
      const result = await service.listPeople('user-1');
      expect(result.people).toHaveLength(0);
    });
  });

  describe('findPersonByEmail', () => {
    it('returns person with recordId when found', async () => {
      mockAxiosPost.mockResolvedValue({
        data: { data: [{ id: { record_id: 'rec-person-1' } }] },
      });

      const person = await service.findPersonByEmail('user-1', 'john@acme.com');

      expect(person).not.toBeNull();
      expect(person?.recordId).toBe('rec-person-1');
      expect(mockAxiosGet).not.toHaveBeenCalled();
    });

    it('returns null when search returns no results', async () => {
      mockAxiosPost.mockResolvedValue({ data: { data: [] } });
      const person = await service.findPersonByEmail('user-1', 'nobody@nowhere.com');
      expect(person).toBeNull();
    });
  });

  describe('createPerson', () => {
    it('creates person and returns mapped record', async () => {
      mockAxiosPost.mockResolvedValue({ data: { data: MOCK_PERSON_RECORD } });

      const person = await service.createPerson('user-1', {
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

      const person = await service.createPerson('user-1', { firstName: 'No', lastName: 'Email' });
      expect(person.recordId).toBe('rec-2');
      expect(person.email).toBe('');
    });

    it('throws on API error', async () => {
      mockAxiosPost.mockRejectedValue(new Error('API error'));
      await expect(service.createPerson('user-1', { email: 'x@x.com' })).rejects.toThrow('API error');
    });
  });

  describe('updatePerson', () => {
    it('calls patch with correct record id and values', async () => {
      mockAxiosPatch.mockResolvedValue({ data: { data: MOCK_PERSON_RECORD } });

      const person = await service.updatePerson('user-1', 'rec-person-1', { jobTitle: 'CEO' });

      expect(mockAxiosPatch).toHaveBeenCalledWith(
        'https://api.attio.com/v2/objects/people/records/rec-person-1',
        expect.objectContaining({ data: expect.objectContaining({ values: expect.objectContaining({ job_title: expect.any(Array) }) }) }),
        expect.any(Object)
      );
      expect(person.recordId).toBe('rec-person-1');
    });

    it('throws on invalid record id', async () => {
      mockAxiosPatch.mockRejectedValue({ response: { status: 404 } });
      await expect(service.updatePerson('user-1', 'bad-id', { jobTitle: 'X' })).rejects.toBeDefined();
    });
  });

  describe('deletePerson', () => {
    it('calls delete with correct record id', async () => {
      mockAxiosDelete.mockResolvedValue({ data: {} });

      await service.deletePerson('user-1', 'rec-person-1');

      expect(mockAxiosDelete).toHaveBeenCalledWith(
        'https://api.attio.com/v2/objects/people/records/rec-person-1',
        expect.any(Object)
      );
    });

    it('throws on API error', async () => {
      mockAxiosDelete.mockRejectedValue(new Error('Not found'));
      await expect(service.deletePerson('user-1', 'bad-id')).rejects.toThrow('Not found');
    });
  });

  // ─── Companies ───────────────────────────────────────────────────

  describe('listCompanies', () => {
    it('returns mapped companies array', async () => {
      mockAxiosPost.mockResolvedValue({ data: { data: [MOCK_COMPANY_RECORD] } });

      const result = await service.listCompanies('user-1');

      expect(result.companies).toHaveLength(1);
      expect(result.companies[0]).toMatchObject({ recordId: 'rec-company-1', name: 'Acme Corp' });
    });

    it('returns empty array when no companies', async () => {
      mockAxiosPost.mockResolvedValue({ data: { data: [] } });
      const result = await service.listCompanies('user-1');
      expect(result.companies).toHaveLength(0);
    });
  });

  describe('findCompanyByName', () => {
    it('returns company when found', async () => {
      mockAxiosPost.mockResolvedValue({ data: { data: [MOCK_COMPANY_RECORD] } });
      const company = await service.findCompanyByName('user-1', 'Acme Corp');
      expect(company?.name).toBe('Acme Corp');
    });

    it('returns null when not found', async () => {
      mockAxiosPost.mockResolvedValue({ data: { data: [] } });
      const company = await service.findCompanyByName('user-1', 'Unknown Co');
      expect(company).toBeNull();
    });
  });

  describe('createCompany', () => {
    it('creates company with name and returns mapped record', async () => {
      mockAxiosPost.mockResolvedValue({ data: { data: MOCK_COMPANY_RECORD } });

      const company = await service.createCompany('user-1', 'Acme Corp');

      expect(mockAxiosPost).toHaveBeenCalledWith(
        'https://api.attio.com/v2/objects/companies/records',
        expect.objectContaining({ data: expect.objectContaining({ values: expect.objectContaining({ name: expect.any(Array) }) }) }),
        expect.any(Object)
      );
      expect(company.name).toBe('Acme Corp');
    });
  });

  // ─── Webhooks ────────────────────────────────────────────────────

  describe('registerWebhook', () => {
    it('posts to /v2/webhooks with correct subscriptions and stores webhook_id', async () => {
      mockAxiosPost.mockResolvedValue({ data: { data: { id: { webhook_id: 'wh-abc' }, target_url: 'https://api.agentweb.pro/api/webhooks/attio', subscriptions: ['record.created', 'record.updated', 'record.deleted'] } } });

      const result = await service.registerWebhook('user-1');

      expect(mockAxiosPost).toHaveBeenCalledWith(
        'https://api.attio.com/v2/webhooks',
        expect.objectContaining({
          data: expect.objectContaining({
            target_url: 'https://api.agentweb.pro/api/webhooks/attio',
            subscriptions: ['record.created', 'record.updated', 'record.deleted'],
          }),
        }),
        expect.any(Object)
      );
      expect(mockUpdateAccountConfig).toHaveBeenCalledWith('user-1', 'attio', 'ws-123', { webhook_id: 'wh-abc' });
      expect(result.webhookId).toBe('wh-abc');
    });

    it('throws if account not found', async () => {
      mockGetAccountsByUserId.mockResolvedValue([]);
      await expect(service.registerWebhook('user-1')).rejects.toThrow('Attio account not connected');
    });
  });

  describe('deleteWebhook', () => {
    it('calls delete on correct webhook endpoint', async () => {
      mockAxiosDelete.mockResolvedValue({ data: {} });

      await service.deleteWebhook('user-1', 'wh-abc');

      expect(mockAxiosDelete).toHaveBeenCalledWith(
        'https://api.attio.com/v2/webhooks/wh-abc',
        expect.any(Object)
      );
    });
  });

  describe('listWebhooks', () => {
    it('returns mapped webhooks array', async () => {
      mockAxiosGet.mockResolvedValue({
        data: {
          data: [
            { id: { webhook_id: 'wh-1' }, target_url: 'https://api.agentweb.pro/api/webhooks/attio', subscriptions: ['record.created'] },
          ],
        },
      });

      const webhooks = await service.listWebhooks('user-1');

      expect(webhooks).toHaveLength(1);
      expect(webhooks[0]).toMatchObject({ webhookId: 'wh-1', targetUrl: 'https://api.agentweb.pro/api/webhooks/attio' });
    });

    it('returns empty array when no webhooks', async () => {
      mockAxiosGet.mockResolvedValue({ data: { data: [] } });
      const webhooks = await service.listWebhooks('user-1');
      expect(webhooks).toHaveLength(0);
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

      const attrs = await service.listListAttributes('user-1', 'list-abc');

      expect(mockAxiosGet).toHaveBeenCalledWith(
        'https://api.attio.com/v2/lists/list-abc/attributes',
        expect.any(Object)
      );
      expect(attrs).toHaveLength(2);
      expect(attrs[0].api_slug).toBe('industry');
    });

    it('returns empty array when list has no custom attributes', async () => {
      mockAxiosGet.mockResolvedValue({ data: { data: [] } });
      const attrs = await service.listListAttributes('user-1', 'list-abc');
      expect(attrs).toHaveLength(0);
    });

    it('throws if account not connected', async () => {
      mockGetAccountsByUserId.mockResolvedValue([]);
      await expect(service.listListAttributes('user-1', 'list-abc')).rejects.toThrow('Attio account not connected');
    });
  });

  describe('ensureListAttribute', () => {
    it('returns existing slug without creating if attribute already exists', async () => {
      mockAxiosGet.mockResolvedValue({
        data: { data: [{ api_slug: 'industry', title: 'Industry' }] },
      });

      const slug = await service.ensureListAttribute('user-1', 'list-abc', 'industry', 'Industry');

      expect(slug).toBe('industry');
      expect(mockAxiosPost).not.toHaveBeenCalled();
    });

    it('creates attribute when it does not exist', async () => {
      mockAxiosGet.mockResolvedValue({ data: { data: [] } });
      mockAxiosPost.mockResolvedValue({ data: { data: { api_slug: 'revenue_arr' } } });

      const slug = await service.ensureListAttribute('user-1', 'list-abc', 'revenue_arr', 'Revenue ARR');

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

      const slug = await service.ensureListAttribute('user-1', 'list-abc', 'leadSource', 'Lead Source');

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

      await service.addPersonToList('user-1', 'list-abc', 'rec-person-1', undefined, {
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

      await service.addPersonToList('user-1', 'list-abc', 'rec-person-1');

      expect(mockAxiosPost).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          data: expect.objectContaining({ entry_values: {} }),
        }),
        expect.any(Object)
      );
    });
  });
});
