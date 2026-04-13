import axios from 'axios';

export interface HubSpotContact {
  id: string;
  properties: Record<string, string | null>;
}

export interface HubSpotDeal {
  id: string;
  properties: Record<string, string | null>;
}

export interface HubSpotBatchResult {
  status: string;
  results: Array<{ id: string; properties: Record<string, string | null> }>;
  errors?: Array<{ message: string; context?: any }>;
}

export interface FieldMapping {
  agentwebField: string;
  hubspotProperty: string;
  direction: 'push' | 'pull' | 'both';
}

const DEFAULT_CONTACT_MAPPING: FieldMapping[] = [
  { agentwebField: 'email', hubspotProperty: 'email', direction: 'both' },
  { agentwebField: 'firstName', hubspotProperty: 'firstname', direction: 'both' },
  { agentwebField: 'lastName', hubspotProperty: 'lastname', direction: 'both' },
  { agentwebField: 'phone', hubspotProperty: 'phone', direction: 'both' },
  { agentwebField: 'company', hubspotProperty: 'company', direction: 'both' },
  { agentwebField: 'title', hubspotProperty: 'jobtitle', direction: 'both' },
  { agentwebField: 'linkedin', hubspotProperty: 'hs_linkedin_url', direction: 'push' },
  { agentwebField: 'notes', hubspotProperty: 'notes', direction: 'push' },
];

const DEFAULT_DEAL_MAPPING: FieldMapping[] = [
  { agentwebField: 'dealValue', hubspotProperty: 'amount', direction: 'both' },
  { agentwebField: 'dealCurrency', hubspotProperty: 'deal_currency_code', direction: 'both' },
  { agentwebField: 'status', hubspotProperty: 'dealstage', direction: 'both' },
];

export { DEFAULT_CONTACT_MAPPING, DEFAULT_DEAL_MAPPING };

export class HubSpotService {
  private client: ReturnType<typeof axios.create>;

  constructor(apiKey: string) {
    this.client = axios.create({
      baseURL: 'https://api.hubapi.com',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });
  }

  async testConnection(): Promise<{ valid: boolean; portalId?: string; error?: string }> {
    try {
      const resp = await this.client.get('/crm/v3/objects/contacts', { params: { limit: 1 } });
      return { valid: true };
    } catch (err: any) {
      const msg = err.response?.data?.message || err.message || 'Unknown error';
      return { valid: false, error: msg };
    }
  }

  // --- Contacts ---

  async getContactByEmail(email: string): Promise<HubSpotContact | null> {
    try {
      const resp = await this.client.post('/crm/v3/objects/contacts/search', {
        filterGroups: [{
          filters: [{ propertyName: 'email', operator: 'EQ', value: email }],
        }],
        properties: ['email', 'firstname', 'lastname', 'phone', 'company', 'jobtitle', 'hs_linkedin_url', 'notes'],
        limit: 1,
      });
      const data = resp.data as any;
      const results = data.results;
      return results.length > 0 ? results[0] : null;
    } catch {
      return null;
    }
  }

  async createContact(properties: Record<string, string>): Promise<HubSpotContact> {
    const resp = await this.client.post('/crm/v3/objects/contacts', { properties });
    return resp.data as HubSpotContact;
  }

  async updateContact(contactId: string, properties: Record<string, string>): Promise<HubSpotContact> {
    const resp = await this.client.patch(`/crm/v3/objects/contacts/${contactId}`, { properties });
    return resp.data as HubSpotContact;
  }

  async upsertContact(properties: Record<string, string>): Promise<{ contact: HubSpotContact; isNew: boolean }> {
    const email = properties.email;
    if (!email) throw new Error('Email is required to upsert a contact');

    const existing = await this.getContactByEmail(email);
    if (existing) {
      const updated = await this.updateContact(existing.id, properties);
      return { contact: updated, isNew: false };
    }
    const created = await this.createContact(properties);
    return { contact: created, isNew: true };
  }

  async batchUpsertContacts(
    leads: Array<{ email: string; properties: Record<string, string> }>
  ): Promise<{ created: number; updated: number; errors: string[] }> {
    const result = { created: 0, updated: 0, errors: [] as string[] };

    // Process in chunks of 100 (HubSpot batch limit)
    const chunks = chunkArray(leads, 100);
    for (const chunk of chunks) {
      for (const lead of chunk) {
        try {
          const { isNew } = await this.upsertContact(lead.properties);
          if (isNew) result.created++;
          else result.updated++;
        } catch (err: any) {
          const msg = err.response?.data?.message || err.message || 'Unknown error';
          result.errors.push(`${lead.email}: ${msg}`);
        }
      }
    }
    return result;
  }

  async listContacts(after?: string, limit: number = 100): Promise<{
    results: HubSpotContact[];
    paging?: { next: { after: string } };
  }> {
    const params: any = {
      limit,
      properties: 'email,firstname,lastname,phone,company,jobtitle,hs_linkedin_url,notes',
    };
    if (after) params.after = after;
    const resp = await this.client.get('/crm/v3/objects/contacts', { params });
    return resp.data as any;
  }

  // --- Deals ---

  async createDeal(properties: Record<string, string>): Promise<HubSpotDeal> {
    const resp = await this.client.post('/crm/v3/objects/deals', { properties });
    return resp.data as HubSpotDeal;
  }

  async updateDeal(dealId: string, properties: Record<string, string>): Promise<HubSpotDeal> {
    const resp = await this.client.patch(`/crm/v3/objects/deals/${dealId}`, { properties });
    return resp.data as HubSpotDeal;
  }

  async getDealsByContactId(contactId: string): Promise<HubSpotDeal[]> {
    try {
      const resp = await this.client.get(
        `/crm/v3/objects/contacts/${contactId}/associations/deals`
      );
      const associations = (resp.data as any).results || [];
      if (associations.length === 0) return [];

      const deals: HubSpotDeal[] = [];
      for (const assoc of associations) {
        try {
          const dealResp = await this.client.get(`/crm/v3/objects/deals/${assoc.id}`, {
            params: { properties: 'amount,deal_currency_code,dealstage,dealname' },
          });
          deals.push(dealResp.data as HubSpotDeal);
        } catch {
          // Skip deals we can't fetch
        }
      }
      return deals;
    } catch {
      return [];
    }
  }

  async listDeals(after?: string, limit: number = 100): Promise<{
    results: HubSpotDeal[];
    paging?: { next: { after: string } };
  }> {
    const params: any = {
      limit,
      properties: 'amount,deal_currency_code,dealstage,dealname',
    };
    if (after) params.after = after;
    const resp = await this.client.get('/crm/v3/objects/deals', { params });
    return resp.data as any;
  }

  // --- Associations ---

  async associateContactToDeal(contactId: string, dealId: string): Promise<void> {
    await this.client.put(
      `/crm/v3/objects/contacts/${contactId}/associations/deals/${dealId}/contact_to_deal`
    );
  }

  // --- Mapping Helpers ---

  static leadToContactProperties(lead: any, fieldMapping: FieldMapping[] = DEFAULT_CONTACT_MAPPING): Record<string, string> {
    const props: Record<string, string> = {};
    for (const mapping of fieldMapping) {
      if (mapping.direction === 'pull') continue;
      const value = getNestedValue(lead, mapping.agentwebField);
      if (value !== undefined && value !== null && value !== '') {
        props[mapping.hubspotProperty] = String(value);
      }
    }
    return props;
  }

  static leadToDealProperties(lead: any, fieldMapping: FieldMapping[] = DEFAULT_DEAL_MAPPING): Record<string, string> | null {
    // Only create deal if lead has deal data
    if (!lead.dealValue && !lead.status) return null;

    const props: Record<string, string> = {};
    for (const mapping of fieldMapping) {
      if (mapping.direction === 'pull') continue;
      const value = getNestedValue(lead, mapping.agentwebField);
      if (value !== undefined && value !== null && value !== '') {
        props[mapping.hubspotProperty] = String(value);
      }
    }
    // Add a deal name if not mapped
    if (!props.dealname) {
      const name = [lead.firstName, lead.lastName].filter(Boolean).join(' ') || lead.email || 'Unknown';
      props.dealname = `${name} - Deal`;
    }
    return Object.keys(props).length > 0 ? props : null;
  }

  static contactToLeadData(contact: HubSpotContact, fieldMapping: FieldMapping[] = DEFAULT_CONTACT_MAPPING): Record<string, any> {
    const data: Record<string, any> = {};
    for (const mapping of fieldMapping) {
      if (mapping.direction === 'push') continue;
      const value = contact.properties[mapping.hubspotProperty];
      if (value !== undefined && value !== null && value !== '') {
        data[mapping.agentwebField] = value;
      }
    }
    // Store HubSpot contact ID for future updates
    if (!data.customFields) data.customFields = {};
    data.customFields.hubspot_contact_id = contact.id;
    return data;
  }

  static dealToLeadUpdates(deal: HubSpotDeal, fieldMapping: FieldMapping[] = DEFAULT_DEAL_MAPPING): Record<string, any> {
    const data: Record<string, any> = {};
    for (const mapping of fieldMapping) {
      if (mapping.direction === 'push') continue;
      const value = deal.properties[mapping.hubspotProperty];
      if (value !== undefined && value !== null && value !== '') {
        if (mapping.agentwebField === 'dealValue') {
          data[mapping.agentwebField] = parseFloat(value) || 0;
        } else {
          data[mapping.agentwebField] = value;
        }
      }
    }
    if (!data.customFields) data.customFields = {};
    data.customFields.hubspot_deal_id = deal.id;
    return data;
  }
}

function getNestedValue(obj: any, path: string): any {
  const parts = path.split('.');
  let current = obj;
  for (const part of parts) {
    if (current === undefined || current === null) return undefined;
    current = current[part];
  }
  return current;
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}
