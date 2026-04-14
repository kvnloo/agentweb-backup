import axios from 'axios';
import { getAccountsByUserId, getAccountById, updateAccountConfig } from './connectedAccountsDb';

const ATTIO_API_BASE = 'https://api.attio.com/v2';

// ─────────────────────────────────────────────────────────────────────────────
// ATTIO WEBHOOK EVENTS
//
// Webhooks are registered PER USER via POST /v2/webhooks using their access
// token. Call registerWebhook() when a user connects Attio. The returned
// webhook_id is stored in their account config so it can be deleted on disconnect.
//
// Events we subscribe to:
//
//   record.created  — a new People or Companies record was created in Attio
//                     → pull into our lead list (create lead if email not found)
//
//   record.updated  — a field changed on a People or Companies record
//                     (e.g. email, phone, job_title, company link)
//                     → find matching lead by email and update fields
//
//   record.deleted  — a People or Companies record was permanently deleted
//                     → mark lead as removed / flag for review
//
// Events we intentionally skip:
//   attribute.created   — workspace schema change, not contact data
//   list.entry.created  — list membership change, not contact data
//   comment.created     — user comments, not relevant for sync
// ─────────────────────────────────────────────────────────────────────────────

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

export interface AttioWebhook {
  webhookId: string;
  targetUrl: string;
  subscriptions: string[];
}

export class AttioService {
  private readonly baseUrl = ATTIO_API_BASE;

  // ─── Private helpers ──────────────────────────────────────────────────────

  private headers(accessToken: string) {
    return {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    };
  }

  private async resolveAttioAccount(userId: string, accountId?: string) {
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

  async getValidAccessToken(userId: string, accountId?: string): Promise<string> {
    const account = await this.resolveAttioAccount(userId, accountId);
    return (account.config as any).access_token;
  }

  // kept as private alias for internal callers
  private async getAccessToken(userId: string, accountId?: string): Promise<string> {
    return this.getValidAccessToken(userId, accountId);
  }

  async testConnection(userId: string, accountId?: string): Promise<{ valid: boolean; error?: string }> {
    try {
      const token = await this.getValidAccessToken(userId, accountId);
      await axios.get(`${ATTIO_API_BASE}/objects`, {
        headers: this.headers(token),
      });
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

  async listPeople(
    userId: string,
    accountId?: string,
    cursor?: string
  ): Promise<{ people: AttioPerson[]; nextCursor?: string }> {
    const token = await this.getAccessToken(userId, accountId);
    const body: any = { limit: 50 };
    if (cursor) body.cursor = cursor;

    const res = await axios.post(
      `${this.baseUrl}/objects/people/records/query`,
      body,
      { headers: this.headers(token) }
    );

    return {
      people: ((res.data as any)?.data ?? []).map((r: any) => this.mapPerson(r)),
      nextCursor: (res.data as any)?.next_cursor,
    };
  }

  async findPersonByEmail(
    userId: string,
    email: string,
    accountId?: string
  ): Promise<AttioPerson | null> {
    const token = await this.getAccessToken(userId, accountId);

    // Use the query endpoint with an exact email filter instead of fuzzy search.
    const res = await axios.post(
      `${this.baseUrl}/objects/people/records/query`,
      {
        filter: {
          email_addresses: { email_address: { $eq: email.toLowerCase() } },
        },
        limit: 1,
      },
      { headers: this.headers(token) }
    );

    const records = (res.data as any)?.data ?? [];
    if (records.length === 0) return null;
    return this.mapPerson(records[0]);
  }

  // Upsert a person by email using Attio's PUT endpoint.
  // Creates the record if no match found; updates if email already exists.
  async upsertPerson(
    userId: string,
    data: Omit<AttioPerson, 'recordId'> & { email: string },
    accountId?: string
  ): Promise<AttioPerson> {
    const token = await this.getAccessToken(userId, accountId);
    const values: any = {};

    const firstName = data.firstName?.trim();
    const lastName = data.lastName?.trim();
    if (firstName || lastName) {
      const nameEntry: any = {};
      if (firstName) nameEntry.first_name = firstName;
      if (lastName) nameEntry.last_name = lastName;
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

    const res = await axios.put(
      `${this.baseUrl}/objects/people/records?matching_attribute=email_addresses`,
      {
        data: {
          values,
        },
      },
      { headers: this.headers(token) }
    );

    return this.mapPerson((res.data as any)?.data);
  }

  async createPerson(
    userId: string,
    data: Omit<AttioPerson, 'recordId'>,
    accountId?: string
  ): Promise<AttioPerson> {
    const token = await this.getAccessToken(userId, accountId);
    const values: any = {};

    const firstName = data.firstName?.trim();
    const lastName = data.lastName?.trim();
    if (firstName || lastName) {
      const nameEntry: any = {};
      if (firstName) nameEntry.first_name = firstName;
      if (lastName) nameEntry.last_name = lastName;
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

    const res = await axios.post(
      `${this.baseUrl}/objects/people/records`,
      { data: { values } },
      { headers: this.headers(token) }
    );

    return this.mapPerson((res.data as any)?.data);
  }

  async updatePerson(
    userId: string,
    recordId: string,
    data: Partial<Omit<AttioPerson, 'recordId'>>,
    accountId?: string
  ): Promise<AttioPerson> {
    const token = await this.getAccessToken(userId, accountId);
    const values: any = {};

    const firstName = data.firstName?.trim();
    const lastName = data.lastName?.trim();
    if (firstName || lastName) {
      const nameEntry: any = {};
      if (firstName) nameEntry.first_name = firstName;
      if (lastName) nameEntry.last_name = lastName;
      values.name = [nameEntry];
    }
    if (data.email !== undefined) {
      values.email_addresses = [{ email_address: data.email.toLowerCase() }];
    }
    if (data.phone !== undefined) {
      values.phone_numbers = [{ original_phone_number: data.phone }];
    }
    if (data.jobTitle !== undefined) {
      values.job_title = [{ value: data.jobTitle }];
    }
    if (data.linkedinUrl !== undefined) {
      values.linkedin = [{ value: data.linkedinUrl }];
    }
    if (data.companyId !== undefined) {
      values.company = [{ target_object: 'companies', target_record_id: data.companyId }];
    }

    const res = await axios.patch(
      `${this.baseUrl}/objects/people/records/${recordId}`,
      { data: { values } },
      { headers: this.headers(token) }
    );

    return this.mapPerson((res.data as any)?.data);
  }

  async deletePerson(userId: string, recordId: string, accountId?: string): Promise<void> {
    const token = await this.getAccessToken(userId, accountId);
    await axios.delete(
      `${this.baseUrl}/objects/people/records/${recordId}`,
      { headers: this.headers(token) }
    );
  }

  // ─── Companies ────────────────────────────────────────────────────────────

  async listCompanies(
    userId: string,
    accountId?: string,
    cursor?: string
  ): Promise<{ companies: AttioCompany[]; nextCursor?: string }> {
    const token = await this.getAccessToken(userId, accountId);
    const body: any = { limit: 50 };
    if (cursor) body.cursor = cursor;

    const res = await axios.post(
      `${this.baseUrl}/objects/companies/records/query`,
      body,
      { headers: this.headers(token) }
    );

    return {
      companies: ((res.data as any)?.data ?? []).map((r: any) => this.mapCompany(r)),
      nextCursor: (res.data as any)?.next_cursor,
    };
  }

  async findCompanyByName(
    userId: string,
    name: string,
    accountId?: string
  ): Promise<AttioCompany | null> {
    const token = await this.getAccessToken(userId, accountId);

    const res = await axios.post(
      `${this.baseUrl}/objects/companies/records/query`,
      { filter: { name: { $contains: name } }, limit: 1 },
      { headers: this.headers(token) }
    );

    const records = (res.data as any)?.data ?? [];
    return records.length > 0 ? this.mapCompany(records[0]) : null;
  }

  async createCompany(userId: string, name: string, accountId?: string): Promise<AttioCompany> {
    const token = await this.getAccessToken(userId, accountId);

    const res = await axios.post(
      `${this.baseUrl}/objects/companies/records`,
      { data: { values: { name: [{ value: name }] } } },
      { headers: this.headers(token) }
    );

    return this.mapCompany((res.data as any)?.data);
  }

  // ─── Lists ────────────────────────────────────────────────────────────────
  // Attio Lists are named collections of People or Company records.
  // Use the /v2/lists endpoint. Lists are scoped per object type (people/companies).

  async findListByName(userId: string, name: string, accountId?: string): Promise<string | null> {
    const token = await this.getAccessToken(userId, accountId);
    const res = await axios.get(`${this.baseUrl}/lists`, { headers: this.headers(token) });
    const lists = (res.data as any)?.data ?? [];
    const match = lists.find((l: any) => l.name === name);
    // list_id is nested: id.list_id
    return match ? match.id?.list_id : null;
  }

  async createList(userId: string, name: string, objectSlug: 'people' | 'companies', accountId?: string): Promise<string> {
    const token = await this.getAccessToken(userId, accountId);

    // api_slug must be snake_case, max ~50 chars
    // We append a random hash to prevent 409 slug_conflict with trashed/deleted lists
    const baseSlug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '')
      .slice(0, 40);
    const apiSlug = `${baseSlug}_${Math.floor(Math.random() * 100000)}`;

    const res = await axios.post(
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
      { headers: this.headers(token) }
    );

    return (res.data as any)?.data?.id?.list_id;
  }

  // Find or create a list by name for a given object type, returns Attio list ID
  async findOrCreateList(userId: string, name: string, objectSlug: 'people' | 'companies', accountId?: string): Promise<string> {
    const existing = await this.findListByName(userId, name, accountId);
    if (existing) return existing;
    return this.createList(userId, name, objectSlug, accountId);
  }

  async addPersonToList(
    userId: string,
    listId: string,
    recordId: string,
    accountId?: string,
    entryValues?: Record<string, any[]>
  ): Promise<void> {
    const token = await this.getAccessToken(userId, accountId);
    await axios.post(
      `${this.baseUrl}/lists/${listId}/entries`,
      {
        data: {
          parent_record_id: recordId,
          parent_object: 'people',
          entry_values: entryValues ?? {},
        },
      },
      { headers: this.headers(token) }
    );
  }

  // ─── List entry attributes ────────────────────────────────────────────────
  // List entry attributes are scoped to a specific list (not global to the object).
  // Used to sync custom fields from our lead records without polluting the global
  // people object with attributes from every list.

  async listListAttributes(userId: string, attioListId: string, accountId?: string): Promise<any[]> {
    const token = await this.getAccessToken(userId, accountId);
    const res = await axios.get(
      `${this.baseUrl}/lists/${attioListId}/attributes`,
      { headers: this.headers(token) }
    );
    return (res.data as any)?.data ?? [];
  }

  // Converts any key (camelCase, spaces, etc.) to snake_case slug
  private toSlug(key: string): string {
    return key
      .replace(/([a-z])([A-Z])/g, '$1_$2')   // camelCase → camel_case
      .replace(/[\s\-]+/g, '_')               // spaces/hyphens → _
      .replace(/[^a-z0-9_]/gi, '')            // strip other chars
      .toLowerCase()
      .replace(/^_+|_+$/g, '')               // trim leading/trailing _
      .slice(0, 50);
  }

  // Find or create a list entry attribute. Returns the api_slug.
  async ensureListAttribute(
    userId: string,
    attioListId: string,
    key: string,
    title: string,
    accountId?: string
  ): Promise<string> {
    const slug = this.toSlug(key);
    const existing = await this.listListAttributes(userId, attioListId, accountId);
    const found = existing.find((a: any) => a.api_slug === slug);
    if (found) return slug;

    const token = await this.getAccessToken(userId, accountId);
    await axios.post(
      `${this.baseUrl}/lists/${attioListId}/attributes`,
      {
        data: {
          title,
          description: null,
          api_slug: slug,
          type: 'text',
          is_required: false,
          is_unique: false,
          is_multiselect: false,
          config: {},
        },
      },
      { headers: this.headers(token) }
    );
    return slug;
  }

  async findListEntry(
    userId: string,
    listId: string,
    personRecordId: string,
    accountId?: string
  ): Promise<string | null> {
    const token = await this.getAccessToken(userId, accountId);
    // Attio's List Entries /query endpoint filters by list attributes, not parent records.
    // To find an entry for a specific record, query the record's entries directly.
    const res = await axios.get(
      `${this.baseUrl}/objects/people/records/${personRecordId}/entries`,
      { headers: this.headers(token) }
    );
    const entries = (res.data as any)?.data ?? [];

    if (entries.length > 0) {
      console.log("[DEBUG] Sample List Entry:", JSON.stringify(entries[0], null, 2));
    }

    // entries contains all list entries for this person. Filter by the listId we want.
    const match = entries.find((e: any) =>
      e?.id?.list_id === listId || e?.list_id === listId || e?.parent_list?.id === listId
    );
    return match?.id?.entry_id ?? match?.entry_id ?? null;
  }

  // Update the entry_values on an existing list entry.
  async updateListEntry(
    userId: string,
    listId: string,
    entryId: string,
    entryValues: Record<string, any[]>,
    accountId?: string
  ): Promise<void> {
    const token = await this.getAccessToken(userId, accountId);
    await axios.patch(
      `${this.baseUrl}/lists/${listId}/entries/${entryId}`,
      { data: { entry_values: entryValues } },
      { headers: this.headers(token) }
    );
  }

  async addCompanyToList(userId: string, listId: string, recordId: string, accountId?: string): Promise<void> {
    const token = await this.getAccessToken(userId, accountId);
    await axios.post(
      `${this.baseUrl}/lists/${listId}/entries`,
      {
        data: {
          parent_record_id: recordId,
          parent_object: 'companies',
          entry_values: {},
        },
      },
      { headers: this.headers(token) }
    );
  }

  // ─── Webhooks ─────────────────────────────────────────────────────────────

  async registerWebhook(userId: string, accountId?: string): Promise<AttioWebhook> {
    const token = await this.getAccessToken(userId, accountId);
    const account = await this.resolveAttioAccount(userId, accountId);
    const targetUrl = `${process.env.BACKEND_URL}/api/webhooks/attio`;
    const subscriptions = ['record.created', 'record.updated', 'record.deleted'];

    const res = await axios.post(
      `${this.baseUrl}/webhooks`,
      { data: { target_url: targetUrl, subscriptions } },
      { headers: this.headers(token) }
    );

    const webhookId = (res.data as any)?.data?.id?.webhook_id ?? (res.data as any)?.data?.id;

    // Store webhook_id so we can delete it when the user disconnects
    await updateAccountConfig(userId, 'attio', account.account_id, { webhook_id: webhookId });

    return { webhookId, targetUrl, subscriptions };
  }

  async deleteWebhook(userId: string, webhookId: string, accountId?: string): Promise<void> {
    const token = await this.getAccessToken(userId, accountId);
    await axios.delete(
      `${this.baseUrl}/webhooks/${webhookId}`,
      { headers: this.headers(token) }
    );
  }

  async listWebhooks(userId: string, accountId?: string): Promise<AttioWebhook[]> {
    const token = await this.getAccessToken(userId, accountId);
    const res = await axios.get(`${this.baseUrl}/webhooks`, { headers: this.headers(token) });

    return ((res.data as any)?.data ?? []).map((w: any) => ({
      webhookId: w.id?.webhook_id ?? w.id,
      targetUrl: w.target_url,
      subscriptions: w.subscriptions ?? [],
    }));
  }
}

export const attioService = new AttioService();
