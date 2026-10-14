/**
 * ENG-2171, end to end against a STATEFUL FAKE HubSpot.
 *
 * The real HubSpotService and the real HubspotAdapter run unchanged; only the HTTP
 * transport (axios adapter) is replaced by an in-memory HubSpot (unique emails, ids,
 * batch upsert/update, 207s). That exercises what the mock-the-service tests cannot:
 * the actual request bodies, the real 207 -> throw translation, the real 429 retry
 * interceptor, and multi-push state (does the second push create a second contact?).
 *
 * WHAT THIS DOES NOT PROVE: how the REAL HubSpot answers a missing id, an archived id,
 * a merged id or an email collision. HubSpot's docs are silent on all of these, so the
 * fake's answers for them are explicit per-test GUESSES (see `FakeOpts`). A pass here
 * means "the code behaves correctly if HubSpot answers like this", nothing more. ENG-2464
 * is the live check.
 *
 * The fake is also MORE FORGIVING than HubSpot in ways that matter: it is strongly
 * consistent (an upsert is visible to the very next search, so the read-after-write hazard
 * the adapter's adopt-instead-of-upsert logic avoids cannot occur here), it does not
 * reject unknown properties, and a 404/409 batch/update applies none of the inputs while a
 * 207 applies the valid ones (HubSpot's real atomicity is undocumented).
 */

jest.mock('../services/db', () => ({
  crmDb: {
    updateLead: jest.fn(),
    getLeadListById: jest.fn().mockResolvedValue({ listId: 'list_1', name: 'Q1 Outbound' }),
  },
}));

/* eslint-disable @typescript-eslint/no-var-requires */
const axios = require('axios');

interface FakeOpts {
  missingIdMode: '404' | '400' | '207';   // GUESS: what batch/update returns for an unknown id
  collisionMode: '409' | '207';           // GUESS: what an email owned by another contact returns
  throttleBatchUpdate: number;            // number of 429s to answer before behaving
}
interface Contact { id: string; properties: Record<string, string> }

const hs = {
  contacts: new Map<string, Contact>(),
  properties: new Set<string>(),
  nextId: 1000,
  calls: [] as Array<{ method: string; path: string; body: any }>,
  opts: { missingIdMode: '404', collisionMode: '409', throttleBatchUpdate: 0 } as FakeOpts,
  reset(opts: Partial<FakeOpts> = {}) {
    this.contacts = new Map();
    this.properties = new Set();
    this.nextId = 1000;
    this.calls = [];
    this.opts = { missingIdMode: '404', collisionMode: '409', throttleBatchUpdate: 0, ...opts };
  },
  byEmail(email: string) {
    const e = email.toLowerCase();
    return [...this.contacts.values()].find((c) => (c.properties.email || '').toLowerCase() === e);
  },
  seed(properties: Record<string, string>) {
    const id = String(this.nextId++);
    this.contacts.set(id, { id, properties: { ...properties } });
    return id;
  },
  count(method: string, path: RegExp) {
    return this.calls.filter((c) => c.method === method && path.test(c.path)).length;
  },
};

const record = (c: Contact, isNew?: boolean) => ({ id: c.id, properties: c.properties, ...(isNew === undefined ? {} : { new: isNew }) });

function respond(config: any, status: number, data: any, headers: Record<string, string> = {}) {
  const response = { status, statusText: String(status), data, headers, config, request: {} };
  if (status >= 200 && status < 300) return Promise.resolve(response);
  return Promise.reject(new axios.AxiosError(`HTTP ${status}`, 'ERR_BAD_RESPONSE', config, {}, response));
}

const conflict = (existingId: string) => ({
  status: 'error', category: 'CONFLICT', message: `Contact already exists. Existing ID: ${existingId}`,
});

let throttled = 0;
function fakeAdapter(config: any): Promise<any> {
  const path = String(config.url).replace('https://api.hubapi.com', '');
  const method = String(config.method).toUpperCase();
  const body = typeof config.data === 'string' && config.data ? JSON.parse(config.data) : config.data;
  hs.calls.push({ method, path, body });

  // ── contact property definitions (ensureContactProperty: GET, 404, then POST) ──
  const prop = path.match(/^\/crm\/v3\/properties\/contacts\/(\w+)$/);
  if (method === 'GET' && prop) {
    return hs.properties.has(prop[1])
      ? respond(config, 200, { name: prop[1] })
      : respond(config, 404, { status: 'error', category: 'OBJECT_NOT_FOUND', message: 'property not found' });
  }
  if (method === 'POST' && path === '/crm/v3/properties/contacts') {
    hs.properties.add(body.name);
    return respond(config, 201, { name: body.name });
  }
  // ── search by email ──
  if (method === 'POST' && path === '/crm/v3/objects/contacts/search') {
    const value = body?.filterGroups?.[0]?.filters?.[0]?.value;
    const hit = value ? hs.byEmail(value) : undefined;
    return respond(config, 200, { results: hit ? [record(hit)] : [] });
  }
  // ── create ──
  if (method === 'POST' && path === '/crm/v3/objects/contacts') {
    const email = body?.properties?.email;
    const clash = email ? hs.byEmail(email) : undefined;
    if (clash) return respond(config, 409, conflict(clash.id));
    return respond(config, 201, record({ id: hs.seed(body.properties), properties: body.properties }));
  }
  // ── single update ──
  const single = path.match(/^\/crm\/v3\/objects\/contacts\/(\d+)$/);
  if (method === 'PATCH' && single) {
    const c = hs.contacts.get(single[1]);
    if (!c) return respond(config, 404, { status: 'error', category: 'OBJECT_NOT_FOUND', message: 'not found' });
    const email = body?.properties?.email;
    const clash = email ? hs.byEmail(email) : undefined;
    if (clash && clash.id !== c.id) return respond(config, 409, conflict(clash.id));
    c.properties = { ...c.properties, ...body.properties };
    return respond(config, 200, record(c));
  }
  // ── batch upsert by email ──
  if (method === 'POST' && path === '/crm/v3/objects/contacts/batch/upsert') {
    const results = (body.inputs as any[]).map((i) => {
      const existing = hs.byEmail(i.id);
      if (existing) { existing.properties = { ...existing.properties, ...i.properties }; return record(existing, false); }
      const id = hs.seed({ ...i.properties, email: i.id });
      return record(hs.contacts.get(id)!, true);
    });
    return respond(config, 200, { status: 'COMPLETE', results });
  }
  // ── batch update by id ──
  if (method === 'POST' && path === '/crm/v3/objects/contacts/batch/update') {
    if (throttled < hs.opts.throttleBatchUpdate) {
      throttled++;
      return respond(config, 429, { status: 'error', errorType: 'RATE_LIMIT' }, { 'retry-after': '0' });
    }
    const inputs = body.inputs as Array<{ id: string; properties: Record<string, string> }>;
    const errors: any[] = [];
    const valid: Array<{ c: Contact; p: Record<string, string> }> = [];
    for (const i of inputs) {
      const c = hs.contacts.get(String(i.id));
      if (!c) {
        if (hs.opts.missingIdMode === '404') return respond(config, 404, { status: 'error', category: 'OBJECT_NOT_FOUND', message: `no contact ${i.id}` });
        if (hs.opts.missingIdMode === '400') return respond(config, 400, { status: 'error', category: 'VALIDATION_ERROR', message: `bad id ${i.id}` });
        errors.push({ status: 'error', category: 'OBJECT_NOT_FOUND', message: `no contact ${i.id}`, context: { ids: [i.id] } });
        continue;
      }
      const clash = i.properties.email ? hs.byEmail(i.properties.email) : undefined;
      if (clash && clash.id !== c.id) {
        if (hs.opts.collisionMode === '409') return respond(config, 409, conflict(clash.id));
        errors.push({ status: 'error', category: 'CONTACT_EXISTS', message: 'email in use', context: { ids: [i.id] } });
        continue;
      }
      valid.push({ c, p: i.properties });
    }
    for (const v of valid) v.c.properties = { ...v.c.properties, ...v.p };
    if (errors.length) {
      return respond(config, 207, { status: 'COMPLETE', results: valid.map((v) => record(v.c)), numErrors: errors.length, errors });
    }
    return respond(config, 200, { status: 'COMPLETE', results: valid.map((v) => record(v.c)) });
  }
  return respond(config, 500, { status: 'error', message: `fake HubSpot: unhandled ${method} ${path}` });
}

axios.defaults.adapter = fakeAdapter; // axios.create() in hubspotService inherits this at import time

const { HubspotAdapter } = require('../services/adapters/hubspotAdapter');
const { crmDb } = require('../services/db');

const auth = { type: 'token', apiKey: 'pat-fake' };
const mapping = (agentwebField: string, crmProperty: string) => ({ agentwebField, crmProperty, direction: 'both', enabled: true });
const config: any = {
  provider: 'hubspot', listId: 'list_1', userId: 'user_1', apiKeyEncrypted: 'enc', autoSyncEnabled: false,
  contactFieldMapping: [mapping('email', 'email'), mapping('firstName', 'firstname'), mapping('phone', 'phone')],
  dealFieldMapping: [], customFieldMapping: [],
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
};

// The "database": updateLead writes here and every push re-reads fresh copies, like production.
const db = new Map<string, any>();
const fromDb = (...ids: string[]) => ids.map((id) => JSON.parse(JSON.stringify(db.get(id))));
const storedId = (leadId: string) => db.get(leadId).syncMetadata?.hubspot_contact_id;
const addLead = (leadId: string, fields: any) => db.set(leadId, { leadId, listId: 'list_1', firstName: leadId, ...fields });

describe('ENG-2171 against a stateful fake HubSpot (real service + real adapter, fake transport)', () => {
  const ORIGINAL = process.env.HUBSPOT_PUSH_BY_STORED_ID;
  let adapter: any;

  beforeEach(() => {
    hs.reset();
    throttled = 0;
    db.clear();
    jest.clearAllMocks();
    (crmDb.updateLead as jest.Mock).mockImplementation(async (_l: string, leadId: string, patch: any) => {
      Object.assign(db.get(leadId), patch);
    });
    (crmDb.getLeadListById as jest.Mock).mockResolvedValue({ listId: 'list_1', name: 'Q1 Outbound' });
    delete process.env.HUBSPOT_PUSH_BY_STORED_ID;
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    adapter = new HubspotAdapter();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (ORIGINAL === undefined) delete process.env.HUBSPOT_PUSH_BY_STORED_ID;
    else process.env.HUBSPOT_PUSH_BY_STORED_ID = ORIGINAL;
  });

  const push = (...ids: string[]) => adapter.pushLeads(auth, fromDb(...ids), config);

  /** The ticket: push a phone-only lead, then the lead gains an email, then push again. */
  async function phoneOnlyThenGainsEmail() {
    addLead('l1', { email: '', phone: '+15550100001' });
    const first = await push('l1');
    const contactA = storedId('l1');
    db.get('l1').email = 'now.has@example.com';
    const second = await push('l1');
    return { first, second, contactA };
  }

  it('POSITIVE CONTROL: with the fix disabled the fake reproduces the orphaning (two contacts, id overwritten)', async () => {
    process.env.HUBSPOT_PUSH_BY_STORED_ID = 'off';

    const { contactA } = await phoneOnlyThenGainsEmail();

    expect(hs.contacts.size).toBe(2);                       // A and a new B
    expect(storedId('l1')).not.toBe(contactA);              // stored id overwritten
    expect(hs.contacts.get(contactA)!.properties.email).toBeUndefined(); // A is orphaned, never got the email
  });

  it('THE FIX: the same scenario updates contact A in place — one contact, id kept, email set', async () => {
    const { first, second, contactA } = await phoneOnlyThenGainsEmail();

    expect(first).toMatchObject({ successCount: 1, newCount: 1, errorCount: 0 });
    expect(second).toMatchObject({ successCount: 1, updatedCount: 1, newCount: 0, errorCount: 0 });
    expect(hs.contacts.size).toBe(1);
    expect(storedId('l1')).toBe(contactA);
    expect(hs.contacts.get(contactA)!.properties).toMatchObject({ email: 'now.has@example.com', phone: '+15550100001' });
  });

  it('sends the real batch/update body: inputs of {id, properties} with the lowercased email', async () => {
    await phoneOnlyThenGainsEmail();

    const call = hs.calls.filter((c) => c.path === '/crm/v3/objects/contacts/batch/update');
    expect(call).toHaveLength(1);
    expect(call[0].body).toEqual({
      inputs: [{ id: expect.stringMatching(/^\d+$/), properties: expect.objectContaining({ email: 'now.has@example.com', firstname: 'l1' }) }],
    });
    expect(hs.count('POST', /batch\/upsert$/)).toBe(0);
  });

  it('is idempotent: pushing again creates nothing and changes nothing', async () => {
    await phoneOnlyThenGainsEmail();
    const before = JSON.stringify([...hs.contacts.values()]);
    const creates = hs.count('POST', /\/contacts$/) + hs.count('POST', /batch\/upsert$/);

    const third = await push('l1');

    expect(third).toMatchObject({ successCount: 1, errorCount: 0 });
    expect(JSON.stringify([...hs.contacts.values()])).toBe(before);
    expect(hs.count('POST', /\/contacts$/) + hs.count('POST', /batch\/upsert$/)).toBe(creates);
  });

  it('a normal synced email lead keeps its contact across pushes (the common re-push path)', async () => {
    addLead('l1', { email: 'plain@example.com' });
    await push('l1');
    const id = storedId('l1');
    expect(hs.contacts.size).toBe(1);

    db.get('l1').firstName = 'Renamed';
    const again = await push('l1');

    expect(again).toMatchObject({ successCount: 1, updatedCount: 1, errorCount: 0 });
    expect(storedId('l1')).toBe(id);
    expect(hs.contacts.size).toBe(1);
    expect(hs.contacts.get(id)!.properties.firstname).toBe('Renamed');
  });

  describe('the contact was deleted in HubSpot (the response shape is a GUESS)', () => {
    it.each([['404', '404'], ['207 OBJECT_NOT_FOUND', '207']] as const)('%s: recovers by upserting; the stale id is replaced', async (_n, mode) => {
      hs.reset({ missingIdMode: mode });
      const { contactA } = await phoneOnlyThenGainsEmail();
      hs.contacts.delete(contactA);
      db.get('l1').firstName = 'After';

      const result = await push('l1');

      expect(result).toMatchObject({ successCount: 1, newCount: 1, errorCount: 0 });
      expect(hs.contacts.size).toBe(1);
      expect(storedId('l1')).not.toBe(contactA);
      expect(hs.contacts.get(storedId('l1'))!.properties).toMatchObject({ email: 'now.has@example.com', firstname: 'After' });
    });

    it('an UNRECOGNISED shape (400) fails closed: lead failed, id kept, nothing created', async () => {
      hs.reset({ missingIdMode: '400' });
      const { contactA } = await phoneOnlyThenGainsEmail();
      hs.contacts.delete(contactA);

      const result = await push('l1');

      expect(result).toMatchObject({ successCount: 0, errorCount: 1 });
      expect(hs.contacts.size).toBe(0);
      expect(storedId('l1')).toBe(contactA);
      expect(db.get('l1').syncMetadata.syncStatus).toBe('sync_failed');
    });
  });

  describe('the lead\'s new email already belongs to a DIFFERENT HubSpot contact (the response shape is a GUESS)', () => {
    it.each([['409', '409'], ['207', '207']] as const)('%s: refused, lead failed visibly, contact A untouched, nothing created', async (_n, mode) => {
      hs.reset({ collisionMode: mode });
      addLead('l1', { email: '', phone: '+15550100001' });
      await push('l1');
      const contactA = storedId('l1');
      const customersOwn = hs.seed({ email: 'taken@example.com', firstname: 'Existing' });
      db.get('l1').email = 'taken@example.com';

      const result = await push('l1');

      expect(result).toMatchObject({ successCount: 0, errorCount: 1 });
      expect(hs.contacts.size).toBe(2);
      expect(hs.contacts.get(contactA)!.properties.email).toBeUndefined();
      expect(hs.contacts.get(customersOwn)!.properties.firstname).toBe('Existing');
      expect(storedId('l1')).toBe(contactA);
      expect(db.get('l1').syncMetadata.syncStatus).toBe('sync_failed');
    });

    it('contrast: the old behaviour adopted the other contact and orphaned A', async () => {
      process.env.HUBSPOT_PUSH_BY_STORED_ID = 'off';
      addLead('l1', { email: '', phone: '+15550100001' });
      await push('l1');
      const contactA = storedId('l1');
      const customersOwn = hs.seed({ email: 'taken@example.com', firstname: 'Existing' });
      db.get('l1').email = 'taken@example.com';

      const result = await push('l1');

      expect(result).toMatchObject({ successCount: 1, errorCount: 0 });
      expect(storedId('l1')).toBe(customersOwn);
      expect(hs.contacts.get(contactA)!.properties.email).toBeUndefined();
    });
  });

  describe('rate limiting goes through the REAL 429 interceptor', () => {
    it('one 429 is retried by the service and the push succeeds', async () => {
      hs.reset({ throttleBatchUpdate: 1 });
      addLead('l1', { email: 'a@example.com' });
      await push('l1');
      throttled = 0;
      db.get('l1').firstName = 'After';

      const result = await push('l1');

      expect(result).toMatchObject({ successCount: 1, errorCount: 0 });
      expect(hs.count('POST', /batch\/update$/)).toBe(2);   // the 429 and the retry
      expect(hs.contacts.size).toBe(1);
    });

    it('a sustained 429 fails the whole chunk once (original + one retry), is not bisected, and creates nothing', async () => {
      addLead('l1', { email: 'a@example.com' });
      addLead('l2', { email: 'b@example.com' });
      addLead('l3', { email: 'c@example.com' });
      await push('l1', 'l2', 'l3');
      const sizeBefore = hs.contacts.size;
      hs.opts.throttleBatchUpdate = 1000;
      throttled = 0;
      hs.calls = [];

      const result = await push('l1', 'l2', 'l3');

      expect(result).toMatchObject({ successCount: 0, errorCount: 3 });
      expect(hs.count('POST', /batch\/update$/)).toBe(2);
      expect(hs.contacts.size).toBe(sizeBefore);
      for (const id of ['l1', 'l2', 'l3']) expect(db.get(id).syncMetadata.syncStatus).toBe('sync_failed');
    });
  });

  it('130 synced leads, one deleted in HubSpot: only that one is recreated, the rest are updated in place, all counted once', async () => {
    const ids = Array.from({ length: 130 }, (_, i) => `l${i}`);
    ids.forEach((id, i) => addLead(id, { email: `user${i}@example.com` }));
    await push(...ids);
    expect(hs.contacts.size).toBe(130);
    const victim = storedId('l57');
    hs.contacts.delete(victim);
    const before = new Map(ids.map((id) => [id, storedId(id)]));
    hs.calls = [];

    const result = await push(...ids);

    expect(result.successCount + result.errorCount).toBe(130);
    expect(result).toMatchObject({ successCount: 130, errorCount: 0, newCount: 1, updatedCount: 129 });
    expect(hs.contacts.size).toBe(130);
    for (const id of ids) {
      if (id === 'l57') expect(storedId(id)).not.toBe(victim);
      else expect(storedId(id)).toBe(before.get(id));
    }
    // bisection of the bad chunk is bounded (log-ish), not one call per lead
    expect(hs.count('POST', /batch\/update$/)).toBeLessThan(25);
  });
});
