import axios from 'axios';
import { getAccountsByUserId, getAccountById } from './connectedAccountsDb';

// Module-level axios instance with a 15-second timeout for all Attio API calls.
// Falls back to the base axios object when axios.create returns falsy (e.g., in jest auto-mock).
const _created = axios.create?.({ timeout: 15000 });
const axiosInstance: typeof axios = (_created ?? axios) as typeof axios;

// Retry-After parsing: HTTP spec allows either a delta-seconds integer or an
// HTTP-date. Live-verified (ENG-1380, a real 429 triggered against Attio's
// API) that Attio always sends the HTTP-date form (e.g. "Thu, 27 Aug 2026
// 08:45:29 GMT") — unlike HubSpot's, which sends plain delta-seconds. A
// naive parseInt() on a date string always yields NaN, silently discarding
// Attio's actual instructed wait and falling back to the flat default every
// time. Disambiguate on the header's shape rather than trying Date.parse()
// first: Date.parse('0') and Date.parse('600') both return non-NaN (but
// bogus) timestamps, so checking for a pure-digit string first is required
// to keep delta-seconds inputs (still handled, for spec-compliance/safety)
// from being misread as dates.
function parseRetryAfterSeconds(headerValue: string | undefined): number {
  if (!headerValue) return 10;
  const trimmed = String(headerValue).trim();
  if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  const asDate = Date.parse(trimmed);
  if (!isNaN(asDate)) return Math.max(0, Math.ceil((asDate - Date.now()) / 1000));
  return 10;
}

// Retry once on 429 — respect Retry-After header, default 10s. Mirrors
// hubspotService.ts's identical interceptor.
if (_created) {
  _created.interceptors.response.use(
    (res) => res,
    async (err) => {
      const config = err?.config as any;
      if (err?.response?.status === 429 && config && !config.__attioRetried) {
        config.__attioRetried = true;
        const retryAfter = Math.min(parseRetryAfterSeconds(err.response.headers?.['retry-after']), 60);
        await new Promise(r => setTimeout(r, retryAfter * 1000));
        return _created.request(config);
      }
      throw err;
    }
  );
}

const ATTIO_API_BASE = 'https://api.attio.com/v2';

export interface AttioPerson {
  recordId: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  jobTitle?: string;
  linkedinUrl?: string;
  companyId?: string;
}

export interface AttioCompany {
  recordId: string;
  name: string;
  domainNames?: string[];
}

/** A single Attio List Entry, reshaped from the raw API response. */
export interface AttioListEntry {
  entryId: string;
  personRecordId: string;
  values: Record<string, any>;
}

// ─── Module-level account resolver ───────────────────────────────────────────

async function resolveAttioAccount(userId: string, accountId?: string) {
  if (accountId) {
    const account = await getAccountById(accountId, userId);
    if (!account || account.platform !== 'attio') {
      throw new Error(`Attio account "${accountId}" not found. Please reconnect.`);
    }
    return account;
  }

  const accounts = await getAccountsByUserId(userId);
  const attioAccounts = accounts.filter(a => a.platform === 'attio');

  if (attioAccounts.length === 0) {
    throw new Error('Attio account not connected. Please connect your Attio account in Settings.');
  }
  if (attioAccounts.length > 1) {
    const list = attioAccounts.map(a => `${a.account_name} (ID: ${a.account_id})`).join(', ');
    throw new Error(`Multiple Attio accounts found: [${list}]. Specify account_id.`);
  }

  return attioAccounts[0];
}

export class AttioService {
  private readonly baseUrl = ATTIO_API_BASE;

  // ─── Instance state ───────────────────────────────────────────────────────
  // _token      — always set (resolved at factory time or passed directly)
  // _userId     — only set on OAuth instances; needed by registerWebhook
  // _accountId  — same
  private readonly _token: string;
  private readonly _userId?: string;
  private readonly _accountId?: string;
  // object_id -> api_slug, lazily populated by getObjectSlug(). object/slug
  // mappings are effectively permanent within a workspace, so a per-instance
  // cache (this instance's lifetime — one webhook job, one request) is
  // enough to avoid a GET /v2/objects call per event without needing a
  // module-level cache or TTL.
  private objectSlugCache: Map<string, string> | null = null;

  private constructor(token: string, userId?: string, accountId?: string) {
    this._token = token;
    this._userId = userId;
    this._accountId = accountId;
  }

  // ─── Factories ────────────────────────────────────────────────────────────

  /**
   * OAuth path — resolves token from DB (one read), then returns a
   * fully-initialised instance. Attio tokens never expire, so no refresh.
   */
  static async create(userId: string, accountId?: string): Promise<AttioService> {
    const account = await resolveAttioAccount(userId, accountId);
    return new AttioService(
      (account.config as any).access_token,
      userId,
      account.account_id,
    );
  }

  /**
   * Direct API key / pre-resolved token path — bypasses all DB logic.
   * Used by AttioAdapter for token-based (non-OAuth) connections.
   */
  static fromToken(apiKey: string): AttioService {
    return new AttioService(apiKey);
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private headers() {
    return {
      Authorization: `Bearer ${this._token}`,
      'Content-Type': 'application/json',
    };
  }

  // ─── Connection test ──────────────────────────────────────────────────────

  async testConnection(): Promise<{ valid: boolean; error?: string }> {
    try {
      await axiosInstance.get(`${ATTIO_API_BASE}/objects`, { headers: this.headers() });
      return { valid: true };
    } catch (err: any) {
      const msg = err.response?.data?.message || err.message || 'Unknown error';
      return { valid: false, error: msg };
    }
  }

  // ─── Mappers ──────────────────────────────────────────────────────────────

  private mapPerson(record: any): AttioPerson {
    const v = record?.values ?? {};
    return {
      recordId: record?.id?.record_id ?? record?.id,
      firstName: v.name?.[0]?.first_name ?? '',
      lastName: v.name?.[0]?.last_name ?? '',
      email: v.email_addresses?.[0]?.email_address ?? '',
      phone: v.phone_numbers?.[0]?.original_phone_number ?? '',
      jobTitle: v.job_title?.[0]?.value ?? '',
      linkedinUrl: v.linkedin?.[0]?.value ?? '',
      companyId: v.company?.[0]?.target_record_id ?? undefined,
    };
  }

  private mapCompany(record: any): AttioCompany {
    const v = record?.values ?? {};
    return {
      recordId: record?.id?.record_id ?? record?.id,
      name: v.name?.[0]?.value ?? '',
      domainNames: (v.domains ?? []).map((d: any) => d.domain ?? d.value).filter(Boolean),
    };
  }

  // ─── People ───────────────────────────────────────────────────────────────

  // POST /objects/{object}/records/query uses limit/offset pagination, not
  // cursor — confirmed against Attio's own docs (docs.attio.com/rest-api/
  // guides/pagination and .../endpoint-reference/records/list-records, which
  // uses this exact endpoint as its offset-pagination example). There is no
  // next_cursor in the response; end-of-results is inferred from a
  // short/empty page. The previous cursor-based implementation always sent
  // no cursor param, so Attio always returned page 1, and the response never
  // carried next_cursor — every call silently returned at most 50 people
  // with no way to reach a second page, for any list.
  async listPeople(offset: number = 0): Promise<{ people: AttioPerson[]; nextOffset?: number }> {
    const limit = 50;
    const res = await axiosInstance.post(
      `${this.baseUrl}/objects/people/records/query`,
      { limit, offset },
      { headers: this.headers() }
    );

    const people = ((res.data as any)?.data ?? []).map((r: any) => this.mapPerson(r));
    return {
      people,
      nextOffset: people.length === limit ? offset + limit : undefined,
    };
  }

  async findPersonByEmail(email: string): Promise<AttioPerson | null> {
    const res = await axiosInstance.post(
      `${this.baseUrl}/objects/people/records/query`,
      {
        filter: {
          email_addresses: { email_address: { $eq: email.toLowerCase() } },
        },
        limit: 1,
      },
      { headers: this.headers() }
    );

    const records = (res.data as any)?.data ?? [];
    if (records.length === 0) return null;
    return this.mapPerson(records[0]);
  }

  async upsertPerson(
    data: Omit<AttioPerson, 'recordId'> & { email: string }
  ): Promise<AttioPerson> {
    const values: any = {};

    const firstName = data.firstName?.trim();
    const lastName = data.lastName?.trim();
    if (firstName || lastName) {
      const nameEntry: any = {};
      if (firstName) nameEntry.first_name = firstName;
      if (lastName) nameEntry.last_name = lastName;
      nameEntry.full_name = [firstName, lastName].filter(Boolean).join(' ');
      values.name = [nameEntry];
    }
    values.email_addresses = [{ email_address: data.email.toLowerCase() }];
    if (data.phone) {
      values.phone_numbers = [{ original_phone_number: data.phone }];
    }
    if (data.jobTitle) {
      values.job_title = [{ value: data.jobTitle }];
    }
    if (data.linkedinUrl) {
      values.linkedin = [{ value: data.linkedinUrl }];
    }
    if (data.companyId) {
      values.company = [{ target_object: 'companies', target_record_id: data.companyId }];
    }

    const res = await axiosInstance.put(
      `${this.baseUrl}/objects/people/records?matching_attribute=email_addresses`,
      { data: { values } },
      { headers: this.headers() }
    );

    return this.mapPerson((res.data as any)?.data);
  }

  async createPerson(data: Omit<AttioPerson, 'recordId'>): Promise<AttioPerson> {
    const values: any = {};

    const firstName = data.firstName?.trim();
    const lastName = data.lastName?.trim();
    if (firstName || lastName) {
      const nameEntry: any = {};
      if (firstName) nameEntry.first_name = firstName;
      if (lastName) nameEntry.last_name = lastName;
      nameEntry.full_name = [firstName, lastName].filter(Boolean).join(' ');
      values.name = [nameEntry];
    }
    if (data.email) {
      values.email_addresses = [{ email_address: data.email.toLowerCase() }];
    }
    if (data.phone) {
      values.phone_numbers = [{ original_phone_number: data.phone }];
    }
    if (data.jobTitle) {
      values.job_title = [{ value: data.jobTitle }];
    }
    if (data.linkedinUrl) {
      values.linkedin = [{ value: data.linkedinUrl }];
    }
    if (data.companyId) {
      values.company = [{ target_object: 'companies', target_record_id: data.companyId }];
    }

    const res = await axiosInstance.post(
      `${this.baseUrl}/objects/people/records`,
      { data: { values } },
      { headers: this.headers() }
    );

    return this.mapPerson((res.data as any)?.data);
  }

  async updatePerson(
    recordId: string,
    data: Partial<Omit<AttioPerson, 'recordId'>>
  ): Promise<AttioPerson> {
    const values: any = {};

    const firstName = data.firstName?.trim();
    const lastName = data.lastName?.trim();
    if (firstName || lastName) {
      const nameEntry: any = {};
      if (firstName) nameEntry.first_name = firstName;
      if (lastName) nameEntry.last_name = lastName;
      nameEntry.full_name = [firstName, lastName].filter(Boolean).join(' ');
      values.name = [nameEntry];
    }
    if (data.email != null && data.email !== '') {
      values.email_addresses = [{ email_address: data.email.toLowerCase() }];
    }
    if (data.phone != null && data.phone !== '') {
      values.phone_numbers = [{ original_phone_number: data.phone }];
    }
    if (data.jobTitle != null && data.jobTitle !== '') {
      values.job_title = [{ value: data.jobTitle }];
    }
    if (data.linkedinUrl != null && data.linkedinUrl !== '') {
      values.linkedin = [{ value: data.linkedinUrl }];
    }
    if (data.companyId != null && data.companyId !== '') {
      values.company = [{ target_object: 'companies', target_record_id: data.companyId }];
    }

    const res = await axiosInstance.patch(
      `${this.baseUrl}/objects/people/records/${recordId}`,
      { data: { values } },
      { headers: this.headers() }
    );

    return this.mapPerson((res.data as any)?.data);
  }

  async deletePerson(recordId: string): Promise<void> {
    await axiosInstance.delete(
      `${this.baseUrl}/objects/people/records/${recordId}`,
      { headers: this.headers() }
    );
  }

  // ─── Companies ────────────────────────────────────────────────────────────

  // See listPeople's comment — same endpoint family, same limit/offset contract.
  async listCompanies(offset: number = 0): Promise<{ companies: AttioCompany[]; nextOffset?: number }> {
    const limit = 50;
    const res = await axiosInstance.post(
      `${this.baseUrl}/objects/companies/records/query`,
      { limit, offset },
      { headers: this.headers() }
    );

    const companies = ((res.data as any)?.data ?? []).map((r: any) => this.mapCompany(r));
    return {
      companies,
      nextOffset: companies.length === limit ? offset + limit : undefined,
    };
  }

  async findCompanyByName(name: string): Promise<AttioCompany | null> {
    const res = await axiosInstance.post(
      `${this.baseUrl}/objects/companies/records/query`,
      { filter: { name: { $contains: name } }, limit: 1 },
      { headers: this.headers() }
    );

    const records = (res.data as any)?.data ?? [];
    return records.length > 0 ? this.mapCompany(records[0]) : null;
  }

  /**
   * Read-only record search for call_attio_api RECORDS SEARCH (ENG-2580).
   * People: an `@` query filters by email; otherwise name contains. Companies:
   * name contains. One page of up to 25 records.
   */
  async searchRecords(
    objectSlug: 'people' | 'companies',
    query: string,
    limit: number = 25,
  ): Promise<Array<AttioPerson | AttioCompany>> {
    const q = query.trim();
    const filter =
      objectSlug === 'people'
        ? q.includes('@')
          ? { email_addresses: { email_address: { $eq: q.toLowerCase() } } }
          : { name: { full_name: { $contains: q } } }
        : { name: { $contains: q } };
    const res = await axiosInstance.post(
      `${this.baseUrl}/objects/${objectSlug}/records/query`,
      { filter, limit },
      { headers: this.headers() }
    );
    const records = (res.data as any)?.data ?? [];
    return records.map((r: any) => (objectSlug === 'people' ? this.mapPerson(r) : this.mapCompany(r)));
  }

  async getCompanyById(recordId: string): Promise<AttioCompany | null> {
    try {
      const res = await axiosInstance.get(
        `${this.baseUrl}/objects/companies/records/${recordId}`,
        { headers: this.headers() }
      );
      return this.mapCompany((res.data as any)?.data);
    } catch {
      return null;
    }
  }

  async createCompany(name: string): Promise<AttioCompany> {
    const res = await axiosInstance.post(
      `${this.baseUrl}/objects/companies/records`,
      { data: { values: { name: [{ value: name }] } } },
      { headers: this.headers() }
    );

    return this.mapCompany((res.data as any)?.data);
  }

  // ─── Lists ────────────────────────────────────────────────────────────────
  // Attio Lists are named collections of People or Company records.
  // Use the /v2/lists endpoint. Lists are scoped per object type (people/companies).

  /**
   * Resolves an Attio object_id (a UUID, e.g. from a webhook event's
   * `id.object_id`) to its api_slug (e.g. 'people', 'companies'). Live-caught
   * bug (ENG-1380): webhook payloads never carry a slug directly — only this
   * UUID — so anything trying to filter events by object type needs this
   * lookup. Cached per-instance since the mapping is effectively permanent.
   */
  async getObjectSlug(objectId: string): Promise<string | null> {
    if (!this.objectSlugCache) {
      const res = await axiosInstance.get(`${this.baseUrl}/objects`, { headers: this.headers() });
      this.objectSlugCache = new Map(
        ((res.data as any)?.data ?? [])
          .filter((o: any) => o?.id?.object_id && o?.api_slug)
          .map((o: any) => [o.id.object_id as string, o.api_slug as string])
      );
    }
    return this.objectSlugCache.get(objectId) ?? null;
  }

  /**
   * Attio returns a list's `parent_object` as an ARRAY of object slugs or
   * object UUIDs (legacy lists may allow several parents); only list entries
   * carry it as a string (ENG-2631). Normalise to slugs, and report
   * `parentObject: 'companies'` whenever companies is an allowed parent.
   */
  async getAllLists(): Promise<Array<{ id: string; name: string; parentObject: 'people' | 'companies' | string; parentObjects: string[] }>> {
    const res = await axiosInstance.get(`${this.baseUrl}/lists`, { headers: this.headers() });
    const raw: any[] = (res.data as any)?.data ?? [];
    const isUuid = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
    return Promise.all(raw.map(async (l: any) => {
      const rawParents: string[] = (Array.isArray(l.parent_object) ? l.parent_object : [l.parent_object])
        .filter((v: any): v is string => typeof v === 'string' && !!v);
      const parentObjects: string[] = [];
      for (const v of rawParents) {
        let slug = v;
        if (isUuid(v)) {
          try { slug = (await this.getObjectSlug(v)) ?? v; } catch { /* keep raw id */ }
        }
        parentObjects.push(slug);
      }
      return {
        id: l.id?.list_id as string,
        name: l.name as string,
        parentObject: parentObjects.includes('companies') ? 'companies' : (parentObjects[0] ?? ''),
        parentObjects,
      };
    }));
  }

  async findListByName(name: string): Promise<string | null> {
    const lists = await this.getAllLists();
    const match = lists.find(l => l.name === name);
    return match ? match.id : null;
  }

  async createList(name: string, objectSlug: 'people' | 'companies'): Promise<string> {
    // api_slug must be snake_case, max ~50 chars
    // We append a random hash to prevent 409 slug_conflict with trashed/deleted lists
    const baseSlug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '')
      .slice(0, 40);
    const apiSlug = `${baseSlug}_${Math.floor(Math.random() * 100000)}`;

    const res = await axiosInstance.post(
      `${this.baseUrl}/lists`,
      {
        data: {
          name,
          api_slug: apiSlug,
          parent_object: objectSlug,
          workspace_access: 'full-access',
          workspace_member_access: [],
        },
      },
      { headers: this.headers() }
    );

    return (res.data as any)?.data?.id?.list_id;
  }

  async findOrCreateList(name: string, objectSlug: 'people' | 'companies'): Promise<string> {
    const existing = await this.findListByName(name);
    if (existing) return existing;
    return this.createList(name, objectSlug);
  }

  async addPersonToList(
    listId: string,
    recordId: string,
    entryValues?: Record<string, any[]>
  ): Promise<string | undefined> {
    const res = await axiosInstance.post(
      `${this.baseUrl}/lists/${listId}/entries`,
      {
        data: {
          parent_record_id: recordId,
          parent_object: 'people',
          entry_values: entryValues ?? {},
        },
      },
      { headers: this.headers() }
    );
    return (res.data as any)?.data?.id?.entry_id;
  }

  // ─── List entry attributes ────────────────────────────────────────────────
  // List entry attributes are scoped to a specific list (not global to the object).

  async listListAttributes(attioListId: string): Promise<any[]> {
    const res = await axiosInstance.get(
      `${this.baseUrl}/lists/${attioListId}/attributes`,
      { headers: this.headers() }
    );
    return (res.data as any)?.data ?? [];
  }

  /**
   * Returns all attributes defined on the Attio People object.
   * Uses GET /v2/objects/people/attributes.
   * Each entry: { api_slug, title, type, is_system_attribute, is_writable }
   */
  async getAllPeopleAttributes(): Promise<Array<{ api_slug: string; title: string; type: string; is_system_attribute: boolean }>> {
    const res = await axiosInstance.get(
      `${this.baseUrl}/objects/people/attributes`,
      { headers: this.headers() }
    );
    return ((res.data as any)?.data ?? []).map((a: any) => ({
      api_slug: a.api_slug as string,
      title: a.title as string,
      type: a.type as string,
      is_system_attribute: !!a.is_system_attribute,
    }));
  }

  private toSlug(key: string): string {
    return key
      .replace(/([a-z])([A-Z])/g, '$1_$2')
      .replace(/[\s\-]+/g, '_')
      .replace(/[^a-z0-9_]/gi, '')
      .toLowerCase()
      .replace(/^_+|_+$/g, '')
      .slice(0, 50);
  }

  async ensureListAttribute(
    attioListId: string,
    key: string,
    title: string,
    type: string = 'text'
  ): Promise<string> {
    const slug = this.toSlug(key);
    const existing = await this.listListAttributes(attioListId);

    const found = existing.find((a: any) => this.toSlug(a.api_slug) === slug);
    if (found) return found.api_slug;

    const res = await axiosInstance.post(
      `${this.baseUrl}/lists/${attioListId}/attributes`,
      {
        data: {
          title,
          description: null,
          api_slug: slug,
          type,
          is_required: false,
          is_unique: false,
          is_multiselect: false,
          config: {},
        },
      },
      { headers: this.headers() }
    );
    return (res.data as any)?.data?.api_slug ?? slug;
  }

  async ensurePersonAttribute(
    key: string,
    title: string,
    type: string = 'text'
  ): Promise<string> {
    const slug = this.toSlug(key);
    const existing = await this.getAllPeopleAttributes();

    const found = existing.find(a => this.toSlug(a.api_slug) === slug);
    if (found) return found.api_slug;

    const res = await axiosInstance.post(
      `${this.baseUrl}/objects/people/attributes`,
      {
        data: {
          title,
          description: null,
          api_slug: slug,
          type,
          is_required: false,
          is_unique: false,
          is_multiselect: false,
          config: {},
        },
      },
      { headers: this.headers() }
    );
    return (res.data as any)?.data?.api_slug ?? slug;
  }

  async findListEntry(
    listId: string,
    recordId: string,
    objectSlug: 'people' | 'companies' = 'people'
  ): Promise<string | null> {
    const ids = await this.findListEntries(listId, recordId, objectSlug);
    return ids[0] ?? null;
  }

  /**
   * Every entry id this record has in `listId`. Attio allows several entries
   * for the same parent record in one list (ENG-2632), and the record-entries
   * endpoint pages at 100 by default, so walk all pages.
   */
  async findListEntries(
    listId: string,
    recordId: string,
    objectSlug: 'people' | 'companies' = 'people'
  ): Promise<string[]> {
    const PAGE = 500;
    const MAX_PAGES = 20;
    const ids: string[] = [];
    for (let page = 0, offset = 0; page < MAX_PAGES; page++, offset += PAGE) {
      const res = await axiosInstance.get(
        `${this.baseUrl}/objects/${objectSlug}/records/${recordId}/entries`,
        { headers: this.headers(), params: { limit: PAGE, offset } }
      );
      const entries: any[] = (res.data as any)?.data ?? [];
      for (const e of entries) {
        if (e?.id?.list_id === listId || e?.list_id === listId || e?.parent_list?.id === listId) {
          const id = e?.id?.entry_id ?? e?.entry_id;
          if (id && !ids.includes(id)) ids.push(id);
        }
      }
      if (entries.length < PAGE) break;
    }
    return ids;
  }

  /**
   * Idempotent add: `PUT /lists/{list}/entries` upserts by parent record, so
   * repeating it never creates a duplicate entry (POST does — ENG-2632).
   * Attio returns MULTIPLE_MATCH_RESULTS when duplicates already exist; in
   * that case the record is already on the list, so return its first entry.
   */
  async upsertListEntry(
    listId: string,
    recordId: string,
    objectSlug: 'people' | 'companies'
  ): Promise<string | undefined> {
    try {
      const res = await axiosInstance.put(
        `${this.baseUrl}/lists/${listId}/entries`,
        { data: { parent_record_id: recordId, parent_object: objectSlug, entry_values: {} } },
        { headers: this.headers() }
      );
      return (res.data as any)?.data?.id?.entry_id;
    } catch (err: any) {
      const code = err?.response?.data?.code;
      if (code === 'MULTIPLE_MATCH_RESULTS' || /multiple/i.test(err?.response?.data?.message ?? '')) {
        const existing = await this.findListEntries(listId, recordId, objectSlug);
        if (existing.length) return existing[0];
      }
      throw err;
    }
  }

  async updateListEntry(
    listId: string,
    entryId: string,
    entryValues: Record<string, any[]>
  ): Promise<void> {
    await axiosInstance.patch(
      `${this.baseUrl}/lists/${listId}/entries/${entryId}`,
      { data: { entry_values: entryValues } },
      { headers: this.headers() }
    );
  }

  async deleteListEntry(listId: string, entryId: string): Promise<void> {
    await axiosInstance.delete(
      `${this.baseUrl}/lists/${listId}/entries/${entryId}`,
      { headers: this.headers() }
    );
  }

  // No deleteList() — live-verified against Attio's REST API (ENG-1380):
  // there is no delete-list endpoint at all (List/Create/Get/Update exist,
  // Delete doesn't), and update-a-list's fields have no archive/is_archived
  // option either. Deleting a list is only possible through Attio's own UI.

  async addCompanyToList(listId: string, recordId: string): Promise<string | undefined> {
    const res = await axiosInstance.post(
      `${this.baseUrl}/lists/${listId}/entries`,
      {
        data: {
          parent_record_id: recordId,
          parent_object: 'companies',
          entry_values: {},
        },
      },
      { headers: this.headers() }
    );
    return (res.data as any)?.data?.id?.entry_id;
  }

  // ─── Webhooks ──────────────────────────────────────────────────────────────
  // Attio's webhook model is per-workspace (register against this token, not
  // an app-wide subscription list like HubSpot's) — confirmed against
  // docs.attio.com. One create call carries every event type we want in a
  // single `subscriptions` array; the returned `secret` is shown exactly
  // once and must be persisted by the caller immediately.

  /**
   * Registers a webhook subscription for this workspace covering Person/
   * Company record changes and Deal-analog (List Entry) changes — the same
   * event scope HubSpot's webhook already covers for contacts + deals.
   */
  async registerWebhook(targetUrl: string): Promise<{ webhookId: string; secret: string }> {
    const res = await axiosInstance.post(
      `${this.baseUrl}/webhooks`,
      {
        data: {
          target_url: targetUrl,
          subscriptions: [
            { event_type: 'record.created', filter: null },
            { event_type: 'record.updated', filter: null },
            { event_type: 'record.deleted', filter: null },
            { event_type: 'list-entry.created', filter: null },
            { event_type: 'list-entry.updated', filter: null },
            { event_type: 'list-entry.deleted', filter: null },
          ],
        },
      },
      { headers: this.headers() }
    );
    const data = (res.data as any)?.data;
    return { webhookId: data?.id?.webhook_id, secret: data?.secret };
  }

  // ─── Sync helpers (used by AttioAdapter) ──────────────────────────────────

  async verifyList(listId: string): Promise<void> {
    await axiosInstance.get(`${this.baseUrl}/lists/${listId}`, { headers: this.headers() });
  }

  async loadAttributeTypes(
    objectSlug: string,
    listId?: string
  ): Promise<Map<string, string>> {
    const cache = new Map<string, string>();
    try {
      const objRes = await axiosInstance.get(`${this.baseUrl}/objects/${objectSlug}/attributes`, { headers: this.headers() });
      for (const attr of (objRes.data as any).data || []) {
        cache.set(`object:${objectSlug}:${attr.api_slug}`, attr.type);
      }
    } catch { /* non-fatal */ }
    if (listId) {
      try {
        const listRes = await axiosInstance.get(`${this.baseUrl}/lists/${listId}/attributes`, { headers: this.headers() });
        for (const attr of (listRes.data as any).data || []) {
          cache.set(`list:${listId}:${attr.api_slug}`, attr.type);
        }
      } catch { /* non-fatal */ }
    }
    console.log(`[AttioService] Loaded ${cache.size} attribute types for ${objectSlug} (list: ${listId})`);
    return cache;
  }

  async upsertPersonByValues(
    values: Record<string, any>
  ): Promise<{ recordId: string; isNew: boolean }> {
    const res = await axiosInstance.put(
      `${this.baseUrl}/objects/people/records?matching_attribute=email_addresses`,
      { data: { values } },
      { headers: this.headers() }
    );
    const recordId = (res.data as any).data?.id?.record_id;
    const emailAddress = values.email_addresses?.[0]?.email_address ?? '<unknown>';
    if (!recordId) {
      throw new Error(`Attio upsert returned no record ID for email: ${emailAddress}`);
    }
    return {
      recordId,
      isNew: res.status === 201,
    };
  }

  async createPersonByValues(values: Record<string, any>): Promise<string> {
    const res = await axiosInstance.post(
      `${this.baseUrl}/objects/people/records`,
      { data: { values } },
      { headers: this.headers() }
    );
    return (res.data as any).data?.id?.record_id;
  }

  async updatePersonByValues(recordId: string, values: Record<string, any>): Promise<void> {
    await this.updateRecord('people', recordId, values);
  }

  async getPersonValues(recordId: string): Promise<Record<string, any>> {
    return this.getRecordValues('people', recordId);
  }

  async getCompanyValues(recordId: string): Promise<Record<string, any>> {
    return this.getRecordValues('companies', recordId);
  }



  // ─── Generic Records ──────────────────────────────────────────────────────

  async createRecord(objectSlug: string, values: Record<string, any>): Promise<string> {
    const res = await axiosInstance.post(
      `${this.baseUrl}/objects/${objectSlug}/records`,
      { data: { values } },
      { headers: this.headers() }
    );
    return (res.data as any).data?.id?.record_id;
  }

  async updateRecord(objectSlug: string, recordId: string, values: Record<string, any>): Promise<void> {
    await axiosInstance.patch(
      `${this.baseUrl}/objects/${objectSlug}/records/${recordId}`,
      { data: { values } },
      { headers: this.headers() }
    );
  }

  async getRecordValues(objectSlug: string, recordId: string): Promise<Record<string, any>> {
    const res = await axiosInstance.get(
      `${this.baseUrl}/objects/${objectSlug}/records/${recordId}`,
      { headers: this.headers() }
    );
    return (res.data as any).data?.values ?? {};
  }

  async deleteRecord(objectSlug: string, recordId: string): Promise<void> {
    await axiosInstance.delete(
      `${this.baseUrl}/objects/${objectSlug}/records/${recordId}`,
      { headers: this.headers() }
    );
  }

  async queryRecords(
    objectSlug: string,
    filter: Record<string, any>,
    limit: number = 50
  ): Promise<any[]> {
    const res = await axiosInstance.post(
      `${this.baseUrl}/objects/${objectSlug}/records/query`,
      { filter, limit },
      { headers: this.headers() }
    );
    return (res.data as any).data ?? [];
  }



  async getAllObjectAttributes(objectSlug: string): Promise<Array<{ api_slug: string; title: string; type: string; is_system_attribute: boolean; attribute_id: string }>> {
    const res = await axiosInstance.get(
      `${this.baseUrl}/objects/${objectSlug}/attributes`,
      { headers: this.headers() }
    );
    return ((res.data as any)?.data ?? []).map((a: any) => ({
      api_slug: a.api_slug as string,
      title: a.title as string,
      type: a.type as string,
      is_system_attribute: !!a.is_system_attribute,
      attribute_id: a.id?.attribute_id as string,
    }));
  }

  async ensureObjectAttribute(
    objectSlug: string,
    key: string,
    title: string,
    type: string = 'text'
  ): Promise<string> {
    const slug = this.toSlug(key);
    const existing = await this.getAllObjectAttributes(objectSlug);

    const found = existing.find(a => this.toSlug(a.api_slug) === slug);
    if (found) return found.api_slug;

    const res = await axiosInstance.post(
      `${this.baseUrl}/objects/${objectSlug}/attributes`,
      {
        data: {
          title,
          description: null,
          api_slug: slug,
          type,
          is_required: false,
          is_unique: false,
          is_multiselect: false,
          config: {},
        },
      },
      { headers: this.headers() }
    );
    return (res.data as any)?.data?.api_slug ?? slug;
  }

  // ─── Attribute Statuses ───────────────────────────────────────────────────

  async listAttributeStatuses(objectSlug: string, attributeSlug: string): Promise<Array<{ id: string; title: string }>> {
    const res = await axiosInstance.get(
      `${this.baseUrl}/objects/${objectSlug}/attributes/${attributeSlug}/statuses`,
      { headers: this.headers() }
    );
    return ((res.data as any)?.data ?? []).map((s: any) => ({
      id: s.id?.status_id ?? s.id,
      title: s.title as string,
    }));
  }

  async ensureStatusOption(objectSlug: string, attributeSlug: string, title: string): Promise<string> {
    const existing = await this.listAttributeStatuses(objectSlug, attributeSlug);
    const titleLower = title.trim().toLowerCase();
    const found = existing.find(s => s.title.toLowerCase() === titleLower);
    if (found) return found.title;

    // Create the status if it doesn't exist
    const res = await axiosInstance.post(
      `${this.baseUrl}/objects/${objectSlug}/attributes/${attributeSlug}/statuses`,
      {
        data: {
          title: title.trim(),
          celebration_enabled: false,
        },
      },
      { headers: this.headers() }
    );
    return (res.data as any)?.data?.title ?? title.trim();
  }

  // ─── List entries ─────────────────────────────────────────────────────────

  // POST /lists/{list}/entries/query also uses limit/offset pagination, not
  // cursor — same contract as listPeople above (confirmed via Attio's
  // pagination docs); no next_cursor in the response, end-of-results
  // inferred from a short/empty page.
  async listListEntries(
    listId: string,
    offset: number = 0
  ): Promise<{ entries: any[]; nextOffset?: number }> {
    const limit = 50;
    const res = await axiosInstance.post(
      `${this.baseUrl}/lists/${listId}/entries/query`,
      { limit, offset },
      { headers: this.headers() }
    );
    const entries = (res.data as any).data ?? [];
    return {
      entries,
      nextOffset: entries.length === limit ? offset + limit : undefined,
    };
  }

  /**
   * Total entry count for a list. Attio's list-entries endpoint doesn't return
   * a total in its response envelope, so this pages through with
   * listListEntries and sums — same page-and-sum shape as
   * businessFunnelService.fetchLeadCount for AgentWeb's own lead lists.
   * Bounded at MAX_COUNT_PAGES (50 entries/page, so 10,000 entries tallied
   * exactly) so an enormous or pathological list can't turn a single Emma
   * CPL-reporting call into an unbounded API-call fan-out — `capped: true`
   * tells the caller the real total may be higher than `count`.
   */
  async countListEntries(listId: string): Promise<{ count: number; capped: boolean }> {
    const MAX_COUNT_PAGES = 200;
    let total = 0;
    let offset: number | undefined = 0;
    let pages = 0;
    let capped = false;
    do {
      const { entries, nextOffset } = await this.listListEntries(listId, offset);
      total += entries.length;
      offset = nextOffset;
      pages++;
      if (offset !== undefined && pages >= MAX_COUNT_PAGES) {
        capped = true;
        break;
      }
    } while (offset !== undefined);
    return { count: total, capped };
  }

  /**
   * Same page of list entries as listListEntries, reshaped into a typed,
   * caller-friendly form (entryId, personRecordId, values) instead of the
   * raw Attio response shape — keeps adapters from touching raw API shapes
   * directly. Entries missing either id are dropped (defensive — matches
   * findListEntry's null-safety style; shouldn't happen in practice).
   */
  async listListEntriesDetailed(
    listId: string,
    offset: number = 0
  ): Promise<{ entries: AttioListEntry[]; nextOffset?: number }> {
    const { entries, nextOffset } = await this.listListEntries(listId, offset);
    const detailed = entries
      .map((e: any) => ({
        entryId: e?.id?.entry_id as string | undefined,
        personRecordId: e?.parent_record_id as string | undefined,
        values: (e?.entry_values ?? {}) as Record<string, any>,
      }))
      .filter((e): e is AttioListEntry => !!e.entryId && !!e.personRecordId);
    return { entries: detailed, nextOffset };
  }

  /**
   * Fetches one list entry directly by id (GET /v2/lists/{list}/entries/{entry_id})
   * instead of paginating through listListEntriesDetailed to find it — the
   * targeted read a webhook handler needs when it only has an entryId from
   * the event payload. Requesting it scoped to `listId` doubles as a
   * membership check: a 404 means the entry isn't in that list (wrong list,
   * or already deleted), which the caller treats as "not found", not an error.
   */
  async getListEntry(listId: string, entryId: string): Promise<AttioListEntry | null> {
    try {
      const res = await axiosInstance.get(
        `${this.baseUrl}/lists/${listId}/entries/${entryId}`,
        { headers: this.headers() }
      );
      const e = (res.data as any)?.data;
      const reshaped: AttioListEntry = {
        entryId: e?.id?.entry_id,
        personRecordId: e?.parent_record_id,
        values: e?.entry_values ?? {},
      };
      if (!reshaped.entryId || !reshaped.personRecordId) return null;
      return reshaped;
    } catch (err: any) {
      if (err?.response?.status === 404) return null;
      throw err;
    }
  }
}
