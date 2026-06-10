import axios from 'axios';
import { getHubSpotConfig } from '../config/integrations';
import { getAccountsByUserId, getAccountById, updateAccountTokens } from './connectedAccountsDb';

// Module-level axios instance with a 15-second timeout for all HubSpot API calls.
// Falls back to the base axios object when axios.create returns falsy (e.g., in jest auto-mock).
const _created = axios.create?.({ timeout: 15000 });
const axiosInstance: typeof axios = (_created ?? axios) as typeof axios;

// Retry once on 429 — respect Retry-After header, default 10s.
if (_created) {
  _created.interceptors.response.use(
    (res) => res,
    async (err) => {
      const config = err?.config as any;
      if (err?.response?.status === 429 && config && !config.__hubspotRetried) {
        config.__hubspotRetried = true;
        const retryAfter = Math.min(parseInt(err.response.headers?.['retry-after'] ?? '10', 10), 10);
        await new Promise(r => setTimeout(r, retryAfter * 1000));
        return _created.request(config);
      }
      throw err;
    }
  );
}

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

export interface UpsertContactResult {
  contactId: string;
  isNew: boolean;
}

export interface HubSpotPipelineStage {
  id: string;
  label: string;
  displayOrder: number;
  metadata?: Record<string, any>;
  archived?: boolean;
}

export interface HubSpotPipeline {
  id: string;
  label: string;
  displayOrder: number;
  stages: HubSpotPipelineStage[];
}

const TOKEN_REFRESH_BUFFER_MS = 60 * 1000; // refresh 60s before expiry

// Stores in-flight refresh promises keyed by "userId:accountId".
// Value is { access_token, token_expires_at } so waiting callers get both.
const refreshLocks = new Map<string, Promise<{ access_token: string; token_expires_at: number }>>();

// ─── Module-level account resolver ───────────────────────────────────────────
// Used by both the static factory and the mid-operation refresh path.

async function resolveHubSpotAccount(userId: string, accountId?: string) {
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

export class HubSpotService {
  // ─── Instance state ───────────────────────────────────────────────────────
  // _token      — always set; for direct (Private App) tokens, _tokenExpiresAt is undefined
  // _userId     — stored for mid-operation refresh; absent on direct-token instances
  // _accountId  — same
  // _tokenExpiresAt — undefined means "never refreshes" (direct token path)
  private _token: string;
  private readonly _userId?: string;
  private readonly _accountId?: string;
  private _tokenExpiresAt?: number;

  private constructor(
    token: string,
    userId?: string,
    accountId?: string,
    tokenExpiresAt?: number,
  ) {
    this._token = token;
    this._userId = userId;
    this._accountId = accountId;
    this._tokenExpiresAt = tokenExpiresAt;
  }

  // ─── Factories ────────────────────────────────────────────────────────────

  /**
   * OAuth path — resolves and (if needed) refreshes the token from the DB,
   * then returns a fully-initialised instance. One DB read per operation.
   */
  static async create(userId: string, accountId?: string): Promise<HubSpotService> {
    const account = await resolveHubSpotAccount(userId, accountId);
    const config = account.config as any;
    const expiresAt: number = config.token_expires_at || 0;

    if (expiresAt - Date.now() > TOKEN_REFRESH_BUFFER_MS) {
      return new HubSpotService(config.access_token, userId, account.account_id, expiresAt);
    }

    if (!config.refresh_token) {
      throw new Error('HubSpot access token expired and no refresh token is available. Please reconnect your HubSpot account.');
    }

    // Token is expiring — create provisional instance, refresh, then return it.
    const instance = new HubSpotService(config.access_token, userId, account.account_id, expiresAt);
    await instance.doRefresh(userId, account.account_id, config.refresh_token);
    return instance;
  }

  /**
   * Private App token path — bypasses all DB / OAuth logic.
   * Used by HubspotAdapter for token-based (non-OAuth) connections.
   */
  static fromToken(apiKey: string): HubSpotService {
    return new HubSpotService(apiKey); // no _tokenExpiresAt → never refreshes
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  /**
   * Returns a valid access token for this instance.
   * - Direct token (no _tokenExpiresAt): returned immediately, zero I/O.
   * - OAuth token still fresh: returned from cache.
   * - OAuth token expiring mid-operation: refreshes and updates instance state.
   */
  private async token(): Promise<string> {
    if (!this._tokenExpiresAt) return this._token;

    if (this._tokenExpiresAt - Date.now() > TOKEN_REFRESH_BUFFER_MS) return this._token;

    // Expiring mid-operation — refresh using stored credentials
    if (!this._userId || !this._accountId) {
      throw new Error('Cannot refresh: OAuth context missing on this instance.');
    }
    const account = await resolveHubSpotAccount(this._userId, this._accountId);
    const config = account.config as any;
    if (!config.refresh_token) {
      throw new Error('HubSpot access token expired and no refresh token is available. Please reconnect your HubSpot account.');
    }
    await this.doRefresh(this._userId, this._accountId, config.refresh_token);
    return this._token;
  }

  private async doRefresh(userId: string, accountId: string, refreshToken: string): Promise<void> {
    const hubspotConfig = await getHubSpotConfig();
    const lockKey = `${userId}:${accountId}`;

    if (refreshLocks.has(lockKey)) {
      const result = await refreshLocks.get(lockKey)!;
      this._token = result.access_token;
      this._tokenExpiresAt = result.token_expires_at;
      return;
    }

    const refreshPromise = (async () => {
      const response = await axiosInstance.post(
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

      const token_expires_at = Date.now() + expires_in * 1000;

      await updateAccountTokens(userId, 'hubspot', {
        access_token,
        refresh_token: refresh_token ?? refreshToken,
        token_expires_at,
      }, accountId);

      return { access_token, token_expires_at };
    })().finally(() => refreshLocks.delete(lockKey));

    refreshLocks.set(lockKey, refreshPromise);

    const result = await refreshPromise;
    this._token = result.access_token;
    this._tokenExpiresAt = result.token_expires_at;
  }

  private async authHeaders(): Promise<Record<string, string>> {
    return {
      Authorization: `Bearer ${await this.token()}`,
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

  // ─── Connection test ──────────────────────────────────────────────────────────

  async testConnection(): Promise<{ valid: boolean; error?: string }> {
    try {
      await axiosInstance.get(
        `${HUBSPOT_API_BASE}/crm/v3/objects/contacts`,
        { headers: await this.authHeaders(), params: { limit: 1 } }
      );
      return { valid: true };
    } catch (err: any) {
      const msg = err.response?.data?.message || err.message || 'Unknown error';
      return { valid: false, error: msg };
    }
  }

  // ─── Contacts ────────────────────────────────────────────────────────────────

  async listContacts(
    cursor?: string
  ): Promise<{ contacts: HubSpotContact[]; nextCursor?: string }> {
    const properties = 'email,firstname,lastname,phone,jobtitle,company,hs_linkedin_url,lastmodifieddate';
    const limit = 50;
    let url = `${HUBSPOT_API_BASE}/crm/v3/objects/contacts?limit=${limit}&properties=${properties}`;
    if (cursor) url += `&after=${cursor}`;

    const res = await axiosInstance.get(url, { headers: await this.authHeaders() });
    return {
      contacts: ((res.data as any)?.results ?? []).map((r: any) => this.mapContact(r)),
      nextCursor: (res.data as any)?.paging?.next?.after,
    };
  }

  /**
   * Raw paginated contacts for pull sync — returns HubSpot results as-is
   * so the adapter can apply its own field mapping.
   */
  async listContactsPage(
    properties: string[],
    cursor?: string
  ): Promise<{ results: any[]; nextCursor?: string }> {
    const propsParam = encodeURIComponent(properties.join(','));
    let url = `${HUBSPOT_API_BASE}/crm/v3/objects/contacts?limit=100&properties=${propsParam}`;
    if (cursor) url += `&after=${cursor}`;

    const res = await axiosInstance.get(url, { headers: await this.authHeaders() });
    return {
      results: (res.data as any)?.results ?? [],
      nextCursor: (res.data as any)?.paging?.next?.after,
    };
  }

  async findContactByEmail(email: string): Promise<HubSpotContact | null> {
    const properties = ['email', 'firstname', 'lastname', 'phone', 'jobtitle', 'company', 'hs_linkedin_url', 'lastmodifieddate'];
    const res = await axiosInstance.post(
      `${HUBSPOT_API_BASE}/crm/v3/objects/contacts/search`,
      {
        filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email.toLowerCase() }] }],
        properties,
        limit: 1,
      },
      { headers: await this.authHeaders() }
    );
    const results = (res.data as any)?.results ?? [];
    return results.length > 0 ? this.mapContact(results[0]) : null;
  }

  /**
   * Find-or-create by email. Returns contactId and whether it was newly created.
   * Updates all provided fields if the contact already exists.
   */
  async upsertContact(
    data: Omit<HubSpotContact, 'contactId'>
  ): Promise<UpsertContactResult> {
    if (!data.email) throw new Error('upsertContact requires an email address');

    const searchRes = await axiosInstance.post(
      `${HUBSPOT_API_BASE}/crm/v3/objects/contacts/search`,
      {
        filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: data.email.toLowerCase() }] }],
        properties: ['email'],
        limit: 1,
      },
      { headers: await this.authHeaders() }
    );

    const existing = ((searchRes.data as any)?.results ?? [])[0];

    if (existing) {
      const updated = await this.updateContact(existing.id, data);
      return { contactId: updated.contactId, isNew: false };
    }

    const created = await this.createContact(data);
    return { contactId: created.contactId, isNew: true };
  }

  async createContact(
    data: Omit<HubSpotContact, 'contactId'>
  ): Promise<HubSpotContact> {
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

    const res = await axiosInstance.post(
      `${HUBSPOT_API_BASE}/crm/v3/objects/contacts`,
      { properties },
      { headers: await this.authHeaders() }
    );
    return this.mapContact(res.data as any);
  }

  async updateContact(
    contactId: string,
    data: Partial<Omit<HubSpotContact, 'contactId'>>
  ): Promise<HubSpotContact> {
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

    const res = await axiosInstance.patch(
      `${HUBSPOT_API_BASE}/crm/v3/objects/contacts/${contactId}`,
      { properties },
      { headers: await this.authHeaders() }
    );
    return this.mapContact(res.data as any);
  }

  async getContactEmailById(contactId: string): Promise<string | null> {
    try {
      const res = await axiosInstance.get(
        `${HUBSPOT_API_BASE}/crm/v3/objects/contacts/${contactId}?properties=email`,
        { headers: await this.authHeaders() }
      );
      return (res.data as any)?.properties?.email || null;
    } catch (e: any) {
      if (e?.response?.status === 404) return null;
      throw e;
    }
  }

  /**
   * Fetches a contact by ID and returns all its property values as a flat map.
   * Pass specific propertyNames to request only those fields; omit to fetch
   * the standard set (email, name, phone, jobtitle, company, linkedin).
   * Returns {} if the contact is not found (404).
   */
  async getContactById(contactId: string, propertyNames?: string[]): Promise<Record<string, string>> {
    try {
      const props = (propertyNames && propertyNames.length > 0)
        ? propertyNames.join(',')
        : 'email,firstname,lastname,phone,jobtitle,company,hs_linkedin_url';
      const res = await axiosInstance.get(
        `${HUBSPOT_API_BASE}/crm/v3/objects/contacts/${contactId}?properties=${props}`,
        { headers: await this.authHeaders() }
      );
      return (res.data as any)?.properties ?? {};
    } catch (e: any) {
      if (e?.response?.status === 404) return {};
      throw e;
    }
  }

  async deleteContact(contactId: string): Promise<void> {
    await axiosInstance.delete(
      `${HUBSPOT_API_BASE}/crm/v3/objects/contacts/${contactId}`,
      { headers: await this.authHeaders() }
    );
  }

  // ─── Property discovery ───────────────────────────────────────────────────────

  /**
   * Returns all non-archived contact properties from HubSpot.
   * Uses GET /crm/v3/properties/contacts.
   */
  async listContactProperties(): Promise<Array<{ name: string; label: string; type: string }>> {
    const res = await axiosInstance.get(
      `${HUBSPOT_API_BASE}/crm/v3/properties/contacts?archived=false`,
      { headers: await this.authHeaders() }
    );
    return ((res.data as any).results ?? [])
      .filter((p: any) => !p.archived)
      .map((p: any) => ({ name: p.name as string, label: p.label as string, type: p.type as string }));
  }

  /**
   * Returns all non-archived deal properties from HubSpot.
   * Uses GET /crm/v3/properties/deals.
   */
  async listDealProperties(): Promise<Array<{ name: string; label: string; type: string }>> {
    const res = await axiosInstance.get(
      `${HUBSPOT_API_BASE}/crm/v3/properties/deals?archived=false`,
      { headers: await this.authHeaders() }
    );
    return ((res.data as any).results ?? [])
      .filter((p: any) => !p.archived)
      .map((p: any) => ({ name: p.name as string, label: p.label as string, type: p.type as string }));
  }

  // ─── Deals ────────────────────────────────────────────────────────────────────

  /**
   * Create a deal. Returns the new deal's HubSpot ID.
   */
  async createDeal(properties: Record<string, string>): Promise<string> {
    const res = await axiosInstance.post(
      `${HUBSPOT_API_BASE}/crm/v3/objects/deals`,
      { properties },
      { headers: await this.authHeaders() }
    );
    return (res.data as any).id;
  }

  async updateDeal(dealId: string, properties: Record<string, string>): Promise<void> {
    await axiosInstance.patch(
      `${HUBSPOT_API_BASE}/crm/v3/objects/deals/${dealId}`,
      { properties },
      { headers: await this.authHeaders() }
    );
  }

  async deleteDeal(dealId: string): Promise<void> {
    await axiosInstance.delete(
      `${HUBSPOT_API_BASE}/crm/v3/objects/deals/${dealId}`,
      { headers: await this.authHeaders() }
    );
  }

  /**
   * Associate a contact with a deal using the v4 Associations API.
   * Uses the HUBSPOT_DEFINED default association type (contact_to_deal).
   */
  async associateContactToDeal(contactId: string, dealId: string): Promise<void> {
    await axiosInstance.put(
      `${HUBSPOT_API_BASE}/crm/v4/objects/contacts/${contactId}/associations/default/deals/${dealId}`,
      undefined,
      { headers: await this.authHeaders() }
    );
  }

  /**
   * Get the IDs of all deals associated with a contact.
   */
  async getContactDealAssociations(contactId: string): Promise<string[]> {
    const res = await axiosInstance.get(
      `${HUBSPOT_API_BASE}/crm/v3/objects/contacts/${contactId}/associations/deals`,
      { headers: await this.authHeaders() }
    );
    return ((res.data as any)?.results ?? []).map((r: any) => r.id as string);
  }

  /**
   * Get the IDs of all contacts associated with a deal.
   * Follows pagination cursors to return all contacts, not just the first 100.
   */
  async getDealContactAssociations(dealId: string): Promise<string[]> {
    const allIds: string[] = [];
    let after: string | undefined;
    do {
      const params: Record<string, string> = {};
      if (after) params.after = after;
      const res = await axiosInstance.get(
        `${HUBSPOT_API_BASE}/crm/v3/objects/deals/${dealId}/associations/contacts`,
        { headers: await this.authHeaders(), params }
      );
      const data = res.data as any;
      allIds.push(...((data?.results ?? []).map((r: any) => r.id as string)));
      after = data?.paging?.next?.after;
    } while (after);
    return allIds;
  }

  /**
   * Fetch a raw deal record by ID.
   * Returns the full HubSpot response object, or null on 404.
   */
  async getDeal(dealId: string, properties: string[]): Promise<any | null> {
    try {
      const propsParam = properties.join(',');
      const res = await axiosInstance.get(
        `${HUBSPOT_API_BASE}/crm/v3/objects/deals/${dealId}?properties=${propsParam}`,
        { headers: await this.authHeaders() }
      );
      return res.data as any;
    } catch (e: any) {
      if (e?.response?.status === 404) return null;
      throw e;
    }
  }

  // ─── Deal pipelines / stages ────────────────────────────────────────────────

  async getDealPipelineStages(pipelineId = 'default'): Promise<HubSpotPipelineStage[]> {
    const res = await axiosInstance.get(
      `${HUBSPOT_API_BASE}/crm/v3/pipelines/deals/${pipelineId}`,
      { headers: await this.authHeaders() }
    );

    return (((res.data as any)?.stages ?? []) as any[])
      .filter((stage: any) => !stage?.archived)
      .map((stage: any) => ({
        id: String(stage.id),
        label: String(stage.label ?? stage.id),
        displayOrder: Number(stage.displayOrder ?? 0),
        metadata: stage.metadata ?? {},
        archived: stage.archived,
      }));
  }

  async listDealPipelines(): Promise<HubSpotPipeline[]> {
    const res = await axiosInstance.get(
      `${HUBSPOT_API_BASE}/crm/v3/pipelines/deals`,
      { headers: await this.authHeaders() }
    );

    return (((res.data as any)?.results ?? []) as any[])
      .filter((pipeline: any) => !pipeline?.archived)
      .map((pipeline: any) => ({
        id: String(pipeline.id),
        label: String(pipeline.label ?? pipeline.id),
        displayOrder: Number(pipeline.displayOrder ?? 0),
        stages: ((pipeline.stages ?? []) as any[])
          .filter((stage: any) => !stage?.archived)
          .map((stage: any) => ({
            id: String(stage.id),
            label: String(stage.label ?? stage.id),
            displayOrder: Number(stage.displayOrder ?? 0),
            metadata: stage.metadata ?? {},
            archived: stage.archived,
          })),
      }));
  }

  async createDealPipeline(
    label: string,
    stages: Array<{ stageId: string; label: string; displayOrder: number; probability: number }>
  ): Promise<HubSpotPipeline> {
    const payload = {
      label,
      displayOrder: 0,
      stages: stages.map(stage => ({
        stageId: stage.stageId.replace(/[^a-zA-Z0-9_]/g, '_'), // HubSpot stageId must be alphanumeric
        label: stage.label,
        displayOrder: stage.displayOrder,
        metadata: {
          probability: Number(stage.probability.toFixed(1)),
        },
      })),
    };

    try {
      const res = await axiosInstance.post(
        `${HUBSPOT_API_BASE}/crm/v3/pipelines/deals`,
        payload,
        { headers: await this.authHeaders() }
      );

      const pipeline = res.data as any;
      return {
        id: String(pipeline.id),
        label: String(pipeline.label ?? label),
        displayOrder: Number(pipeline.displayOrder ?? 0),
        stages: ((pipeline.stages ?? []) as any[]).map((stage: any) => ({
          id: String(stage.id),
          label: String(stage.label ?? stage.id),
          displayOrder: Number(stage.displayOrder ?? 0),
          metadata: stage.metadata ?? {},
          archived: stage.archived,
        })),
      };
    } catch (err: any) {
      console.error(`[HubSpotService] Failed to create pipeline:`, err.response?.data || err.message);
      throw err;
    }
  }

  async createDealStage(
    pipelineId: string,
    stage: {
      stageId: string;
      label: string;
      displayOrder: number;
      probability: number;
    }
  ): Promise<HubSpotPipelineStage> {
    const res = await axiosInstance.post(
      `${HUBSPOT_API_BASE}/crm/v3/pipelines/deals/${pipelineId}/stages`,
      {
        stageId: stage.stageId,
        label: stage.label,
        displayOrder: stage.displayOrder,
        metadata: {
          probability: Number(stage.probability.toFixed(1)),
        },
      },
      { headers: await this.authHeaders() }
    );

    const created = res.data as any;
    return {
      id: String(created.id),
      label: String(created.label ?? created.id),
      displayOrder: Number(created.displayOrder ?? stage.displayOrder),
      metadata: created.metadata ?? {},
      archived: created.archived,
    };
  }

  // ─── Companies ───────────────────────────────────────────────────────────────

  async findCompanyByName(name: string): Promise<string | null> {
    const res = await axiosInstance.post(
      `${HUBSPOT_API_BASE}/crm/v3/objects/companies/search`,
      {
        filterGroups: [{ filters: [{ propertyName: 'name', operator: 'EQ', value: name }] }],
        properties: ['name'],
        limit: 1,
      },
      { headers: await this.authHeaders() }
    );
    const results = (res.data as any)?.results ?? [];
    return results.length > 0 ? results[0].id : null;
  }

  async createCompany(name: string): Promise<string> {
    const res = await axiosInstance.post(
      `${HUBSPOT_API_BASE}/crm/v3/objects/companies`,
      { properties: { name } },
      { headers: await this.authHeaders() }
    );
    return (res.data as any).id;
  }

  async findOrCreateCompany(name: string): Promise<string> {
    const existing = await this.findCompanyByName(name);
    if (existing) return existing;
    return this.createCompany(name);
  }

  // ─── Properties ──────────────────────────────────────────────────────────────

  async ensureContactProperty(key: string, label: string): Promise<string> {
    const propertyName = key.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
    try {
      await axiosInstance.get(
        `${HUBSPOT_API_BASE}/crm/v3/properties/contacts/${propertyName}`,
        { headers: await this.authHeaders() }
      );
      return propertyName;
    } catch (err: any) {
      if (err?.response?.status === 404) {
        await axiosInstance.post(
          `${HUBSPOT_API_BASE}/crm/v3/properties/contacts`,
          {
            name: propertyName,
            label,
            type: 'string',
            fieldType: 'text',
            groupName: 'contactinformation',
          },
          { headers: await this.authHeaders() }
        );
        return propertyName;
      }
      throw err;
    }
  }

  /**
   * Ensure a custom deal property exists. Creates it if not found (404).
   * Requires crm.schemas.deals.write scope.
   */
  async ensureDealProperty(key: string, label: string): Promise<string> {
    const propertyName = key.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
    try {
      await axiosInstance.get(
        `${HUBSPOT_API_BASE}/crm/v3/properties/deals/${propertyName}`,
        { headers: await this.authHeaders() }
      );
      return propertyName;
    } catch (err: any) {
      if (err?.response?.status === 404) {
        await axiosInstance.post(
          `${HUBSPOT_API_BASE}/crm/v3/properties/deals`,
          {
            name: propertyName,
            label,
            type: 'string',
            fieldType: 'text',
            groupName: 'dealinformation',
          },
          { headers: await this.authHeaders() }
        );
        return propertyName;
      }
      throw err;
    }
  }

  // ─── Lists ────────────────────────────────────────────────────────────────────
  // HubSpot "lists" are static lists of contacts (ILS v3 API)

  async findListByName(name: string): Promise<string | null> {
    try {
      // Strategy 1: Direct retrieval by name (v3 API) - most efficient
      const encodedName = encodeURIComponent(name);
      const res = await axiosInstance.get(
        `${HUBSPOT_API_BASE}/crm/v3/lists/object-type-id/0-1/name/${encodedName}`,
        { headers: await this.authHeaders() }
      );
      const data = res.data as any;
      if (data?.listId) return String(data.listId);
    } catch (err: any) {
      if (err.response?.status !== 404) {
        console.warn(`[HubSpot] Direct list retrieval failed for "${name}":`, err.message);
      }
    }

    // Strategy 2: Fallback to robust search (case-insensitive in-memory check, but server-side filtered)
    const lists = await this.getAllLists(name);
    const searchName = name.toLowerCase();
    const match = lists.find(l => l.name.toLowerCase() === searchName);
    return match ? match.id : null;
  }

  async createList(name: string): Promise<string> {
    const res = await axiosInstance.post(
      `${HUBSPOT_API_BASE}/crm/v3/lists/`,
      { name, objectTypeId: '0-1', processingType: 'MANUAL' },
      { headers: await this.authHeaders() }
    );
    return String((res.data as any)?.listId ?? (res.data as any)?.list?.listId);
  }

  async findOrCreateList(name: string): Promise<string> {
    const existing = await this.findListByName(name);
    if (existing) return existing;
    return this.createList(name);
  }

  async addContactToList(listId: string, contactIds: string[]): Promise<{ addedCount: number; failedChunks: number[] }> {
    const CHUNK_SIZE = 100;
    let addedCount = 0;
    const failedChunks: number[] = [];

    for (let i = 0; i < contactIds.length; i += CHUNK_SIZE) {
      const chunk = contactIds.slice(i, i + CHUNK_SIZE);
      try {
        await axiosInstance.put(
          `${HUBSPOT_API_BASE}/crm/v3/lists/${listId}/memberships/add`,
          chunk,
          { headers: await this.authHeaders() }
        );
        addedCount += chunk.length;
      } catch (err: any) {
        console.error(`[HubSpotService] addContactToList chunk ${i}–${i + chunk.length - 1} failed:`, err?.response?.data ?? err?.message);
        failedChunks.push(i);
      }
    }

    return { addedCount, failedChunks };
  }

  // ─── Campaigns ───────────────────────────────────────────────────────────────
  // Requires Marketing Hub Professional+
  // Scopes: marketing.campaigns.read, marketing.campaigns.write

  async listCampaigns(cursor?: string): Promise<any> {
    const CAMPAIGN_PROPS = 'hs_name,hs_start_date,hs_end_date,hs_notes,hs_utm,hs_campaign_status';
    let url = `${HUBSPOT_API_BASE}/marketing/v3/campaigns?properties=${CAMPAIGN_PROPS}`;
    if (cursor) url += `&after=${encodeURIComponent(cursor)}`;
    const res = await axiosInstance.get(url, { headers: await this.authHeaders() });
    return res.data;
  }

  async getCampaign(guid: string): Promise<any> {
    const CAMPAIGN_PROPS = 'hs_name,hs_start_date,hs_end_date,hs_notes,hs_utm,hs_campaign_status';
    const res = await axiosInstance.get(
      `${HUBSPOT_API_BASE}/marketing/v3/campaigns/${guid}?properties=${CAMPAIGN_PROPS}`,
      { headers: await this.authHeaders() }
    );
    return res.data;
  }

  async createCampaign(
    name: string,
    opts?: { startDate?: string; notes?: string; utm?: string }
  ): Promise<any> {
    if (!name || !name.trim()) throw new Error('Campaign name is required');

    const properties: Record<string, string> = { hs_name: name.trim() };
    if (opts?.startDate) properties.hs_start_date = opts.startDate;
    if (opts?.notes) properties.hs_notes = opts.notes;
    if (opts?.utm) properties.hs_utm = opts.utm;

    const res = await axiosInstance.post(
      `${HUBSPOT_API_BASE}/marketing/v3/campaigns`,
      { properties },
      { headers: await this.authHeaders() }
    );
    return res.data;
  }

  async updateCampaign(
    guid: string,
    props: { name?: string; startDate?: string; notes?: string; utm?: string }
  ): Promise<any> {
    const properties: Record<string, string> = {};
    if (props.name !== undefined) properties.hs_name = props.name;
    if (props.startDate !== undefined) properties.hs_start_date = props.startDate;
    if (props.notes !== undefined) properties.hs_notes = props.notes;
    if (props.utm !== undefined) properties.hs_utm = props.utm;

    const res = await axiosInstance.patch(
      `${HUBSPOT_API_BASE}/marketing/v3/campaigns/${guid}`,
      { properties },
      { headers: await this.authHeaders() }
    );
    return res.data;
  }

  async deleteCampaign(guid: string): Promise<void> {
    await axiosInstance.request({
      method: 'DELETE',
      url: `${HUBSPOT_API_BASE}/marketing/v3/campaigns/${guid}`,
      headers: await this.authHeaders(),
    });
  }

  async getCampaignMetrics(guid: string): Promise<any> {
    const res = await axiosInstance.get(
      `${HUBSPOT_API_BASE}/marketing/v3/campaigns/${guid}/reports/metrics`,
      { headers: await this.authHeaders() }
    );
    return res.data;
  }

  async getAllLists(query?: string): Promise<Array<{ id: string; name: string }>> {
    const results: Array<{ id: string; name: string }> = [];
    let after: string | undefined;

    do {
      const body: Record<string, any> = {
        processingTypes: ['MANUAL', 'SNAPSHOT', 'DYNAMIC'],
        count: 200,
        objectTypeId: '0-1', // Focus on contacts
      };
      if (query) body.query = query;
      if (after) body.after = after;

      const res = await axiosInstance.post(
        `${HUBSPOT_API_BASE}/crm/v3/lists/search`,
        body,
        { headers: await this.authHeaders() }
      );

      const data = res.data as any;
      const lists: any[] = data?.lists ?? [];
      for (const l of lists) {
        results.push({
          id: String(l.listId || l.id),
          name: l.name || l.label,
        });
      }

      after = data?.paging?.next?.after;
    } while (after);

    return results;
  }
}
