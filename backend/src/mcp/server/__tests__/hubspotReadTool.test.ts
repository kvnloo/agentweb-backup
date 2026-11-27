/**
 * ENG-2840 (W2-9): `call_hubspot_api` for outside agents (hubspotReadTool.ts), the read-only subset of Emma's tool. What is refused before
 * anything is called (every write action, raw-REST shapes and aliases, ids that could steer a HubSpot URL, unknown arguments, caps), what
 * is sent to the route, the guard, the fixed-field answer and its size cap, and error handling. No network: the self-call is a double; the
 * route's own checks are in __tests__/emmaHubspotReadRoutes.test.ts.
 */
jest.mock('../httpClient', () => ({ mcpFetch: jest.fn() }));

import { mcpFetch } from '../httpClient';
import { mcpToolRegistry } from '../registry';
import { HUBSPOT_READ_GUARD, HUBSPOT_READ_TIMEOUT_MS, MAX_ANSWER_BYTES, capResult } from '../hubspotReadTool';
import { HUBSPOT_READ_PAIRS } from '../../../utils/hubspotReadArgs';

const mockFetch = mcpFetch as jest.Mock;
const TOOL = 'call_hubspot_api';
const ctxFor = (userId: string) => ({ userId, sessionId: 'sess-1', apiKeyId: 'key-1', externalMcp: true });
const call = (args: unknown, userId = 'user-1') => (mcpToolRegistry.getTool(TOOL) as any).execute(args, ctxFor(userId));
const parse = (r: any) => JSON.parse(r.content[0].text);
const ok = (result: unknown) => ({ success: true, account: { account_id: '4242', source: 'own' }, entity_type: 'X', action: 'Y', result });

beforeEach(() => {
  mockFetch.mockReset();
  HUBSPOT_READ_GUARD.reset();
});

describe('the allow-list', () => {
  it('is exactly the research read list, and the description says read-only and names every pair', () => {
    const pairs = Object.fromEntries(Object.entries(HUBSPOT_READ_PAIRS).map(([e, actions]) => [e, Object.keys(actions)]));
    expect(pairs).toEqual({
      CONTACTS: ['LIST', 'SEARCH'],
      DEALS: ['LIST_PIPELINES', 'SEARCH', 'GET_CONTACTS'],
      CONTACT_LIST: ['LIST', 'GET'],
      CAMPAIGN: ['LIST', 'GET', 'GET_METRICS', 'LIST_ASSETS'],
      EMAIL: ['LIST', 'GET', 'GET_STATS', 'LIST_SUBSCRIPTION_TYPES'],
      FORM: ['LIST', 'GET', 'GET_FORM_FIELDS', 'GET_SUBMISSIONS'],
      LANDING_PAGE: ['LIST', 'GET'],
      BLOG_POST: ['LIST', 'GET'],
      WORKFLOW: ['LIST', 'GET', 'GET_PERFORMANCE'],
      SOCIAL: ['LIST_CHANNELS', 'LIST_BROADCASTS'],
    });
    const tool = mcpToolRegistry.getTool(TOOL) as any;
    expect(tool.readOnly).toBeUndefined(); // a read can refresh and store the owner's OAuth token
    expect(tool.requiresUserAccount).toBe(true);
    const description: string = tool.definition.description;
    expect(description).toMatch(/^A READ-ONLY subset of Emma's call_hubspot_api/);
    for (const [entity, actions] of Object.entries(pairs)) expect(description).toContain(`${entity}: ${actions.join(', ')}`);
  });

  it('refuses every write action of Emma\'s tool before any call', async () => {
    const writes: Record<string, string[]> = {
      CONTACTS: ['GET', 'CREATE', 'UPDATE', 'DELETE', 'UPSERT'],
      DEALS: ['LIST', 'CREATE', 'UPDATE', 'DELETE'],
      CONTACT_LIST: ['CREATE', 'ADD_CONTACTS', 'REMOVE_CONTACTS', 'DELETE'],
      CAMPAIGN: ['CREATE', 'UPDATE', 'DELETE', 'ADD_ASSET', 'REMOVE_ASSET'],
      EMAIL: ['CREATE', 'UPDATE', 'PUBLISH', 'UNPUBLISH', 'CLONE', 'DELETE'],
      FORM: ['CREATE', 'UPDATE', 'DELETE', 'SUBMIT'],
      LANDING_PAGE: ['CREATE', 'PUBLISH', 'UPDATE', 'DELETE'],
      BLOG_POST: ['CREATE', 'PUBLISH', 'UPDATE', 'DELETE'],
      WORKFLOW: ['DELETE', 'ENABLE', 'DISABLE'],
      SOCIAL: ['CREATE_BROADCAST', 'DELETE_BROADCAST'],
    };
    for (const [entity, actions] of Object.entries(writes)) {
      for (const action of actions) {
        await expect(call({ entity_type: entity, action })).rejects.toThrow(new RegExp(`^${TOOL}: ${entity} ${action} is not available here: this tool only reads\\..*Nothing was changed\\.$`));
      }
    }
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('accepts upper case only, and refuses unknown entities and non-text actions', async () => {
    const cases: Array<[unknown, RegExp]> = [
      [{ entity_type: 'contacts', action: 'LIST' }, /entity_type must be one of CONTACTS, DEALS/],
      [{ entity_type: 'CONTACTS', action: 'list' }, /CONTACTS list is not available here/],
      [{ entity_type: 'COMPANIES', action: 'LIST' }, /entity_type must be one of/],
      [{ entity_type: '__proto__', action: 'LIST' }, /entity_type must be one of/],
      [{ entity_type: 'CONTACTS', action: 'constructor' }, /CONTACTS constructor is not available here/],
      [{ entity_type: 'CONTACTS', action: ['LIST'] }, /action is not one this tool allows/],
      [{ action: 'LIST' }, /entity_type must be one of/],
      [{ entity_type: 'CONTACTS' }, /action is not one this tool allows/],
    ];
    for (const [args, re] of cases) await expect(call(args)).rejects.toThrow(re);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('refuses raw-REST shapes and aliases by name (Emma\'s normaliser would map them onto actions)', async () => {
    const cases: unknown[] = [
      { endpoint: '/crm/v3/objects/contacts', method: 'GET' },
      { entity_type: 'CONTACTS', action: 'LIST', endpoint: '/crm/v3/objects/contacts' },
      { entity_type: 'CONTACTS', action: 'LIST', method: 'DELETE' },
      { entity_type: 'CAMPAIGN', action: 'GET', id: 'abc' },
      { entity_type: 'CONTACT_LIST', action: 'GET', listId: '12' },
      { entity_type: 'DEALS', action: 'SEARCH', dealstage: 'won' },
      { entity_type: 'CONTACTS', action: 'LIST', userId: 'victim' },
      { entity_type: 'CONTACTS', action: 'LIST', user_id: 'victim' },
      { entity_type: 'FORM', action: 'GET', form_id: 'f1', fields: [{ name: 'email', value: 'x' }] },
    ];
    for (const args of cases.slice(1)) await expect(call(args)).rejects.toThrow(/is not an input of call_hubspot_api.*Nothing was changed\.$/);
    await expect(call(cases[0])).rejects.toThrow(/"endpoint", "method" are not inputs/);
    await expect(call({ action: 'LIST_CONTACTS' })).rejects.toThrow(/entity_type must be one of/);
    await expect(call('CONTACTS LIST')).rejects.toThrow(/the arguments must be an object/);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('values', () => {
  it('refuses an id that could steer a HubSpot URL, in every id field, before any call', async () => {
    const bad = ['../../crm/v3/objects/contacts', '1?archived=true', '12/../34', '..', 'a b', 'x#y', '%2e%2e', '1&x=2', 'x'.repeat(65), '', 'é1', -5, 1.5, true, {}];
    const fields: Array<[Record<string, unknown>, string]> = [
      [{ entity_type: 'CAMPAIGN', action: 'GET' }, 'guid'],
      [{ entity_type: 'CAMPAIGN', action: 'LIST_ASSETS' }, 'guid'],
      [{ entity_type: 'EMAIL', action: 'GET' }, 'email_id'],
      [{ entity_type: 'FORM', action: 'GET_SUBMISSIONS' }, 'form_id'],
      [{ entity_type: 'FORM', action: 'GET_FORM_FIELDS' }, 'form_id'],
      [{ entity_type: 'LANDING_PAGE', action: 'GET' }, 'page_id'],
      [{ entity_type: 'BLOG_POST', action: 'GET' }, 'post_id'],
      [{ entity_type: 'WORKFLOW', action: 'GET' }, 'workflow_id'],
      [{ entity_type: 'CONTACT_LIST', action: 'GET' }, 'list_id'],
      [{ entity_type: 'DEALS', action: 'GET_CONTACTS' }, 'deal_id'],
      [{ entity_type: 'DEALS', action: 'SEARCH' }, 'pipeline'],
      [{ entity_type: 'SOCIAL', action: 'LIST_CHANNELS' }, 'account_id'],
    ];
    for (const [base, field] of fields) {
      for (const value of bad) {
        await expect(call({ ...base, [field]: value })).rejects.toThrow(new RegExp(`${field} must be an id of 1 to 64 letters`));
      }
    }
    await expect(call({ entity_type: 'EMAIL', action: 'GET_STATS', email_ids: ['1', '../2'] })).rejects.toThrow(/email_ids must be an id/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('refuses a cursor that is not a short paging token (CONTACTS LIST puts it raw into a query string)', async () => {
    for (const cursor of ['a&after=b', 'a?b', 'a/b', 'a b', 'a#b', '../x', 'x'.repeat(201), '', 5]) {
      await expect(call({ entity_type: 'CONTACTS', action: 'LIST', cursor })).rejects.toThrow(/cursor must be the paging token HubSpot returned/);
    }
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('enforces the caps and shapes', async () => {
    const props = (n: number) => Array.from({ length: n }, (_, i) => `p${i}`);
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ entity_type: 'CONTACTS', action: 'SEARCH', properties: props(21) }, /properties must be a list of 1 to 20/],
      [{ entity_type: 'CONTACTS', action: 'SEARCH', properties: [] }, /properties must be a list of 1 to 20/],
      [{ entity_type: 'CONTACTS', action: 'SEARCH', properties: 'email,phone' }, /properties must be a list/],
      [{ entity_type: 'CONTACTS', action: 'SEARCH', properties: ['Email'] }, /not a HubSpot property name/],
      [{ entity_type: 'CONTACTS', action: 'SEARCH', properties: ['a,b'] }, /not a HubSpot property name/],
      [{ entity_type: 'CONTACTS', action: 'SEARCH', limit: 0 }, /limit must be a whole number from 1 to 100/],
      [{ entity_type: 'CONTACTS', action: 'SEARCH', limit: 101 }, /limit must be a whole number from 1 to 100/],
      [{ entity_type: 'DEALS', action: 'SEARCH', limit: 2.5 }, /limit must be a whole number/],
      [{ entity_type: 'DEALS', action: 'SEARCH', limit: '10' }, /limit must be a whole number/],
      [{ entity_type: 'CONTACT_LIST', action: 'LIST', count: 101 }, /count must be a whole number from 1 to 100/],
      [{ entity_type: 'EMAIL', action: 'GET_STATS', email_ids: Array.from({ length: 21 }, (_, i) => String(i + 1)) }, /email_ids must be a list of 1 to 20/],
      [{ entity_type: 'EMAIL', action: 'GET_STATS', email_ids: ['1', '1'] }, /email_ids has the same id twice/],
      [{ entity_type: 'EMAIL', action: 'GET_STATS', email_ids: '1,2' }, /email_ids must be a list/],
      [{ entity_type: 'CONTACTS', action: 'SEARCH', created_after: 'yesterday' }, /created_after must be epoch milliseconds/],
      [{ entity_type: 'CONTACTS', action: 'SEARCH', created_after: '2026-02-30' }, /created_after must be epoch milliseconds/],
      [{ entity_type: 'CONTACTS', action: 'SEARCH', created_after: '2026-01-01T25:00:00Z' }, /created_after must be epoch milliseconds/],
      [{ entity_type: 'CONTACTS', action: 'SEARCH', created_after: 1_700_000_000 }, /created_after must be epoch milliseconds/], // epoch seconds
      [{ entity_type: 'CONTACTS', action: 'SEARCH', created_after: '1700000000' }, /created_after must be epoch milliseconds/],
      [{ entity_type: 'CONTACTS', action: 'SEARCH', created_after: 8.64e15 }, /created_after must be epoch milliseconds/],
      [{ entity_type: 'CONTACTS', action: 'SEARCH', created_after: '2026-11-02', created_before: '2026-11-01' }, /created_after must be before created_before/],
      [{ entity_type: 'EMAIL', action: 'GET_STATS', email_ids: ['1'], start_timestamp: 'last week' }, /start_timestamp must be epoch milliseconds/],
      [{ entity_type: 'WORKFLOW', action: 'GET_PERFORMANCE', workflow_id: '1', start: 1767225600000, end: 1767225600000, bucket: 'DAY' }, /start must be before end/],
      [{ entity_type: 'WORKFLOW', action: 'GET_PERFORMANCE', workflow_id: '1', start: '1767225600000&x=1', end: 1769904000000, bucket: 'DAY' }, /start must be epoch milliseconds/],
      [{ entity_type: 'WORKFLOW', action: 'GET_PERFORMANCE', workflow_id: '1', start: 1767225600000, end: 1769904000000, bucket: 'YEAR' }, /bucket must be one of DAY, WEEK, MONTH/],
      [{ entity_type: 'WORKFLOW', action: 'GET_PERFORMANCE', workflow_id: '1', start: 1767225600000, end: 1769904000000, bucket: 'DAY&x=1' }, /bucket must be one of/],
      [{ entity_type: 'CAMPAIGN', action: 'LIST_ASSETS', guid: 'g1', asset_type: 'CONTACT' }, /asset_type must be one of MARKETING_EMAIL/],
      [{ entity_type: 'CAMPAIGN', action: 'LIST_ASSETS', guid: 'g1', asset_type: '../emails' }, /asset_type must be one of/],
      [{ entity_type: 'CAMPAIGN', action: 'LIST_ASSETS', guid: 'g1', start_date: '2026-02-30' }, /start_date must be a real day/],
      [{ entity_type: 'CAMPAIGN', action: 'LIST_ASSETS', guid: 'g1', start_date: '2026-03-02', end_date: '2026-03-01' }, /start_date must not be after end_date/],
      [{ entity_type: 'DEALS', action: 'SEARCH', deal_stage: ' won' }, /deal_stage holds spaces at the ends/],
      [{ entity_type: 'DEALS', action: 'SEARCH', deal_stage: 'won\nx' }, /deal_stage holds spaces at the ends or control/],
      [{ entity_type: 'DEALS', action: 'SEARCH', deal_stage: 'x'.repeat(101) }, /deal_stage is 101 characters/],
      [{ entity_type: 'CONTACT_LIST', action: 'LIST', query: 'list_id=12' }, /to read one list use action GET with list_id/],
      [{ entity_type: 'CONTACT_LIST', action: 'LIST', query: { listId: '12' } }, /query must be text/],
    ];
    for (const [args, re] of cases) await expect(call(args)).rejects.toThrow(re);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('refuses an input the pair does not use, and a missing required one', async () => {
    await expect(call({ entity_type: 'EMAIL', action: 'GET', email_id: '1', guid: 'g' })).rejects.toThrow(/guid is not used by EMAIL GET\. Its inputs are: email_id/);
    await expect(call({ entity_type: 'SOCIAL', action: 'LIST_BROADCASTS', cursor: 'abc' })).rejects.toThrow(/cursor is not used by SOCIAL LIST_BROADCASTS\. Its inputs are: none/);
    await expect(call({ entity_type: 'CONTACTS', action: 'LIST', limit: 5 })).rejects.toThrow(/limit is not used by CONTACTS LIST/);
    await expect(call({ entity_type: 'CAMPAIGN', action: 'GET' })).rejects.toThrow(/guid is required for CAMPAIGN GET/);
    await expect(call({ entity_type: 'EMAIL', action: 'GET_STATS' })).rejects.toThrow(/email_ids is required/);
    await expect(call({ entity_type: 'WORKFLOW', action: 'GET_PERFORMANCE', workflow_id: '1', start: 1767225600000, end: 1769904000000 })).rejects.toThrow(/bucket is required/);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('what is sent', () => {
  it('posts only the checked fields to /api/emma/hubspot-read with a two-minute timeout, as the key\'s own user', async () => {
    mockFetch.mockResolvedValue(ok({}));
    await call({ entity_type: 'CONTACTS', action: 'SEARCH', created_after: '2026-11-01', created_before: 1798761600000, properties: ['hs_lead_status', 'hs_lead_status'], cursor: 'MTAw', account_id: 4242 });
    const req = mockFetch.mock.calls[0][0];
    expect(req).toMatchObject({ method: 'POST', path: '/api/emma/hubspot-read', timeoutMs: HUBSPOT_READ_TIMEOUT_MS });
    expect(HUBSPOT_READ_TIMEOUT_MS).toBeLessThanOrEqual(120_000);
    expect(req.context.userId).toBe('user-1');
    expect(req.body).toStrictEqual({
      entity_type: 'CONTACTS', action: 'SEARCH', account_id: '4242',
      created_after: String(Date.UTC(2026, 10, 1)), created_before: '1798761600000',
      properties: ['hs_lead_status'], cursor: 'MTAw', limit: 25,
    });
  });

  it('sends epoch milliseconds for every date the handler reads and leaves YYYY-MM-DD days as they are', async () => {
    mockFetch.mockResolvedValue(ok({}));
    await call({ entity_type: 'EMAIL', action: 'GET_STATS', email_ids: ['101', 202], start_timestamp: '2026-01-01T00:00:00Z', end_timestamp: '1769904000000' });
    expect(mockFetch.mock.calls[0][0].body).toStrictEqual({ entity_type: 'EMAIL', action: 'GET_STATS', email_ids: ['101', '202'], start_timestamp: '1767225600000', end_timestamp: '1769904000000' });
    await call({ entity_type: 'WORKFLOW', action: 'GET_PERFORMANCE', workflow_id: 77, start: '2026-01-01', end: 1769904000000, bucket: 'WEEK' });
    expect(mockFetch.mock.calls[1][0].body).toStrictEqual({ entity_type: 'WORKFLOW', action: 'GET_PERFORMANCE', workflow_id: '77', start: 1767225600000, end: 1769904000000, bucket: 'WEEK' });
    await call({ entity_type: 'CAMPAIGN', action: 'LIST_ASSETS', guid: '6b3c-11ab', asset_type: 'FORM', start_date: '2026-01-01', end_date: '2026-01-31', cursor: 'NTI1Cg%3D%3D' });
    expect(mockFetch.mock.calls[2][0].body).toStrictEqual({ entity_type: 'CAMPAIGN', action: 'LIST_ASSETS', guid: '6b3c-11ab', asset_type: 'FORM', start_date: '2026-01-01', end_date: '2026-01-31', cursor: 'NTI1Cg%3D%3D' });
    await call({ entity_type: 'DEALS', action: 'SEARCH', deal_stage: 'New Business Meetings', pipeline: 'default', limit: 100, account_id: null, cursor: null });
    expect(mockFetch.mock.calls[3][0].body).toStrictEqual({ entity_type: 'DEALS', action: 'SEARCH', deal_stage: 'New Business Meetings', pipeline: 'default', limit: 100 });
  });
});

describe('guard', () => {
  it('one call at a time per caller; 120 an hour; a refusal before the call does not count', async () => {
    let release: (v: unknown) => void = () => undefined;
    mockFetch.mockImplementationOnce(() => new Promise((r) => { release = r; }));
    const first = call({ entity_type: 'SOCIAL', action: 'LIST_CHANNELS' }, 'u-guard');
    await expect(call({ entity_type: 'SOCIAL', action: 'LIST_CHANNELS' }, 'u-guard')).rejects.toThrow(/another call of yours to this tool is still running/);
    mockFetch.mockResolvedValueOnce(ok({ channels: [] }));
    await expect(call({ entity_type: 'SOCIAL', action: 'LIST_CHANNELS' }, 'u-other')).resolves.toBeDefined();
    release(ok({ channels: [] }));
    await first;
    expect(HUBSPOT_READ_GUARD.inFlight).toBe(0);

    HUBSPOT_READ_GUARD.reset();
    await expect(call({ entity_type: 'EMAIL', action: 'PUBLISH', email_id: '1' }, 'u-cap')).rejects.toThrow(/only reads/);
    expect(HUBSPOT_READ_GUARD.recent.get('u-cap')).toBeUndefined();
    mockFetch.mockResolvedValue(ok({}));
    for (let i = 0; i < 120; i++) await call({ entity_type: 'WORKFLOW', action: 'LIST' }, 'u-cap');
    await expect(call({ entity_type: 'WORKFLOW', action: 'LIST' }, 'u-cap')).rejects.toThrow(/you have made 120 calls to this tool in the last hour/);
    expect(HUBSPOT_READ_GUARD.processMax).toBe(8);
  });

  it('frees the slot when the route fails', async () => {
    mockFetch.mockRejectedValueOnce(new Error('API error (500): x'));
    await expect(call({ entity_type: 'WORKFLOW', action: 'LIST' }, 'u1')).rejects.toThrow(/HTTP 500/);
    expect(HUBSPOT_READ_GUARD.inFlight).toBe(0);
    expect(HUBSPOT_READ_GUARD.callers.size).toBe(0);
  });
});

describe('the answer', () => {
  it('is built from fixed fields: account, entity_type, action, result, truncated', async () => {
    mockFetch.mockResolvedValueOnce({ success: true, account: { account_id: '4242', source: 'org_shared', ownerEmail: 'boss@x.com' }, entity_type: 'EVIL', action: 'DELETE', result: { results: [{ id: '1' }], paging: { next: { after: '2' } } }, debug: 'secret', error: 'raw' });
    const a = parse(await call({ entity_type: 'FORM', action: 'LIST' }));
    expect(a).toEqual({ account: { account_id: '4242', source: 'org_shared' }, entity_type: 'FORM', action: 'LIST', result: { results: [{ id: '1' }], paging: { next: { after: '2' } } }, truncated: false });
  });

  it('answers account null when the route\'s account is missing or not in the expected shape', async () => {
    for (const account of [undefined, null, 'own', { source: 'admin', account_id: '1' }, ['own']]) {
      mockFetch.mockResolvedValueOnce({ success: true, account, result: { a: 1 } });
      expect(parse(await call({ entity_type: 'WORKFLOW', action: 'LIST' })).account).toBeNull();
    }
    mockFetch.mockResolvedValueOnce({ success: true, account: { account_id: '../x', source: 'lead_list_token' }, result: { a: 1 } });
    expect(parse(await call({ entity_type: 'WORKFLOW', action: 'LIST' })).account).toEqual({ account_id: null, source: 'lead_list_token' });
  });

  it('withholds credential-shaped fields anywhere in the result', async () => {
    mockFetch.mockResolvedValueOnce(ok({ results: [{ name: 'p', password: 'hunter2', meta: { accessToken: 'tok', api_key: 'k', client_secret: 's' } }] }));
    const a = parse(await call({ entity_type: 'LANDING_PAGE', action: 'LIST' }));
    expect(a.result).toEqual({ results: [{ name: 'p', meta: {} }] });
    expect(a.fields_withheld).toBe(4);
    expect(JSON.stringify(a)).not.toMatch(/hunter2|"tok"|client_secret/);
  });

  it('keeps a "__proto__" key from JSON a plain field', async () => {
    mockFetch.mockResolvedValueOnce(ok(JSON.parse('{"__proto__": {"polluted": true}, "x": 1}')));
    const a = parse(await call({ entity_type: 'WORKFLOW', action: 'LIST' }));
    expect(({} as any).polluted).toBeUndefined();
    expect(a.result.x).toBe(1);
  });

  it('cuts a large list from its end to fit about 60 KB and says so', async () => {
    const results = Array.from({ length: 1000 }, (_, i) => ({ id: String(i), properties: { email: `p${i}@example.com`, note: 'n'.repeat(200) } }));
    mockFetch.mockResolvedValueOnce(ok({ results, paging: { next: { after: '1000' } }, total: 5000 }));
    const r = await call({ entity_type: 'CONTACTS', action: 'LIST' });
    const text: string = r.content[0].text;
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(MAX_ANSWER_BYTES);
    const a = JSON.parse(text);
    expect(a.truncated).toBe(true);
    expect(a.note).toMatch(/lists were cut from the end/);
    expect(a.result.results.length).toBeGreaterThan(100);
    expect(a.result.results.length).toBeLessThan(1000);
    expect(a.result.results[0].id).toBe('0');
    expect(a.result.total).toBe(5000);
  });

  it('shortens a huge text (a landing page body) and fits', async () => {
    mockFetch.mockResolvedValueOnce(ok({ id: '1', name: 'Page', layoutSections: { body: 'x'.repeat(500_000) }, widgets: { a: 'y'.repeat(100_000) } }));
    const r = await call({ entity_type: 'LANDING_PAGE', action: 'GET', page_id: '1' });
    expect(Buffer.byteLength(r.content[0].text, 'utf8')).toBeLessThanOrEqual(MAX_ANSWER_BYTES);
    const a = JSON.parse(r.content[0].text);
    expect(a.truncated).toBe(true);
    expect(a.result.name).toBe('Page');
    expect(a.result.layoutSections.body.endsWith('…[cut]')).toBe(true);
  });

  it('capResult: small results are untouched; an object of many small fields that cannot be cut becomes a note; deep nesting is cut', () => {
    expect(capResult({ a: [1, 2], b: 'x' })).toEqual({ value: { a: [1, 2], b: 'x' }, truncated: false, withheld: 0 });
    const wide: Record<string, number> = {};
    for (let i = 0; i < 20_000; i++) wide[`k${i}`] = i;
    expect(capResult(wide).value).toEqual({ note: expect.stringMatching(/too large to return/) });
    let deep: any = 'bottom';
    for (let i = 0; i < 30; i++) deep = { d: deep };
    const cut = capResult(deep);
    expect(cut.truncated).toBe(true);
    expect(JSON.stringify(cut.value)).toContain('nested too deep');
    const big = capResult(Array.from({ length: 50_000 }, (_, i) => i), 1_000);
    expect(Buffer.byteLength(JSON.stringify(big.value))).toBeLessThanOrEqual(1_000);
    expect(big.truncated).toBe(true);
  });
});

describe('errors', () => {
  it('a refusal carries only the route message; a 4xx passes through; a 5xx or no answer is a fixed text', async () => {
    mockFetch.mockResolvedValueOnce({ success: false, message: 'HubSpot found nothing at that id (HTTP 404).', error: 'raw stack at /srv/app.js', hubspotError: { message: 'x' } });
    await expect(call({ entity_type: 'EMAIL', action: 'GET', email_id: '9' })).rejects.toThrow(/^call_hubspot_api: HubSpot found nothing at that id \(HTTP 404\)\.$/);
    mockFetch.mockResolvedValueOnce({ success: false });
    await expect(call({ entity_type: 'EMAIL', action: 'GET', email_id: '9' })).rejects.toThrow(/^call_hubspot_api: the request was refused\.$/);
    mockFetch.mockRejectedValueOnce(new Error('API error (400): guid is required for CAMPAIGN GET.'));
    await expect(call({ entity_type: 'WORKFLOW', action: 'LIST' })).rejects.toThrow('API error (400): guid is required for CAMPAIGN GET.');
    mockFetch.mockRejectedValueOnce(new Error('API error (429): Monthly token quota exceeded'));
    await expect(call({ entity_type: 'WORKFLOW', action: 'LIST' })).rejects.toThrow('API error (429): Monthly token quota exceeded');
    mockFetch.mockRejectedValueOnce(new Error('API error (500): ENOENT /srv/x token=abc'));
    await expect(call({ entity_type: 'WORKFLOW', action: 'LIST' })).rejects.toThrow(/^call_hubspot_api: the service could not answer \(HTTP 500\)\. Try again later\. Nothing was changed\.$/);
    mockFetch.mockRejectedValueOnce(new Error('MCP self-call POST /api/emma/hubspot-read failed after 1 attempt(s): ECONNREFUSED 127.0.0.1:3001'));
    await expect(call({ entity_type: 'WORKFLOW', action: 'LIST' })).rejects.toThrow(/^call_hubspot_api: the service could not be reached or did not answer in time\. Nothing was changed\.$/);
    mockFetch.mockResolvedValueOnce(null);
    await expect(call({ entity_type: 'WORKFLOW', action: 'LIST' })).rejects.toThrow(/the service gave no answer/);
  });
});
