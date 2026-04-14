/**
 * Unit tests for HubSpotService — Contacts CRUD methods
 * Tests cover: listContacts, findContactByEmail, createContact, updateContact, deleteContact
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('axios');
jest.mock('../services/connectedAccountsDb', () => ({
  getAccountsByUserId: jest.fn(),
  getAccountById: jest.fn(),
  updateAccountTokens: jest.fn(),
}));
jest.mock('../config/integrations', () => ({
  getHubSpotConfig: jest.fn().mockResolvedValue({
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    tokenUrl: 'https://api.hubapi.com/oauth/v1/token',
    redirectUri: 'http://localhost:3001/api/oauth/hubspot/callback',
    scopes: ['crm.objects.contacts.read', 'crm.objects.contacts.write'],
    authorizationUrl: 'https://app.hubspot.com/oauth/authorize',
    tokenInfoUrl: 'https://api.hubapi.com/oauth/v1/access-tokens',
  }),
}));

import axios from 'axios';
import { HubSpotService } from '../services/hubspotService';
import { getAccountsByUserId, getAccountById, updateAccountTokens } from '../services/connectedAccountsDb';

const mockAxiosGet = axios.get as jest.Mock;
const mockAxiosPost = axios.post as jest.Mock;
const mockAxiosPatch = axios.patch as jest.Mock;
const mockAxiosDelete = axios.delete as jest.Mock;
const mockGetAccountsByUserId = getAccountsByUserId as jest.MockedFunction<typeof getAccountsByUserId>;
const mockGetAccountById = getAccountById as jest.MockedFunction<typeof getAccountById>;

const MOCK_ACCOUNT = {
  platform: 'hubspot' as const,
  account_id: '12345',
  account_name: 'mycompany.hubspot.com',
  config: {
    account_type: 'oauth' as const,
    access_token: 'valid-token',
    refresh_token: 'refresh-token',
    token_expires_at: Date.now() + 3600 * 1000,
    hub_id: 12345,
    hub_domain: 'mycompany.hubspot.com',
  },
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
  userId: 'user-1',
};

const MOCK_HS_CONTACT = {
  id: 'hs-contact-1',
  properties: {
    email: 'john@acme.com',
    firstname: 'John',
    lastname: 'Doe',
    phone: '+1234567890',
    jobtitle: 'CTO',
    company: 'Acme Corp',
    hs_linkedin_url: 'https://linkedin.com/in/johndoe',
    lastmodifieddate: '2024-01-15T10:00:00Z',
  },
};

describe('HubSpotService — Contacts CRUD', () => {
  let service: HubSpotService;

  beforeEach(() => {
    service = new HubSpotService();
    jest.clearAllMocks();
    mockGetAccountsByUserId.mockResolvedValue([MOCK_ACCOUNT]);
    mockGetAccountById.mockResolvedValue(MOCK_ACCOUNT);
  });

  // ─── listContacts ─────────────────────────────────────────────────

  describe('listContacts', () => {
    it('returns mapped contacts array from HubSpot', async () => {
      mockAxiosGet.mockResolvedValue({
        data: { results: [MOCK_HS_CONTACT], paging: { next: { after: 'cursor-100' } } },
      });

      const result = await service.listContacts('user-1');

      expect(mockAxiosGet).toHaveBeenCalledWith(
        expect.stringContaining('crm/v3/objects/contacts'),
        expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer valid-token' }) })
      );
      expect(result.contacts).toHaveLength(1);
      expect(result.contacts[0]).toMatchObject({
        contactId: 'hs-contact-1',
        email: 'john@acme.com',
        firstName: 'John',
        lastName: 'Doe',
        company: 'Acme Corp',
      });
      expect(result.nextCursor).toBe('cursor-100');
    });

    it('passes after cursor for pagination', async () => {
      mockAxiosGet.mockResolvedValue({ data: { results: [] } });

      await service.listContacts('user-1', undefined, 'some-cursor');

      expect(mockAxiosGet).toHaveBeenCalledWith(
        expect.stringContaining('after=some-cursor'),
        expect.any(Object)
      );
    });

    it('returns empty array when no contacts', async () => {
      mockAxiosGet.mockResolvedValue({ data: { results: [] } });
      const result = await service.listContacts('user-1');
      expect(result.contacts).toHaveLength(0);
      expect(result.nextCursor).toBeUndefined();
    });

    it('throws if no HubSpot account connected', async () => {
      mockGetAccountsByUserId.mockResolvedValue([]);
      await expect(service.listContacts('user-1')).rejects.toThrow('HubSpot account not connected');
    });
  });

  // ─── findContactByEmail ───────────────────────────────────────────

  describe('findContactByEmail', () => {
    it('returns contact when found by email', async () => {
      mockAxiosPost.mockResolvedValue({ data: { results: [MOCK_HS_CONTACT] } });

      const contact = await service.findContactByEmail('user-1', 'john@acme.com');

      expect(contact).not.toBeNull();
      expect(contact?.email).toBe('john@acme.com');
      expect(mockAxiosPost).toHaveBeenCalledWith(
        expect.stringContaining('crm/v3/objects/contacts/search'),
        expect.objectContaining({ filterGroups: expect.any(Array) }),
        expect.any(Object)
      );
    });

    it('returns null when contact not found', async () => {
      mockAxiosPost.mockResolvedValue({ data: { results: [] } });
      const contact = await service.findContactByEmail('user-1', 'nobody@nowhere.com');
      expect(contact).toBeNull();
    });
  });

  // ─── createContact ────────────────────────────────────────────────

  describe('createContact', () => {
    it('creates contact and returns mapped result', async () => {
      mockAxiosPost.mockResolvedValue({ data: MOCK_HS_CONTACT });

      const contact = await service.createContact('user-1', {
        email: 'john@acme.com',
        firstName: 'John',
        lastName: 'Doe',
        company: 'Acme Corp',
        phone: '+1234567890',
        jobTitle: 'CTO',
        linkedinUrl: 'https://linkedin.com/in/johndoe',
      });

      expect(mockAxiosPost).toHaveBeenCalledWith(
        expect.stringContaining('crm/v3/objects/contacts'),
        expect.objectContaining({
          properties: expect.objectContaining({
            email: 'john@acme.com',
            firstname: 'John',
            lastname: 'Doe',
            company: 'Acme Corp',
          }),
        }),
        expect.any(Object)
      );
      expect(contact.contactId).toBe('hs-contact-1');
      expect(contact.email).toBe('john@acme.com');
    });

    it('throws on API error', async () => {
      mockAxiosPost.mockRejectedValue(new Error('API error'));
      await expect(service.createContact('user-1', { email: 'x@x.com' })).rejects.toThrow('API error');
    });

    it('maps all optional fields correctly', async () => {
      mockAxiosPost.mockResolvedValue({ data: MOCK_HS_CONTACT });

      await service.createContact('user-1', {
        email: 'test@test.com',
        linkedinUrl: 'https://linkedin.com/in/test',
      });

      expect(mockAxiosPost).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          properties: expect.objectContaining({
            hs_linkedin_url: 'https://linkedin.com/in/test',
          }),
        }),
        expect.any(Object)
      );
    });
  });

  // ─── updateContact ────────────────────────────────────────────────

  describe('updateContact', () => {
    it('patches contact by id with correct properties', async () => {
      mockAxiosPatch.mockResolvedValue({ data: MOCK_HS_CONTACT });

      const contact = await service.updateContact('user-1', 'hs-contact-1', { jobTitle: 'CEO' });

      expect(mockAxiosPatch).toHaveBeenCalledWith(
        expect.stringContaining('crm/v3/objects/contacts/hs-contact-1'),
        expect.objectContaining({
          properties: expect.objectContaining({ jobtitle: 'CEO' }),
        }),
        expect.any(Object)
      );
      expect(contact.contactId).toBe('hs-contact-1');
    });

    it('throws on invalid contact id', async () => {
      mockAxiosPatch.mockRejectedValue({ response: { status: 404 } });
      await expect(service.updateContact('user-1', 'bad-id', { firstName: 'X' })).rejects.toBeDefined();
    });
  });

  // ─── deleteContact ────────────────────────────────────────────────

  describe('deleteContact', () => {
    it('calls delete on correct contact endpoint', async () => {
      mockAxiosDelete.mockResolvedValue({ data: {} });

      await service.deleteContact('user-1', 'hs-contact-1');

      expect(mockAxiosDelete).toHaveBeenCalledWith(
        expect.stringContaining('crm/v3/objects/contacts/hs-contact-1'),
        expect.any(Object)
      );
    });

    it('throws on API error', async () => {
      mockAxiosDelete.mockRejectedValue(new Error('Not found'));
      await expect(service.deleteContact('user-1', 'bad-id')).rejects.toThrow('Not found');
    });
  });
});
