/**
 * ENG-2840 wave 1, PR B: what an outside agent may write to a lead through manage_leads, proved through the REAL path (MCP client -> MCP
 * server -> tool -> mcpFetch -> the real Express app -> db.ts -> in-memory DynamoDB), the same path as mcp.twoTenantIsolation.test.ts.
 *
 * Emma's own update_lead forwards eleven standard fields, merges every other key into customFields, turns a do-not-contact status into a
 * real suppression and can never write the contact-status fields. Over MCP the body used to be forwarded verbatim.
 */
jest.mock('aws-sdk', () => {
  const actual = jest.requireActual('aws-sdk');
  const { makeTwoTenantFake } = jest.requireActual('./helpers/twoTenantMcpHarness');
  const fake = makeTwoTenantFake();
  (global as any).__leadsWritesFake = fake;
  actual.DynamoDB.DocumentClient = fake.documentClient;
  return actual;
});
jest.mock('../server', () => ({ io: { to: jest.fn().mockReturnValue({ emit: jest.fn() }), emit: jest.fn() }, app: {} }));
jest.mock('../utils/secretsManager', () => ({
  getMetaAccessToken: jest.fn().mockResolvedValue('mock-token'),
  getSecret: jest.fn().mockResolvedValue('mock-secret'),
}));

import app from '../app';
import { isDoNotContactStatus } from '../mcp/server/manageLeadsWrites';
import {
  connectCaller,
  installSelfCallFetch,
  seedTwoTenantWorld,
  snapshotTenant,
  TENANT_A,
  TENANT_B,
  type McpCaller,
} from './helpers/twoTenantMcpHarness';

const fake: any = (global as any).__leadsWritesFake;
const leadRow = (listId: string, leadId: string) => fake.items('AW-Leads').find((r: any) => r.listId === listId && r.leadId === leadId);
const leadsOf = (listId: string) => fake.items('AW-Leads').filter((r: any) => r.listId === listId);
const listRowOf = (listId: string) => fake.items('AW-LeadLists').find((r: any) => r.listId === listId);

let restoreFetch: () => void;
let a: McpCaller;
const [a1, a2] = TENANT_A.leads;
const b1 = TENANT_B.leads[0];

beforeAll(async () => {
  restoreFetch = installSelfCallFetch(app);
  a = await connectCaller(TENANT_A.owner);
});
afterAll(async () => {
  await a.close();
  restoreFetch();
});
beforeEach(() => {
  seedTwoTenantWorld(fake);
  // a1 already carries custom fields, so a merge can be told from a replace.
  fake.seed('AW-Leads', { ...leadRow(TENANT_A.listId, a1.leadId), customFields: { region: 'EMEA', tier: 'gold' } });
});

describe('update', () => {
  it('status do-not-contact suppresses the lead (contact status, group-email unsubscribe), as Emma does', async () => {
    const r = await a.call('manage_leads', { action: 'update', list_id: TENANT_A.listId, lead_id: a1.leadId, updates: { status: 'do-not-contact' } });
    expect(r.isError).toBe(false);
    const row = leadRow(TENANT_A.listId, a1.leadId);
    expect(row).toMatchObject({ status: 'do-not-contact', contactStatus: 'do-not-contact', unsubscribedFromGroupEmail: true });
    // The other lead is untouched.
    expect(leadRow(TENANT_A.listId, a2.leadId).contactStatus).toBeUndefined();
  });

  it('a differently written do-not-contact status ("Do Not Contact", "dnc") suppresses too', async () => {
    for (const [leadId, status] of [[a1.leadId, 'Do Not Contact'], [a2.leadId, 'dnc']]) {
      const r = await a.call('manage_leads', { action: 'update', list_id: TENANT_A.listId, lead_id: leadId, updates: { status } });
      expect(r.isError).toBe(false);
      expect(leadRow(TENANT_A.listId, leadId).contactStatus).toBe('do-not-contact');
    }
  });

  it('an ordinary status does not suppress', async () => {
    const r = await a.call('manage_leads', { action: 'update', list_id: TENANT_A.listId, lead_id: a1.leadId, updates: { status: 'contacted' } });
    expect(r.isError).toBe(false);
    expect(leadRow(TENANT_A.listId, a1.leadId).contactStatus).toBeUndefined();
  });

  it('contact-status fields are refused by name, and a suppressed lead cannot be un-suppressed', async () => {
    await a.call('manage_leads', { action: 'update', list_id: TENANT_A.listId, lead_id: a1.leadId, updates: { status: 'do-not-contact' } });
    const before = JSON.stringify(leadRow(TENANT_A.listId, a1.leadId));

    for (const updates of [
      { contactStatus: 'active' },
      { unsubscribedFromGroupEmail: false },
      { contactStatus: 'active', notes: 'resubscribed' },
      { customFields: { contactStatus: 'x' }, contactStatusUpdatedBy: 'someone-else' },
    ]) {
      const r = await a.call('manage_leads', { action: 'update', list_id: TENANT_A.listId, lead_id: a1.leadId, updates });
      expect({ updates, isError: r.isError }).toEqual({ updates, isError: true });
      expect(r.text).toMatch(/cannot be set as given/);
    }
    // Nothing was written, not even the harmless field that travelled with a refused one.
    expect(JSON.stringify(leadRow(TENANT_A.listId, a1.leadId))).toBe(before);
    expect(leadRow(TENANT_A.listId, a1.leadId).contactStatus).toBe('do-not-contact');
  });

  it('identity, sync and attribution keys are refused by name', async () => {
    const before = JSON.stringify(leadRow(TENANT_A.listId, a1.leadId));
    for (const key of ['userId', 'tenantId', 'accountOwnerUserId', 'listId', 'syncMetadata', 'lastAutoSendAt', 'firstTouch', '__proto__']) {
      const updates = JSON.parse(`{ "${key}": "x" }`);
      const r = await a.call('manage_leads', { action: 'update', list_id: TENANT_A.listId, lead_id: a1.leadId, updates });
      expect({ key, isError: r.isError, names: r.text.includes(key) }).toEqual({ key, isError: true, names: true });
    }
    expect(JSON.stringify(leadRow(TENANT_A.listId, a1.leadId))).toBe(before);
  });

  it('other keys and an explicit customFields object are MERGED into the existing custom fields, never replacing them', async () => {
    const r = await a.call('manage_leads', {
      action: 'update', list_id: TENANT_A.listId, lead_id: a1.leadId,
      updates: { favouriteColour: 'green', customFields: { tier: 'platinum' }, company: 'Alpha Inc' },
    });
    expect(r.isError).toBe(false);
    const row = leadRow(TENANT_A.listId, a1.leadId);
    expect(row.company).toBe('Alpha Inc');
    expect(row.customFields).toEqual({ region: 'EMEA', tier: 'platinum', favouriteColour: 'green' });
  });

  it('an empty update, a missing lead_id and a non-object customFields are refused without a write', async () => {
    const before = JSON.stringify(leadRow(TENANT_A.listId, a1.leadId));
    for (const args of [
      { updates: {} },
      { lead_id: undefined, updates: { notes: 'x' } },
      { updates: { customFields: 'not-an-object' } },
    ]) {
      const r = await a.call('manage_leads', { action: 'update', list_id: TENANT_A.listId, lead_id: a1.leadId, ...args });
      expect({ args, isError: r.isError }).toEqual({ args, isError: true });
    }
    expect(JSON.stringify(leadRow(TENANT_A.listId, a1.leadId))).toBe(before);
  });

  it("suppressing, merging or deleting through the caller's list with the OTHER tenant's lead id changes nothing of theirs", async () => {
    const victim = snapshotTenant(fake, TENANT_B);
    for (const updates of [{ status: 'do-not-contact' }, { somethingNew: 'x' }]) {
      const r = await a.call('manage_leads', { action: 'update', list_id: TENANT_A.listId, lead_id: b1.leadId, updates });
      expect(r.isError).toBe(true);
    }
    expect(snapshotTenant(fake, TENANT_B)).toBe(victim);
  });
});

describe('add', () => {
  it('one lead answers as before: the created lead; other keys become custom fields', async () => {
    const r = await a.call('manage_leads', { action: 'add', list_id: TENANT_A.listId, leads: [{ email: 'new@alpha.test', firstName: 'Nia', source_note: 'met at expo' }] });
    expect(r.isError).toBe(false);
    expect(r.json).toMatchObject({ email: 'new@alpha.test', firstName: 'Nia' });
    const row = leadsOf(TENANT_A.listId).find((l: any) => l.email === 'new@alpha.test');
    expect(row.customFields).toEqual({ source_note: 'met at expo' });
    expect(row.userId).toBe(TENANT_A.owner);
  });

  it('keys that name the owner, sync, attribution or contact status are refused by name and nothing is created', async () => {
    const count = leadsOf(TENANT_A.listId).length;
    for (const extra of [
      { userId: TENANT_B.owner }, { tenantId: TENANT_B.orgId }, { accountOwnerUserId: TENANT_B.owner },
      { contactStatus: 'active' }, { firstTouch: { source: 'x' } }, { syncMetadata: { syncStatus: 'synced' } },
    ]) {
      const r = await a.call('manage_leads', { action: 'add', list_id: TENANT_A.listId, leads: [{ email: 'x@alpha.test', ...extra }] });
      const key = Object.keys(extra)[0];
      expect({ key, isError: r.isError, names: r.text.includes(key) }).toEqual({ key, isError: true, names: true });
    }
    expect(leadsOf(TENANT_A.listId).length).toBe(count);
  });

  it('several leads are created one by one and the answer counts what really happened (created, duplicate, failed)', async () => {
    const r = await a.call('manage_leads', {
      action: 'add', list_id: TENANT_A.listId,
      leads: [{ email: 'one@alpha.test' }, { email: a1.email }, { email: 'two@alpha.test' }],
    });
    expect(r.isError).toBe(false);
    expect(r.json).toMatchObject({ requested: 3, created: 2, duplicates: 1, failed: 0 });
    expect(r.json.results.map((x: any) => x.status)).toEqual(['created', 'duplicate', 'created']);
    expect(leadsOf(TENANT_A.listId).length).toBe(TENANT_A.leads.length + 2);
  });

  it('a refused row stops the whole call before anything is created (no half-applied batch)', async () => {
    const count = leadsOf(TENANT_A.listId).length;
    const r = await a.call('manage_leads', {
      action: 'add', list_id: TENANT_A.listId,
      leads: [{ email: 'ok@alpha.test' }, { email: 'bad@alpha.test', userId: TENANT_B.owner }],
    });
    expect(r.isError).toBe(true);
    expect(leadsOf(TENANT_A.listId).length).toBe(count);
  });

  it('into the other tenant\'s list creates nothing there, with one lead or several', async () => {
    const victim = snapshotTenant(fake, TENANT_B);
    for (const leads of [[{ email: 'p@x.test' }], [{ email: 'p@x.test' }, { email: 'q@x.test' }]]) {
      const r = await a.call('manage_leads', { action: 'add', list_id: TENANT_B.listId, leads });
      expect(r.isError).toBe(true);
      expect(r.text).not.toContain(TENANT_B.leads[0].email);
    }
    expect(snapshotTenant(fake, TENANT_B)).toBe(victim);
  });

  it('0 rows and more than 100 rows are refused', async () => {
    expect((await a.call('manage_leads', { action: 'add', list_id: TENANT_A.listId, leads: [] })).isError).toBe(true);
    const many = Array.from({ length: 101 }, (_, i) => ({ email: `m${i}@alpha.test` }));
    const r = await a.call('manage_leads', { action: 'add', list_id: TENANT_A.listId, leads: many });
    expect(r.isError).toBe(true);
    expect(leadsOf(TENANT_A.listId).length).toBe(TENANT_A.leads.length);
  });
});

describe('delete', () => {
  it('several ids: the answer counts what was really deleted; an id the caller cannot touch is a failure, not a success', async () => {
    const victim = snapshotTenant(fake, TENANT_B);
    const r = await a.call('manage_leads', { action: 'delete', list_id: TENANT_A.listId, lead_ids: [a1.leadId, b1.leadId, 'no-such-lead'] });
    expect(r.isError).toBe(false);
    expect(r.json).toMatchObject({ requested: 3, deleted: 1, failed: 2 });
    expect(r.json.results.map((x: any) => x.status)).toEqual(['deleted', 'failed', 'failed']);
    expect(leadRow(TENANT_A.listId, a1.leadId)).toBeUndefined();
    expect(leadRow(TENANT_A.listId, a2.leadId)).toBeDefined();
    expect(snapshotTenant(fake, TENANT_B)).toBe(victim);
    // The list's count follows what was really deleted: the REST DELETE lowers it for ANY id, so one for a lead that is not there would miscount.
    expect(listRowOf(TENANT_A.listId).leadCount).toBe(TENANT_A.leads.length - 1);
  });

  it('a single id that is not in the list is a 404 and leaves the list count alone', async () => {
    const r = await a.call('manage_leads', { action: 'delete', list_id: TENANT_A.listId, lead_ids: ['no-such-lead'] });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('(404)');
    expect(listRowOf(TENANT_A.listId).leadCount).toBe(TENANT_A.leads.length);
  });

  it('when none of several ids can be deleted the call is an error, not an empty success', async () => {
    const r = await a.call('manage_leads', { action: 'delete', list_id: TENANT_A.listId, lead_ids: [b1.leadId, 'no-such-lead'] });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('none of the attempted rows succeeded');
  });

  it('no ids, and more than 100 ids, are refused', async () => {
    for (const lead_ids of [undefined, [], Array.from({ length: 101 }, (_, i) => `l${i}`)]) {
      const r = await a.call('manage_leads', { action: 'delete', list_id: TENANT_A.listId, lead_ids });
      expect({ n: lead_ids?.length, isError: r.isError }).toEqual({ n: lead_ids?.length, isError: true });
    }
    expect(leadsOf(TENANT_A.listId).length).toBe(TENANT_A.leads.length);
  });
});

describe('list', () => {
  it('passes search through to the route that reads it (the page/limit/search/engaged_only/status names are the route\'s)', async () => {
    const r = await a.call('manage_leads', { action: 'list', list_id: TENANT_A.listId, search: 'Alice' });
    expect(r.isError).toBe(false);
    expect(r.text).toContain(a1.email);
    expect(r.text).not.toContain(a2.email);
    expect(r.text).not.toContain(b1.email);
  });

  it('a non-boolean engaged_only is refused instead of being silently ignored', async () => {
    const r = await a.call('manage_leads', { action: 'list', list_id: TENANT_A.listId, engaged_only: 'yes' });
    expect(r.isError).toBe(true);
  });
});

describe('create_lead_list update: Emma\'s eight fields, nothing else', () => {
  const listRow = (listId: string) => fake.items('AW-LeadLists').find((r: any) => r.listId === listId);
  const update = (extra: Record<string, unknown>, listId = TENANT_A.listId) =>
    a.call('create_lead_list', { action: 'update', list_id: listId, ...extra });

  it('sets name, description, the auto-draft switch and the status pipeline', async () => {
    const statusConfig = [{ value: 'qualified', label: 'Qualified', color: 'blue', type: 'active' }];
    const r = await update({ name: 'ALPHA renamed', description: 'about', auto_draft_enabled: true, status_config: statusConfig });
    expect(r.isError).toBe(false);
    expect(listRow(TENANT_A.listId)).toMatchObject({ name: 'ALPHA renamed', description: 'about', autoDraftEnabled: true, statusConfig });
  });

  it('saves an auto-draft instruction on its own route, keeping the current on/off switch when none is given', async () => {
    await update({ auto_draft_enabled: true });
    const r = await update({ auto_draft_instruction: 'Keep it short.' });
    expect(r.isError).toBe(false);
    expect(listRow(TENANT_A.listId)).toMatchObject({ autoDraftEnabled: true, autoDraftInstruction: 'Keep it short.' });
  });

  it('never forwards auto-send, alert copies, the list sender or the LinkedIn account, even when they are passed', async () => {
    const before = listRow(TENANT_A.listId);
    const r = await update({
      description: 'only this changes',
      autoSendEnabled: true, auto_send_enabled: true, alertCcEmails: ['outsider@elsewhere.test'], alert_cc_emails: ['outsider@elsewhere.test'],
      listSenderId: 'sender-x', linkedInAccountId: 'li-x', conversionMapping: { qualifiedStatus: null },
    });
    expect(r.isError).toBe(false);
    const after = listRow(TENANT_A.listId);
    expect(after.description).toBe('only this changes');
    for (const key of ['autoSendEnabled', 'alertCcEmails', 'listSenderId', 'linkedInAccountId', 'conversionMapping']) {
      expect({ key, value: after[key] }).toEqual({ key, value: before[key] });
    }
  });

  it('an empty update, a bad status pipeline and a second list_type are refused and change nothing', async () => {
    expect((await update({})).isError).toBe(true);
    expect((await update({ status_config: [{ value: 'x' }] })).isError).toBe(true);
    // The seeded list already has a type, so a change is refused; a list with none can be given one, once.
    const { listType: _typed, ...untyped } = listRow(TENANT_A.listId);
    expect((await update({ list_type: 'customers' })).isError).toBe(true);
    expect(listRow(TENANT_A.listId).listType).toBe('sales');
    fake.tables.get('AW-LeadLists')!.delete(TENANT_A.listId);
    fake.seed('AW-LeadLists', untyped);
    expect((await update({ list_type: 'customers' })).isError).toBe(false);
    expect(listRow(TENANT_A.listId).listType).toBe('customers');
    expect((await update({ list_type: 'sales' })).isError).toBe(true);
    expect(listRow(TENANT_A.listId).listType).toBe('customers');
  });

  it("the other tenant's list is refused for every field, the instruction included, and is left as it was", async () => {
    const victim = snapshotTenant(fake, TENANT_B);
    for (const extra of [{ name: 'HIJACKED' }, { auto_draft_instruction: 'HIJACKED' }, { auto_draft_enabled: true }, { status_config: [{ value: 'h', label: 'H', color: 'red', type: 'lost' }] }]) {
      const r = await update(extra, TENANT_B.listId);
      expect({ extra, isError: r.isError }).toEqual({ extra, isError: true });
    }
    expect(snapshotTenant(fake, TENANT_B)).toBe(victim);
  });
});

// ---- Found by the independent review of this PR ------------------------------------------------------------------------------------------

describe('update reads the lead first', () => {
  it('a standard-field update of a lead that does not exist is a 404 and creates nothing (the REST update would upsert a one-field row)', async () => {
    const before = leadsOf(TENANT_A.listId).length;
    const r = await a.call('manage_leads', { action: 'update', list_id: TENANT_A.listId, lead_id: 'ghost-lead', updates: { notes: 'x', company: 'Acme' } });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('(404)');
    expect(leadsOf(TENANT_A.listId).length).toBe(before);
    expect(leadRow(TENANT_A.listId, 'ghost-lead')).toBeUndefined();
  });

  it("a custom-field update keeps the custom fields the caller's own read hides (card-revenue data), because the merge starts from the stored lead", async () => {
    fake.seed('AW-Leads', { ...leadRow(TENANT_A.listId, a1.leadId), customFields: { region: 'EMEA', card_revenue_12m: 123456 } });
    const seen = await a.call('manage_leads', { action: 'get', list_id: TENANT_A.listId, lead_id: a1.leadId });
    expect(seen.json.customFields).toEqual({ region: 'EMEA' }); // the REST read hides it for this caller
    const r = await a.call('manage_leads', { action: 'update', list_id: TENANT_A.listId, lead_id: a1.leadId, updates: { tier: 'gold' } });
    expect(r.isError).toBe(false);
    expect(leadRow(TENANT_A.listId, a1.leadId).customFields).toEqual({ region: 'EMEA', card_revenue_12m: 123456, tier: 'gold' });
  });

  it('a name the tool refuses at the top level can be stored as the caller\'s own data inside customFields', async () => {
    const r = await a.call('manage_leads', { action: 'update', list_id: TENANT_A.listId, lead_id: a1.leadId, updates: { customFields: { user_id: 'crm-77', userId: 'u-1' } } });
    expect(r.isError).toBe(false);
    const row = leadRow(TENANT_A.listId, a1.leadId);
    expect(row.customFields).toMatchObject({ user_id: 'crm-77', userId: 'u-1' });
    expect(row.userId).toBe(TENANT_A.owner); // the lead's owner is unchanged
  });
});

describe('add: do-not-contact', () => {
  const OPTOUT = 'optout@alpha.test';
  beforeEach(() => {
    // The owner's address list: a do-not-contact lead in ANOTHER of A's lists, and one that belongs to tenant B.
    fake.seed('AW-LeadLists', { listId: 'list-a2', userId: TENANT_A.owner, name: 'ALPHA other', listType: 'sales', createdAt: '2026-11-18T10:00:00.000Z', leadCount: 1 });
    fake.seed('AW-Leads', { listId: 'list-a2', leadId: '900-optout', userId: TENANT_A.owner, name: 'Opt Out', email: OPTOUT, status: 'new', contactStatus: 'do-not-contact', contactStatusReason: 'requested', createdAt: '2026-11-18T10:00:00.000Z' });
    fake.seed('AW-Leads', { listId: TENANT_B.listId, leadId: '900-b-optout', userId: TENANT_B.owner, name: 'B Opt Out', email: 'b-optout@shared.test', status: 'new', contactStatus: 'do-not-contact', createdAt: '2026-11-18T10:00:00.000Z' });
  });

  it('several leads: an address the owner already marked do-not-contact is flagged on the new lead too, and the answer says so', async () => {
    const r = await a.call('manage_leads', { action: 'add', list_id: TENANT_A.listId, leads: [{ email: 'fresh@alpha.test' }, { email: OPTOUT }] });
    expect(r.isError).toBe(false);
    expect(r.json).toMatchObject({ requested: 2, created: 2, doNotContactCheckFailed: 0 });
    const flagged = leadsOf(TENANT_A.listId).find((l: any) => l.email === OPTOUT);
    expect(flagged).toMatchObject({ contactStatus: 'do-not-contact', unsubscribedFromGroupEmail: true });
    expect(r.json.inheritedDoNotContact).toEqual([flagged.leadId]);
    expect(leadsOf(TENANT_A.listId).find((l: any) => l.email === 'fresh@alpha.test').contactStatus).toBeUndefined();
  });

  it('one lead: same inheritance (the single-lead REST route does not do it), and the answer says so', async () => {
    const r = await a.call('manage_leads', { action: 'add', list_id: TENANT_A.listId, leads: [{ email: OPTOUT }] });
    expect(r.isError).toBe(false);
    expect(r.json).toMatchObject({ email: OPTOUT, inheritedDoNotContact: true });
    expect(leadsOf(TENANT_A.listId).find((l: any) => l.email === OPTOUT).contactStatus).toBe('do-not-contact');
  });

  it("another tenant's do-not-contact lead for the same address does not flag this tenant's new lead", async () => {
    const r = await a.call('manage_leads', { action: 'add', list_id: TENANT_A.listId, leads: [{ email: 'b-optout@shared.test' }, { email: 'x@alpha.test' }] });
    expect(r.isError).toBe(false);
    expect(r.json.inheritedDoNotContact).toEqual([]);
    expect(leadsOf(TENANT_A.listId).find((l: any) => l.email === 'b-optout@shared.test').contactStatus).toBeUndefined();
  });

  it('a new lead cannot be created with status do-not-contact (it would be labelled, not suppressed); nothing is created', async () => {
    const count = leadsOf(TENANT_A.listId).length;
    for (const leads of [[{ email: 'n@alpha.test', status: 'do-not-contact' }], [{ email: 'ok@alpha.test' }, { email: 'n2@alpha.test', status: 'Do Not Contact' }]]) {
      const r = await a.call('manage_leads', { action: 'add', list_id: TENANT_A.listId, leads });
      expect(r.isError).toBe(true);
      expect(r.text).toContain('cannot be created with status "do-not-contact"');
    }
    expect(leadsOf(TENANT_A.listId).length).toBe(count);
  });

  it("the status check reads do-not-contact exactly as Emma's suppression helper does", async () => {
    const { suppressionContactStatusUpdates } = await import('../emma/impl/leads');
    for (const status of ['do-not-contact', 'Do Not Contact', ' DO_NOT_CONTACT ', 'dnc', 'DNC', 'contacted', 'do not', '', null, undefined, 7, {}]) {
      const emma = Object.keys(suppressionContactStatusUpdates(status, null, 'u')).length > 0;
      expect({ status, isDoNotContact: isDoNotContactStatus(status) }).toEqual({ status, isDoNotContact: emma });
    }
  });
});

describe('add: profile fields and in-call duplicates', () => {
  it('website, companyLinkedin and attribution reach the lead (source tracking becomes first/last touch) instead of landing in custom fields', async () => {
    const r = await a.call('manage_leads', {
      action: 'add', list_id: TENANT_A.listId,
      leads: [{ email: 'src@alpha.test', website: 'https://src.example', companyLinkedin: 'https://linkedin.com/company/src', attribution: { utm: { source: 'expo', medium: 'booth' } } }],
    });
    expect(r.isError).toBe(false);
    const row = leadsOf(TENANT_A.listId).find((l: any) => l.email === 'src@alpha.test');
    expect(row).toMatchObject({ website: 'https://src.example', companyLinkedin: 'https://linkedin.com/company/src' });
    expect(row.firstTouch?.utm).toMatchObject({ source: 'expo', medium: 'booth' });
    expect(row.customFields).toEqual({});
  });

  it('the same address twice in one call: the second is counted as a duplicate, not created', async () => {
    const r = await a.call('manage_leads', { action: 'add', list_id: TENANT_A.listId, leads: [{ email: 'twice@alpha.test' }, { email: 'twice@alpha.test' }] });
    expect(r.isError).toBe(false);
    expect(r.json).toMatchObject({ requested: 2, created: 1, duplicates: 1, failed: 0 });
    expect(leadsOf(TENANT_A.listId).filter((l: any) => l.email === 'twice@alpha.test').length).toBe(1);
  });

  it('a call where every attempted row fails is an error even when one other row was a duplicate', async () => {
    const r = await a.call('manage_leads', { action: 'add', list_id: TENANT_A.listId, leads: [{ email: a1.email }, { email: 'bad@alpha.test', lifecycle: 'not-a-stage' }, { email: 'bad2@alpha.test', lifecycle: 'not-a-stage' }] });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('none of the attempted rows succeeded');
  });
});

describe('create_lead_list update: no half-applied updates', () => {
  const listRow2 = (listId: string) => fake.items('AW-LeadLists').find((r: any) => r.listId === listId);

  it('an instruction over 2000 characters is refused BEFORE any field is saved', async () => {
    const r = await a.call('create_lead_list', { action: 'update', list_id: TENANT_A.listId, name: 'SHOULD NOT SAVE', auto_draft_instruction: 'x'.repeat(2001) });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('2000 characters or fewer');
    expect(listRow2(TENANT_A.listId).name).toBe(TENANT_A.listName);
  });

  it('when the second save fails after the first succeeded, the error says which part was saved', async () => {
    const { crmDb } = await import('../services/db');
    const original = crmDb.updateLeadList.bind(crmDb);
    const spy = jest.spyOn(crmDb, 'updateLeadList');
    spy.mockImplementationOnce(original as any).mockRejectedValueOnce(new Error('storage unavailable'));
    try {
      const r = await a.call('create_lead_list', { action: 'update', list_id: TENANT_A.listId, name: 'RENAMED', auto_draft_instruction: 'Short.' });
      expect(r.isError).toBe(true);
      expect(r.text).toContain('the other fields were saved, but the auto-draft instruction was not');
      expect(listRow2(TENANT_A.listId).name).toBe('RENAMED');
    } finally {
      spy.mockRestore();
    }
  });
});

// ---- Found by the focused review of the fixes ---------------------------------------------------------------------------------------------

describe('add: drafts and source tracking', () => {
  it('drafts are refused on add (createLead would drop them and the call would still report success); an update saves them', async () => {
    const count = leadsOf(TENANT_A.listId).length;
    for (const extra of [
      { emailDraft: { subject: 'Hi', textContent: 'Hello' } },
      { messageDraft: 'Hello there' },
      { emailDraftFormat: 'html' },
      { status: 'pending_review', emailDraft: { subject: 'Hi', textContent: 'Hello' } },
    ]) {
      const r = await a.call('manage_leads', { action: 'add', list_id: TENANT_A.listId, leads: [{ email: 'drafty@alpha.test', ...extra }] });
      const key = Object.keys(extra).find((k) => k !== 'status')!;
      expect({ key, isError: r.isError, names: r.text.includes(key) }).toEqual({ key, isError: true, names: true });
      expect(r.text).toContain('Drafts are saved with an update');
    }
    expect(leadsOf(TENANT_A.listId).length).toBe(count);

    const saved = await a.call('manage_leads', { action: 'update', list_id: TENANT_A.listId, lead_id: a1.leadId, updates: { emailDraft: { subject: 'Hi', textContent: 'Hello' } } });
    expect(saved.isError).toBe(false);
    expect(leadRow(TENANT_A.listId, a1.leadId).emailDraft).toMatchObject({ subject: 'Hi' });
  });

  it('only attribution.utm (short strings) is accepted; click ids, referrer, landing URL, extra parameters and the bare utm key are refused by name', async () => {
    const count = leadsOf(TENANT_A.listId).length;
    for (const [attribution, named] of [
      [{ utm: { source: 'expo' }, clickIds: { fbclid: 'x' } }, 'attribution.clickIds'],
      [{ referrer: 'https://x.example' }, 'attribution.referrer'],
      [{ landingUrl: 'https://x.example/lp' }, 'attribution.landingUrl'],
      [{ utm: { source: 'expo', gclid: 'x' } }, 'attribution.utm.gclid'],
      [{ utm: { source: { nested: true } } }, 'attribution.utm.source'],
      ['not-an-object', 'attribution (must be'],
    ] as Array<[unknown, string]>) {
      const r = await a.call('manage_leads', { action: 'add', list_id: TENANT_A.listId, leads: [{ email: 'src2@alpha.test', attribution }] });
      expect({ named, isError: r.isError, names: r.text.includes(named) }).toEqual({ named, isError: true, names: true });
    }
    const bare = await a.call('manage_leads', { action: 'add', list_id: TENANT_A.listId, leads: [{ email: 'src2@alpha.test', utm: { source: 'expo' } }] });
    expect(bare.isError).toBe(true);
    expect(bare.text).toContain('utm');
    expect(leadsOf(TENANT_A.listId).length).toBe(count);
  });

  it('a long utm value is shortened, and attribution is refused on update', async () => {
    const r = await a.call('manage_leads', { action: 'add', list_id: TENANT_A.listId, leads: [{ email: 'long@alpha.test', attribution: { utm: { source: 'x'.repeat(500) } } }] });
    expect(r.isError).toBe(false);
    expect(leadsOf(TENANT_A.listId).find((l: any) => l.email === 'long@alpha.test').firstTouch.utm.source.length).toBe(200);
    for (const updates of [{ attribution: { utm: { source: 'x' } } }, { utm: { source: 'x' } }]) {
      const u = await a.call('manage_leads', { action: 'update', list_id: TENANT_A.listId, lead_id: a1.leadId, updates });
      expect({ updates, isError: u.isError }).toEqual({ updates, isError: true });
    }
  });
});

describe('update fails closed when the stored lead cannot be read', () => {
  it('a failed or empty stored read saves nothing instead of merging into the REST copy (which hides card-revenue fields)', async () => {
    fake.seed('AW-Leads', { ...leadRow(TENANT_A.listId, a1.leadId), customFields: { region: 'EMEA', card_revenue_12m: 123456 } });
    const before = JSON.stringify(leadRow(TENANT_A.listId, a1.leadId));
    const { crmDb } = await import('../services/db');
    const original = crmDb.getLeadById.bind(crmDb);
    process.env.CRM_LEAD_PUT_GUARD = 'enforce'; // the read-merge path (key-by-key writes need no read)
    for (const second of [() => Promise.reject(new Error('throttled')), () => Promise.resolve(undefined)]) {
      const spy = jest.spyOn(crmDb, 'getLeadById');
      // The REST read (first call) is real; the module's own stored read (second call) is the one that fails.
      spy.mockImplementationOnce(original as any).mockImplementationOnce(second as any);
      try {
        const r = await a.call('manage_leads', { action: 'update', list_id: TENANT_A.listId, lead_id: a1.leadId, updates: { tier: 'gold' } });
        expect(r.isError).toBe(true);
        expect(r.text).toMatch(/Nothing was saved|were not changed/);
        expect(JSON.stringify(leadRow(TENANT_A.listId, a1.leadId))).toBe(before);
      } finally {
        spy.mockRestore();
      }
    }
    delete process.env.CRM_LEAD_PUT_GUARD;
  });

  it('a list_id or lead_id that is not a string is refused before anything is read or written', async () => {
    const before = snapshotTenant(fake, TENANT_A);
    for (const args of [
      { action: 'update', list_id: [TENANT_A.listId], lead_id: a1.leadId, updates: { notes: 'x' } },
      { action: 'update', list_id: TENANT_A.listId, lead_id: [a1.leadId], updates: { notes: 'x' } },
      { action: 'add', list_id: [TENANT_A.listId], leads: [{ email: 'arr@alpha.test' }] },
      { action: 'delete', list_id: { id: TENANT_A.listId }, lead_ids: [a1.leadId] },
    ]) {
      const r = await a.call('manage_leads', args);
      expect({ action: args.action, isError: r.isError }).toEqual({ action: args.action, isError: true });
    }
    expect(snapshotTenant(fake, TENANT_A)).toBe(before);
  });
});

describe('add: same address within one call, and the owner of the list', () => {
  it('the same address in different case or with padding is a duplicate of the earlier row, decided without asking the route', async () => {
    const r = await a.call('manage_leads', {
      action: 'add', list_id: TENANT_A.listId,
      leads: [{ email: 'Mixed@Alpha.test' }, { email: ' mixed@alpha.test ' }, { email: 'other@alpha.test' }],
    });
    expect(r.isError).toBe(false);
    expect(r.json).toMatchObject({ requested: 3, created: 2, duplicates: 1, failed: 0 });
    expect(r.json.results[1]).toMatchObject({ status: 'duplicate', error: expect.stringContaining('same address as an earlier row') });
  });

  it("an org owner adding to a member's list uses the LIST owner for the do-not-contact check (the member's own opt-outs flag the new lead)", async () => {
    const stamp = '2026-11-18T10:00:00.000Z';
    fake.seed('AW-LeadLists', { listId: 'list-a-member', userId: TENANT_A.member, name: 'ALPHA member list', listType: 'sales', createdAt: stamp, leadCount: 0 });
    fake.seed('AW-LeadLists', { listId: 'list-a-member-2', userId: TENANT_A.member, name: 'ALPHA member other', listType: 'sales', createdAt: stamp, leadCount: 1 });
    fake.seed('AW-Leads', { listId: 'list-a-member-2', leadId: '800-m-optout', userId: TENANT_A.member, name: 'M Opt', email: 'member-optout@alpha.test', status: 'new', contactStatus: 'do-not-contact', createdAt: stamp });
    const r = await a.call('manage_leads', { action: 'add', list_id: 'list-a-member', leads: [{ email: 'member-optout@alpha.test' }, { email: 'fine@alpha.test' }] });
    expect(r.isError).toBe(false);
    expect(r.json).toMatchObject({ created: 2, doNotContactCheckFailed: 0 });
    expect(leadsOf('list-a-member').find((l: any) => l.email === 'member-optout@alpha.test').contactStatus).toBe('do-not-contact');
    expect(leadsOf('list-a-member').find((l: any) => l.email === 'fine@alpha.test').contactStatus).toBeUndefined();
  });
});

// ---- Found by the fresh full review of the final head ------------------------------------------------------------------------------------

describe('update: consistent merge base and field types', () => {
  it('where the whole map is merged and written back (the portal route is in enforce mode and drops the key-by-key flag), the stored read behind the merge is a CONSISTENT read', async () => {
    const { crmDb } = await import('../services/db');
    const spy = jest.spyOn(crmDb, 'getLeadById');
    process.env.CRM_LEAD_PUT_GUARD = 'enforce';
    try {
      const r = await a.call('manage_leads', { action: 'update', list_id: TENANT_A.listId, lead_id: a1.leadId, updates: { tier: 'gold' } });
      expect(r.isError).toBe(false);
      expect(spy.mock.calls.some(([, , opts]) => (opts as any)?.consistentRead === true)).toBe(true);
    } finally {
      delete process.env.CRM_LEAD_PUT_GUARD;
      spy.mockRestore();
    }
  });

  it('a lead with no custom-field map is merged without a false corruption alarm in the log', async () => {
    const { customFields: _gone, ...bare } = leadRow(TENANT_A.listId, a2.leadId);
    fake.seed('AW-Leads', bare);
    const err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const r = await a.call('manage_leads', { action: 'update', list_id: TENANT_A.listId, lead_id: a2.leadId, updates: { tier: 'gold' } });
      expect(r.isError).toBe(false);
      expect(err.mock.calls.filter((c) => String(c[0]).includes('customFieldsGuard'))).toEqual([]);
    } finally {
      err.mockRestore();
    }
  });

  it('a status that is not non-empty text is refused and no engagement is written (the route would record it before validating)', async () => {
    const before = JSON.stringify(leadRow(TENANT_A.listId, a1.leadId));
    for (const status of [{ value: 'won' }, '', '   ', null, 7, ['won']]) {
      const r = await a.call('manage_leads', { action: 'update', list_id: TENANT_A.listId, lead_id: a1.leadId, updates: { status } });
      expect({ status, isError: r.isError, named: r.text.includes('status (must be non-empty text)') }).toEqual({ status, isError: true, named: true });
    }
    expect(JSON.stringify(leadRow(TENANT_A.listId, a1.leadId))).toBe(before);
  });

  it('other standard fields of the wrong type are refused by name; null clears a text field', async () => {
    for (const [updates, named] of [
      [{ notes: { text: 'x' } }, 'notes (must be text)'],
      [{ dealValue: '1000' }, 'dealValue (must be a number)'],
      [{ pocEmails: 'a@b.test' }, 'pocEmails (must be a list'],
    ] as Array<[Record<string, unknown>, string]>) {
      const r = await a.call('manage_leads', { action: 'update', list_id: TENANT_A.listId, lead_id: a1.leadId, updates });
      expect({ updates, isError: r.isError, named: r.text.includes(named) }).toEqual({ updates, isError: true, named: true });
    }
    // isPrimary is a create-time field: its type is checked on add (an update refuses it by name).
    const badAdd = await a.call('manage_leads', { action: 'add', list_id: TENANT_A.listId, leads: [{ email: 'prim@alpha.test', isPrimary: 'yes' }] });
    expect(badAdd.isError).toBe(true);
    expect(badAdd.text).toContain('isPrimary (must be true or false)');
    const cleared = await a.call('manage_leads', { action: 'update', list_id: TENANT_A.listId, lead_id: a1.leadId, updates: { company: 'Alpha Inc' } });
    expect(cleared.isError).toBe(false);
    const clear2 = await a.call('manage_leads', { action: 'update', list_id: TENANT_A.listId, lead_id: a1.leadId, updates: { company: null } });
    expect(clear2.isError).toBe(false);
  });

  it('CRM fields the verbatim forward used to honour keep working: the update layer stores domain and pocEmails, the create layer stores priority, role, isPrimary, dates and scores; links to deals and enrichment results are refused', async () => {
    const ok = await a.call('manage_leads', { action: 'update', list_id: TENANT_A.listId, lead_id: a1.leadId, updates: { domain: 'alpha.example', pocEmails: ['poc@alpha.test'] } });
    expect(ok.isError).toBe(false);
    expect(leadRow(TENANT_A.listId, a1.leadId)).toMatchObject({ domain: 'alpha.example', pocEmails: ['poc@alpha.test'] });
    expect(leadRow(TENANT_A.listId, a1.leadId).customFields).toEqual({ region: 'EMEA', tier: 'gold' });

    const created = await a.call('manage_leads', {
      action: 'add', list_id: TENANT_A.listId,
      leads: [{ email: 'crmfields@alpha.test', priority: 'High', role: 'KDM', isPrimary: true, expectedClose: '2026-12-31', closedDate: '2027-01-15', heatScore: 60, healthScore: 70 }],
    });
    expect(created.isError).toBe(false);
    const row = leadsOf(TENANT_A.listId).find((l: any) => l.email === 'crmfields@alpha.test');
    expect(row).toMatchObject({ priority: 'High', role: 'KDM', isPrimary: true, expectedClose: '2026-12-31', closedDate: '2027-01-15', heatScore: 60, healthScore: 70 });
    expect(row.customFields).toEqual({});

    // A value the create layer rejects (it validates priority, role and the score ranges) fails the add and creates nothing.
    const count = leadsOf(TENANT_A.listId).length;
    for (const bad of [{ priority: 'Urgent' }, { role: 'Boss' }, { heatScore: 500 }]) {
      const r = await a.call('manage_leads', { action: 'add', list_id: TENANT_A.listId, leads: [{ email: 'badcrm@alpha.test', ...bad }] });
      expect({ bad, isError: r.isError }).toEqual({ bad, isError: true });
    }
    expect(leadsOf(TENANT_A.listId).length).toBe(count);

    const before = JSON.stringify(leadRow(TENANT_A.listId, a1.leadId));
    for (const key of ['dealIds', 'icpMatch', 'enrichmentMetadata']) {
      const r = await a.call('manage_leads', { action: 'update', list_id: TENANT_A.listId, lead_id: a1.leadId, updates: { [key]: key === 'dealIds' ? ['deal-of-another-account'] : { x: 1 } } });
      expect({ key, isError: r.isError, named: r.text.includes(key) }).toEqual({ key, isError: true, named: true });
      const a2r = await a.call('manage_leads', { action: 'add', list_id: TENANT_A.listId, leads: [{ email: `x-${key}@alpha.test`, [key]: key === 'dealIds' ? ['deal-of-another-account'] : { x: 1 } }] });
      expect({ key, isError: a2r.isError, named: a2r.text.includes(key) }).toEqual({ key, isError: true, named: true });
    }
    expect(JSON.stringify(leadRow(TENANT_A.listId, a1.leadId))).toBe(before);
    expect(leadsOf(TENANT_A.listId).length).toBe(count + 0);
  });
});

describe('do-not-contact: delete, email change, unchecked leads', () => {
  const stamp = '2026-11-18T10:00:00.000Z';
  const OPTOUT = 'optout2@alpha.test';
  beforeEach(() => {
    fake.seed('AW-LeadLists', { listId: 'list-a3', userId: TENANT_A.owner, name: 'ALPHA third', listType: 'sales', createdAt: stamp, leadCount: 1 });
    fake.seed('AW-Leads', { listId: 'list-a3', leadId: '950-optout', userId: TENANT_A.owner, name: 'Opt Out Two', email: OPTOUT, status: 'new', contactStatus: 'do-not-contact', createdAt: stamp });
  });

  it('a lead marked do-not-contact is not deleted (single id, or counted as failed among several); an ordinary lead is', async () => {
    const one = await a.call('manage_leads', { action: 'delete', list_id: 'list-a3', lead_ids: ['950-optout'] });
    expect(one.isError).toBe(true);
    expect(one.text).toContain('marked do-not-contact');
    expect(leadsOf('list-a3').length).toBe(1);

    fake.seed('AW-Leads', { listId: 'list-a3', leadId: '951-plain', userId: TENANT_A.owner, name: 'Plain', email: 'plain3@alpha.test', status: 'new', createdAt: stamp });
    const many = await a.call('manage_leads', { action: 'delete', list_id: 'list-a3', lead_ids: ['950-optout', '951-plain'] });
    expect(many.isError).toBe(false);
    expect(many.json).toMatchObject({ requested: 2, deleted: 1, failed: 1 });
    expect(many.json.results[0].error).toContain('marked do-not-contact');
    expect(leadRow('list-a3', '950-optout')).toBeDefined();
    expect(leadRow('list-a3', '951-plain')).toBeUndefined();
  });

  it('a legacy opt-out (unsubscribedFromGroupEmail, no contactStatus) is protected from deletion too', async () => {
    fake.seed('AW-Leads', { listId: 'list-a3', leadId: '952-legacy', userId: TENANT_A.owner, name: 'Legacy', email: 'legacy3@alpha.test', status: 'new', unsubscribedFromGroupEmail: true, createdAt: stamp });
    const r = await a.call('manage_leads', { action: 'delete', list_id: 'list-a3', lead_ids: ['952-legacy'] });
    expect(r.isError).toBe(true);
    expect(leadRow('list-a3', '952-legacy')).toBeDefined();
  });

  it("changing a lead's email to an address the owner marked do-not-contact flags the lead, and says so", async () => {
    const r = await a.call('manage_leads', { action: 'update', list_id: TENANT_A.listId, lead_id: a2.leadId, updates: { email: OPTOUT } });
    expect(r.isError).toBe(false);
    expect(r.json).toMatchObject({ inheritedDoNotContact: true });
    expect(leadRow(TENANT_A.listId, a2.leadId)).toMatchObject({ email: OPTOUT, contactStatus: 'do-not-contact' });
    // An ordinary address changes nothing.
    const plain = await a.call('manage_leads', { action: 'update', list_id: TENANT_A.listId, lead_id: a1.leadId, updates: { email: 'fine2@alpha.test' } });
    expect(plain.isError).toBe(false);
    expect(plain.json.inheritedDoNotContact).toBeUndefined();
    expect(leadRow(TENANT_A.listId, a1.leadId).contactStatus).toBeUndefined();
  });

  it('when the do-not-contact check itself fails, the lead is still created and the answer names the leads that were NOT checked', async () => {
    const svc = await import('../services/leadImportFollowups');
    const spy = jest.spyOn(svc, 'applyLeadImportFollowups').mockRejectedValue(new Error('lookup unavailable'));
    const err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const multi = await a.call('manage_leads', { action: 'add', list_id: TENANT_A.listId, leads: [{ email: 'u1@alpha.test' }, { email: 'u2@alpha.test' }] });
      expect(multi.isError).toBe(false);
      const ids = multi.json.results.map((x: any) => x.leadId);
      expect(multi.json).toMatchObject({ created: 2, doNotContactCheckFailed: 2 });
      expect(multi.json.doNotContactUnchecked.sort()).toEqual([...ids].sort());
      const single = await a.call('manage_leads', { action: 'add', list_id: TENANT_A.listId, leads: [{ email: 'u3@alpha.test' }] });
      expect(single.json).toMatchObject({ email: 'u3@alpha.test', doNotContactCheckFailed: 1 });
      expect(single.json.doNotContactUnchecked).toEqual([single.json.leadId]);
    } finally {
      spy.mockRestore();
      err.mockRestore();
    }
  });
});

describe('add: a refused row is named, and a non-object lead fails closed', () => {
  it('the error names the row in a multi-row add', async () => {
    const r = await a.call('manage_leads', { action: 'add', list_id: TENANT_A.listId, leads: [{ email: 'ok1@alpha.test' }, { email: 'ok2@alpha.test' }, { email: 'bad@alpha.test', userId: 'x' }] });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('(row 2)');
    expect(leadsOf(TENANT_A.listId).length).toBe(TENANT_A.leads.length);
  });

  it('buildLeadCreateBody refuses anything that is not a plain object instead of returning an empty lead', async () => {
    const { buildLeadCreateBody } = await import('../mcp/server/manageLeadsWrites');
    for (const bad of [null, undefined, 'x', 7, [], Object.create(null)]) {
      expect(() => buildLeadCreateBody(bad)).toThrow('must be an object');
    }
  });
});

describe('a member who is not an editor of the list cannot write to it', () => {
  it('update, add, delete and a list update by a same-org member without editor rights are refused and change nothing', async () => {
    const member = await connectCaller(TENANT_A.member!);
    try {
      const before = snapshotTenant(fake, TENANT_A);
      for (const [tool, args] of [
        ['manage_leads', { action: 'update', list_id: TENANT_A.listId, lead_id: a1.leadId, updates: { status: 'do-not-contact' } }],
        ['manage_leads', { action: 'add', list_id: TENANT_A.listId, leads: [{ email: 'm1@alpha.test' }, { email: 'm2@alpha.test' }] }],
        ['manage_leads', { action: 'delete', list_id: TENANT_A.listId, lead_ids: [a1.leadId, a2.leadId] }],
        ['create_lead_list', { action: 'update', list_id: TENANT_A.listId, name: 'MEMBER RENAME', auto_draft_instruction: 'x' }],
      ] as Array<[string, Record<string, unknown>]>) {
        const r = await member.call(tool, args);
        // Either a clear refusal, or (delete of several) a call whose every row failed: never a success that changed data.
        expect({ tool, action: args.action, changed: false, isError: r.isError }).toEqual({ tool, action: args.action, changed: false, isError: true });
      }
      expect(snapshotTenant(fake, TENANT_A)).toBe(before);
    } finally {
      await member.close();
    }
  });
});

describe('create_lead_list update: duplicate status values', () => {
  it('two stages with the same value are refused before anything is saved', async () => {
    const dup = [{ value: 'qualified', label: 'Qualified', color: 'blue', type: 'active' }, { value: ' Qualified ', label: 'Again', color: 'red', type: 'lost' }];
    const r = await a.call('create_lead_list', { action: 'update', list_id: TENANT_A.listId, name: 'SHOULD NOT SAVE', status_config: dup });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('duplicate status values: qualified');
    expect(fake.items('AW-LeadLists').find((l: any) => l.listId === TENANT_A.listId).name).toBe(TENANT_A.listName);
  });
});

// ---- Found by the THIRD review (final head f838eda7e: DO NOT SHIP until the email-edit hole was closed) -------------------------------------

describe('an opted-out lead keeps its address (editing it was a way to un-suppress)', () => {
  it('suppress, then change or clear the email: refused; the same address is a no-op; the address still flags a re-add elsewhere', async () => {
    const X = a1.email;
    const sup = await a.call('manage_leads', { action: 'update', list_id: TENANT_A.listId, lead_id: a1.leadId, updates: { status: 'do-not-contact' } });
    expect(sup.isError).toBe(false);
    const before = JSON.stringify(leadRow(TENANT_A.listId, a1.leadId));
    for (const email of ['moved@alpha.test', null, '', '   ']) {
      const r = await a.call('manage_leads', { action: 'update', list_id: TENANT_A.listId, lead_id: a1.leadId, updates: { email } });
      expect({ email, isError: r.isError, said: r.text.includes('marked do-not-contact') }).toEqual({ email, isError: true, said: true });
    }
    expect(JSON.stringify(leadRow(TENANT_A.listId, a1.leadId))).toBe(before);
    // Writing the same address (any case or padding) changes nothing and is allowed.
    const same = await a.call('manage_leads', { action: 'update', list_id: TENANT_A.listId, lead_id: a1.leadId, updates: { email: `  ${X.toUpperCase()} `, notes: 'kept' } });
    expect(same.isError).toBe(false);
    // The address still flags a new lead for it in another list of the owner's.
    fake.seed('AW-LeadLists', { listId: 'list-a9', userId: TENANT_A.owner, name: 'ALPHA ninth', listType: 'sales', createdAt: '2026-11-18T10:00:00.000Z', leadCount: 0 });
    const readd = await a.call('manage_leads', { action: 'add', list_id: 'list-a9', leads: [{ email: X }] });
    expect(readd.isError).toBe(false);
    expect(readd.json).toMatchObject({ inheritedDoNotContact: true });
    expect(leadsOf('list-a9')[0].contactStatus).toBe('do-not-contact');
  });

  it('an ordinary lead can still change its email', async () => {
    const r = await a.call('manage_leads', { action: 'update', list_id: TENANT_A.listId, lead_id: a2.leadId, updates: { email: 'arnold2@alpha.test' } });
    expect(r.isError).toBe(false);
    expect(leadRow(TENANT_A.listId, a2.leadId).email).toBe('arnold2@alpha.test');
  });
});

describe('update: fields the update layer does not store, drafts, system-owned custom keys', () => {
  it('priority, role, isPrimary, expectedClose, closedDate, heatScore and healthScore are refused by name on update (they would be dropped while the call said success)', async () => {
    const before = JSON.stringify(leadRow(TENANT_A.listId, a1.leadId));
    for (const updates of [{ priority: 'High' }, { role: 'KDM' }, { isPrimary: true }, { expectedClose: '2026-12-31' }, { closedDate: '2027-01-01' }, { heatScore: 50 }, { healthScore: 50 }]) {
      const key = Object.keys(updates)[0];
      const r = await a.call('manage_leads', { action: 'update', list_id: TENANT_A.listId, lead_id: a1.leadId, updates });
      expect({ key, isError: r.isError, named: r.text.includes(key), hint: r.text.includes('when a lead is added') }).toEqual({ key, isError: true, named: true, hint: true });
    }
    expect(JSON.stringify(leadRow(TENANT_A.listId, a1.leadId))).toBe(before);
  });

  it('drafts must have the real shape: strings, objects with the right keys, "text" or "html"; they are stored with their times; null clears', async () => {
    const before = JSON.stringify(leadRow(TENANT_A.listId, a1.leadId));
    for (const updates of [
      { emailDraft: 'just a string' }, { emailDraft: { subject: 1 } }, { emailDraft: { subject: 'S', evil: 'x' } }, { emailDraft: {} },
      { messageDraft: { content: 1 } }, { messageDraft: '   ' }, { messageDraft: { content: 'x', extra: 1 } }, { emailDraftFormat: 'weird' },
    ]) {
      const r = await a.call('manage_leads', { action: 'update', list_id: TENANT_A.listId, lead_id: a1.leadId, updates });
      expect({ updates, isError: r.isError }).toEqual({ updates, isError: true });
    }
    expect(JSON.stringify(leadRow(TENANT_A.listId, a1.leadId))).toBe(before);

    const ok = await a.call('manage_leads', {
      action: 'update', list_id: TENANT_A.listId, lead_id: a1.leadId,
      updates: { emailDraft: { subject: 'Hi', htmlContent: '<p>Hello</p>' }, emailDraftFormat: 'html', messageDraft: 'Hello on LinkedIn' },
    });
    expect(ok.isError).toBe(false);
    const row = leadRow(TENANT_A.listId, a1.leadId);
    expect(row.emailDraft).toMatchObject({ subject: 'Hi', htmlContent: '<p>Hello</p>' });
    expect(typeof row.emailDraft.createdAt).toBe('string');
    expect(row.messageDraft).toMatchObject({ content: 'Hello on LinkedIn' });
    expect(row.emailDraftFormat).toBe('html');

    const cleared = await a.call('manage_leads', { action: 'update', list_id: TENANT_A.listId, lead_id: a1.leadId, updates: { emailDraft: null, messageDraft: null } });
    expect(cleared.isError).toBe(false);
    expect(leadRow(TENANT_A.listId, a1.leadId).emailDraft).toBeUndefined();
    expect(leadRow(TENANT_A.listId, a1.leadId).messageDraft).toBeUndefined();
  });

  it('customFields.email_validation (read by the send-eligibility check) cannot be written, at the top level or inside customFields, on update or add', async () => {
    const before = JSON.stringify(leadRow(TENANT_A.listId, a1.leadId));
    for (const updates of [{ email_validation: { status: 'deliverable' } }, { customFields: { email_validation: { status: 'deliverable' } } }]) {
      const r = await a.call('manage_leads', { action: 'update', list_id: TENANT_A.listId, lead_id: a1.leadId, updates });
      expect({ updates, isError: r.isError, named: r.text.includes('email_validation') }).toEqual({ updates, isError: true, named: true });
    }
    const add = await a.call('manage_leads', { action: 'add', list_id: TENANT_A.listId, leads: [{ email: 'ev@alpha.test', customFields: { email_validation: { status: 'deliverable' } } }] });
    expect(add.isError).toBe(true);
    expect(JSON.stringify(leadRow(TENANT_A.listId, a1.leadId))).toBe(before);
    expect(leadsOf(TENANT_A.listId).find((l: any) => l.email === 'ev@alpha.test')).toBeUndefined();
  });
});

describe('delete: the same id twice, and a list that holds opted-out leads', () => {
  it('a repeated id is one lead (not a failure), and the answer says it was ignored', async () => {
    const r = await a.call('manage_leads', { action: 'delete', list_id: TENANT_A.listId, lead_ids: [a1.leadId, a1.leadId, a2.leadId] });
    expect(r.isError).toBe(false);
    expect(r.json).toMatchObject({ requested: 2, deleted: 2, failed: 0, duplicateIdsIgnored: 1 });
    const same = await a.call('manage_leads', { action: 'delete', list_id: TENANT_A.listId, lead_ids: ['no-such-1', 'no-such-1'] });
    expect(same.isError).toBe(true); // one id, not found: a 404, not a success
  });

  it('create_lead_list delete is refused while the list holds a lead marked do-not-contact, and the list and its leads stay', async () => {
    await a.call('manage_leads', { action: 'update', list_id: TENANT_A.listId, lead_id: a1.leadId, updates: { status: 'do-not-contact' } });
    const before = snapshotTenant(fake, TENANT_A);
    const r = await a.call('create_lead_list', { action: 'delete', list_id: TENANT_A.listId });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('1 lead(s) marked do-not-contact');
    expect(snapshotTenant(fake, TENANT_A)).toBe(before);
    // The other tenant's list is refused by the route before anything is read.
    const foreign = await a.call('create_lead_list', { action: 'delete', list_id: TENANT_B.listId });
    expect(foreign.isError).toBe(true);
    expect(foreign.text).not.toContain(TENANT_B.leads[0].email);
  });
});

describe('list: page and limit are whole numbers', () => {
  it('anything else is refused instead of becoming NaN in the route', async () => {
    for (const bad of [{ limit: 'x' }, { limit: '1.5' }, { limit: '-3' }, { limit: 1.5 }, { page: -1 }, { page: '0x10' }, { page: { n: 1 } }, { limit: { a: 1 } }, { engaged_only: 'maybe' }, { engaged_only: 1 }]) {
      const r = await a.call('manage_leads', { action: 'list', list_id: TENANT_A.listId, ...bad });
      expect({ bad, isError: r.isError }).toEqual({ bad, isError: true });
    }
    const ok = await a.call('manage_leads', { action: 'list', list_id: TENANT_A.listId, page: 1, limit: 10 });
    expect(ok.isError).toBe(false);
  });

  // Found by Opslane (run 2309, P2) on head 6f980cf98: the older list call forwarded `limit` as text and skipped a falsy one, so these worked before.
  it('a number sent as text, and an empty or 0 value, still list (as the older call did); true/false may be text', async () => {
    const own = leadsOf(TENANT_A.listId).length;
    for (const good of [{ limit: '50' }, { limit: ' 50 ' }, { limit: '' }, { limit: 0 }, { limit: '0' }, { page: '1' }, { page: 0 }, { page: '' }, { limit: null }, { engaged_only: '' }, { engaged_only: '  ' }, { engaged_only: 'false' }, { engaged_only: 'FALSE' }, { engaged_only: false }]) {
      const r = await a.call('manage_leads', { action: 'list', list_id: TENANT_A.listId, ...good });
      expect({ good, isError: r.isError, rows: r.isError ? null : r.json.leads?.length }).toEqual({ good, isError: false, rows: own });
    }
  });

  it('the values sent to the route are exactly what was meant (digits become the number; empty and 0 are not sent)', async () => {
    const { buildLeadListQuery } = await import('../mcp/server/manageLeadsWrites');
    expect(buildLeadListQuery({ limit: '50', page: ' 2 ', engaged_only: 'TRUE', search: ' x ', status: ' new ' })).toEqual({ limit: '50', page: '2', engagedOnly: 'true', search: 'x', status: 'new' });
    expect(buildLeadListQuery({ limit: '', page: 0, engaged_only: '', search: '  ' })).toEqual({});
    expect(buildLeadListQuery({ limit: 25, engaged_only: false })).toEqual({ limit: '25', engagedOnly: 'false' });
  });

  it('search and status are text: a number becomes text, anything else is refused instead of being dropped (a dropped filter returns the whole page and looks like a match)', async () => {
    const { buildLeadListQuery } = await import('../mcp/server/manageLeadsWrites');
    expect(buildLeadListQuery({ search: 94107, status: ' new ' })).toEqual({ search: '94107', status: 'new' });
    expect(buildLeadListQuery({ search: '', status: '   ', limit: undefined })).toEqual({});
    for (const bad of [{ search: true }, { search: { q: 'x' } }, { search: ['x'] }, { status: false }, { status: { s: 'new' } }, { search: Number.NaN }]) {
      expect(() => buildLeadListQuery(bad)).toThrow(/must be text/);
      const r = await a.call('manage_leads', { action: 'list', list_id: TENANT_A.listId, ...bad });
      expect({ bad, isError: r.isError }).toEqual({ bad, isError: true });
    }
  });
});

// ---- Found by the FOURTH review (final head b3ffcf33c: DO NOT SHIP until these two reproduced problems were closed) -----------------------------

describe('an opted-out lead keeps its compliance record', () => {
  const stamp = '2026-11-18T10:00:00.000Z';
  const X = 'twin-optout@alpha.test';
  beforeEach(() => {
    // An opted-out lead with a human's reason, note and actor, and a twin with the same address in another list (the original plus an inherited copy).
    fake.seed('AW-LeadLists', { listId: 'list-a5', userId: TENANT_A.owner, name: 'ALPHA fifth', listType: 'sales', createdAt: stamp, leadCount: 1 });
    fake.seed('AW-Leads', {
      listId: TENANT_A.listId, leadId: '700-orig', userId: TENANT_A.owner, name: 'Orig', email: X, status: 'new',
      contactStatus: 'do-not-contact', contactStatusReason: 'complained', contactStatusNote: 'spam complaint 2026-01', contactStatusUpdatedBy: 'human-1', contactStatusUpdatedAt: '2026-01-05T00:00:00.000Z', createdAt: stamp,
    });
    fake.seed('AW-Leads', { listId: 'list-a5', leadId: '701-twin', userId: TENANT_A.owner, name: 'Twin', email: X, status: 'new', contactStatus: 'unsubscribed', contactStatusReason: 'opted-out', contactStatusUpdatedBy: 'recipient', createdAt: stamp });
  });

  it('writing the SAME address on an opted-out lead (with a twin elsewhere) leaves its reason, note, actor and status untouched, and does not claim an inheritance', async () => {
    const before = JSON.stringify(leadRow(TENANT_A.listId, '700-orig'));
    const twinBefore = JSON.stringify(leadRow('list-a5', '701-twin'));
    const r = await a.call('manage_leads', { action: 'update', list_id: TENANT_A.listId, lead_id: '700-orig', updates: { email: X, notes: 'touch' } });
    expect(r.isError).toBe(false);
    expect(r.json.inheritedDoNotContact).toBeUndefined();
    const row = leadRow(TENANT_A.listId, '700-orig');
    expect(row).toMatchObject({ contactStatus: 'do-not-contact', contactStatusReason: 'complained', contactStatusNote: 'spam complaint 2026-01', contactStatusUpdatedBy: 'human-1', notes: 'touch' });
    // Every contact-status field is exactly as it was (the update also derives the lead's domain from the address: that is not part of the record).
    const contactFields = (r: Record<string, any>) => Object.fromEntries(Object.entries(r).filter(([k]) => k.startsWith('contactStatus') || k.startsWith('unsubscribed')));
    expect(contactFields(row)).toEqual(contactFields(JSON.parse(before)));
    // The same for the twin, which is the recipient's own unsubscribe: it must not be relabelled do-not-contact.
    const t = await a.call('manage_leads', { action: 'update', list_id: 'list-a5', lead_id: '701-twin', updates: { email: `  ${X.toUpperCase()}  `, notes: 'touch' } });
    expect(t.isError).toBe(false);
    expect(leadRow('list-a5', '701-twin')).toMatchObject({ contactStatus: 'unsubscribed', contactStatusReason: 'opted-out', contactStatusUpdatedBy: 'recipient' });
    expect(JSON.parse(twinBefore).contactStatus).toBe('unsubscribed');
  });

  it('an ordinary lead whose address does not change gets no inheritance run either', async () => {
    const svc = await import('../services/leadImportFollowups');
    const spy = jest.spyOn(svc, 'applyLeadImportFollowups');
    try {
      const r = await a.call('manage_leads', { action: 'update', list_id: TENANT_A.listId, lead_id: a2.leadId, updates: { email: a2.email.toUpperCase(), notes: 'same address' } });
      expect(r.isError).toBe(false);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('the address must be a plain address (a decorated form of an opted-out mailbox would not be matched)', () => {
  it('Name <addr>, "addr", addr. and malformed addresses are refused on add and update, by name; a padded or upper-case plain address is fine', async () => {
    const count = leadsOf(TENANT_A.listId).length;
    const before = JSON.stringify(leadRow(TENANT_A.listId, a2.leadId));
    for (const email of ['Mallory <victim@alpha.test>', '"victim@alpha.test"', 'victim@alpha.test.', 'victim@alpha', 'a b@alpha.test', 'victim@@alpha.test', '<victim@alpha.test>', 'victim@alpha.test, other@alpha.test',
      // invisible and look-alike characters would be stored as a different string from the address they imitate
      'vic\u200Btim@alpha.test', 'vic\u00ADtim@alpha.test', '\uFF56ictim@alpha.test', 'victim\u0000@alpha.test', 'victim@alph\u0430.test']) {
      const add = await a.call('manage_leads', { action: 'add', list_id: TENANT_A.listId, leads: [{ email }] });
      expect({ email, op: 'add', isError: add.isError, named: add.text.includes('email (must be a plain ASCII address') }).toEqual({ email, op: 'add', isError: true, named: true });
      const upd = await a.call('manage_leads', { action: 'update', list_id: TENANT_A.listId, lead_id: a2.leadId, updates: { email } });
      expect({ email, op: 'update', isError: upd.isError, named: upd.text.includes('email (must be a plain ASCII address') }).toEqual({ email, op: 'update', isError: true, named: true });
    }
    expect(leadsOf(TENANT_A.listId).length).toBe(count);
    expect(JSON.stringify(leadRow(TENANT_A.listId, a2.leadId))).toBe(before);
    const ok = await a.call('manage_leads', { action: 'add', list_id: TENANT_A.listId, leads: [{ email: '  Fine.Person+tag@Sub.Alpha.TEST ' }] });
    expect(ok.isError).toBe(false);
    // No email at all is still fine (a lead need not have one), and null clears an ordinary lead's address.
    const none = await a.call('manage_leads', { action: 'add', list_id: TENANT_A.listId, leads: [{ firstName: 'No', lastName: 'Email', linkedin: 'https://linkedin.com/in/no-email' }] });
    expect(none.isError).toBe(false);
  });
});

describe('the opt-out guards read the stored lead consistently and fail closed', () => {
  it('the email guard and the delete guard use a consistent read; if it cannot be read, nothing is changed or deleted', async () => {
    const { crmDb } = await import('../services/db');
    // A consistent read is requested by the email guard...
    const spy = jest.spyOn(crmDb, 'getLeadById');
    try {
      const r = await a.call('manage_leads', { action: 'update', list_id: TENANT_A.listId, lead_id: a2.leadId, updates: { email: 'arnold-new@alpha.test' } });
      expect(r.isError).toBe(false);
      expect(spy.mock.calls.some(([, , opts]) => (opts as any)?.consistentRead === true)).toBe(true);
      spy.mockClear();
      const d = await a.call('manage_leads', { action: 'delete', list_id: TENANT_A.listId, lead_ids: [a1.leadId] });
      expect(d.isError).toBe(false);
      expect(spy.mock.calls.some(([, , opts]) => (opts as any)?.consistentRead === true)).toBe(true);
    } finally {
      spy.mockRestore();
    }
    // ...and a stored read that fails (after the REST read succeeded) stops both, with nothing changed.
    fake.seed('AW-Leads', { listId: TENANT_A.listId, leadId: '010-extra', userId: TENANT_A.owner, name: 'Extra', email: 'extra@alpha.test', status: 'new', createdAt: '2026-11-18T10:00:00.000Z' });
    const before = JSON.stringify(leadRow(TENANT_A.listId, '010-extra'));
    const original = crmDb.getLeadById.bind(crmDb);
    const failing = jest.spyOn(crmDb, 'getLeadById');
    failing.mockImplementationOnce(original as any).mockRejectedValueOnce(new Error('throttled'));
    const err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const u = await a.call('manage_leads', { action: 'update', list_id: TENANT_A.listId, lead_id: '010-extra', updates: { email: 'moved-extra@alpha.test' } });
      expect(u.isError).toBe(true);
      expect(u.text).toContain('Nothing was saved');
      failing.mockImplementationOnce(original as any).mockRejectedValueOnce(new Error('throttled'));
      const d = await a.call('manage_leads', { action: 'delete', list_id: TENANT_A.listId, lead_ids: ['010-extra'] });
      expect(d.isError).toBe(true);
      expect(leadRow(TENANT_A.listId, '010-extra')).toBeDefined();
      expect(JSON.stringify(leadRow(TENANT_A.listId, '010-extra'))).toBe(before);
    } finally {
      failing.mockRestore();
      err.mockRestore();
    }
  });
});

// ---- Found by Opslane (run 2308, P1) on b3ffcf33c: two updates to one lead at the same moment could silently drop a custom field -------------

describe('custom fields are written key by key: overlapping updates to one lead cannot drop each other', () => {
  const customOf = (leadId: string) => leadRow(TENANT_A.listId, leadId).customFields;

  it('three updates sent at the same moment, one key each, all land (repeated, so a race could not hide)', async () => {
    for (let round = 0; round < 6; round++) {
      fake.seed('AW-Leads', { ...leadRow(TENANT_A.listId, a1.leadId), customFields: { region: 'EMEA', tier: 'gold' } });
      const calls = await Promise.all([
        a.call('manage_leads', { action: 'update', list_id: TENANT_A.listId, lead_id: a1.leadId, updates: { region: `EMEA-${round}` } }),
        a.call('manage_leads', { action: 'update', list_id: TENANT_A.listId, lead_id: a1.leadId, updates: { tier: `gold-${round}` } }),
        a.call('manage_leads', { action: 'update', list_id: TENANT_A.listId, lead_id: a1.leadId, updates: { third: `x-${round}` } }),
      ]);
      expect(calls.map((c) => c.isError)).toEqual([false, false, false]);
      expect({ round, custom: customOf(a1.leadId) }).toEqual({ round, custom: { region: `EMEA-${round}`, tier: `gold-${round}`, third: `x-${round}` } });
    }
  });

  it('the portal route receives only the keys being changed, with the key-by-key flag (never the whole map)', async () => {
    const { crmDb } = await import('../services/db');
    const spy = jest.spyOn(crmDb, 'updateLead');
    try {
      const r = await a.call('manage_leads', { action: 'update', list_id: TENANT_A.listId, lead_id: a1.leadId, updates: { tier: 'platinum', customFields: { extra: 1 }, notes: 'n' } });
      expect(r.isError).toBe(false);
      const sent = spy.mock.calls.find(([l, id]) => l === TENANT_A.listId && id === a1.leadId)![2] as any;
      expect(sent.customFieldsKeyMerge).toBe(true);
      expect(sent.customFields).toEqual({ tier: 'platinum', extra: 1 });
      expect(sent.notes).toBe('n');
      expect(customOf(a1.leadId)).toEqual({ region: 'EMEA', tier: 'platinum', extra: 1 });
    } finally {
      spy.mockRestore();
    }
  });

  it('when the portal route is in enforce mode (it would drop the flag and replace the map) the whole map is merged from a consistent read: nothing is lost sequentially', async () => {
    process.env.CRM_LEAD_PUT_GUARD = 'enforce';
    const { crmDb } = await import('../services/db');
    const spy = jest.spyOn(crmDb, 'updateLead');
    try {
      expect((await a.call('manage_leads', { action: 'update', list_id: TENANT_A.listId, lead_id: a1.leadId, updates: { region: 'APAC' } })).isError).toBe(false);
      expect((await a.call('manage_leads', { action: 'update', list_id: TENANT_A.listId, lead_id: a1.leadId, updates: { tier: 'silver' } })).isError).toBe(false);
      expect(customOf(a1.leadId)).toEqual({ region: 'APAC', tier: 'silver' });
      const sent = spy.mock.calls.map(([, , u]) => u as any).filter((u) => u.customFields);
      expect(sent.every((u) => u.customFieldsKeyMerge === undefined)).toBe(true);
    } finally {
      delete process.env.CRM_LEAD_PUT_GUARD;
      spy.mockRestore();
    }
  });

  it('a lead with no custom-field map gets it created by the key-level write (the update layer creates a missing map and retries); overlapping updates keep every key', async () => {
    const { customFields: _gone, ...bare } = leadRow(TENANT_A.listId, a2.leadId);
    fake.seed('AW-Leads', bare);
    const r = await a.call('manage_leads', { action: 'update', list_id: TENANT_A.listId, lead_id: a2.leadId, updates: { first: 1, second: 2 } });
    expect(r.isError).toBe(false);
    expect(customOf(a2.leadId)).toEqual({ first: 1, second: 2 });
  });

  it('an empty custom field name is refused (the key-by-key write would drop it silently)', async () => {
    const before = JSON.stringify(leadRow(TENANT_A.listId, a1.leadId));
    for (const updates of [{ customFields: { '': 'x' } }, { customFields: { '   ': 'x' } }]) {
      const r = await a.call('manage_leads', { action: 'update', list_id: TENANT_A.listId, lead_id: a1.leadId, updates });
      expect({ updates, isError: r.isError, named: r.text.includes('(empty name)') || r.text.includes('customFields.') }).toEqual({ updates, isError: true, named: true });
    }
    expect(JSON.stringify(leadRow(TENANT_A.listId, a1.leadId))).toBe(before);
  });
});

// ---- Found by the FIFTH review (final head 6f980cf98: DO NOT SHIP): one agent's PARALLEL calls beat the read-then-write guards -------------------

describe('one agent\'s parallel calls on the same lead are serialized (the guards are read-then-write)', () => {
  const stamp = '2026-11-18T10:00:00.000Z';
  const seedLead = (leadId: string, extra: Record<string, unknown> = {}) =>
    fake.seed('AW-Leads', { listId: TENANT_A.listId, leadId, userId: TENANT_A.owner, name: leadId, email: `${leadId}@alpha.test`, status: 'new', createdAt: stamp, customFields: { region: 'EMEA', tier: 'gold' }, ...extra });
  const listCount = () => fake.items('AW-LeadLists').find((l: any) => l.listId === TENANT_A.listId).leadCount;

  it('"mark do-not-contact" and "delete" sent together, in either order, never leave a hollow row or a sendable address', async () => {
    for (const order of ['suppress-first', 'delete-first'] as const) {
      seedLead(`par-${order}`);
      const suppress = () => a.call('manage_leads', { action: 'update', list_id: TENANT_A.listId, lead_id: `par-${order}`, updates: { status: 'do-not-contact' } });
      const del = () => a.call('manage_leads', { action: 'delete', list_id: TENANT_A.listId, lead_ids: [`par-${order}`] });
      await Promise.all(order === 'suppress-first' ? [suppress(), del()] : [del(), suppress()]);
      const row = leadRow(TENANT_A.listId, `par-${order}`);
      if (row) {
        // The lead survived: it is a real, suppressed lead (never a one-field stub).
        expect({ order, hollow: !row.email }).toEqual({ order, hollow: false });
        expect(row.contactStatus).toBe('do-not-contact');
      } else {
        // The lead was deleted BEFORE it was suppressed: nothing was re-created.
        expect(row).toBeUndefined();
      }
      // The address is never left on a sendable lead while an opted-out one was deleted: if a lead exists for it, it is opted out.
      expect(leadsOf(TENANT_A.listId).filter((l: any) => l.email === `par-${order}@alpha.test` && !l.contactStatus)).toEqual([]);
    }
  });

  it('an update and a delete of one lead sent together never re-create a hollow row, and the list count drops once', async () => {
    for (let round = 0; round < 4; round++) {
      seedLead(`ud-${round}`);
      const before = listCount();
      const calls = round % 2 === 0
        ? [a.call('manage_leads', { action: 'update', list_id: TENANT_A.listId, lead_id: `ud-${round}`, updates: { notes: 'late' } }), a.call('manage_leads', { action: 'delete', list_id: TENANT_A.listId, lead_ids: [`ud-${round}`] })]
        : [a.call('manage_leads', { action: 'delete', list_id: TENANT_A.listId, lead_ids: [`ud-${round}`] }), a.call('manage_leads', { action: 'update', list_id: TENANT_A.listId, lead_id: `ud-${round}`, updates: { notes: 'late' } })];
      await Promise.all(calls);
      expect({ round, row: leadRow(TENANT_A.listId, `ud-${round}`) }).toEqual({ round, row: undefined });
      expect({ round, dropped: before - listCount() }).toEqual({ round, dropped: 1 });
    }
  });

  it('two deletes of one lead sent together: one succeeds, the other is a 404, and the list count drops by exactly one', async () => {
    seedLead('dd-1');
    const before = listCount();
    const [x, y] = await Promise.all([
      a.call('manage_leads', { action: 'delete', list_id: TENANT_A.listId, lead_ids: ['dd-1'] }),
      a.call('manage_leads', { action: 'delete', list_id: TENANT_A.listId, lead_ids: ['dd-1'] }),
    ]);
    expect([x.isError, y.isError].sort()).toEqual([false, true]);
    expect([x, y].find((r) => r.isError)!.text).toContain('(404)');
    expect(before - listCount()).toBe(1);
  });

  it('overlapping custom-field updates keep every key in enforce mode (read-merge-write) and on a lead with no map', async () => {
    process.env.CRM_LEAD_PUT_GUARD = 'enforce';
    try {
      for (let round = 0; round < 4; round++) {
        seedLead('enf-1');
        await Promise.all(['one', 'two', 'three'].map((k) => a.call('manage_leads', { action: 'update', list_id: TENANT_A.listId, lead_id: 'enf-1', updates: { [k]: `v${round}` } })));
        expect({ round, custom: leadRow(TENANT_A.listId, 'enf-1').customFields }).toEqual({ round, custom: { region: 'EMEA', tier: 'gold', one: `v${round}`, two: `v${round}`, three: `v${round}` } });
      }
    } finally {
      delete process.env.CRM_LEAD_PUT_GUARD;
    }
    for (let round = 0; round < 4; round++) {
      const { customFields: _none, ...bare } = { ...leadRow(TENANT_A.listId, a2.leadId) } as Record<string, any>;
      fake.seed('AW-Leads', bare);
      await Promise.all(['x', 'y', 'z'].map((k) => a.call('manage_leads', { action: 'update', list_id: TENANT_A.listId, lead_id: a2.leadId, updates: { [k]: round } })));
      expect({ round, custom: leadRow(TENANT_A.listId, a2.leadId).customFields }).toEqual({ round, custom: { x: round, y: round, z: round } });
    }
  });
});

describe('the status decision reads the stored lead, not a lagging REST copy', () => {
  it('an existing unsubscribe is not relabelled do-not-contact when the REST read is stale', async () => {
    const { crmDb } = await import('../services/db');
    fake.seed('AW-Leads', { listId: TENANT_A.listId, leadId: 'stale-1', userId: TENANT_A.owner, name: 'Stale', email: 'stale-1@alpha.test', status: 'new', contactStatus: 'unsubscribed', contactStatusReason: 'opted-out', contactStatusUpdatedBy: 'recipient', createdAt: '2026-11-18T10:00:00.000Z', customFields: {} });
    // The REST read (the route's first getLeadById call) shows the lead BEFORE the unsubscribe; the module's own consistent read shows the truth.
    const original = crmDb.getLeadById.bind(crmDb);
    const spy = jest.spyOn(crmDb, 'getLeadById');
    spy.mockImplementationOnce((async (...args: any[]) => ({ ...((await (original as any)(...args)) ?? {}), contactStatus: undefined, contactStatusReason: undefined, contactStatusUpdatedBy: undefined })) as any);
    try {
      const r = await a.call('manage_leads', { action: 'update', list_id: TENANT_A.listId, lead_id: 'stale-1', updates: { status: 'do-not-contact' } });
      expect(r.isError).toBe(false);
    } finally {
      spy.mockRestore();
    }
    expect(leadRow(TENANT_A.listId, 'stale-1')).toMatchObject({ contactStatus: 'unsubscribed', contactStatusReason: 'opted-out', contactStatusUpdatedBy: 'recipient' });
  });
});

describe('system-owned custom keys and empty updates', () => {
  it('the CRM sync ids the adapters fall back to are refused as custom field names (top level and inside customFields)', async () => {
    const before = JSON.stringify(leadRow(TENANT_A.listId, a1.leadId));
    for (const key of ['hubspot_contact_id', 'hubspot_deal_id', 'attio_record_id', 'attio_list_entry_id', 'attio_deal_list_id']) {
      for (const updates of [{ [key]: 'rec-of-someone-else' }, { customFields: { [key]: 'rec-of-someone-else' } }]) {
        const r = await a.call('manage_leads', { action: 'update', list_id: TENANT_A.listId, lead_id: a1.leadId, updates });
        expect({ key, isError: r.isError, named: r.text.includes(key) }).toEqual({ key, isError: true, named: true });
      }
    }
    expect(JSON.stringify(leadRow(TENANT_A.listId, a1.leadId))).toBe(before);
  });

  it('an update that changes nothing is refused (an empty customFields object only touches the update time)', async () => {
    for (const updates of [{ customFields: {} }, {}]) {
      const r = await a.call('manage_leads', { action: 'update', list_id: TENANT_A.listId, lead_id: a1.leadId, updates });
      expect({ updates, isError: r.isError }).toEqual({ updates, isError: true });
    }
  });
});

describe('delete: the same id sent twice', () => {
  it('is one lead, deleted once, and the answer says a repeat was ignored (with one distinct id as well as with several)', async () => {
    const stamp = '2026-11-18T10:00:00.000Z';
    for (const id of ['dupdel-1', 'dupdel-2', 'dupdel-3']) fake.seed('AW-Leads', { listId: TENANT_A.listId, leadId: id, userId: TENANT_A.owner, name: id, email: `${id}@alpha.test`, status: 'new', createdAt: stamp, customFields: {} });
    const countBefore = fake.items('AW-LeadLists').find((l: any) => l.listId === TENANT_A.listId).leadCount;
    const one = await a.call('manage_leads', { action: 'delete', list_id: TENANT_A.listId, lead_ids: ['dupdel-1', 'dupdel-1', 'dupdel-1'] });
    expect(one.isError).toBe(false);
    expect(one.json.duplicateIdsIgnored).toBe(2);
    expect(leadRow(TENANT_A.listId, 'dupdel-1')).toBeUndefined();
    const several = await a.call('manage_leads', { action: 'delete', list_id: TENANT_A.listId, lead_ids: ['dupdel-2', 'dupdel-3', 'dupdel-2'] });
    expect(several.isError).toBe(false);
    expect(several.json.duplicateIdsIgnored).toBe(1);
    expect(leadRow(TENANT_A.listId, 'dupdel-2')).toBeUndefined();
    expect(leadRow(TENANT_A.listId, 'dupdel-3')).toBeUndefined();
    // Three real leads, each deleted once: the list count dropped by exactly three.
    expect(countBefore - fake.items('AW-LeadLists').find((l: any) => l.listId === TENANT_A.listId).leadCount).toBe(3);
    // A plain single delete (no repeat) carries no such note.
    fake.seed('AW-Leads', { listId: TENANT_A.listId, leadId: 'dupdel-4', userId: TENANT_A.owner, name: 'd4', email: 'dupdel-4@alpha.test', status: 'new', createdAt: stamp, customFields: {} });
    const plain = await a.call('manage_leads', { action: 'delete', list_id: TENANT_A.listId, lead_ids: ['dupdel-4'] });
    expect(plain.isError).toBe(false);
    expect(plain.json.duplicateIdsIgnored).toBeUndefined();
  });
});
