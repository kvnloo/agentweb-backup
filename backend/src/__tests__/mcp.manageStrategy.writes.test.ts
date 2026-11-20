/**
 * ENG-2840 wave 1, PR C: what an outside agent may write to the market strategy through manage_market_strategy, and how its read pages,
 * proved through the REAL path (MCP client -> MCP server -> tool -> mcpFetch -> the real Express app -> db.ts -> in-memory DynamoDB), the same path
 * as mcp.twoTenantIsolation.test.ts and mcp.manageLeads.writes.test.ts.
 *
 * Emma's update_market_strategy reads the strategy first and merges competitors by name and ICPs by title. Over MCP the arguments were forwarded to
 * POST /api/market-strategy, which REPLACES the stored lists: one new competitor deleted the others, and positioning / differentiators / channels
 * were dropped without a word.
 */
jest.mock('aws-sdk', () => {
  const actual = jest.requireActual('aws-sdk');
  const { makeTwoTenantFake } = jest.requireActual('./helpers/twoTenantMcpHarness');
  const fake = makeTwoTenantFake();
  (global as any).__strategyWritesFake = fake;
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
  COMPETITOR_LOOKUP_MAX,
  COMPETITOR_PAGE_CHAR_BUDGET,
  MAX_STORED_COMPETITORS,
  mergeStrategyEntries,
  validateStrategyEntries,
} from '../mcp/server/manageStrategyWrites';
import {
  connectCaller,
  installSelfCallFetch,
  seedTwoTenantWorld,
  snapshotTenant,
  TENANT_A,
  TENANT_B,
  type McpCaller,
} from './helpers/twoTenantMcpHarness';

const fake: any = (global as any).__strategyWritesFake;
const orgRow = (orgId: string) => fake.items('AW-Organizations').find((o: any) => o.orgId === orgId);
const strategyOf = (orgId: string) => orgRow(orgId).marketStrategy;
const names = (list: any[]) => list.map((e) => e.name);
const SOLO = 'user-solo';
const STORED_AT = '2026-10-01T09:00:00.000Z';

let restoreFetch: () => void;
let owner: McpCaller;
let member: McpCaller;
let other: McpCaller;
let solo: McpCaller;

beforeAll(async () => {
  restoreFetch = installSelfCallFetch(app);
  owner = await connectCaller(TENANT_A.owner);
  member = await connectCaller(TENANT_A.member!);
  other = await connectCaller(TENANT_B.owner);
  solo = await connectCaller(SOLO);
});
afterAll(async () => {
  await Promise.all([owner.close(), member.close(), other.close(), solo.close()]);
  restoreFetch();
});

/** Tenant A's org holds a realistic strategy; a solo user (no org) holds one on the user record. */
beforeEach(() => {
  seedTwoTenantWorld(fake);
  fake.seed('AW-Organizations', {
    ...orgRow(TENANT_A.orgId),
    marketStrategy: {
      businessOverview: 'ALPHA sells widgets',
      competitors: [
        { name: 'AlphaRival', description: 'The old incumbent' },
        { name: 'Beta Corp', description: 'Cheap and cheerful' },
        { name: 'Gamma', description: 'Enterprise only' },
      ],
      icp: [
        { title: 'IT Director', description: 'Runs the stack', valueProposition: 'Fewer tickets', buyerPersonas: ['CIO'], extractedFilters: { cacheKey: 'k1', cacheVersion: 1, variants: [], generatedAt: STORED_AT } },
        { title: 'Founder', description: 'Small team', valueProposition: 'Speed', buyerPersonas: ['CEO', 'CTO'] },
      ],
      createdAt: STORED_AT,
      updatedAt: STORED_AT,
      icpUpdatedAt: STORED_AT,
    },
  });
  fake.seed('AW-Users', {
    email: 'solo@solo.test', userId: SOLO, isActive: true, isAdmin: false, roles: ['customer'],
    marketStrategy: { businessOverview: 'SOLO sells gadgets', competitors: [{ name: 'SoloRival', description: 'x' }], icp: [{ title: 'Solo ICP', description: 'y' }], createdAt: STORED_AT, updatedAt: STORED_AT },
  });
});

const update = (caller: McpCaller, args: Record<string, unknown>) => caller.call('manage_market_strategy', { action: 'update', ...args });
const read = (caller: McpCaller, args: Record<string, unknown> = {}) => caller.call('manage_market_strategy', { action: 'read', ...args });

describe('update: merge, never replace', () => {
  it('one new competitor is added and the stored ones stay (the route alone would have replaced the list)', async () => {
    const r = await update(owner, { competitors: [{ name: 'Delta', description: 'New entrant' }] });
    expect(r.isError).toBe(false);
    expect(names(strategyOf(TENANT_A.orgId).competitors)).toEqual(['AlphaRival', 'Beta Corp', 'Gamma', 'Delta']);
    expect(r.json).toMatchObject({ success: true, changed: true, competitors: { added: ['Delta'], updated: [], unchanged: [], total: 4 } });
    // Nothing else moved.
    expect(strategyOf(TENANT_A.orgId).icp).toHaveLength(2);
    expect(strategyOf(TENANT_A.orgId).businessOverview).toBe('ALPHA sells widgets');
  });

  it('a stored competitor is matched without regard to case and padding, keeps its own spelling, and is not duplicated', async () => {
    const r = await update(owner, { competitors: [{ name: '  alphaRIVAL ', description: 'Now acquired' }] });
    expect(r.isError).toBe(false);
    const list = strategyOf(TENANT_A.orgId).competitors;
    expect(list).toHaveLength(3);
    expect(list[0]).toEqual({ name: 'AlphaRival', description: 'Now acquired' });
    expect(r.json.competitors).toMatchObject({ added: [], updated: ['AlphaRival'], total: 3 });
  });

  it('an ICP is merged by title: persona list replaced, stored fields the caller did not send (including the cached search filters) kept', async () => {
    const r = await update(owner, { icp: [{ title: 'it director', valueProposition: 'Fewer tickets, faster', buyerPersonas: ['CIO', 'VP Infrastructure'] }] });
    expect(r.isError).toBe(false);
    const icp = strategyOf(TENANT_A.orgId).icp;
    expect(icp).toHaveLength(2);
    expect(icp[0]).toMatchObject({
      title: 'IT Director',
      description: 'Runs the stack',
      valueProposition: 'Fewer tickets, faster',
      buyerPersonas: ['CIO', 'VP Infrastructure'],
      extractedFilters: { cacheKey: 'k1' },
    });
    expect(icp[1].title).toBe('Founder');
    expect(strategyOf(TENANT_A.orgId).icpUpdatedAt).not.toBe(STORED_AT);
  });

  it('a competitors-only update does not mark the ICPs as edited', async () => {
    await update(owner, { competitors: [{ name: 'Delta' }] });
    expect(strategyOf(TENANT_A.orgId).icpUpdatedAt).toBe(STORED_AT);
  });

  it('businessOverview replaces the overview and nothing else', async () => {
    const r = await update(owner, { businessOverview: 'ALPHA sells widgets and gadgets' });
    expect(r.isError).toBe(false);
    expect(r.json.businessOverview).toBe('updated');
    const s = strategyOf(TENANT_A.orgId);
    expect(s.businessOverview).toBe('ALPHA sells widgets and gadgets');
    expect(names(s.competitors)).toEqual(['AlphaRival', 'Beta Corp', 'Gamma']);
    expect(s.icp).toHaveLength(2);
    expect(s.icpUpdatedAt).toBe(STORED_AT);
  });

  it('several entries in one call, including two for the same new name, merge in order', async () => {
    const r = await update(owner, {
      competitors: [{ name: 'Delta', description: 'first' }, { name: 'delta', description: 'second' }, { name: 'Beta Corp', description: 'Cheap, cheerful, growing' }],
    });
    expect(r.isError).toBe(false);
    const list = strategyOf(TENANT_A.orgId).competitors;
    expect(list.map((e: any) => [e.name, e.description])).toEqual([
      ['AlphaRival', 'The old incumbent'],
      ['Beta Corp', 'Cheap, cheerful, growing'],
      ['Gamma', 'Enterprise only'],
      ['Delta', 'second'],
    ]);
    expect(r.json.competitors).toMatchObject({ added: ['Delta'], updated: ['Delta', 'Beta Corp'] });
  });

  it('a stored ICP that has no title (older data) is kept and the new profile is added next to it', async () => {
    fake.seed('AW-Organizations', { ...orgRow(TENANT_A.orgId), marketStrategy: { ...strategyOf(TENANT_A.orgId), icp: [{ name: 'Legacy persona' }] } });
    const r = await update(owner, { icp: [{ title: 'Founder', description: 'Small team' }] });
    expect(r.isError).toBe(false);
    expect(strategyOf(TENANT_A.orgId).icp).toEqual([{ name: 'Legacy persona' }, { title: 'Founder', description: 'Small team' }]);
  });

  it('works for a solo user (the strategy on the user record) the same way', async () => {
    const r = await update(solo, { competitors: [{ name: 'Delta' }], icp: [{ title: 'Solo ICP', valueProposition: 'Simple' }] });
    expect(r.isError).toBe(false);
    const row = fake.items('AW-Users').find((u: any) => u.userId === SOLO).marketStrategy;
    expect(names(row.competitors)).toEqual(['SoloRival', 'Delta']);
    expect(row.icp).toEqual([{ title: 'Solo ICP', description: 'y', valueProposition: 'Simple' }]);
    expect(row.businessOverview).toBe('SOLO sells gadgets');
  });

  it('the other tenant is untouched by every write', async () => {
    const before = snapshotTenant(fake, TENANT_B);
    await update(owner, { competitors: [{ name: 'Delta' }], businessOverview: 'changed' });
    expect(snapshotTenant(fake, TENANT_B)).toBe(before);
  });
});

describe('update: nothing is written when nothing changes', () => {
  it('entries already stored exactly as sent write nothing (no timestamp moves, the ICPs are not marked edited)', async () => {
    const before = JSON.stringify(orgRow(TENANT_A.orgId));
    const r = await update(owner, {
      businessOverview: 'ALPHA sells widgets',
      competitors: [{ name: 'AlphaRival', description: 'The old incumbent' }],
      icp: [{ title: 'Founder', description: 'Small team', valueProposition: 'Speed', buyerPersonas: ['CEO', 'CTO'] }],
    });
    expect(r.isError).toBe(false);
    expect(r.json).toMatchObject({ success: true, changed: false, businessOverview: 'unchanged', competitors: { unchanged: ['AlphaRival'], total: 3 }, icp: { unchanged: ['Founder'], total: 2 } });
    expect(JSON.stringify(orgRow(TENANT_A.orgId))).toBe(before);
  });

  it('blank text never blanks a stored value', async () => {
    const r = await update(owner, { competitors: [{ name: 'AlphaRival', description: '   ' }], icp: [{ title: 'Founder', valueProposition: '', buyerPersonas: [] }] });
    expect(r.isError).toBe(false);
    expect(r.json.changed).toBe(false);
    expect(strategyOf(TENANT_A.orgId).competitors[0].description).toBe('The old incumbent');
    expect(strategyOf(TENANT_A.orgId).icp[1]).toMatchObject({ valueProposition: 'Speed', buyerPersonas: ['CEO', 'CTO'] });
  });

  it.each([
    ['no fields at all', {}],
    ['empty lists and blank overview', { competitors: [], icp: [], businessOverview: '  ' }],
  ])('%s is refused instead of reported as saved', async (_label, args) => {
    const before = JSON.stringify(orgRow(TENANT_A.orgId));
    const r = await update(owner, args);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/at least one of businessOverview, competitors or icp/);
    expect(JSON.stringify(orgRow(TENANT_A.orgId))).toBe(before);
  });
});

describe('update: refusals name the problem and change nothing', () => {
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ['positioning', { competitors: [{ name: 'Delta' }], positioning: 'The best' }, /"positioning" is not stored/],
    ['differentiators', { differentiators: ['fast'] }, /"differentiators" is not stored/],
    ['channels', { channels: ['email'] }, /"channels" is not stored/],
    ['an unsupported competitor field', { competitors: [{ name: 'Delta', website: 'https://delta.test' }] }, /competitors\[0\] has fields that are not stored: "website"/],
    ['an unsupported ICP field', { icp: [{ title: 'X', extractedFilters: { cacheKey: 'forged' } }] }, /icp\[0\] has fields that are not stored: "extractedFilters"/],
    ['a competitor without a name', { competitors: [{ description: 'no name' }] }, /competitors\[0\]\.name is required/],
    ['a blank competitor name', { competitors: [{ name: '   ' }] }, /competitors\[0\]\.name is required/],
    ['an ICP without a title', { icp: [{ description: 'no title' }] }, /icp\[0\]\.title is required/],
    ['competitors that are not a list', { competitors: 'Delta' }, /competitors must be a list of objects/],
    ['an entry that is not an object', { competitors: ['Delta'] }, /competitors\[0\] must be an object/],
    ['a description that is not text', { competitors: [{ name: 'Delta', description: 42 }] }, /competitors\[0\]\.description must be text/],
    ['buyerPersonas that are not a list of text', { icp: [{ title: 'X', buyerPersonas: 'CIO' }] }, /icp\[0\]\.buyerPersonas must be a list of text/],
    ['an overview that is not text', { businessOverview: { text: 'x' } }, /businessOverview must be text/],
    ['an over-long name', { competitors: [{ name: 'n'.repeat(201) }] }, /competitors\[0\]\.name must be 200 characters or fewer/],
    ['an over-long description', { competitors: [{ name: 'Delta', description: 'd'.repeat(5001) }] }, /competitors\[0\]\.description must be 5000 characters or fewer/],
    ['an over-long overview', { businessOverview: 'o'.repeat(20001) }, /businessOverview must be 20000 characters or fewer/],
    ['more than 100 entries', { competitors: Array.from({ length: 101 }, (_, i) => ({ name: `C${i}` })) }, /at most 100 entries per call/],
    ['too many buyer personas', { icp: [{ title: 'X', buyerPersonas: Array.from({ length: 51 }, (_, i) => `P${i}`) }] }, /buyerPersonas may hold at most 50/],
  ];
  it.each(cases)('%s', async (_label, args, message) => {
    const before = JSON.stringify(orgRow(TENANT_A.orgId));
    const r = await update(owner, args);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(message);
    expect(r.text).toMatch(/Nothing was changed/);
    expect(JSON.stringify(orgRow(TENANT_A.orgId))).toBe(before);
  });

  it('one bad entry in a list refuses the whole call: the good entries are not saved either', async () => {
    const before = JSON.stringify(orgRow(TENANT_A.orgId));
    const r = await update(owner, { competitors: [{ name: 'Delta' }, { name: 'Epsilon', website: 'x' }] });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(orgRow(TENANT_A.orgId))).toBe(before);
  });

  it('a list that is full takes no new entry, but its stored entries can still be updated', async () => {
    const full = Array.from({ length: MAX_STORED_COMPETITORS }, (_, i) => ({ name: `Rival ${i}`, description: 'x' }));
    fake.seed('AW-Organizations', { ...orgRow(TENANT_A.orgId), marketStrategy: { ...strategyOf(TENANT_A.orgId), competitors: full } });
    const refused = await update(owner, { competitors: [{ name: 'One too many' }] });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/would hold 501 entries, over the limit of 500/);
    expect(strategyOf(TENANT_A.orgId).competitors).toHaveLength(MAX_STORED_COMPETITORS);
    const ok = await update(owner, { competitors: [{ name: 'rival 7', description: 'changed' }] });
    expect(ok.isError).toBe(false);
    expect(strategyOf(TENANT_A.orgId).competitors[7]).toEqual({ name: 'Rival 7', description: 'changed' });
  });
});

describe('update: who may write', () => {
  it('an org member who is not an editor is refused by the route, and nothing changes; a listed editor may write', async () => {
    const before = JSON.stringify(orgRow(TENANT_A.orgId));
    const refused = await update(member, { competitors: [{ name: 'Delta' }] });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/Not authorized to edit marketing strategy/);
    expect(JSON.stringify(orgRow(TENANT_A.orgId))).toBe(before);

    const org = orgRow(TENANT_A.orgId);
    fake.seed('AW-Organizations', { ...org, shareSettings: { ...(org.shareSettings || {}), marketingStrategy: { editors: [TENANT_A.member] } } });
    const ok = await update(member, { competitors: [{ name: 'Delta' }] });
    expect(ok.isError).toBe(false);
    expect(names(strategyOf(TENANT_A.orgId).competitors)).toContain('Delta');
  });

  it('a member who is not an editor can still read', async () => {
    const r = await read(member);
    expect(r.isError).toBe(false);
    expect(r.json.totalCompetitors).toBe(3);
  });

  it('another tenant\'s caller writes to its own strategy only', async () => {
    const before = snapshotTenant(fake, TENANT_A);
    const r = await update(other, { competitors: [{ name: 'BravoNew' }] });
    expect(r.isError).toBe(false);
    expect(snapshotTenant(fake, TENANT_A)).toBe(before);
    expect(names(strategyOf(TENANT_B.orgId).competitors)).toEqual(['BravoRival', 'BravoNew']);
  });
});

describe('update: parallel calls from one agent', () => {
  it('two updates sent together both land (each merges onto what the other saved)', async () => {
    const [x, y] = await Promise.all([
      update(owner, { competitors: [{ name: 'Delta' }] }),
      update(owner, { competitors: [{ name: 'Epsilon' }], icp: [{ title: 'Analyst' }] }),
    ]);
    expect(x.isError).toBe(false);
    expect(y.isError).toBe(false);
    const s = strategyOf(TENANT_A.orgId);
    expect(names(s.competitors).sort()).toEqual(['AlphaRival', 'Beta Corp', 'Delta', 'Epsilon', 'Gamma']);
    expect(s.icp.map((e: any) => e.title)).toEqual(['IT Director', 'Founder', 'Analyst']);
  });

  it('five updates sent together all land', async () => {
    const results = await Promise.all(['D1', 'D2', 'D3', 'D4', 'D5'].map((n) => update(owner, { competitors: [{ name: n }] })));
    expect(results.every((r) => !r.isError)).toBe(true);
    expect(strategyOf(TENANT_A.orgId).competitors).toHaveLength(8);
  });
});

describe('read: paged competitors', () => {
  const roster = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `Rival ${String(i).padStart(3, '0')}`, description: `d${i} ` + 'x'.repeat(1000) }));
  const seedRoster = (n: number) =>
    fake.seed('AW-Organizations', { ...orgRow(TENANT_A.orgId), marketStrategy: { ...strategyOf(TENANT_A.orgId), competitors: roster(n) } });

  it('a small roster comes back whole, with the true total and no next page (the answer keeps its old shape)', async () => {
    const r = await read(owner);
    expect(r.isError).toBe(false);
    expect(r.json).toMatchObject({ success: true, totalCompetitors: 3, competitorOffset: 0, competitorsReturned: 3, nextCompetitorOffset: null });
    expect(r.json.data.competitors).toHaveLength(3);
    expect(r.json.data.icp).toHaveLength(2);
    expect(r.json.data.businessOverview).toBe('ALPHA sells widgets');
    expect(r.json.competitorLookup).toBeUndefined();
  });

  it('a large roster is paged by size; walking nextCompetitorOffset returns every competitor once, in order', async () => {
    seedRoster(60);
    const seen: string[] = [];
    let offset: number | null = 0;
    let pages = 0;
    while (offset !== null) {
      const r: any = await read(owner, { competitorOffset: offset });
      expect(r.isError).toBe(false);
      expect(r.json.totalCompetitors).toBe(60);
      expect(r.json.competitorOffset).toBe(offset);
      expect(JSON.stringify(r.json.data.competitors).length).toBeLessThanOrEqual(COMPETITOR_PAGE_CHAR_BUDGET + 1100);
      seen.push(...names(r.json.data.competitors));
      offset = r.json.nextCompetitorOffset;
      pages++;
      expect(pages).toBeLessThan(20);
    }
    expect(pages).toBeGreaterThan(1);
    expect(seen).toEqual(names(roster(60)));
  });

  it('an offset past the end lands on the last competitor, never on an empty page', async () => {
    seedRoster(60);
    const r = await read(owner, { competitorOffset: 9999 });
    expect(r.json).toMatchObject({ competitorOffset: 59, competitorsReturned: 1, nextCompetitorOffset: null });
    expect(names(r.json.data.competitors)).toEqual(['Rival 059']);
  });

  it('a single entry bigger than the page budget is still returned', async () => {
    fake.seed('AW-Organizations', { ...orgRow(TENANT_A.orgId), marketStrategy: { ...strategyOf(TENANT_A.orgId), competitors: [{ name: 'Huge', description: 'h'.repeat(COMPETITOR_PAGE_CHAR_BUDGET * 2) }, { name: 'Small' }] } });
    const r = await read(owner);
    expect(r.json).toMatchObject({ competitorsReturned: 1, nextCompetitorOffset: 1 });
    expect(names(r.json.data.competitors)).toEqual(['Huge']);
  });

  it('competitorNames answers stored / not stored with the offset, ignoring case and padding, whatever the page shows', async () => {
    seedRoster(60);
    const r = await read(owner, { competitorNames: ['rival 059', ' RIVAL 003 ', 'Nobody'] });
    expect(r.json.competitorLookup).toEqual([
      { name: 'rival 059', stored: true, offset: 59 },
      { name: ' RIVAL 003 ', stored: true, offset: 3 },
      { name: 'Nobody', stored: false, offset: null },
    ]);
    expect(r.json.competitorNamesNotChecked).toBe(0);
  });

  it('names beyond the 50 that are checked are reported, not treated as absent', async () => {
    const asked = Array.from({ length: COMPETITOR_LOOKUP_MAX + 7 }, (_, i) => `Name ${i}`);
    const r = await read(owner, { competitorNames: asked });
    expect(r.json.competitorLookup).toHaveLength(COMPETITOR_LOOKUP_MAX);
    expect(r.json.competitorNamesNotChecked).toBe(7);
  });

  it('digits-only text is a whole number; anything else is refused by name', async () => {
    seedRoster(60);
    expect((await read(owner, { competitorOffset: '3' })).json.competitorOffset).toBe(3);
    for (const bad of [-1, 1.5, 'abc', '-2', {}, true]) {
      const r = await read(owner, { competitorOffset: bad });
      expect({ bad, isError: r.isError }).toEqual({ bad, isError: true });
      expect(r.text).toMatch(/competitorOffset must be a whole number/);
    }
    const r = await read(owner, { competitorNames: 'Delta' });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/competitorNames must be a list of text/);
  });

  it('an account with no stored strategy reads as empty, with a zero total', async () => {
    fake.tables.get('AW-Users').clear();
    fake.seed('AW-Users', { email: 'empty@solo.test', userId: SOLO, isActive: true, isAdmin: false, roles: ['customer'] });
    const r = await read(solo);
    expect(r.isError).toBe(false);
    expect(r.json).toMatchObject({ totalCompetitors: 0, competitorsReturned: 0, nextCompetitorOffset: null });
    expect(r.json.data.competitors).toEqual([]);
  });
});

describe('pure helpers', () => {
  it('validateStrategyEntries leaves an unsent list alone and cleans a sent one', () => {
    expect(validateStrategyEntries('competitors', undefined)).toBeUndefined();
    expect(validateStrategyEntries('competitors', null)).toBeUndefined();
    expect(validateStrategyEntries('icp', [{ title: ' T ', description: ' d ', buyerPersonas: [' a ', '', 'b'] }])).toEqual([{ title: 'T', description: 'd', buyerPersonas: ['a', 'b'] }]);
  });

  it('mergeStrategyEntries removes nothing, keeps stored extras, and reports a repeat as unchanged', () => {
    const stored = [{ name: 'A', description: 'a', extra: 1 }, 'legacy text entry', { name: 'B' }];
    const out = mergeStrategyEntries(stored, [{ name: 'a', description: 'a' }, { name: 'B', description: 'new' }, { name: 'C' }], 'name');
    expect(out.merged).toEqual([{ name: 'A', description: 'a', extra: 1 }, 'legacy text entry', { name: 'B', description: 'new' }, { name: 'C' }]);
    expect({ added: out.added, updated: out.updated, unchanged: out.unchanged }).toEqual({ added: ['C'], updated: ['B'], unchanged: ['A'] });
    expect(mergeStrategyEntries(undefined, [{ name: 'X' }], 'name').merged).toEqual([{ name: 'X' }]);
  });
});
