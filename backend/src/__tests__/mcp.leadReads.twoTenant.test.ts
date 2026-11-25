/**
 * ENG-2840 (W2-5a): `get_lead_details`, `get_lead_engagements` and `get_lead_list_statuses` proved through the REAL path (MCP client -> MCP
 * server -> tool -> mcpFetch -> the real Express app and /api/emma routes -> Emma's real handlers -> in-memory DynamoDB), with two tenants.
 *
 * What this adds to the tool unit tests and the route tests: that the list access check on the far side of the self-call really holds for
 * a caller from another tenant (a refusal is an MCP error that carries nothing of the other tenant), that naming another tenant's lead id
 * through one's own list finds nothing, that an identity argument cannot change whose data answers, that an organization member reads what
 * the organization shares and loses it when sharing is switched off, and that a read leaves the stored rows as they were.
 *
 * Not provable here, said plainly: AW-EmailEvents is not part of the fake (no lead below has an email domain, so the email-history half of
 * an engagement read, including the mail provider fetch and its cache write, is not exercised), and the fake database ignores Limit and
 * ExclusiveStartKey. It does serve BatchGetItem, which the stale-list recovery uses: the tests below read which lists that lookup asked for.
 */
jest.mock('aws-sdk', () => {
  const actual = jest.requireActual('aws-sdk');
  const { makeTwoTenantFake } = jest.requireActual('./helpers/twoTenantMcpHarness');
  const fake = makeTwoTenantFake();
  (global as any).__leadReadsFake = fake;
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
  contentMarkers,
  idMarkers,
  installSelfCallFetch,
  seedTwoTenantWorld,
  snapshotTenant,
  TENANT_A,
  TENANT_B,
  type McpCaller,
  type Outcome,
  type Tenant,
} from './helpers/twoTenantMcpHarness';

const fake: any = (global as any).__leadReadsFake;
// the in-memory DocumentClient the mock above installed: its prototype is where the recovery lookup's BatchGetItem can be watched
const { DynamoDB } = require('aws-sdk');

/** Text only tenant A's engagements carry (and tenant B's), so a leak is visible whatever field it travels in. */
const ENG = { A: 'ALPHA-ENG', B: 'BRAVO-ENG' } as const;

/** The refusal an outside agent sees: the tool's own error, carrying the route's short message and nothing else. */
const refusal = (tool: string, message: string) => new RegExp(`^Error: ${tool}: ${message}\\.`);

let restoreFetch: () => void;
const callers: Record<string, McpCaller> = {};

beforeAll(async () => {
  restoreFetch = installSelfCallFetch(app);
  for (const userId of [TENANT_A.owner, TENANT_A.member!, TENANT_B.owner]) callers[userId] = await connectCaller(userId);
});
afterAll(async () => {
  await Promise.all(Object.values(callers).map((c) => c.close()));
  restoreFetch();
});

/** Give a tenant's first lead hand-recorded engagements (the half of an engagement read the fake database can serve). */
function seedEngagements(t: Tenant, tag: string): void {
  const row = fake.items('AW-Leads').find((l: any) => l.leadId === t.leads[0].leadId);
  fake.seed('AW-Leads', {
    ...row,
    notes: `${tag} note`,
    engagements: [
      { eventId: `${tag}-1`, eventType: 'manual.call', eventData: { note: `${tag} first call` }, createdAt: '2026-11-01T10:00:00.000Z' },
      { eventId: `${tag}-2`, eventType: 'manual.meeting', eventData: { note: `${tag} meeting`, ipAddress: '203.0.113.9' }, createdAt: '2026-11-10T10:00:00.000Z' },
      { eventId: `${tag}-3`, eventType: 'manual.note', eventData: { note: `${tag} follow-up` }, createdAt: '2026-11-05T10:00:00.000Z' },
    ],
  });
}

/** A second (and for A's member a third) list, so the stale-list recovery has other lists to look in. */
const EXTRA = {
  A: { listId: 'list-a2', owner: TENANT_A.owner, name: 'ALPHA second list', leadId: 'lead-a2-1', email: 'zed@alpha-secret.test' },
  AM: { listId: 'list-a2m', owner: TENANT_A.member!, name: 'ALPHA members list', leadId: 'lead-a2m-1', email: 'mia@alpha-secret.test' },
  B: { listId: 'list-b2', owner: TENANT_B.owner, name: 'BRAVO second list', leadId: 'lead-b2-1', email: 'bea@bravo-secret.test' },
} as const;

function seedExtraList(e: { listId: string; owner: string; name: string; leadId: string; email: string }): void {
  fake.seed('AW-LeadLists', { listId: e.listId, userId: e.owner, name: e.name, listType: 'sales', createdAt: '2026-11-18T10:00:00.000Z', leadCount: 1 });
  fake.seed('AW-Leads', { listId: e.listId, leadId: e.leadId, userId: e.owner, name: e.name, email: e.email, status: 'new', createdAt: '2026-11-18T10:00:00.000Z' });
}

const setCrmSharing = (t: Tenant, enabled: boolean) => {
  const row = fake.items('AW-Organizations').find((o: any) => o.orgId === t.orgId);
  fake.seed('AW-Organizations', { ...row, shareSettings: { crm: { enabled } } });
};

let batchGetSpy: jest.SpyInstance;
/** The list ids the stale-list recovery asked the database for, across the call under test. */
const listsLookedIn = (): string[] =>
  batchGetSpy.mock.calls.flatMap((c: any[]) => Object.values<any>(c[0].RequestItems).flatMap((r) => r.Keys.map((k: any) => k.listId)));

beforeEach(() => {
  seedTwoTenantWorld(fake);
  seedEngagements(TENANT_A, ENG.A);
  seedEngagements(TENANT_B, ENG.B);
  for (const e of Object.values(EXTRA)) seedExtraList(e);
  batchGetSpy = jest.spyOn(DynamoDB.DocumentClient.prototype, 'batchGet');
});
afterEach(() => batchGetSpy.mockRestore());

/** Nothing of the victim's, in ANY outcome: its list name, lead names and addresses, its engagement text, and its ids when the caller never named them. */
function expectNoVictimContent(label: string, o: Outcome, vic: Tenant, namedIds: string[] = []): void {
  const tag = vic.label === 'A' ? ENG.A : ENG.B;
  const extras = (vic.label === 'A' ? [EXTRA.A, EXTRA.AM] : [EXTRA.B]).flatMap((e) => [e.name, e.email]);
  const markers = [...contentMarkers(vic), tag, ...extras, ...idMarkers(vic).filter((m) => !namedIds.includes(m))];
  const leaked = markers.filter((m) => o.text.includes(m));
  expect({ label, leaked }).toEqual({ label, leaked: [] });
}

const READS = [
  { tool: 'get_lead_details', args: (t: Tenant) => ({ list_id: t.listId, lead_id: t.leads[0].leadId }) },
  { tool: 'get_lead_engagements', args: (t: Tenant) => ({ list_id: t.listId, lead_id: t.leads[0].leadId }) },
  { tool: 'get_lead_list_statuses', args: (t: Tenant) => ({ list_id: t.listId }) },
] as const;

describe('a caller reads its own tenant', () => {
  it('get_lead_details answers with the lead, its engagement count and its recent engagements', async () => {
    const o = await callers[TENANT_A.owner].call('get_lead_details', READS[0].args(TENANT_A));
    expect(o.isError).toBe(false);
    expect(o.json.success).toBe(true);
    expect(o.text).toContain('alice@alpha-secret.test');
    expect(o.text).toContain(TENANT_A.listName);
    expect(o.text).toContain(`${ENG.A} follow-up`);
    expectNoVictimContent('own read', o, TENANT_B);
  });

  it('get_lead_engagements answers newest first, and a limit shortens the page', async () => {
    const all = await callers[TENANT_A.owner].call('get_lead_engagements', READS[1].args(TENANT_A));
    expect(all.isError).toBe(false);
    expect(all.json.success).toBe(true);
    const types = all.json.engagements.map((e: any) => e.eventType);
    expect(types).toEqual(['manual.meeting', 'manual.note', 'manual.call']);
    const one = await callers[TENANT_A.owner].call('get_lead_engagements', { ...READS[1].args(TENANT_A), limit: 1 });
    expect(one.json.engagements).toHaveLength(1);
    expect(one.json.engagements[0].eventType).toBe('manual.meeting');
    expectNoVictimContent('own read', all, TENANT_B);
  });

  it('get_lead_list_statuses answers with the list name and the default stages of a list that stored none', async () => {
    const o = await callers[TENANT_A.owner].call('get_lead_list_statuses', READS[2].args(TENANT_A));
    expect(o.isError).toBe(false);
    expect(o.json.success).toBe(true);
    expect(o.json.listName).toBe(TENANT_A.listName);
    expect(Array.isArray(o.json.statuses)).toBe(true);
    expect(o.json.statuses.length).toBeGreaterThan(0);
    expectNoVictimContent('own read', o, TENANT_B);
  });

  it('the public answer drops the IP address a stored event carries (the sanitiser runs on these tools too)', async () => {
    const o = await callers[TENANT_A.owner].call('get_lead_engagements', READS[1].args(TENANT_A));
    expect(o.text).toContain(`${ENG.A} meeting`);
    expect(o.text).not.toContain('203.0.113.9');
    expect(o.text).not.toContain('ipAddress');
  });

  it.each(READS)('$tool leaves every stored lead and list row exactly as it was (the email-event cache is outside the fake)', async ({ tool, args }) => {
    const before = [snapshotTenant(fake, TENANT_A), snapshotTenant(fake, TENANT_B)];
    const o = await callers[TENANT_A.owner].call(tool, args(TENANT_A));
    expect(o.isError).toBe(false);
    expect([snapshotTenant(fake, TENANT_A), snapshotTenant(fake, TENANT_B)]).toEqual(before);
  });
});

describe.each([
  [TENANT_A, TENANT_B],
  [TENANT_B, TENANT_A],
] as Array<[Tenant, Tenant]>)('tenant %#: an owner aiming at the other tenant', (atk, vic) => {
  const owner = () => callers[atk.owner];

  it.each(READS)(`$tool: the other tenant's list is refused as access denied, and nothing of it is returned`, async ({ tool, args }) => {
    const before = snapshotTenant(fake, vic);
    const o = await owner().call(tool, args(vic));
    expect(o.isError).toBe(true);
    expect(o.text).toMatch(refusal(tool, 'Access denied'));
    expectNoVictimContent(`${tool} foreign list`, o, vic, [vic.listId, vic.leads[0].leadId]);
    expect(snapshotTenant(fake, vic)).toBe(before);
  });

  it.each(READS.slice(0, 2))(`$tool: the other tenant's lead id through the caller's OWN list finds nothing`, async ({ tool }) => {
    const before = snapshotTenant(fake, vic);
    const o = await owner().call(tool, { list_id: atk.listId, lead_id: vic.leads[0].leadId });
    expect(o.isError).toBe(true);
    expect(o.text).toMatch(refusal(tool, 'Lead not found'));
    expectNoVictimContent(`${tool} foreign lead id`, o, vic, [vic.leads[0].leadId]);
    expect(snapshotTenant(fake, vic)).toBe(before);
  });

  it.each(READS)('$tool: a list that does not exist is "not found", and says nothing about any tenant', async ({ tool }) => {
    // the list tool takes no lead id (one sent would be refused by name, which is not what is tested here)
    const o = await owner().call(tool, tool === 'get_lead_list_statuses' ? { list_id: 'list-nobody' } : { list_id: 'list-nobody', lead_id: 'lead-nobody' });
    expect(o.isError).toBe(true);
    expect(o.text).toMatch(refusal(tool, 'Lead list not found'));
    expectNoVictimContent(`${tool} missing list`, o, vic);
  });
});

describe('an identity in the arguments changes nothing', () => {
  it.each(READS)('$tool: user_id, client_id, orgId and tenantId are refused by name before any call, and nothing is returned', async ({ tool, args }) => {
    for (const extra of ['user_id', 'client_id', 'orgId', 'tenantId', 'accountOwnerUserId']) {
      const o = await callers[TENANT_B.owner].call(tool, { ...args(TENANT_A), [extra]: TENANT_A.owner });
      expect({ extra, isError: o.isError, named: o.text.includes(`"${extra}" is not an input of ${tool}`) }).toEqual({ extra, isError: true, named: true });
      expectNoVictimContent(`${tool} ${extra}`, o, TENANT_A, [TENANT_A.listId, TENANT_A.leads[0].leadId, TENANT_A.owner]);
    }
  });

  it.each(READS)('$tool: userId (which the MCP server strips from every call) cannot make the caller read the other tenant', async ({ tool, args }) => {
    const o = await callers[TENANT_B.owner].call(tool, { ...args(TENANT_A), userId: TENANT_A.owner });
    expect(o.isError).toBe(true);
    expect(o.text).toMatch(refusal(tool, 'Access denied'));
    expectNoVictimContent(`${tool} userId`, o, TENANT_A, [TENANT_A.listId, TENANT_A.leads[0].leadId]);
  });

  it.each(READS)('$tool: userId on the caller\'s own list still answers as the caller', async ({ tool, args }) => {
    const o = await callers[TENANT_A.owner].call(tool, { ...args(TENANT_A), userId: TENANT_B.owner });
    expect(o.isError).toBe(false);
    expectNoVictimContent(`${tool} userId own`, o, TENANT_B);
  });
});

describe('an organization member', () => {
  it.each(READS)('$tool: reads what the organization shares (sharing is on by default) and nothing of the other tenant', async ({ tool, args }) => {
    const o = await callers[TENANT_A.member!].call(tool, args(TENANT_A));
    expect(o.isError).toBe(false);
    expect(o.json.success).toBe(true);
    expectNoVictimContent(`${tool} member`, o, TENANT_B);
  });

  it.each(READS)('$tool: is refused once the organization switches CRM sharing off; the list owner still reads', async ({ tool, args }) => {
    setCrmSharing(TENANT_A, false);
    const member = await callers[TENANT_A.member!].call(tool, args(TENANT_A));
    expect(member.isError).toBe(true);
    expect(member.text).toMatch(refusal(tool, 'Access denied'));
    expectNoVictimContent(`${tool} member sharing off`, member, TENANT_A, [TENANT_A.listId, TENANT_A.leads[0].leadId]);
    const owner = await callers[TENANT_A.owner].call(tool, args(TENANT_A));
    expect(owner.isError).toBe(false);
  });

  it.each(READS)("$tool: a member of A is refused B's list", async ({ tool, args }) => {
    const o = await callers[TENANT_A.member!].call(tool, args(TENANT_B));
    expect(o.isError).toBe(true);
    expect(o.text).toMatch(refusal(tool, 'Access denied'));
    expectNoVictimContent(`${tool} member foreign`, o, TENANT_B, [TENANT_B.listId, TENANT_B.leads[0].leadId]);
  });
});

describe('a stale list id: get_lead_details finds the lead only inside lists the caller can access', () => {
  const details = (caller: McpCaller, list_id: string, lead_id: string) => caller.call('get_lead_details', { list_id, lead_id });

  it('the owner of two lists asks for a lead through the wrong one: it is found, with a note naming the right list', async () => {
    const o = await details(callers[TENANT_A.owner], TENANT_A.listId, EXTRA.A.leadId);
    expect(o.isError).toBe(false);
    expect(o.json.success).toBe(true);
    expect(o.json.lead.email).toBe(EXTRA.A.email);
    expect(o.json.note).toContain(EXTRA.A.listId);
    expect(o.json.listName).toBe(EXTRA.A.name);
    expect(listsLookedIn()).toEqual([EXTRA.A.listId]);
  });

  it("the same for tenant B, so the next test's refusal is a recovery that ran and found nothing, not one that never ran", async () => {
    const o = await details(callers[TENANT_B.owner], TENANT_B.listId, EXTRA.B.leadId);
    expect(o.json.success).toBe(true);
    expect(o.json.lead.email).toBe(EXTRA.B.email);
    expect(o.json.note).toContain(EXTRA.B.listId);
    expect(listsLookedIn()).toEqual([EXTRA.B.listId]);
  });

  it("another tenant's lead id, asked through the caller's own list, is not found: the recovery looks only in the caller's own lists", async () => {
    const before = snapshotTenant(fake, TENANT_A);
    for (const leadId of [EXTRA.A.leadId, TENANT_A.leads[0].leadId]) {
      batchGetSpy.mockClear();
      const o = await details(callers[TENANT_B.owner], TENANT_B.listId, leadId);
      expect(o.isError).toBe(true);
      expect(o.text).toMatch(refusal('get_lead_details', 'Lead not found'));
      expectNoVictimContent('recovery across tenants', o, TENANT_A, [leadId]);
      // the lookup really ran (B has another list), and asked for B's list only: never for a list of A
      expect(listsLookedIn()).toEqual([EXTRA.B.listId]);
    }
    expect(snapshotTenant(fake, TENANT_A)).toBe(before);
  });

  it("an organization member recovers into the owner's list while the organization shares its CRM", async () => {
    const o = await details(callers[TENANT_A.member!], EXTRA.AM.listId, TENANT_A.leads[0].leadId);
    expect(o.isError).toBe(false);
    expect(o.json.lead.email).toBe(TENANT_A.leads[0].email);
    expect(o.json.note).toContain(TENANT_A.listId);
    expect(listsLookedIn().sort()).toEqual([TENANT_A.listId, EXTRA.A.listId].sort());
    expectNoVictimContent('member recovery', o, TENANT_B);
  });

  it("the same member does not recover into the owner's list once CRM sharing is switched off", async () => {
    setCrmSharing(TENANT_A, false);
    const o = await details(callers[TENANT_A.member!], EXTRA.AM.listId, TENANT_A.leads[0].leadId);
    expect(o.isError).toBe(true);
    expect(o.text).toMatch(refusal('get_lead_details', 'Lead not found'));
    expect(o.text).not.toContain(TENANT_A.leads[0].email);
    // the member's only list is the one asked for: there was nowhere else to look, and no list of the owner was asked for
    expect(listsLookedIn()).toEqual([]);
  });

  it("a member of A never recovers into B's lists", async () => {
    const o = await details(callers[TENANT_A.member!], EXTRA.AM.listId, TENANT_B.leads[0].leadId);
    expect(o.isError).toBe(true);
    expect(o.text).toMatch(refusal('get_lead_details', 'Lead not found'));
    expectNoVictimContent('member recovery into B', o, TENANT_B, [TENANT_B.leads[0].leadId]);
    expect(listsLookedIn().filter((id) => id.includes('b'))).toEqual([]);
  });

  it('get_lead_engagements has no recovery: a lead asked for through the wrong list is not found, and no other list is looked in', async () => {
    const o = await callers[TENANT_A.owner].call('get_lead_engagements', { list_id: TENANT_A.listId, lead_id: EXTRA.A.leadId });
    expect(o.isError).toBe(true);
    expect(o.text).toMatch(refusal('get_lead_engagements', 'Lead not found'));
    expect(listsLookedIn()).toEqual([]);
  });
});
