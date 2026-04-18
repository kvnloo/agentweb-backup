import axios from 'axios';
import { getAccountsByUserId, getAccountById } from './connectedAccountsDb';

// Module-level axios instance with a 15-second timeout for all Attio API calls.
// Falls back to the base axios object when axios.create returns falsy (e.g., in jest auto-mock).
const _created = axios.create?.({ timeout: 15000 });
const axiosInstance: typeof axios = (_created ?? axios) as typeof axios;

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

  async listPeople(cursor?: string): Promise<{ people: AttioPerson[]; nextCursor?: string }> {
    const body: any = { limit: 50 };
    if (cursor) body.cursor = cursor;

    const res = await axiosInstance.post(
      `${this.baseUrl}/objects/people/records/query`,
      body,
      { headers: this.headers() }
    );

    return {
      people: ((res.data as any)?.data ?? []).map((r: any) => this.mapPerson(r)),
      nextCursor: (res.data as any)?.next_cursor,
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

  async listCompanies(cursor?: string): Promise<{ companies: AttioCompany[]; nextCursor?: string }> {
    const body: any = { limit: 50 };
    if (cursor) body.cursor = cursor;

    const res = await axiosInstance.post(
      `${this.baseUrl}/objects/companies/records/query`,
      body,
      { headers: this.headers() }
    );

    return {
      companies: ((res.data as any)?.data ?? []).map((r: any) => this.mapCompany(r)),
      nextCursor: (res.data as any)?.next_cursor,
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

  async getAllLists(): Promise<Array<{ id: string; name: string }>> {
    const res = await axiosInstance.get(`${this.baseUrl}/lists`, { headers: this.headers() });
    return ((res.data as any)?.data ?? []).map((l: any) => ({
      id: l.id?.list_id as string,
      name: l.name as string,
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
  ): Promise<void> {
    await axiosInstance.post(
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

    const res = await axios.post(
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
    personRecordId: string
  ): Promise<string | null> {
    const res = await axiosInstance.get(
      `${this.baseUrl}/objects/people/records/${personRecordId}/entries`,
      { headers: this.headers() }
    );
    const entries = (res.data as any)?.data ?? [];

    const match = entries.find((e: any) =>
      e?.id?.list_id === listId || e?.list_id === listId || e?.parent_list?.id === listId
    );
    return match?.id?.entry_id ?? match?.entry_id ?? null;
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

  async addCompanyToList(listId: string, recordId: string): Promise<void> {
    await axiosInstance.post(
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



  // ─── Generic Records ──────────────────────────────────────────────────────

  async createRecord(objectSlug: string, values: Record<string, any>): Promise<string> {
    const res = await axios.post(
      `${this.baseUrl}/objects/${objectSlug}/records`,
      { data: { values } },
      { headers: this.headers() }
    );
    return (res.data as any).data?.id?.record_id;
  }

  async updateRecord(objectSlug: string, recordId: string, values: Record<string, any>): Promise<void> {
    await axios.patch(
      `${this.baseUrl}/objects/${objectSlug}/records/${recordId}`,
      { data: { values } },
      { headers: this.headers() }
    );
  }

  async getRecordValues(objectSlug: string, recordId: string): Promise<Record<string, any>> {
    const res = await axios.get(
      `${this.baseUrl}/objects/${objectSlug}/records/${recordId}`,
      { headers: this.headers() }
    );
    return (res.data as any).data?.values ?? {};
  }

  async deleteRecord(objectSlug: string, recordId: string): Promise<void> {
    await axios.delete(
      `${this.baseUrl}/objects/${objectSlug}/records/${recordId}`,
      { headers: this.headers() }
    );
  }

  async queryRecords(
    objectSlug: string,
    filter: Record<string, any>,
    limit: number = 50
  ): Promise<any[]> {
    const res = await axios.post(
      `${this.baseUrl}/objects/${objectSlug}/records/query`,
      { filter, limit },
      { headers: this.headers() }
    );
    return (res.data as any).data ?? [];
  }



  async getAllObjectAttributes(objectSlug: string): Promise<Array<{ api_slug: string; title: string; type: string; is_system_attribute: boolean; attribute_id: string }>> {
    const res = await axios.get(
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

    const res = await axios.post(
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
    const res = await axios.get(
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
    const res = await axios.post(
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

  async listListEntries(
    listId: string,
    cursor?: string
  ): Promise<{ entries: any[]; nextCursor?: string }> {
    const body: any = { limit: 50 };
    if (cursor) body.cursor = cursor;
    const res = await axiosInstance.post(
      `${this.baseUrl}/lists/${listId}/entries/query`,
      body,
      { headers: this.headers() }
    );
    return {
      entries: (res.data as any).data ?? [],
      nextCursor: (res.data as any).next_cursor,
    };
  }
}
