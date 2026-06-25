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
        const parsed = parseInt(err.response.headers?.['retry-after'] ?? '10', 10);
        const retryAfter = Math.min(isNaN(parsed) ? 10 : parsed, 60);
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

/**
 * HubSpot batch write endpoints return a 207 Multi-Status when SOME (not all)
 * inputs failed: successes land in `results`, failures in `errors` (keyed by
 * objectWriteTraceId for creates, or object id for updates). axios treats 207
 * as success (status < 300), so without this check a partial failure would be
 * silently counted as success. Convert a 207 into a throw that carries the raw
 * response, so callers' split-and-retry isolates the bad record(s) down to a
 * single-item batch and can inspect per-record error categories (e.g.
 * OBJECT_NOT_FOUND) on the attached `error.response`.
 */
function throwIfBatchPartialFailure(res: any): void {
  if (res?.status !== 207) return;
  const data = res.data ?? {};
  const errs: any[] = Array.isArray(data.errors) ? data.errors : [];
  const first = errs[0] ?? {};
  const err: any = new Error(
    `HubSpot batch partial failure (207 Multi-Status): ${data.numErrors ?? errs.length} error(s)` +
      (first.category ? ` — ${first.category}: ${first.message ?? ''}` : '')
  );
  err.response = res;
  throw err;
}


// Recipient audience + send-schedule fields for a marketing email.
export interface EmailAudienceOpts {
  sendOnPublish?: boolean;       // true → send immediately on publish
  publishDate?: string;          // ISO8601 → schedule send for this time
  subscriptionId?: string;       // subscriptionDetails.subscriptionId (email type)
  contactListsInclude?: string[]; // list IDs to send to
  contactListsExclude?: string[]; // list IDs to suppress
}

// All writable fields for create/update of a marketing email.
export interface EmailWriteOpts extends EmailAudienceOpts {
  subject?: string;
  fromName?: string;
  fromEmail?: string;
}

// Flattened view of a single form field (from getFormFields).
export interface FormFieldSummary {
  name: string;
  label?: string;
  fieldType?: string;
  required: boolean;
  objectTypeId?: string;
  options?: any;
}

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
  private readonly _portalId?: string;
  // Per-instance caches of properties already ensured this connection, so a
  // multi-chunk push (which reuses one instance) ensures each property once
  // instead of issuing a redundant GET per 500-lead chunk. Instance-scoped so a
  // fresh push picks up any properties deleted in HubSpot since.
  private readonly _ensuredContactProps = new Set<string>();
  private readonly _ensuredDealProps = new Set<string>();

  private constructor(
    token: string,
    userId?: string,
    accountId?: string,
    tokenExpiresAt?: number,
    portalId?: string,
  ) {
    this._token = token;
    this._userId = userId;
    this._accountId = accountId;
    this._tokenExpiresAt = tokenExpiresAt;
    this._portalId = portalId;
  }

  /** HubSpot portal (hub) ID for this connection. Needed for public form submission. */
  get portalId(): string | undefined {
    return this._portalId;
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
    const portalId: string | undefined = config.hub_id !== undefined ? String(config.hub_id) : account.account_id;

    if (expiresAt - Date.now() > TOKEN_REFRESH_BUFFER_MS) {
      return new HubSpotService(config.access_token, userId, account.account_id, expiresAt, portalId);
    }

    if (!config.refresh_token) {
      throw new Error('HubSpot access token expired and no refresh token is available. Please reconnect your HubSpot account.');
    }

    // Token is expiring — create provisional instance, refresh, then return it.
    const instance = new HubSpotService(config.access_token, userId, account.account_id, expiresAt, portalId);
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
   * Batch-fetch emails for up to 100 contact IDs per request.
   * Returns a Map of contactId → email; contacts with no email are omitted.
   * Chunk size is 100 (HubSpot batch/read limit). Partial chunk failures are
   * logged and skipped so the rest of the batch still resolves.
   */
  async getContactEmailsByIds(contactIds: string[]): Promise<Map<string, string>> {
    const CHUNK_SIZE = 100;
    const emailMap = new Map<string, string>();
    for (let i = 0; i < contactIds.length; i += CHUNK_SIZE) {
      const chunk = contactIds.slice(i, i + CHUNK_SIZE);
      try {
        const res = await axiosInstance.post(
          `${HUBSPOT_API_BASE}/crm/v3/objects/contacts/batch/read`,
          { properties: ['email'], inputs: chunk.map((id) => ({ id })) },
          { headers: await this.authHeaders() },
        );
        for (const contact of (res.data as any)?.results ?? []) {
          const email: string | undefined = contact?.properties?.email;
          if (email) emailMap.set(String(contact.id), email);
        }
      } catch (e: any) {
        console.warn(`[HubSpot] getContactEmailsByIds batch failed for chunk starting at ${i}:`, e?.message);
      }
    }
    return emailMap;
  }

  /**
   * Batch-fetch the current `lifecyclestage` for up to 100 contact IDs per
   * request. Returns a Map of contactId → lifecyclestage (empty string when the
   * contact has no stage set). Contacts not returned (e.g. deleted) are omitted.
   * Chunk size is 100 (HubSpot batch/read limit). Partial chunk failures are
   * logged and skipped so the rest still resolves — callers treat a missing id
   * as "unknown original" and fall back to clearing it.
   * Used by the lifecycle-stage two-step so a failed set can be rolled back to
   * the contact's prior stage instead of being left blank.
   */
  async getContactLifecycleStages(contactIds: string[]): Promise<Map<string, string>> {
    const CHUNK_SIZE = 100;
    const stageMap = new Map<string, string>();
    for (let i = 0; i < contactIds.length; i += CHUNK_SIZE) {
      const chunk = contactIds.slice(i, i + CHUNK_SIZE);
      try {
        const res = await axiosInstance.post(
          `${HUBSPOT_API_BASE}/crm/v3/objects/contacts/batch/read`,
          { properties: ['lifecyclestage'], inputs: chunk.map((id) => ({ id })) },
          { headers: await this.authHeaders() },
        );
        for (const contact of (res.data as any)?.results ?? []) {
          stageMap.set(String(contact.id), String(contact?.properties?.lifecyclestage ?? ''));
        }
      } catch (e: any) {
        console.warn(`[HubSpot] getContactLifecycleStages batch failed for chunk starting at ${i}:`, e?.message);
      }
    }
    return stageMap;
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
   * Returns the enumeration options of a single contact property (value + label).
   * Used to populate the lifecycle-stage picker: custom stages (e.g. "Ad Audience")
   * have a generated internal value that differs from the label, and the API expects
   * the internal value on write — so the UI must offer value/label pairs.
   * Non-enumeration properties (or a missing property) return an empty list.
   */
  async getContactPropertyOptions(propertyName: string): Promise<Array<{ value: string; label: string }>> {
    if (!propertyName?.trim()) throw new Error('propertyName is required');
    const res = await axiosInstance.get(
      `${HUBSPOT_API_BASE}/crm/v3/properties/contacts/${encodeURIComponent(propertyName)}`,
      { headers: await this.authHeaders() }
    );
    const options: any[] = (res.data as any)?.options ?? [];
    return options
      .filter((o: any) => !o?.hidden)
      .map((o: any) => ({ value: String(o.value), label: String(o.label ?? o.value) }));
  }

  /**
   * Creates a new custom option on the lifecyclestage contact property.
   * Fetches all existing options (including hidden), appends the new one, and
   * PATCHes the full list back — HubSpot's options field is a full replacement.
   * Returns the new option's value (timestamp-based, guaranteed unique).
   */
  async createLifecycleStageOption(label: string): Promise<{ value: string; label: string }> {
    if (!label?.trim()) throw new Error('label is required');

    const res = await axiosInstance.get(
      `${HUBSPOT_API_BASE}/crm/v3/properties/contacts/lifecyclestage`,
      { headers: await this.authHeaders() }
    );
    const data = res.data as any;

    if (data?.modificationMetadata?.readOnlyOptions) {
      throw new Error('Lifecycle stage options are read-only on this portal and cannot be modified via API.');
    }

    const existingOptions: any[] = data?.options ?? [];
    const maxOrder = existingOptions.reduce((max: number, o: any) => Math.max(max, o.displayOrder ?? 0), 0);
    const value = Date.now().toString();

    // Normalize existing options to only the fields HubSpot's PATCH accepts —
    // the GET response may include internal-only fields that the write API rejects.
    const normalizedOptions = existingOptions.map((o: any) => ({
      label: String(o.label ?? o.value),
      value: String(o.value),
      displayOrder: Number(o.displayOrder ?? 0),
      hidden: Boolean(o.hidden),
    }));

    await axiosInstance.patch(
      `${HUBSPOT_API_BASE}/crm/v3/properties/contacts/lifecyclestage`,
      {
        options: [
          ...normalizedOptions,
          { label: label.trim(), value, displayOrder: maxOrder + 1, hidden: false },
        ],
      },
      { headers: await this.authHeaders() }
    );

    return { value, label: label.trim() };
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
    let pages = 0;
    const MAX_PAGES = 20;
    do {
      if (pages++ >= MAX_PAGES) {
        console.warn(`[HubSpot] getDealContactAssociations hit ${MAX_PAGES}-page cap for deal ${dealId}`);
        break;
      }
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
    if (this._ensuredContactProps.has(propertyName)) return propertyName;
    try {
      await axiosInstance.get(
        `${HUBSPOT_API_BASE}/crm/v3/properties/contacts/${propertyName}`,
        { headers: await this.authHeaders() }
      );
      this._ensuredContactProps.add(propertyName);
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
        this._ensuredContactProps.add(propertyName);
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
    if (this._ensuredDealProps.has(propertyName)) return propertyName;
    try {
      await axiosInstance.get(
        `${HUBSPOT_API_BASE}/crm/v3/properties/deals/${propertyName}`,
        { headers: await this.authHeaders() }
      );
      this._ensuredDealProps.add(propertyName);
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
        this._ensuredDealProps.add(propertyName);
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
    if (!guid?.trim()) throw new Error('Campaign guid is required');
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
    if (!guid?.trim()) throw new Error('Campaign guid is required');
    await axiosInstance.delete(
      `${HUBSPOT_API_BASE}/marketing/v3/campaigns/${guid}`,
      { headers: await this.authHeaders() }
    );
  }

  async getCampaignMetrics(guid: string): Promise<any> {
    const res = await axiosInstance.get(
      `${HUBSPOT_API_BASE}/marketing/v3/campaigns/${guid}/reports/metrics`,
      { headers: await this.authHeaders() }
    );
    return res.data;
  }

  static readonly CAMPAIGN_ASSET_TYPES = [
    'MARKETING_EMAIL', 'LANDING_PAGE', 'BLOG_POST', 'FORM',
    'WEB_INTERACTIVE', 'CTA', 'SOCIAL_BROADCAST', 'WORKFLOW',
  ] as const;

  async listCampaignAssets(
    guid: string,
    assetType?: string,
    opts?: { startDate?: string; endDate?: string; cursor?: string }
  ): Promise<any> {
    if (assetType) {
      return this._fetchAssetType(guid, assetType, opts);
    }
    const results = await Promise.allSettled(
      HubSpotService.CAMPAIGN_ASSET_TYPES.map(t => this._fetchAssetType(guid, t, opts))
    );
    const byType: Record<string, any> = {};
    HubSpotService.CAMPAIGN_ASSET_TYPES.forEach((t, i) => {
      const r = results[i];
      byType[t] = r.status === 'fulfilled' ? r.value : { error: (r as PromiseRejectedResult).reason?.message };
    });
    return { byType };
  }

  private async _fetchAssetType(
    guid: string,
    assetType: string,
    opts?: { startDate?: string; endDate?: string; cursor?: string }
  ): Promise<any> {
    const params: string[] = ['limit=100'];
    if (opts?.startDate) params.push(`startDate=${encodeURIComponent(opts.startDate)}`);
    if (opts?.endDate) params.push(`endDate=${encodeURIComponent(opts.endDate)}`);
    if (opts?.cursor) params.push(`after=${encodeURIComponent(opts.cursor)}`);
    const url = `${HUBSPOT_API_BASE}/marketing/campaigns/2026-03/${guid}/assets/${assetType}?${params.join('&')}`;
    const res = await axiosInstance.get(url, { headers: await this.authHeaders() });
    return res.data;
  }

  // ─── Campaign Asset Association ───────────────────────────────────────────

  async addCampaignAsset(guid: string, assetType: string, assetId: string): Promise<void> {
    if (!guid?.trim()) throw new Error('Campaign guid is required');
    if (!assetType?.trim()) throw new Error('assetType is required');
    if (!assetId?.trim()) throw new Error('assetId is required');
    // Use the 2026-03 campaigns API (same version as the asset read). The
    // /marketing/v3/campaigns path returns 500 INTERNAL_ERROR for some asset types.
    await axiosInstance.put(
      `${HUBSPOT_API_BASE}/marketing/campaigns/2026-03/${guid}/assets/${assetType}/${assetId}`,
      {},
      { headers: await this.authHeaders() }
    );
  }

  async removeCampaignAsset(guid: string, assetType: string, assetId: string): Promise<void> {
    if (!guid?.trim()) throw new Error('Campaign guid is required');
    if (!assetType?.trim()) throw new Error('assetType is required');
    if (!assetId?.trim()) throw new Error('assetId is required');
    await axiosInstance.delete(
      `${HUBSPOT_API_BASE}/marketing/campaigns/2026-03/${guid}/assets/${assetType}/${assetId}`,
      { headers: await this.authHeaders() }
    );
  }

  // ─── Marketing Emails ─────────────────────────────────────────────────────
  // Scope: content

  async listEmails(cursor?: string): Promise<any> {
    let url = `${HUBSPOT_API_BASE}/marketing/v3/emails?limit=50`;
    if (cursor) url += `&after=${encodeURIComponent(cursor)}`;
    const res = await axiosInstance.get(url, { headers: await this.authHeaders() });
    return res.data;
  }

  async getEmail(emailId: string): Promise<any> {
    const res = await axiosInstance.get(
      `${HUBSPOT_API_BASE}/marketing/v3/emails/${emailId}`,
      { headers: await this.authHeaders() }
    );
    return res.data;
  }

  // Apply recipient audience + send-schedule fields onto a marketing-email body.
  // Used by both createEmail and updateEmail.
  private applyEmailAudience(body: Record<string, any>, opts: EmailAudienceOpts): void {
    if (opts.sendOnPublish !== undefined) body.sendOnPublish = opts.sendOnPublish;
    if (opts.publishDate !== undefined) body.publishDate = opts.publishDate;
    if (opts.subscriptionId !== undefined) {
      body.subscriptionDetails = { subscriptionId: opts.subscriptionId };
    }
    if (opts.contactListsInclude !== undefined || opts.contactListsExclude !== undefined) {
      const contactLists: Record<string, any> = {};
      if (opts.contactListsInclude !== undefined) contactLists.include = opts.contactListsInclude;
      if (opts.contactListsExclude !== undefined) contactLists.exclude = opts.contactListsExclude;
      body.to = { contactLists };
    }
  }

  async createEmail(name: string, opts?: EmailWriteOpts): Promise<any> {
    if (!name?.trim()) throw new Error('Email name is required');
    const body: Record<string, any> = { name: name.trim() };
    if (opts?.subject) body.subject = opts.subject;
    if (opts?.fromName !== undefined || opts?.fromEmail !== undefined) {
      body.from = {};
      if (opts?.fromName) body.from.name = opts.fromName;
      if (opts?.fromEmail) body.from.email = opts.fromEmail;
    }
    if (opts) this.applyEmailAudience(body, opts);
    const res = await axiosInstance.post(
      `${HUBSPOT_API_BASE}/marketing/v3/emails`,
      body,
      { headers: await this.authHeaders() }
    );
    return res.data;
  }

  async updateEmail(
    emailId: string,
    props: EmailWriteOpts & { name?: string }
  ): Promise<any> {
    const body: Record<string, any> = {};
    if (props.name !== undefined) body.name = props.name;
    if (props.subject !== undefined) body.subject = props.subject;
    if (props.fromName !== undefined || props.fromEmail !== undefined) {
      body.from = {};
      if (props.fromName !== undefined) body.from.name = props.fromName;
      if (props.fromEmail !== undefined) body.from.email = props.fromEmail;
    }
    this.applyEmailAudience(body, props);
    const res = await axiosInstance.patch(
      `${HUBSPOT_API_BASE}/marketing/v3/emails/${emailId}`,
      body,
      { headers: await this.authHeaders() }
    );
    return res.data;
  }

  // Publish (send/schedule) a marketing email. Whether it sends immediately or
  // schedules is controlled by sendOnPublish / publishDate set via create/update.
  // Requires Marketing Hub Enterprise or the transactional email add-on.
  async publishEmail(emailId: string): Promise<void> {
    if (!emailId?.trim()) throw new Error('emailId is required');
    await axiosInstance.post(
      `${HUBSPOT_API_BASE}/marketing/v3/emails/${emailId}/publish`,
      {},
      { headers: await this.authHeaders() }
    );
  }

  // Unpublish an email / cancel a scheduled send. Already-sending emails may not
  // be cancellable.
  async unpublishEmail(emailId: string): Promise<void> {
    if (!emailId?.trim()) throw new Error('emailId is required');
    await axiosInstance.post(
      `${HUBSPOT_API_BASE}/marketing/v3/emails/${emailId}/unpublish`,
      {},
      { headers: await this.authHeaders() }
    );
  }

  // List the account's subscription types (email types). The id is needed for
  // subscriptionDetails.subscriptionId when creating a sendable marketing email.
  async listSubscriptionTypes(): Promise<any> {
    const res = await axiosInstance.get(
      `${HUBSPOT_API_BASE}/communication-preferences/v3/definitions`,
      { headers: await this.authHeaders() }
    );
    return res.data;
  }

  async cloneEmail(emailId: string, name: string): Promise<any> {
    if (!emailId?.trim()) throw new Error('emailId is required');
    if (!name?.trim()) throw new Error('Email name is required');
    // Clone is a collection-level endpoint: POST /marketing/v3/emails/clone
    // with { id, cloneName } — NOT /emails/{id}/clone.
    const res = await axiosInstance.post(
      `${HUBSPOT_API_BASE}/marketing/v3/emails/clone`,
      { id: emailId.trim(), cloneName: name.trim() },
      { headers: await this.authHeaders() }
    );
    return res.data;
  }

  async getEmailStatistics(
    emailIds: string[],
    opts?: { startTimestamp?: string; endTimestamp?: string }
  ): Promise<any> {
    if (!emailIds?.length) throw new Error('emailIds array must not be empty');
    // HubSpot requires an ISO-8601 start/end range and rejects raw epoch-ms or a
    // missing value ("Unable to parse value for query parameter: startTimestamp").
    // Accept epoch-ms for convenience and default to the last year when omitted.
    const toIso = (v: string): string => (/^\d+$/.test(v) ? new Date(Number(v)).toISOString() : v);
    const end = opts?.endTimestamp ? toIso(opts.endTimestamp) : new Date().toISOString();
    const start = opts?.startTimestamp
      ? toIso(opts.startTimestamp)
      : new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
    const params: string[] = emailIds.map(id => `emailIds=${encodeURIComponent(id)}`);
    params.push(`startTimestamp=${encodeURIComponent(start)}`);
    params.push(`endTimestamp=${encodeURIComponent(end)}`);
    const url = `${HUBSPOT_API_BASE}/marketing/v3/emails/statistics/list?${params.join('&')}`;
    const res = await axiosInstance.get(url, { headers: await this.authHeaders() });
    return res.data;
  }

  // ─── Contact Lists (2026-03 API) ─────────────────────────────────────────

  async listContactLists(opts?: { query?: string; cursor?: string; count?: number }): Promise<any> {
    const body: Record<string, any> = { objectTypeId: '0-1', count: opts?.count ?? 50 };
    if (opts?.query) body.query = opts.query;
    if (opts?.cursor) body.after = opts.cursor;
    const res = await axiosInstance.post(
      `${HUBSPOT_API_BASE}/crm/lists/2026-03/search`,
      body,
      { headers: await this.authHeaders() }
    );
    return res.data;
  }

  async getContactList(listId: string): Promise<any> {
    if (!listId?.trim()) throw new Error('listId is required');
    const res = await axiosInstance.get(
      `${HUBSPOT_API_BASE}/crm/lists/2026-03/${listId}`,
      { headers: await this.authHeaders() }
    );
    return res.data;
  }

  async createContactList(
    name: string,
    processingType: string,
    opts?: { objectTypeId?: string; filterBranch?: any }
  ): Promise<any> {
    if (!name?.trim()) throw new Error('name is required');
    if (!processingType?.trim()) throw new Error('processingType is required');
    const body: Record<string, any> = {
      name: name.trim(),
      processingType: processingType.trim(),
      objectTypeId: opts?.objectTypeId ?? '0-1',
    };
    if (opts?.filterBranch) body.filterBranch = opts.filterBranch;
    const res = await axiosInstance.post(
      `${HUBSPOT_API_BASE}/crm/lists/2026-03`,
      body,
      { headers: await this.authHeaders() }
    );
    return res.data;
  }

  async addContactsToList(listId: string, recordIds: string[]): Promise<any> {
    if (!listId?.trim()) throw new Error('listId is required');
    if (!recordIds?.length) throw new Error('recordIds array must not be empty');
    const res = await axiosInstance.put(
      `${HUBSPOT_API_BASE}/crm/lists/2026-03/${listId}/memberships/add`,
      recordIds,
      { headers: await this.authHeaders() }
    );
    return res.data;
  }

  async removeContactsFromList(listId: string, recordIds: string[]): Promise<any> {
    if (!listId?.trim()) throw new Error('listId is required');
    if (!recordIds?.length) throw new Error('recordIds array must not be empty');
    const res = await axiosInstance.put(
      `${HUBSPOT_API_BASE}/crm/lists/2026-03/${listId}/memberships/remove`,
      recordIds,
      { headers: await this.authHeaders() }
    );
    return res.data;
  }

  async deleteContactList(listId: string): Promise<void> {
    if (!listId?.trim()) throw new Error('listId is required');
    await axiosInstance.delete(
      `${HUBSPOT_API_BASE}/crm/lists/2026-03/${listId}`,
      { headers: await this.authHeaders() }
    );
  }

  async deleteEmail(emailId: string): Promise<void> {
    if (!emailId?.trim()) throw new Error('emailId is required');
    await axiosInstance.delete(
      `${HUBSPOT_API_BASE}/marketing/v3/emails/${emailId}`,
      { headers: await this.authHeaders() }
    );
  }

  // ─── Forms ────────────────────────────────────────────────────────────────
  // Scope: forms

  async listForms(cursor?: string): Promise<any> {
    let url = `${HUBSPOT_API_BASE}/marketing/v3/forms?limit=50`;
    if (cursor) url += `&after=${encodeURIComponent(cursor)}`;
    const res = await axiosInstance.get(url, { headers: await this.authHeaders() });
    return res.data;
  }

  async getForm(formId: string): Promise<any> {
    const res = await axiosInstance.get(
      `${HUBSPOT_API_BASE}/marketing/v3/forms/${formId}`,
      { headers: await this.authHeaders() }
    );
    return res.data;
  }

  async createForm(props: Record<string, any>): Promise<any> {
    if (!props?.name?.trim()) throw new Error('name is required for form creation');
    // HubSpot's v3 forms POST reuses the full form schema and rejects the request
    // with "required fields were not set: [createdAt]" unless these are present —
    // even though they're server-managed. Inject sane defaults when absent.
    const now = new Date().toISOString();
    const body = {
      archived: false,
      createdAt: now,
      updatedAt: now,
      ...props,
    };
    const res = await axiosInstance.post(
      `${HUBSPOT_API_BASE}/marketing/v3/forms`,
      body,
      { headers: await this.authHeaders() }
    );
    return res.data;
  }

  async updateForm(formId: string, props: Record<string, any>): Promise<any> {
    if (!formId?.trim()) throw new Error('formId is required');
    const res = await axiosInstance.patch(
      `${HUBSPOT_API_BASE}/marketing/v3/forms/${formId}`,
      props,
      { headers: await this.authHeaders() }
    );
    return res.data;
  }

  async deleteForm(formId: string): Promise<void> {
    if (!formId?.trim()) throw new Error('formId is required');
    await axiosInstance.delete(
      `${HUBSPOT_API_BASE}/marketing/v3/forms/${formId}`,
      { headers: await this.authHeaders() }
    );
  }

  async getFormSubmissions(formId: string, cursor?: string): Promise<any> {
    if (!formId?.trim()) throw new Error('formId is required');
    // Submissions live on the legacy Form Integrations API, NOT the v3 forms API.
    // `/marketing/v3/forms/{id}/submissions` does not exist → 404.
    let url = `${HUBSPOT_API_BASE}/form-integrations/v1/submissions/forms/${formId}?limit=50`;
    if (cursor) url += `&after=${encodeURIComponent(cursor)}`;
    const res = await axiosInstance.get(url, { headers: await this.authHeaders() });
    return res.data;
  }

  // Read a form's fields as a flat list — flattens the nested fieldGroups[].fields[]
  // structure so callers can see what to submit without parsing the full schema.
  async getFormFields(formId: string): Promise<{ formId: string; fields: FormFieldSummary[] }> {
    if (!formId?.trim()) throw new Error('formId is required');
    const res = await axiosInstance.get(
      `${HUBSPOT_API_BASE}/marketing/v3/forms/${formId}`,
      { headers: await this.authHeaders() }
    );
    const fieldGroups: any[] = (res.data as any)?.fieldGroups ?? [];
    const fields: FormFieldSummary[] = fieldGroups.flatMap((g: any) => (g?.fields ?? []).map((f: any) => ({
      name: f.name,
      label: f.label,
      fieldType: f.fieldType,
      required: !!f.required,
      objectTypeId: f.objectTypeId,
      options: f.options,
    })));
    return { formId, fields };
  }

  // Submit data INTO a HubSpot form via the public Forms Submission API.
  // This endpoint lives on a different host (api.hsforms.com) and is keyed by
  // portalId + formGuid; it does not use the OAuth bearer token.
  async submitForm(
    portalId: string,
    formGuid: string,
    fields: Array<{ name: string; value: any; objectTypeId?: string }>,
    opts?: { context?: Record<string, any>; legalConsentOptions?: Record<string, any> }
  ): Promise<any> {
    if (!portalId?.trim()) throw new Error('portalId is required to submit a form');
    if (!formGuid?.trim()) throw new Error('formGuid is required');
    if (!fields?.length) throw new Error('fields array must not be empty');
    const body: Record<string, any> = { fields };
    if (opts?.context) body.context = opts.context;
    if (opts?.legalConsentOptions) body.legalConsentOptions = opts.legalConsentOptions;
    const res = await axiosInstance.post(
      `https://api.hsforms.com/submissions/v3/integration/submit/${portalId}/${formGuid}`,
      body,
      { headers: { 'Content-Type': 'application/json' } }
    );
    return res.data;
  }

  // ─── Landing Pages ────────────────────────────────────────────────────────
  // Scope: content

  async listLandingPages(cursor?: string): Promise<any> {
    let url = `${HUBSPOT_API_BASE}/cms/v3/pages/landing-pages?limit=50`;
    if (cursor) url += `&after=${encodeURIComponent(cursor)}`;
    const res = await axiosInstance.get(url, { headers: await this.authHeaders() });
    return res.data;
  }

  async getLandingPage(pageId: string): Promise<any> {
    const res = await axiosInstance.get(
      `${HUBSPOT_API_BASE}/cms/v3/pages/landing-pages/${pageId}`,
      { headers: await this.authHeaders() }
    );
    return res.data;
  }

  async createLandingPage(
    name: string,
    opts?: { templatePath?: string; slug?: string; metaDescription?: string }
  ): Promise<any> {
    if (!name?.trim()) throw new Error('Landing page name is required');
    const body: Record<string, any> = { name: name.trim() };
    if (opts?.templatePath) body.templatePath = opts.templatePath;
    if (opts?.slug) body.slug = opts.slug;
    if (opts?.metaDescription) body.metaDescription = opts.metaDescription;
    const res = await axiosInstance.post(
      `${HUBSPOT_API_BASE}/cms/v3/pages/landing-pages`,
      body,
      { headers: await this.authHeaders() }
    );
    return res.data;
  }

  async publishLandingPage(pageId: string): Promise<any> {
    const res = await axiosInstance.post(
      `${HUBSPOT_API_BASE}/cms/v3/pages/landing-pages/${pageId}/draft/push-live`,
      {},
      { headers: await this.authHeaders() }
    );
    return res.data;
  }

  async updateLandingPage(pageId: string, props: Record<string, any>): Promise<any> {
    if (!pageId?.trim()) throw new Error('pageId is required');
    const res = await axiosInstance.patch(
      `${HUBSPOT_API_BASE}/cms/v3/pages/landing-pages/${pageId}`,
      props,
      { headers: await this.authHeaders() }
    );
    return res.data;
  }

  async deleteLandingPage(pageId: string): Promise<void> {
    if (!pageId?.trim()) throw new Error('pageId is required');
    await axiosInstance.delete(
      `${HUBSPOT_API_BASE}/cms/v3/pages/landing-pages/${pageId}`,
      { headers: await this.authHeaders() }
    );
  }

  // ─── Blog Posts ───────────────────────────────────────────────────────────
  // Scope: content

  async listBlogPosts(cursor?: string): Promise<any> {
    let url = `${HUBSPOT_API_BASE}/cms/v3/blogs/posts?limit=50`;
    if (cursor) url += `&after=${encodeURIComponent(cursor)}`;
    const res = await axiosInstance.get(url, { headers: await this.authHeaders() });
    return res.data;
  }

  async getBlogPost(postId: string): Promise<any> {
    const res = await axiosInstance.get(
      `${HUBSPOT_API_BASE}/cms/v3/blogs/posts/${postId}`,
      { headers: await this.authHeaders() }
    );
    return res.data;
  }

  async createBlogPost(
    name: string,
    contentGroupId: string,
    opts?: { slug?: string; metaDescription?: string; postBody?: string }
  ): Promise<any> {
    if (!name?.trim()) throw new Error('Blog post name is required');
    if (!contentGroupId?.trim()) throw new Error('contentGroupId (blog ID) is required');
    const body: Record<string, any> = { name: name.trim(), contentGroupId: contentGroupId.trim() };
    if (opts?.slug) body.slug = opts.slug;
    if (opts?.metaDescription) body.metaDescription = opts.metaDescription;
    if (opts?.postBody) body.postBody = opts.postBody;
    const res = await axiosInstance.post(
      `${HUBSPOT_API_BASE}/cms/v3/blogs/posts`,
      body,
      { headers: await this.authHeaders() }
    );
    return res.data;
  }

  async publishBlogPost(postId: string): Promise<void> {
    await axiosInstance.post(
      `${HUBSPOT_API_BASE}/cms/blogs/2026-03/posts/${postId}/draft/push-live`,
      {},
      { headers: await this.authHeaders() }
    );
  }

  async updateBlogPost(postId: string, props: Record<string, any>): Promise<any> {
    if (!postId?.trim()) throw new Error('postId is required');
    const res = await axiosInstance.patch(
      `${HUBSPOT_API_BASE}/cms/v3/blogs/posts/${postId}`,
      props,
      { headers: await this.authHeaders() }
    );
    return res.data;
  }

  async deleteBlogPost(postId: string): Promise<void> {
    if (!postId?.trim()) throw new Error('postId is required');
    await axiosInstance.delete(
      `${HUBSPOT_API_BASE}/cms/v3/blogs/posts/${postId}`,
      { headers: await this.authHeaders() }
    );
  }

  // ─── Workflows ────────────────────────────────────────────────────────────
  // Scope: automation

  async listWorkflows(): Promise<any> {
    const res = await axiosInstance.get(
      `${HUBSPOT_API_BASE}/automation/v3/workflows`,
      { headers: await this.authHeaders() }
    );
    return res.data;
  }

  async getWorkflow(workflowId: string): Promise<any> {
    const res = await axiosInstance.get(
      `${HUBSPOT_API_BASE}/automation/v3/workflows/${workflowId}`,
      { headers: await this.authHeaders() }
    );
    return res.data;
  }

  // The v3 workflows API (list/get/performance) and the v4 flows API (enable/
  // disable/delete) use DIFFERENT id spaces. A v3 workflowId is invalid on v4
  // (404). Convert it via the mapping endpoint before any v4 call.
  private async resolveFlowId(workflowId: string): Promise<string> {
    const res = await axiosInstance.post(
      `${HUBSPOT_API_BASE}/automation/v4/workflow-id-mappings/batch/read`,
      { inputs: [{ type: 'WORKFLOW_ID', workflowId }] },
      { headers: await this.authHeaders() }
    );
    const flowId = (res.data as any)?.results?.[0]?.flowId;
    if (flowId === undefined || flowId === null) {
      throw new Error(`Could not map workflowId "${workflowId}" to a v4 flowId`);
    }
    return String(flowId);
  }

  // Read a v4 flow by flowId. GET /automation/v4/flows/{flowId} 404s on this API;
  // the batch-read endpoint is the working path and surfaces clear errors (e.g.
  // missing crm.objects.contacts.sensitive.* scopes for contact flows).
  private async readFlow(flowId: string): Promise<any> {
    const res = await axiosInstance.post(
      `${HUBSPOT_API_BASE}/automation/v4/flows/batch/read`,
      { inputs: [{ type: 'FLOW_ID', flowId }] },
      { headers: await this.authHeaders() }
    );
    const flow = (res.data as any)?.results?.[0];
    if (!flow) {
      const err = (res.data as any)?.errors?.[0]?.message;
      throw new Error(`Could not read v4 flow "${flowId}"${err ? ': ' + err : ''}`);
    }
    return flow;
  }

  async deleteWorkflow(workflowId: string): Promise<void> {
    if (!workflowId?.trim()) throw new Error('workflowId is required');
    const flowId = await this.resolveFlowId(workflowId.trim());
    await axiosInstance.delete(
      `${HUBSPOT_API_BASE}/automation/v4/flows/${flowId}`,
      { headers: await this.authHeaders() }
    );
  }

  // Enable or disable a workflow. The v4 flows API has no partial PATCH — update
  // is a full-object PUT requiring revisionId (optimistic concurrency). So we map
  // the v3 id → v4 flowId, batch-read the current flow, flip isEnabled, strip the
  // server-managed fields, and PUT the whole object back.
  // Requires Marketing/Sales/Service/etc. Hub Professional+ and (for contact
  // flows) crm.objects.contacts.sensitive.read/write.
  async setWorkflowEnabled(workflowId: string, enabled: boolean): Promise<any> {
    if (!workflowId?.trim()) throw new Error('workflowId is required');
    const flowId = await this.resolveFlowId(workflowId.trim());
    const flow = await this.readFlow(flowId);
    const body: Record<string, any> = { ...flow, isEnabled: enabled };
    delete body.createdAt;
    delete body.updatedAt;
    delete body.dataSources;
    const res = await axiosInstance.put(
      `${HUBSPOT_API_BASE}/automation/v4/flows/${flowId}`,
      body,
      { headers: await this.authHeaders() }
    );
    return res.data;
  }

  async getWorkflowPerformance(
    workflowId: string,
    start: number,
    end: number,
    bucket: 'DAY' | 'WEEK' | 'MONTH'
  ): Promise<any> {
    if (!workflowId?.trim()) throw new Error('workflowId is required');
    const url = `${HUBSPOT_API_BASE}/automation/v3/performance/workflow/${workflowId}?start=${start}&end=${end}&bucket=${bucket}`;
    const res = await axiosInstance.get(url, { headers: await this.authHeaders() });
    return res.data;
  }

  // ─── Social Broadcasts (deprecated v1, still functional) ─────────────────

  async listSocialChannels(): Promise<any> {
    const res = await axiosInstance.get(
      `${HUBSPOT_API_BASE}/broadcast/v1/channels/setting/publish/current`,
      { headers: await this.authHeaders() }
    );
    return res.data;
  }

  async listSocialBroadcasts(): Promise<any> {
    const res = await axiosInstance.get(
      `${HUBSPOT_API_BASE}/broadcast/v1/broadcasts`,
      { headers: await this.authHeaders() }
    );
    return res.data;
  }

  async createSocialBroadcast(
    channelKey: string,
    body: string,
    opts?: { triggerAt?: number }
  ): Promise<any> {
    if (!channelKey?.trim()) throw new Error('channelKey is required');
    if (!body?.trim()) throw new Error('broadcast body is required');
    const payload: Record<string, any> = { channelKey, content: { body } };
    if (opts?.triggerAt) payload.triggerAt = opts.triggerAt;
    const res = await axiosInstance.post(
      `${HUBSPOT_API_BASE}/broadcast/v1/broadcasts`,
      payload,
      { headers: await this.authHeaders() }
    );
    return res.data;
  }

  async deleteSocialBroadcast(broadcastGuid: string): Promise<void> {
    if (!broadcastGuid?.trim()) throw new Error('broadcastGuid is required');
    await axiosInstance.delete(
      `${HUBSPOT_API_BASE}/broadcast/v1/broadcasts/${broadcastGuid}`,
      { headers: await this.authHeaders() }
    );
  }

  async getAllLists(query?: string): Promise<Array<{ id: string; name: string }>> {
    const results: Array<{ id: string; name: string }> = [];
    let after: string | undefined;
    let pages = 0;
    const MAX_PAGES = 50;

    do {
      if (pages++ >= MAX_PAGES) {
        console.warn(`[HubSpot] getAllLists hit ${MAX_PAGES}-page cap`);
        break;
      }
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

  // ─── Batch operations ───────────────────────────────────────────────────────
  //
  // Each method below processes a SINGLE batch of at most 100 inputs and THROWS
  // on failure — both a non-2xx response (whole-batch failure) AND a 207
  // Multi-Status (partial failure: some inputs failed), which axios would
  // otherwise treat as success. See throwIfBatchPartialFailure. Chunking and
  // split-and-retry are handled by the caller, so these methods do NOT chunk
  // internally — they throw if more than 100 inputs are supplied.

  /**
   * Batch upsert contacts by email (idProperty = 'email').
   * POST /crm/v3/objects/contacts/batch/upsert
   * Maps each result back via the email returned in result.properties.email
   * (lowercased). isNew is derived from the HubSpot `new` flag on each result.
   */
  async batchUpsertContacts(
    inputs: Array<{ email: string; properties: Record<string, string> }>
  ): Promise<Array<{ email: string; contactId: string; isNew: boolean }>> {
    if (inputs.length > 100) {
      throw new Error(`batchUpsertContacts accepts at most 100 inputs per batch, got ${inputs.length}`);
    }

    const res = await axiosInstance.post(
      `${HUBSPOT_API_BASE}/crm/v3/objects/contacts/batch/upsert`,
      {
        inputs: inputs.map((i) => ({
          idProperty: 'email',
          id: i.email.toLowerCase(),
          properties: i.properties,
        })),
      },
      { headers: await this.authHeaders() }
    );

    // A 207 means some upserts failed — surface it so the caller's split-and-retry
    // isolates the bad input(s) and reports them, rather than silently returning
    // only the successes (the failures would be dropped from both counts).
    throwIfBatchPartialFailure(res);

    return ((res.data as any)?.results ?? []).map((r: any) => ({
      email: String(r?.properties?.email ?? '').toLowerCase(),
      contactId: String(r.id),
      isNew: r?.new === true,
    }));
  }

  /**
   * Batch create deals.
   * POST /crm/v3/objects/deals/batch/create
   * Each input carries a unique objectWriteTraceId (the caller passes leadId) so
   * results — which may NOT preserve input order — can be mapped back reliably.
   */
  async batchCreateDeals(
    inputs: Array<{ traceId: string; properties: Record<string, string> }>
  ): Promise<Array<{ traceId: string; dealId: string }>> {
    if (inputs.length > 100) {
      throw new Error(`batchCreateDeals accepts at most 100 inputs per batch, got ${inputs.length}`);
    }

    const res = await axiosInstance.post(
      `${HUBSPOT_API_BASE}/crm/v3/objects/deals/batch/create`,
      {
        inputs: inputs.map((i) => ({
          properties: i.properties,
          objectWriteTraceId: i.traceId,
        })),
      },
      { headers: await this.authHeaders() }
    );

    // A 207 means some creates failed — surface it so the caller's split-and-retry
    // isolates the bad input(s) instead of silently dropping them (failed creates
    // are absent from `results` and would otherwise map to an undefined dealId).
    throwIfBatchPartialFailure(res);

    const results = (res.data as any)?.results ?? [];

    // Primary path: map back by the echoed objectWriteTraceId (order-independent).
    const allEchoed = results.every((r: any) => r?.objectWriteTraceId !== undefined && r?.objectWriteTraceId !== null);
    if (allEchoed) {
      const dealByTrace = new Map<string, string>();
      for (const r of results) {
        dealByTrace.set(String(r.objectWriteTraceId), String(r.id));
      }
      return inputs.map((i) => ({ traceId: i.traceId, dealId: dealByTrace.get(i.traceId) as string }));
    }

    // FALLBACK: without echoed trace IDs, positional mapping is only safe when it
    // is UNAMBIGUOUS — a single input and a single real result. Anything else
    // (multi-item batch, or a short/incomplete response) risks pairing deals with
    // the wrong lead or emitting the literal string 'undefined', so we THROW and
    // let splitAndRetry isolate the batch down to size 1 (where positional is safe).
    if (inputs.length === 1 && results.length === 1 && results[0]?.id != null) {
      return [{ traceId: inputs[0].traceId, dealId: String(results[0].id) }];
    }
    throw new Error('batchCreateDeals: cannot map results to inputs (objectWriteTraceId not echoed and response is ambiguous or incomplete)');
  }

  /**
   * Batch update deals by id.
   * POST /crm/v3/objects/deals/batch/update
   */
  async batchUpdateDeals(
    inputs: Array<{ dealId: string; properties: Record<string, string> }>
  ): Promise<void> {
    if (inputs.length > 100) {
      throw new Error(`batchUpdateDeals accepts at most 100 inputs per batch, got ${inputs.length}`);
    }

    const res = await axiosInstance.post(
      `${HUBSPOT_API_BASE}/crm/v3/objects/deals/batch/update`,
      {
        inputs: inputs.map((i) => ({ id: i.dealId, properties: i.properties })),
      },
      { headers: await this.authHeaders() }
    );

    // A failed update (e.g. the deal was deleted) comes back as a 207 per-record
    // error, NOT a top-level non-2xx — surface it so the caller can isolate and
    // recreate/report it instead of treating the whole batch as a success.
    throwIfBatchPartialFailure(res);
  }

  /**
   * Batch update contacts by internal HubSpot contact ID.
   * POST /crm/v3/objects/contacts/batch/update
   */
  async batchUpdateContacts(
    inputs: Array<{ id: string; properties: Record<string, string> }>
  ): Promise<void> {
    if (inputs.length > 100) {
      throw new Error(`batchUpdateContacts accepts at most 100 inputs per batch, got ${inputs.length}`);
    }

    const res = await axiosInstance.post(
      `${HUBSPOT_API_BASE}/crm/v3/objects/contacts/batch/update`,
      { inputs: inputs.map((i) => ({ id: i.id, properties: i.properties })) },
      { headers: await this.authHeaders() }
    );

    throwIfBatchPartialFailure(res);
  }

  /**
   * Batch create DEFAULT contact→deal associations.
   * POST /crm/v4/associations/contact/deal/batch/create/default
   */
  async batchAssociateContactsToDeals(
    pairs: Array<{ contactId: string; dealId: string }>
  ): Promise<void> {
    if (pairs.length > 100) {
      throw new Error(`batchAssociateContactsToDeals accepts at most 100 pairs per batch, got ${pairs.length}`);
    }

    const res = await axiosInstance.post(
      `${HUBSPOT_API_BASE}/crm/v4/associations/contact/deal/batch/create/default`,
      {
        inputs: pairs.map((p) => ({ from: { id: p.contactId }, to: { id: p.dealId } })),
      },
      { headers: await this.authHeaders() }
    );

    // Surface a 207 partial failure rather than silently treating it as success.
    throwIfBatchPartialFailure(res);
  }
}
