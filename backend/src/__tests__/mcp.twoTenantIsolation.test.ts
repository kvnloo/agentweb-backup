/**
 * Two-tenant isolation matrix for MCP tools (ENG-2840 wave 1).
 *
 * Why this exists: an outside agent (Hermes) calls these tools with an aw_ key that carries a user, not an org. Isolation therefore lives in
 * each route and service, and nothing at the MCP layer stops a tool from handing one tenant's data to another. This runs every covered tool
 * through the REAL path (see helpers/twoTenantMcpHarness.ts: MCP client -> real MCP server -> real tool -> real Express app -> real db code
 * -> in-memory DynamoDB) with two orgs seeded, and checks, per tool and in both directions (A against B, B against A):
 *
 *   1. the owner reads its own data;
 *   2. the other tenant's text appears nowhere in that owner's answers (and the same holds for the other tenant's owner);
 *   3. reads, updates, deletes and adds aimed at the other tenant's identifiers are refused (where a refusal is the contract) and leave the
 *      other tenant's rows byte-for-byte unchanged;
 *   4. a same-org member sees nothing of the other org either;
 *   5. identity overrides in the arguments (userId, user_id, client_id) never change whose data answers;
 *   6. in none of the above does any answer, success or refusal, contain the other tenant's content.
 *
 * Adding a tool to a wave means adding it to helpers/twoTenantWaveTools.ts and a spec below; the last describe fails otherwise.
 */
jest.mock('aws-sdk', () => {
  const actual = jest.requireActual('aws-sdk');
  const { makeTwoTenantFake } = jest.requireActual('./helpers/twoTenantMcpHarness');
  const fake = makeTwoTenantFake();
  (global as any).__twoTenantFake = fake;
  actual.DynamoDB.DocumentClient = fake.documentClient;
  return actual;
});
jest.mock('../server', () => ({ io: { to: jest.fn().mockReturnValue({ emit: jest.fn() }), emit: jest.fn() }, app: {} }));
jest.mock('../utils/secretsManager', () => ({
  getMetaAccessToken: jest.fn().mockResolvedValue('mock-token'),
  getSecret: jest.fn().mockResolvedValue('mock-secret'),
}));

import app from '../app';
import '../mcp/server/apiTools';
import { mcpToolRegistry } from '../mcp/server/registry';
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
import { TWO_TENANT_COVERED_TOOLS, type TwoTenantCoveredTool } from './helpers/twoTenantWaveTools';

const fake: any = (global as any).__twoTenantFake;

interface Attempt {
  label: string;
  args: Record<string, unknown>;
  /** The contract is a refusal (the MCP reply is an error). Omit where the call is allowed and only isolation is asserted. */
  refused?: true;
  /** Text the answer must contain (the caller's own data answering, not the other tenant's). */
  shows?: string[];
}

interface ToolSpec {
  tool: TwoTenantCoveredTool;
  /** The owner reading its own data. */
  ownRead: (t: Tenant) => { args: Record<string, unknown>; shows: string[] };
  /** Calls by `atk` that name `vic`'s identifiers (lists, leads). Empty when the tool takes none. */
  foreign: (atk: Tenant, vic: Tenant) => Attempt[];
  /** Calls by `atk` that try to switch identity through the arguments. */
  overrides: (atk: Tenant, vic: Tenant) => Attempt[];
}

const SPECS: ToolSpec[] = [
  {
    tool: 'manage_leads',
    ownRead: (t) => ({ args: { action: 'list', list_id: t.listId }, shows: t.leads.map((l) => l.email) }),
    foreign: (atk, vic) => [
      { label: "list the other tenant's list", args: { action: 'list', list_id: vic.listId }, refused: true },
      { label: "get the other tenant's lead through its list", args: { action: 'get', list_id: vic.listId, lead_id: vic.leads[0].leadId }, refused: true },
      { label: "get the other tenant's lead id through the caller's own list", args: { action: 'get', list_id: atk.listId, lead_id: vic.leads[0].leadId }, refused: true },
      { label: "update the other tenant's lead through its list", args: { action: 'update', list_id: vic.listId, lead_id: vic.leads[0].leadId, updates: { name: 'HIJACKED' } }, refused: true },
      { label: "update the other tenant's lead id through the caller's own list", args: { action: 'update', list_id: atk.listId, lead_id: vic.leads[0].leadId, updates: { name: 'HIJACKED' } } },
      { label: "delete the other tenant's lead through its list", args: { action: 'delete', list_id: vic.listId, lead_ids: [vic.leads[0].leadId] }, refused: true },
      { label: "delete the other tenant's lead id through the caller's own list", args: { action: 'delete', list_id: atk.listId, lead_ids: [vic.leads[0].leadId] } },
      { label: "add a lead into the other tenant's list", args: { action: 'add', list_id: vic.listId, leads: [{ name: 'Planted', email: 'planted@elsewhere.test' }] }, refused: true },
    ],
    overrides: (atk, vic) => [
      { label: 'userId override against the other tenant\'s list', args: { action: 'list', list_id: vic.listId, userId: vic.owner }, refused: true },
      { label: 'userId override on the caller\'s own list still answers as the caller', args: { action: 'list', list_id: atk.listId, userId: vic.owner }, shows: atk.leads.map((l) => l.email) },
      { label: 'user_id override against the other tenant\'s list', args: { action: 'list', list_id: vic.listId, user_id: vic.owner }, refused: true },
      { label: 'client_id (admin-only) from a non-admin', args: { action: 'list', list_id: vic.listId, client_id: vic.owner }, refused: true },
    ],
  },
  {
    tool: 'list_lead_lists',
    ownRead: (t) => ({ args: {}, shows: [t.listName] }),
    foreign: () => [],
    overrides: (atk, vic) => [
      { label: 'client_id (admin-only) from a non-admin', args: { client_id: vic.owner }, refused: true },
      { label: 'userId override still lists the caller\'s own lists', args: { userId: vic.owner }, shows: [atk.listName] },
      { label: 'user_id override still lists the caller\'s own lists', args: { user_id: vic.owner }, shows: [atk.listName] },
    ],
  },
  {
    tool: 'create_lead_list',
    ownRead: (t) => ({ args: { action: 'get', list_id: t.listId }, shows: [t.listName] }),
    foreign: (_atk, vic) => [
      { label: "get the other tenant's list", args: { action: 'get', list_id: vic.listId }, refused: true },
      { label: "rename the other tenant's list", args: { action: 'update', list_id: vic.listId, name: 'HIJACKED LIST' }, refused: true },
      { label: "delete the other tenant's list", args: { action: 'delete', list_id: vic.listId }, refused: true },
    ],
    overrides: (atk, vic) => [
      { label: 'userId override on get still answers as the caller', args: { action: 'get', list_id: atk.listId, userId: vic.owner }, shows: [atk.listName] },
      { label: 'userId override on create never creates a list for the other tenant', args: { action: 'create', name: 'PLANTED LIST', list_type: 'sales', userId: vic.owner } },
    ],
  },
  {
    tool: 'manage_brand',
    ownRead: (t) => ({ args: { action: 'read' }, shows: [t.brandName] }),
    foreign: () => [],
    overrides: (atk, vic) => [
      { label: 'client_id on read is ignored: the caller\'s own brand answers', args: { action: 'read', client_id: vic.owner }, shows: [atk.brandName] },
      { label: 'userId override on update never writes the other tenant\'s brand', args: { action: 'update', company_name: 'HIJACKED BRAND', userId: vic.owner } },
      { label: 'user_id override on update never writes the other tenant\'s brand', args: { action: 'update', company_name: 'HIJACKED BRAND', user_id: vic.owner } },
    ],
  },
  {
    tool: 'manage_market_strategy',
    ownRead: (t) => ({ args: { action: 'read' }, shows: [t.competitor, t.icp] }),
    foreign: () => [],
    overrides: (atk, vic) => [
      { label: 'client_id on read is ignored: the caller\'s own strategy answers', args: { action: 'read', client_id: vic.owner }, shows: [atk.competitor] },
      { label: 'userId override on update never writes the other tenant\'s strategy', args: { action: 'update', competitors: [{ name: 'HIJACKRIVAL' }], userId: vic.owner } },
      { label: 'user_id override on update never writes the other tenant\'s strategy', args: { action: 'update', competitors: [{ name: 'HIJACKRIVAL' }], user_id: vic.owner } },
    ],
  },
];

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
beforeEach(() => seedTwoTenantWorld(fake));

/** Check 6, applied to every single answer: nothing of the victim's content, whatever the outcome. */
function expectNoVictimContent(label: string, o: Outcome, vic: Tenant): void {
  const leaked = contentMarkers(vic).filter((m) => o.text.includes(m));
  expect({ label, leaked }).toEqual({ label, leaked: [] });
}

async function runAttempt(caller: McpCaller, tool: string, atk: Tenant, vic: Tenant, a: Attempt): Promise<Outcome> {
  const before = snapshotTenant(fake, vic);
  const o = await caller.call(tool, a.args);
  if (a.refused) expect({ label: a.label, isError: o.isError, text: o.text.slice(0, 200) }).toMatchObject({ label: a.label, isError: true });
  expectNoVictimContent(a.label, o, vic);
  for (const marker of a.shows ?? []) expect({ label: a.label, shown: o.text.includes(marker), marker }).toEqual({ label: a.label, shown: true, marker });
  // The victim's rows must be exactly what they were.
  expect({ label: a.label, victimUnchanged: snapshotTenant(fake, vic) === before }).toEqual({ label: a.label, victimUnchanged: true });
  void atk;
  return o;
}

describe.each(SPECS)('$tool: two-tenant isolation', (spec) => {
  describe.each([
    [TENANT_A, TENANT_B],
    [TENANT_B, TENANT_A],
  ] as Array<[Tenant, Tenant]>)('tenant %#', (atk, vic) => {
    const owner = () => callers[atk.owner];

    it(`1+2: ${atk.label}'s owner reads its own data and never ${vic.label}'s`, async () => {
      const { args, shows } = spec.ownRead(atk);
      const o = await owner().call(spec.tool, args);
      expect(o.isError).toBe(false);
      for (const marker of shows) expect(o.text).toContain(marker);
      expectNoVictimContent('own read', o, vic);
      // A read that named no identifier of the other tenant must not carry one either.
      expect(idMarkers(vic).filter((m) => o.text.includes(m))).toEqual([]);
    });

    it(`3: ${atk.label} aiming at ${vic.label}'s identifiers is refused and ${vic.label}'s rows do not change`, async () => {
      for (const attempt of spec.foreign(atk, vic)) await runAttempt(owner(), spec.tool, atk, vic, attempt);
    });

    it(`5: identity overrides from ${atk.label} never change whose data answers or gets written`, async () => {
      for (const attempt of spec.overrides(atk, vic)) await runAttempt(owner(), spec.tool, atk, vic, attempt);
    });
  });

  it("4: A's same-org member sees nothing of B's, and B's rows do not change", async () => {
    const member = callers[TENANT_A.member!];
    const { args } = spec.ownRead(TENANT_A);
    const before = snapshotTenant(fake, TENANT_B);
    const o = await member.call(spec.tool, args);
    expectNoVictimContent('member own-org read', o, TENANT_B);
    for (const attempt of [...spec.foreign(TENANT_A, TENANT_B), ...spec.overrides(TENANT_A, TENANT_B)]) {
      const r = await member.call(spec.tool, attempt.args);
      expectNoVictimContent(`member: ${attempt.label}`, r, TENANT_B);
      if (attempt.refused) expect({ label: attempt.label, isError: r.isError }).toEqual({ label: attempt.label, isError: true });
    }
    expect(snapshotTenant(fake, TENANT_B)).toBe(before);
  });
});

describe('coverage guard', () => {
  it('every tool in the covered list has a spec, and every spec is in the list', () => {
    expect(SPECS.map((s) => s.tool).sort()).toEqual([...TWO_TENANT_COVERED_TOOLS].sort());
  });

  it('every covered tool is still a registered MCP tool (a rename must not silently drop its isolation cases)', () => {
    for (const tool of TWO_TENANT_COVERED_TOOLS) expect({ tool, registered: !!mcpToolRegistry.getTool(tool) }).toEqual({ tool, registered: true });
  });

  it('the world is two distinct tenants with no shared identifier or text', () => {
    const a = [...idMarkers(TENANT_A), ...contentMarkers(TENANT_A)];
    const b = [...idMarkers(TENANT_B), ...contentMarkers(TENANT_B)];
    expect(a.filter((m) => b.some((x) => x.includes(m) || m.includes(x)))).toEqual([]);
  });
});
