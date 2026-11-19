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
      expect(r.text).toMatch(/cannot be set through this tool/);
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
  });

  it('when none of several ids can be deleted the call is an error, not an empty success', async () => {
    const r = await a.call('manage_leads', { action: 'delete', list_id: TENANT_A.listId, lead_ids: [b1.leadId, 'no-such-lead'] });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('none of the 2 rows succeeded');
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
