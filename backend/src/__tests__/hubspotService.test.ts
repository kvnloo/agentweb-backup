import { HubSpotService, DEFAULT_CONTACT_MAPPING, DEFAULT_DEAL_MAPPING, FieldMapping } from '../services/hubspotService';
import axios from 'axios';

jest.mock('axios');

const mockAxiosInstance = {
  get: jest.fn(),
  post: jest.fn(),
  patch: jest.fn(),
  put: jest.fn(),
};
(axios.create as jest.Mock).mockReturnValue(mockAxiosInstance);

describe('HubSpotService', () => {
  let service: HubSpotService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new HubSpotService('test-api-key');
  });

  describe('testConnection', () => {
    it('returns valid when API responds successfully', async () => {
      mockAxiosInstance.get.mockResolvedValue({ data: { results: [] } });
      const result = await service.testConnection();
      expect(result.valid).toBe(true);
      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/crm/v3/objects/contacts', { params: { limit: 1 } });
    });

    it('returns invalid with error message on API failure', async () => {
      mockAxiosInstance.get.mockRejectedValue({ response: { data: { message: 'Invalid API key' } } });
      const result = await service.testConnection();
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Invalid API key');
    });

    it('returns invalid with generic error on network failure', async () => {
      mockAxiosInstance.get.mockRejectedValue(new Error('Network error'));
      const result = await service.testConnection();
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Network error');
    });
  });

  describe('getContactByEmail', () => {
    it('returns contact when found', async () => {
      const contact = { id: '123', properties: { email: 'test@example.com', firstname: 'John' } };
      mockAxiosInstance.post.mockResolvedValue({ data: { results: [contact] } });

      const result = await service.getContactByEmail('test@example.com');
      expect(result).toEqual(contact);
      expect(mockAxiosInstance.post).toHaveBeenCalledWith('/crm/v3/objects/contacts/search', expect.objectContaining({
        filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: 'test@example.com' }] }],
      }));
    });

    it('returns null when no contact found', async () => {
      mockAxiosInstance.post.mockResolvedValue({ data: { results: [] } });
      const result = await service.getContactByEmail('notfound@example.com');
      expect(result).toBeNull();
    });

    it('returns null on error', async () => {
      mockAxiosInstance.post.mockRejectedValue(new Error('API error'));
      const result = await service.getContactByEmail('test@example.com');
      expect(result).toBeNull();
    });
  });

  describe('createContact', () => {
    it('creates contact with properties', async () => {
      const contact = { id: '123', properties: { email: 'test@example.com' } };
      mockAxiosInstance.post.mockResolvedValue({ data: contact });

      const result = await service.createContact({ email: 'test@example.com', firstname: 'John' });
      expect(result).toEqual(contact);
      expect(mockAxiosInstance.post).toHaveBeenCalledWith('/crm/v3/objects/contacts', {
        properties: { email: 'test@example.com', firstname: 'John' },
      });
    });
  });

  describe('updateContact', () => {
    it('updates contact by ID', async () => {
      const contact = { id: '123', properties: { firstname: 'Jane' } };
      mockAxiosInstance.patch.mockResolvedValue({ data: contact });

      const result = await service.updateContact('123', { firstname: 'Jane' });
      expect(result).toEqual(contact);
      expect(mockAxiosInstance.patch).toHaveBeenCalledWith('/crm/v3/objects/contacts/123', {
        properties: { firstname: 'Jane' },
      });
    });
  });

  describe('upsertContact', () => {
    it('creates new contact when not found', async () => {
      mockAxiosInstance.post
        .mockResolvedValueOnce({ data: { results: [] } }) // search returns empty
        .mockResolvedValueOnce({ data: { id: '456', properties: { email: 'new@example.com' } } }); // create

      const result = await service.upsertContact({ email: 'new@example.com', firstname: 'New' });
      expect(result.isNew).toBe(true);
      expect(result.contact.id).toBe('456');
    });

    it('updates existing contact when found', async () => {
      const existing = { id: '123', properties: { email: 'existing@example.com' } };
      mockAxiosInstance.post.mockResolvedValue({ data: { results: [existing] } }); // search
      mockAxiosInstance.patch.mockResolvedValue({ data: { id: '123', properties: { firstname: 'Updated' } } });

      const result = await service.upsertContact({ email: 'existing@example.com', firstname: 'Updated' });
      expect(result.isNew).toBe(false);
      expect(result.contact.id).toBe('123');
    });

    it('throws when email is missing', async () => {
      await expect(service.upsertContact({ firstname: 'NoEmail' })).rejects.toThrow('Email is required');
    });
  });

  describe('batchUpsertContacts', () => {
    it('processes leads and returns counts', async () => {
      // First lead: new, second lead: existing
      mockAxiosInstance.post
        .mockResolvedValueOnce({ data: { results: [] } }) // search lead1
        .mockResolvedValueOnce({ data: { id: '1', properties: {} } }) // create lead1
        .mockResolvedValueOnce({ data: { results: [{ id: '2', properties: {} }] } }); // search lead2
      mockAxiosInstance.patch.mockResolvedValue({ data: { id: '2', properties: {} } }); // update lead2

      const result = await service.batchUpsertContacts([
        { email: 'new@example.com', properties: { email: 'new@example.com' } },
        { email: 'existing@example.com', properties: { email: 'existing@example.com' } },
      ]);

      expect(result.created).toBe(1);
      expect(result.updated).toBe(1);
      expect(result.errors).toHaveLength(0);
    });

    it('captures errors per lead without stopping', async () => {
      mockAxiosInstance.post.mockRejectedValue({ response: { data: { message: 'Rate limited' } } });

      const result = await service.batchUpsertContacts([
        { email: 'fail@example.com', properties: { email: 'fail@example.com' } },
      ]);

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('fail@example.com');
    });
  });

  describe('listContacts', () => {
    it('paginates with after cursor', async () => {
      mockAxiosInstance.get.mockResolvedValue({
        data: { results: [{ id: '1', properties: {} }], paging: { next: { after: 'cursor123' } } },
      });

      const result = await service.listContacts('cursor123', 50);
      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/crm/v3/objects/contacts', {
        params: expect.objectContaining({ after: 'cursor123', limit: 50 }),
      });
      expect(result.paging?.next.after).toBe('cursor123');
    });
  });

  describe('Deals', () => {
    it('creates a deal', async () => {
      mockAxiosInstance.post.mockResolvedValue({ data: { id: 'deal1', properties: { amount: '1000' } } });
      const result = await service.createDeal({ amount: '1000', dealname: 'Test Deal' });
      expect(result.id).toBe('deal1');
    });

    it('updates a deal', async () => {
      mockAxiosInstance.patch.mockResolvedValue({ data: { id: 'deal1', properties: { amount: '2000' } } });
      const result = await service.updateDeal('deal1', { amount: '2000' });
      expect(result.properties.amount).toBe('2000');
    });

    it('associates contact to deal', async () => {
      mockAxiosInstance.put.mockResolvedValue({ data: {} });
      await service.associateContactToDeal('contact1', 'deal1');
      expect(mockAxiosInstance.put).toHaveBeenCalledWith(
        '/crm/v3/objects/contacts/contact1/associations/deals/deal1/contact_to_deal'
      );
    });
  });

  describe('Static mapping helpers', () => {
    describe('leadToContactProperties', () => {
      it('maps lead fields to HubSpot properties', () => {
        const lead = { email: 'test@example.com', firstName: 'John', lastName: 'Doe', company: 'Acme' };
        const props = HubSpotService.leadToContactProperties(lead);
        expect(props.email).toBe('test@example.com');
        expect(props.firstname).toBe('John');
        expect(props.lastname).toBe('Doe');
        expect(props.company).toBe('Acme');
      });

      it('skips null/empty/undefined values', () => {
        const lead = { email: 'test@example.com', firstName: '', lastName: null, phone: undefined };
        const props = HubSpotService.leadToContactProperties(lead);
        expect(props.email).toBe('test@example.com');
        expect(props).not.toHaveProperty('firstname');
        expect(props).not.toHaveProperty('lastname');
        expect(props).not.toHaveProperty('phone');
      });

      it('skips pull-only mappings', () => {
        const mapping: FieldMapping[] = [
          { agentwebField: 'email', hubspotProperty: 'email', direction: 'pull' },
        ];
        const lead = { email: 'test@example.com' };
        const props = HubSpotService.leadToContactProperties(lead, mapping);
        expect(props).not.toHaveProperty('email');
      });
    });

    describe('leadToDealProperties', () => {
      it('returns null when no deal data', () => {
        const lead = { email: 'test@example.com', firstName: 'John' };
        const result = HubSpotService.leadToDealProperties(lead);
        expect(result).toBeNull();
      });

      it('maps deal fields and generates dealname', () => {
        const lead = { firstName: 'John', lastName: 'Doe', dealValue: 5000, dealCurrency: 'USD', status: 'qualified' };
        const props = HubSpotService.leadToDealProperties(lead);
        expect(props).not.toBeNull();
        expect(props!.amount).toBe('5000');
        expect(props!.deal_currency_code).toBe('USD');
        expect(props!.dealstage).toBe('qualified');
        expect(props!.dealname).toBe('John Doe - Deal');
      });
    });

    describe('contactToLeadData', () => {
      it('maps HubSpot contact to lead data with hubspot_contact_id', () => {
        const contact = {
          id: 'hs123',
          properties: { email: 'test@example.com', firstname: 'John', lastname: 'Doe', company: 'Acme' },
        };
        const data = HubSpotService.contactToLeadData(contact as any);
        expect(data.email).toBe('test@example.com');
        expect(data.firstName).toBe('John');
        expect(data.lastName).toBe('Doe');
        expect(data.customFields.hubspot_contact_id).toBe('hs123');
      });

      it('skips push-only fields', () => {
        const contact = {
          id: 'hs123',
          properties: { email: 'test@example.com', hs_linkedin_url: 'https://linkedin.com/in/test' },
        };
        const data = HubSpotService.contactToLeadData(contact as any);
        expect(data.email).toBe('test@example.com');
        // linkedin is push-only in default mapping, so hs_linkedin_url should not map back
        expect(data).not.toHaveProperty('linkedin');
      });
    });

    describe('dealToLeadUpdates', () => {
      it('maps HubSpot deal to lead updates', () => {
        const deal = {
          id: 'deal456',
          properties: { amount: '3000', deal_currency_code: 'EUR', dealstage: 'won' },
        };
        const data = HubSpotService.dealToLeadUpdates(deal as any);
        expect(data.dealValue).toBe(3000);
        expect(data.dealCurrency).toBe('EUR');
        expect(data.status).toBe('won');
        expect(data.customFields.hubspot_deal_id).toBe('deal456');
      });

      it('handles non-numeric amount gracefully', () => {
        const deal = {
          id: 'deal789',
          properties: { amount: 'not-a-number' },
        };
        const data = HubSpotService.dealToLeadUpdates(deal as any);
        expect(data.dealValue).toBe(0);
      });
    });
  });
});
