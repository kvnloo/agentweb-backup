import axios from 'axios';
import { getHubSpotConfig } from '../config/integrations';
import { getAccountsByUserId, getAccountById, updateAccountTokens } from './connectedAccountsDb';

// ─────────────────────────────────────────────────────────────────────────────
// HUBSPOT WEBHOOK EVENTS
//
// Webhooks are configured ONCE in the HubSpot Developer Portal (not per user):
//   App Settings → Webhooks → Target URL → ${BACKEND_URL}/api/webhooks/hubspot
//
// Subscribe to these event types in the portal:
//
//   contact.creation        — a new contact was added to any connected portal
//                             → pull into our lead list (create lead if not found)
//
//   contact.propertyChange  — a contact field was updated
//                             Configure which properties to watch:
//                             email, phone, firstname, lastname, jobtitle,
//                             company, hs_linkedin_url
//                             → find matching lead by email and update fields
//
//   contact.deletion        — a contact was permanently deleted
//                             → mark lead as removed / flag for review
//
// Events to skip (do NOT subscribe in the portal):
//   company.*   — we don't sync company objects in v1
//   deal.*      — not in scope for v1
//   ticket.*    — not relevant
//
// Each event payload includes portalId — use it to look up which user it
// belongs to by matching against connected accounts with hub_id === portalId.
// ─────────────────────────────────────────────────────────────────────────────

const HUBSPOT_API_BASE = 'https://api.hubapi.com';

export interface HubSpotContact {
  contactId: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  jobTitle?: string;
  company?: string;
  linkedinUrl?: string;
  updatedAt?: string;
  customFields?: Record<string, any>;
}

const TOKEN_REFRESH_BUFFER_MS = 60 * 1000; // refresh 60s before expiry
const refreshLocks = new Map<string, Promise<string>>();

export class HubSpotService {
  /**
   * Returns a valid HubSpot access token, refreshing it if it's expired/expiring soon.
   * If multiple HubSpot accounts are connected, accountId is required.
   */
  async getValidAccessToken(userId: string, accountId?: string): Promise<string> {
    const account = await this.resolveHubSpotAccount(userId, accountId);
    const config = account.config as any;

    const expiresAt = config.token_expires_at || 0;
    const isExpiringSoon = expiresAt - Date.now() < TOKEN_REFRESH_BUFFER_MS;

    if (!isExpiringSoon) {
      return config.access_token;
    }

    if (!config.refresh_token) {
      throw new Error('HubSpot access token expired and no refresh token is available. Please reconnect your HubSpot account.');
    }

    const lockKey = `${userId}:${account.account_id}`;
    if (refreshLocks.has(lockKey)) {
      return refreshLocks.get(lockKey)!;
    }

    const refreshPromise = this.refreshToken(userId, account.account_id, config.refresh_token)
      .finally(() => {
        refreshLocks.delete(lockKey);
      });
    refreshLocks.set(lockKey, refreshPromise);
    return refreshPromise;
  }

  private async refreshToken(userId: string, accountId: string, refreshToken: string): Promise<string> {
    const hubspotConfig = await getHubSpotConfig();

    const response = await axios.post(
      hubspotConfig.tokenUrl,
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: hubspotConfig.clientId,
        client_secret: hubspotConfig.clientSecret,
      }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const { access_token, refresh_token, expires_in } = response.data as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };

    await updateAccountTokens(
      userId,
      'hubspot',
      {
        access_token,
        refresh_token: refresh_token ?? refreshToken,
        token_expires_at: Date.now() + expires_in * 1000,
      },
      accountId
    );

    return access_token;
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  private authHeaders(accessToken: string) {
    return {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    };
  }

  private mapContact(record: any): HubSpotContact {
    const p = record?.properties ?? {};
    return {
      contactId: record?.id,
      email: p.email ?? '',
      firstName: p.firstname ?? '',
      lastName: p.lastname ?? '',
      phone: p.phone ?? '',
      jobTitle: p.jobtitle ?? '',
      company: p.company ?? '',
      linkedinUrl: p.hs_linkedin_url ?? '',
      updatedAt: p.lastmodifieddate ?? '',
    };
  }

  // ─── Contacts ────────────────────────────────────────────────────────────────

  async listContacts(
    userId: string,
    accountId?: string,
    cursor?: string
  ): Promise<{ contacts: HubSpotContact[]; nextCursor?: string }> {
    const token = await this.getValidAccessToken(userId, accountId);
    const properties = 'email,firstname,lastname,phone,jobtitle,company,hs_linkedin_url,lastmodifieddate';
    const limit = 50;

    let url = `${HUBSPOT_API_BASE}/crm/v3/objects/contacts?limit=${limit}&properties=${properties}`;
    if (cursor) url += `&after=${cursor}`;

    const res = await axios.get(url, { headers: this.authHeaders(token) });

    return {
      contacts: ((res.data as any)?.results ?? []).map((r: any) => this.mapContact(r)),
      nextCursor: (res.data as any)?.paging?.next?.after,
    };
  }

  async findContactByEmail(
    userId: string,
    email: string,
    accountId?: string
  ): Promise<HubSpotContact | null> {
    const token = await this.getValidAccessToken(userId, accountId);
    const properties = ['email', 'firstname', 'lastname', 'phone', 'jobtitle', 'company', 'hs_linkedin_url', 'lastmodifieddate'];

    const res = await axios.post(
      `${HUBSPOT_API_BASE}/crm/v3/objects/contacts/search`,
      {
        filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email.toLowerCase() }] }],
        properties,
        limit: 1,
      },
      { headers: this.authHeaders(token) }
    );

    const results = (res.data as any)?.results ?? [];
    return results.length > 0 ? this.mapContact(results[0]) : null;
  }

  async createContact(
    userId: string,
    data: Omit<HubSpotContact, 'contactId'>,
    accountId?: string
  ): Promise<HubSpotContact> {
    const token = await this.getValidAccessToken(userId, accountId);
    const properties: Record<string, string> = {};

    if (data.email) properties.email = data.email.toLowerCase();
    if (data.firstName) properties.firstname = data.firstName;
    if (data.lastName) properties.lastname = data.lastName;
    if (data.phone) properties.phone = data.phone;
    if (data.jobTitle) properties.jobtitle = data.jobTitle;
    if (data.company) properties.company = data.company;
    if (data.linkedinUrl) properties.hs_linkedin_url = data.linkedinUrl;

    if (data.customFields) {
      for (const [k, v] of Object.entries(data.customFields)) {
        properties[k] = String(v);
      }
    }

    const res = await axios.post(
      `${HUBSPOT_API_BASE}/crm/v3/objects/contacts`,
      { properties },
      { headers: this.authHeaders(token) }
    );

    return this.mapContact((res.data as any));
  }

  async updateContact(
    userId: string,
    contactId: string,
    data: Partial<Omit<HubSpotContact, 'contactId'>>,
    accountId?: string
  ): Promise<HubSpotContact> {
    const token = await this.getValidAccessToken(userId, accountId);
    const properties: Record<string, string> = {};

    if (data.email !== undefined) properties.email = data.email.toLowerCase();
    if (data.firstName !== undefined) properties.firstname = data.firstName;
    if (data.lastName !== undefined) properties.lastname = data.lastName;
    if (data.phone !== undefined) properties.phone = data.phone;
    if (data.jobTitle !== undefined) properties.jobtitle = data.jobTitle;
    if (data.company !== undefined) properties.company = data.company;
    if (data.linkedinUrl !== undefined) properties.hs_linkedin_url = data.linkedinUrl;

    if (data.customFields) {
      for (const [k, v] of Object.entries(data.customFields)) {
        properties[k] = String(v);
      }
    }

    const res = await axios.patch(
      `${HUBSPOT_API_BASE}/crm/v3/objects/contacts/${contactId}`,
      { properties },
      { headers: this.authHeaders(token) }
    );

    return this.mapContact((res.data as any));
  }

  async getContactEmailById(userId: string, contactId: string, accountId?: string): Promise<string | null> {
    const token = await this.getValidAccessToken(userId, accountId);
    try {
      const res = await axios.get(
        `${HUBSPOT_API_BASE}/crm/v3/objects/contacts/${contactId}?properties=email`,
        { headers: this.authHeaders(token) }
      );
      return (res.data as any)?.properties?.email || null;
    } catch (e: any) {
      if (e?.response?.status === 404) return null;
      throw e;
    }
  }

  async deleteContact(userId: string, contactId: string, accountId?: string): Promise<void> {
    const token = await this.getValidAccessToken(userId, accountId);
    await axios.delete(
      `${HUBSPOT_API_BASE}/crm/v3/objects/contacts/${contactId}`,
      { headers: this.authHeaders(token) }
    );
  }

  // ─── Companies ───────────────────────────────────────────────────────────────

  async findCompanyByName(userId: string, name: string, accountId?: string): Promise<string | null> {
    const token = await this.getValidAccessToken(userId, accountId);

    const res = await axios.post(
      `${HUBSPOT_API_BASE}/crm/v3/objects/companies/search`,
      {
        filterGroups: [{ filters: [{ propertyName: 'name', operator: 'EQ', value: name }] }],
        properties: ['name'],
        limit: 1,
      },
      { headers: this.authHeaders(token) }
    );

    const results = (res.data as any)?.results ?? [];
    return results.length > 0 ? results[0].id : null;
  }

  async createCompany(userId: string, name: string, accountId?: string): Promise<string> {
    const token = await this.getValidAccessToken(userId, accountId);

    const res = await axios.post(
      `${HUBSPOT_API_BASE}/crm/v3/objects/companies`,
      { properties: { name } },
      { headers: this.authHeaders(token) }
    );

    return (res.data as any).id;
  }

  // Find or create a company by name, returns HubSpot company ID
  async findOrCreateCompany(userId: string, name: string, accountId?: string): Promise<string> {
    const existing = await this.findCompanyByName(userId, name, accountId);
    if (existing) return existing;
    return this.createCompany(userId, name, accountId);
  }

  // ─── Properties ──────────────────────────────────────────────────────────────

  async ensureContactProperty(userId: string, key: string, label: string, accountId?: string): Promise<string> {
    const token = await this.getValidAccessToken(userId, accountId);
    // HubSpot properties must be lower case and alphanumerics/underscores
    const propertyName = key.toLowerCase().replace(/[^a-z0-9]/g, '_');

    try {
      await axios.get(
        `${HUBSPOT_API_BASE}/crm/v3/properties/contacts/${propertyName}`,
        { headers: this.authHeaders(token) }
      );
      return propertyName;
    } catch (err: any) {
      // 404 means the property doesn't exist, so create it
      if (err?.response?.status === 404) {
        await axios.post(
          `${HUBSPOT_API_BASE}/crm/v3/properties/contacts`,
          {
            name: propertyName,
            label,
            type: 'string',
            fieldType: 'text',
            groupName: 'contactinformation',
          },
          { headers: this.authHeaders(token) }
        );
        return propertyName;
      }
      throw err;
    }
  }

  // ─── Lists ────────────────────────────────────────────────────────────────────
  // HubSpot "lists" are static lists of contacts (ILS v3 API)

  async findListByName(userId: string, name: string, accountId?: string): Promise<string | null> {
    const token = await this.getValidAccessToken(userId, accountId);

    const res = await axios.get(
      `${HUBSPOT_API_BASE}/crm/v3/lists/?count=100`,
      { headers: this.authHeaders(token) }
    );

    const lists = (res.data as any)?.lists ?? [];
    const match = lists.find((l: any) => l.name === name);
    return match ? String(match.listId) : null;
  }

  async createList(userId: string, name: string, accountId?: string): Promise<string> {
    const token = await this.getValidAccessToken(userId, accountId);

    const res = await axios.post(
      `${HUBSPOT_API_BASE}/crm/v3/lists/`,
      { name, objectTypeId: '0-1', processingType: 'MANUAL' },
      { headers: this.authHeaders(token) }
    );

    return String((res.data as any)?.listId ?? (res.data as any)?.list?.listId);
  }

  // Find or create a list by name, returns HubSpot list ID
  async findOrCreateList(userId: string, name: string, accountId?: string): Promise<string> {
    const existing = await this.findListByName(userId, name, accountId);
    if (existing) return existing;
    return this.createList(userId, name, accountId);
  }

  async addContactToList(userId: string, listId: string, contactIds: string[], accountId?: string): Promise<void> {
    const token = await this.getValidAccessToken(userId, accountId);

    await axios.put(
      `${HUBSPOT_API_BASE}/crm/v3/lists/${listId}/memberships/add`,
      contactIds,
      { headers: this.authHeaders(token) }
    );
  }

  // ─── Account resolution ──────────────────────────────────────────────────────

  private async resolveHubSpotAccount(userId: string, accountId?: string) {
    if (accountId) {
      const account = await getAccountById(accountId, userId);
      if (!account || account.platform !== 'hubspot') {
        throw new Error(`HubSpot account "${accountId}" not found. Please reconnect your account.`);
      }
      return account;
    }

    const accounts = await getAccountsByUserId(userId);
    const hubspotAccounts = accounts.filter(acc => acc.platform === 'hubspot');
    if (hubspotAccounts.length === 0) {
      throw new Error('HubSpot account not connected. Please connect your HubSpot account in Settings.');
    }
    if (hubspotAccounts.length > 1) {
      const list = hubspotAccounts.map(a => `${a.account_name} (ID: ${a.account_id})`).join(', ');
      throw new Error(`Multiple HubSpot accounts found: [${list}]. Specify account_id.`);
    }
    return hubspotAccounts[0];
  }
}

export const hubspotService = new HubSpotService();
