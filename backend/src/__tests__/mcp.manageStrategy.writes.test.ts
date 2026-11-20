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
import { userDb } from '../services/db';
import {
  clearRecentStrategyWrites,
  executeStrategyUpdate,
  COMPETITOR_LOOKUP_MAX,
  COMPETITOR_PAGE_CHAR_BUDGET,
  MAX_STORED_COMPETITORS,
  MAX_STORED_ICPS,
  MAX_STRATEGY_BYTES,
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
  clearRecentStrategyWrites();
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
      // The entries on a page add up to the budget at most (a single oversized entry aside, which a page always returns).
      const used = r.json.data.competitors.reduce((n: number, e: unknown) => n + JSON.stringify(e).length, 0);
      expect(used).toBeLessThanOrEqual(COMPETITOR_PAGE_CHAR_BUDGET);
      if (r.json.nextCompetitorOffset !== null) expect(used).toBeGreaterThan(COMPETITOR_PAGE_CHAR_BUDGET - 1200);
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

  it('an offset too big to be exact still lands on the last competitor (number or text)', async () => {
    seedRoster(60);
    for (const huge of [1e21, '99999999999999999999']) {
      const r = await read(owner, { competitorOffset: huge });
      expect({ huge, isError: r.isError, offset: r.json?.competitorOffset }).toEqual({ huge, isError: false, offset: 59 });
    }
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
    for (const bad of ['Delta', ['Delta', 7], [null]]) {
      const r = await read(owner, { competitorNames: bad });
      expect({ bad, isError: r.isError }).toEqual({ bad, isError: true });
      expect(r.text).toMatch(/competitorNames must be a list of text/);
    }
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

/** Put `member` on the org's marketingStrategy editors list. */
const makeMemberEditor = () => {
  const org = orgRow(TENANT_A.orgId);
  fake.seed('AW-Organizations', { ...org, shareSettings: { ...(org.shareSettings || {}), marketingStrategy: { editors: [TENANT_A.member] } } });
};

/** Answer GET /api/market-strategy calls with `forced(callNumber)` when it returns a body, and let every other call through to the real app. */
async function withStrategyReadsOverridden(forced: (call: number) => unknown, run: () => Promise<void>): Promise<void> {
  const realFetch = global.fetch;
  let call = 0;
  global.fetch = (async (url: any, init: any = {}) => {
    if (String(url).includes('/api/market-strategy') && String(init.method || 'GET').toUpperCase() === 'GET') {
      const body = forced(++call);
      if (body !== undefined) {
        const text = typeof body === 'string' ? body : JSON.stringify(body);
        return { ok: true, status: 200, headers: { get: () => (typeof body === 'string' ? 'text/plain' : 'application/json') }, json: async () => JSON.parse(text), text: async () => text } as any;
      }
    }
    return realFetch(url, init);
  }) as any;
  try {
    await run();
  } finally {
    global.fetch = realFetch;
  }
}

describe('update: the merge baseline', () => {
  it('the org owner and a listed editor writing at the same moment both land (one lock for the org, not one per member)', async () => {
    makeMemberEditor();
    const [x, y] = await Promise.all([update(owner, { competitors: [{ name: 'FromOwner' }] }), update(member, { competitors: [{ name: 'FromMember' }] })]);
    expect(x.isError).toBe(false);
    expect(y.isError).toBe(false);
    expect(names(strategyOf(TENANT_A.orgId).competitors).sort()).toEqual(['AlphaRival', 'Beta Corp', 'FromMember', 'FromOwner', 'Gamma']);
  });

  it('a read that is older than what this process just saved is not merged onto (an eventually consistent read right after a write)', async () => {
    const before = JSON.parse(JSON.stringify({ success: true, data: strategyOf(TENANT_A.orgId), isOrgLevel: true }));
    const first = await update(owner, { competitors: [{ name: 'Delta' }] });
    expect(first.isError).toBe(false);
    await withStrategyReadsOverridden(() => before, async () => {
      const second = await update(owner, { competitors: [{ name: 'Epsilon' }] });
      expect(second.isError).toBe(false);
    });
    expect(names(strategyOf(TENANT_A.orgId).competitors)).toEqual(['AlphaRival', 'Beta Corp', 'Gamma', 'Delta', 'Epsilon']);
  });

  it('a read that wrongly shows nothing stored is read once more before it is believed (a missed read must not turn the write into a replace)', async () => {
    const empty = { success: true, data: { businessOverview: '', competitors: [], icp: [] }, isOrgLevel: true };
    await withStrategyReadsOverridden((call) => (call === 1 ? empty : undefined), async () => {
      const r = await update(owner, { competitors: [{ name: 'Delta' }] });
      expect(r.isError).toBe(false);
    });
    expect(names(strategyOf(TENANT_A.orgId).competitors)).toEqual(['AlphaRival', 'Beta Corp', 'Gamma', 'Delta']);
  });

  it('an org whose strategy sits on the owner\'s own record is merged onto that, for a listed editor', async () => {
    makeMemberEditor();
    const ownerStrategy = { businessOverview: 'Owner copy', competitors: [{ name: 'OwnerRival', description: 'x' }], icp: [{ title: 'Owner ICP' }], createdAt: STORED_AT, updatedAt: STORED_AT };
    const org = orgRow(TENANT_A.orgId);
    const { marketStrategy: _dropped, ...orgWithoutStrategy } = org;
    fake.seed('AW-Organizations', orgWithoutStrategy);
    const ownerRow = fake.items('AW-Users').find((u: any) => u.userId === TENANT_A.owner);
    fake.seed('AW-Users', { ...ownerRow, marketStrategy: ownerStrategy });
    const r = await update(member, { competitors: [{ name: 'EditorRival' }] });
    expect(r.isError).toBe(false);
    expect(names(strategyOf(TENANT_A.orgId).competitors)).toEqual(['OwnerRival', 'EditorRival']);
    expect(strategyOf(TENANT_A.orgId).icp).toEqual([{ title: 'Owner ICP' }]);
    expect(strategyOf(TENANT_A.orgId).businessOverview).toBe('Owner copy');
  });

  it.each([
    ['text instead of JSON', 'Service Unavailable'],
    ['a failure body', { success: false, error: 'nope' }],
    ['a body with no strategy', { success: true }],
  ])('an answer from the read that is %s is not a baseline: nothing is changed (update and read)', async (_label, bad) => {
    const before = JSON.stringify(orgRow(TENANT_A.orgId));
    await withStrategyReadsOverridden(() => bad, async () => {
      const u = await update(owner, { competitors: [{ name: 'Delta' }] });
      expect(u.isError).toBe(true);
      expect(u.text).toMatch(/could not be read, so nothing was changed/);
      const r = await read(owner);
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/could not be read/);
    });
    expect(JSON.stringify(orgRow(TENANT_A.orgId))).toBe(before);
  });

  it('stored lists that are not lists are refused, not treated as empty', async () => {
    fake.seed('AW-Organizations', { ...orgRow(TENANT_A.orgId), marketStrategy: { ...strategyOf(TENANT_A.orgId), competitors: 'oops' } });
    const before = JSON.stringify(orgRow(TENANT_A.orgId));
    const r = await update(owner, { competitors: [{ name: 'Delta' }] });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/the stored competitors are not a list/);
    expect(JSON.stringify(orgRow(TENANT_A.orgId))).toBe(before);
  });
});

describe('update: stored padding, names and size', () => {
  it('stored text with trailing padding is not a change when the caller sends the same text trimmed (the ICPs are not marked edited)', async () => {
    const s = strategyOf(TENANT_A.orgId);
    fake.seed('AW-Organizations', {
      ...orgRow(TENANT_A.orgId),
      marketStrategy: {
        ...s,
        businessOverview: 'ALPHA sells widgets\n',
        competitors: [{ name: 'AlphaRival', description: 'The old incumbent ' }],
        icp: [{ title: 'Founder', description: 'Runs the stack\n', buyerPersonas: ['CEO ', ' CTO'] }],
      },
    });
    const before = JSON.stringify(orgRow(TENANT_A.orgId));
    const r = await update(owner, {
      businessOverview: 'ALPHA sells widgets',
      competitors: [{ name: 'AlphaRival', description: 'The old incumbent' }],
      icp: [{ title: 'Founder', description: 'Runs the stack', buyerPersonas: ['CEO', 'CTO'] }],
    });
    expect(r.isError).toBe(false);
    expect(r.json.changed).toBe(false);
    expect(JSON.stringify(orgRow(TENANT_A.orgId))).toBe(before);
  });

  it('a name with a doubled space is the same competitor, not a second one', async () => {
    const r = await update(owner, { competitors: [{ name: 'beta   CORP', description: 'Updated' }] });
    expect(r.isError).toBe(false);
    expect(strategyOf(TENANT_A.orgId).competitors).toHaveLength(3);
    expect(strategyOf(TENANT_A.orgId).competitors[1]).toEqual({ name: 'Beta Corp', description: 'Updated' });
  });

  it('echoing back a field shown on read (extractedFilters) is refused with a hint to leave it out', async () => {
    const shown = (await read(owner)).json.data.icp[0];
    expect(shown.extractedFilters).toBeDefined();
    const r = await update(owner, { icp: [shown] });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/"extractedFilters"/);
    expect(r.text).toMatch(/kept for you: leave them out/);
  });

  it('a full ICP list takes no new profile, but a stored one can still be updated', async () => {
    const full = Array.from({ length: MAX_STORED_ICPS }, (_, i) => ({ title: `Profile ${i}`, description: 'x' }));
    fake.seed('AW-Organizations', { ...orgRow(TENANT_A.orgId), marketStrategy: { ...strategyOf(TENANT_A.orgId), icp: full } });
    const refused = await update(owner, { icp: [{ title: 'One too many' }] });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/icp would hold 101 entries, over the limit of 100/);
    expect((await update(owner, { icp: [{ title: 'profile 3', description: 'changed' }] })).isError).toBe(false);
    expect(strategyOf(TENANT_A.orgId).icp[3].description).toBe('changed');
  });

  it('a strategy that would pass the size limit takes no growth, but an account already over it can still shrink an entry', async () => {
    const big = Array.from({ length: 60 }, (_, i) => ({ name: `Big ${i}`, description: 'd'.repeat(4900) }));
    fake.seed('AW-Organizations', { ...orgRow(TENANT_A.orgId), marketStrategy: { ...strategyOf(TENANT_A.orgId), competitors: big } });
    expect(JSON.stringify(big).length).toBeGreaterThan(MAX_STRATEGY_BYTES);
    const grow = await update(owner, { competitors: [{ name: 'One more' }] });
    expect(grow.isError).toBe(true);
    expect(grow.text).toMatch(/over the limit of 250000/);
    const growText = await update(owner, { competitors: [{ name: 'Big 1', description: 'd'.repeat(5000) }] });
    expect(growText.isError).toBe(true);
    const shrink = await update(owner, { competitors: [{ name: 'Big 1', description: 'short' }] });
    expect(shrink.isError).toBe(false);
    expect(strategyOf(TENANT_A.orgId).competitors[1].description).toBe('short');
  });

  it.each([
    ['a persona that is too long', { icp: [{ title: 'X', buyerPersonas: ['p'.repeat(501)] }] }, /buyerPersonas entries must be 500 characters or fewer/],
    ['personas that are not text', { icp: [{ title: 'X', buyerPersonas: ['ok', 5] }] }, /buyerPersonas must be a list of text/],
    ['an entry that is a list', { competitors: [['Delta']] }, /competitors\[0\] must be an object/],
    ['an entry that is null', { competitors: [null] }, /competitors\[0\] must be an object/],
  ])('%s is refused by name', async (_label, args, message) => {
    const before = JSON.stringify(orgRow(TENANT_A.orgId));
    const r = await update(owner, args);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(message);
    expect(JSON.stringify(orgRow(TENANT_A.orgId))).toBe(before);
  });

  it('null field values are "not given"', async () => {
    const r = await update(owner, { competitors: [{ name: 'Delta', description: null }], icp: [{ title: 'Founder', valueProposition: null, buyerPersonas: null }] });
    expect(r.isError).toBe(false);
    expect(strategyOf(TENANT_A.orgId).icp[1]).toMatchObject({ valueProposition: 'Speed', buyerPersonas: ['CEO', 'CTO'] });
    expect(strategyOf(TENANT_A.orgId).competitors[3]).toEqual({ name: 'Delta' });
  });
});

describe('arguments the action does not take', () => {
  it.each([
    ['one the tool does not store (an Opslane finding: it answered success and dropped it)', { competitors: [{ name: 'Delta' }], targetAudience: 'SMB founders' }, /"targetAudience" is not an input of update/],
    ['several, listed together', { competitors: [{ name: 'Delta' }], location: 'EU', audience: 'SMB' }, /"location", "audience" are not inputs of update/],
    ['an argument of read', { competitors: [{ name: 'Delta' }], competitorOffset: 3 }, /"competitorOffset" is not an input of update/],
  ])('an update with %s is refused by name and writes nothing', async (_label, args, message) => {
    const before = JSON.stringify(orgRow(TENANT_A.orgId));
    const r = await update(owner, args);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(message);
    expect(r.text).toMatch(/Update takes businessOverview, competitors, icp\. Nothing was changed\./);
    expect(JSON.stringify(orgRow(TENANT_A.orgId))).toBe(before);
  });

  it('a read with data arguments is refused by name instead of ignoring them', async () => {
    const r = await read(owner, { competitors: [{ name: 'Delta' }] });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/"competitors" is not an input of read \(it would be dropped, not saved\)\. Read takes competitorOffset, competitorNames\./);
  });

  it('positioning, differentiators and channels keep their own, more specific refusal', async () => {
    const r = await update(owner, { competitors: [{ name: 'Delta' }], positioning: 'cheaper' });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/"positioning" is not stored by the market strategy/);
  });

  it('identity-style arguments are ignored (the strategy is always the caller\'s own) and the answer says so', async () => {
    const before = snapshotTenant(fake, TENANT_B);
    const w = await update(owner, { competitors: [{ name: 'Delta' }], client_id: TENANT_B.owner, clientId: TENANT_B.owner, user_id: TENANT_B.owner });
    expect(w.isError).toBe(false);
    expect(w.json.ignoredArguments).toEqual(['client_id', 'clientId', 'user_id']);
    expect(names(strategyOf(TENANT_A.orgId).competitors)).toContain('Delta');
    expect(snapshotTenant(fake, TENANT_B)).toBe(before);
    const r = await read(owner, { client_id: TENANT_B.owner });
    expect(r.isError).toBe(false);
    expect(r.json.ignoredArguments).toEqual(['client_id']);
    expect(r.json.data.competitors.map((e: any) => e.name)).not.toContain('BravoRival');
    // A call without them says nothing about them.
    expect((await read(owner)).json.ignoredArguments).toBeUndefined();
  });
});

/** The bodies of the POSTs the tool makes to the strategy route while `run` goes on. */
async function recordStrategyPosts(run: () => Promise<void>): Promise<Array<Record<string, any>>> {
  const realFetch = global.fetch;
  const bodies: Array<Record<string, any>> = [];
  global.fetch = (async (url: any, init: any = {}) => {
    if (String(url).includes('/api/market-strategy') && String(init.method || 'GET').toUpperCase() === 'POST') bodies.push(JSON.parse(init.body));
    return realFetch(url, init);
  }) as any;
  try {
    await run();
  } finally {
    global.fetch = realFetch;
  }
  return bodies;
}

describe('update: parts the route would fill from its own, possibly older, read', () => {
  it('a part that a save of the last minute changed is sent again by the next call, whatever that call changes (the route reads through an eventually consistent index)', async () => {
    const posts = await recordStrategyPosts(async () => {
      expect((await update(owner, { competitors: [{ name: 'Delta' }] })).isError).toBe(false);
      expect((await update(owner, { businessOverview: 'A new overview' })).isError).toBe(false);
      expect((await update(owner, { icp: [{ title: 'Analyst' }] })).isError).toBe(false);
    });
    expect(posts.map((b) => Object.keys(b).sort())).toEqual([
      ['competitors'],
      ['businessOverview', 'competitors'],
      ['businessOverview', 'competitors', 'icp'],
    ]);
    // The part carried along is the saved one, not an older copy.
    expect(posts[1].competitors.map((e: any) => e.name)).toEqual(['AlphaRival', 'Beta Corp', 'Gamma', 'Delta']);
    expect(posts[2].businessOverview).toBe('A new overview');
    const s = strategyOf(TENANT_A.orgId);
    expect(names(s.competitors)).toEqual(['AlphaRival', 'Beta Corp', 'Gamma', 'Delta']);
    expect(s.businessOverview).toBe('A new overview');
    expect(s.icp.map((e: any) => e.title)).toEqual(['IT Director', 'Founder', 'Analyst']);
  });

  it('a competitors-only call right after an ICP save sends the ICPs again but leaves icpUpdatedAt where the ICP save put it (Opslane P1 on 440bb19)', async () => {
    expect((await update(owner, { icp: [{ title: 'Analyst' }] })).isError).toBe(false);
    const stampOfTheIcpSave = strategyOf(TENANT_A.orgId).icpUpdatedAt;
    expect(stampOfTheIcpSave).not.toBe(STORED_AT);
    await new Promise((resolve) => setTimeout(resolve, 5));

    const posts = await recordStrategyPosts(async () => {
      expect((await update(owner, { competitors: [{ name: 'Delta' }] })).isError).toBe(false);
    });

    // The saved ICP list is carried along (the route would otherwise fill it from its own, possibly older, read) ...
    expect(Object.keys(posts[0]).sort()).toEqual(['competitors', 'icp']);
    expect(posts[0].icp.map((e: any) => e.title)).toEqual(['IT Director', 'Founder', 'Analyst']);
    // ... and, being the list already stored, it does not move the stamp.
    const s = strategyOf(TENANT_A.orgId);
    expect(s.icpUpdatedAt).toBe(stampOfTheIcpSave);
    expect(s.icp.map((e: any) => e.title)).toEqual(['IT Director', 'Founder', 'Analyst']);
    expect(names(s.competitors)).toEqual(['AlphaRival', 'Beta Corp', 'Gamma', 'Delta']);
  });

  it('a part nobody saved recently is not sent (so an ICP the call did not touch is not marked as edited)', async () => {
    const posts = await recordStrategyPosts(async () => {
      await update(owner, { competitors: [{ name: 'Delta' }] });
      await update(owner, { competitors: [{ name: 'Epsilon' }] });
    });
    expect(posts.map((b) => Object.keys(b))).toEqual([['competitors'], ['competitors']]);
    expect(strategyOf(TENANT_A.orgId).icpUpdatedAt).toBe(STORED_AT);
  });

  it('after a minute the memory is gone and a call sends only its own parts', async () => {
    const now = Date.now();
    const spy = jest.spyOn(Date, 'now');
    try {
      spy.mockReturnValue(now);
      await update(owner, { competitors: [{ name: 'Delta' }] });
      spy.mockReturnValue(now + 61_000);
      const posts = await recordStrategyPosts(async () => {
        expect((await update(owner, { businessOverview: 'Later overview' })).isError).toBe(false);
      });
      expect(posts.map((b) => Object.keys(b))).toEqual([['businessOverview']]);
    } finally {
      spy.mockRestore();
    }
  });

  it('the parts carried along are the member-shared ones: the owner\'s save is carried by an editor\'s next call', async () => {
    makeMemberEditor();
    await update(owner, { competitors: [{ name: 'FromOwner' }] });
    const posts = await recordStrategyPosts(async () => {
      expect((await update(member, { businessOverview: 'Editor overview' })).isError).toBe(false);
    });
    expect(Object.keys(posts[0]).sort()).toEqual(['businessOverview', 'competitors']);
    expect(names(strategyOf(TENANT_A.orgId).competitors)).toContain('FromOwner');
  });
});

describe('update: names, arguments and who may write', () => {
  it.each(['constructor', 'toString', 'hasOwnProperty', 'valueOf'])('an argument named %s is refused by name, not dropped', async (name) => {
    const before = JSON.stringify(orgRow(TENANT_A.orgId));
    const r = await update(owner, { businessOverview: 'x', [name]: 'y' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain(`"${name}" is not an input of update`);
    expect(JSON.stringify(orgRow(TENANT_A.orgId))).toBe(before);
  });

  it('an own key named __proto__ (which the MCP transport itself drops before a tool sees it) is refused by name too', async () => {
    const args = JSON.parse('{"action":"update","businessOverview":"x","__proto__":"y"}');
    await expect(executeStrategyUpdate(args, { userId: TENANT_A.owner })).rejects.toThrow(/"__proto__" is not an input of update/);
  });

  it('a call that changes nothing is answered without the route\'s editor check (it writes nothing, and the caller can read all of it); a change is still refused', async () => {
    const same = await update(member, { competitors: [{ name: 'AlphaRival', description: 'The old incumbent' }] });
    expect(same.isError).toBe(false);
    expect(same.json.changed).toBe(false);
    const change = await update(member, { competitors: [{ name: 'AlphaRival', description: 'Different' }] });
    expect(change.isError).toBe(true);
    expect(change.text).toMatch(/Not authorized to edit marketing strategy/);
  });

  it('a name that is only invisible characters is refused, and one with an invisible character is the same competitor', async () => {
    for (const bad of ['\u200b', ' \u200d\ufeff ']) {
      const r = await update(owner, { competitors: [{ name: bad }] });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/competitors\[0\]\.name is required/);
    }
    const r = await update(owner, { competitors: [{ name: 'Alpha\u200bRival', description: 'Zero-width in the middle' }] });
    expect(r.isError).toBe(false);
    expect(strategyOf(TENANT_A.orgId).competitors).toHaveLength(3);
    expect(strategyOf(TENANT_A.orgId).competitors[0]).toEqual({ name: 'AlphaRival', description: 'Zero-width in the middle' });
    // A stored name that holds one is matched too.
    fake.seed('AW-Organizations', { ...orgRow(TENANT_A.orgId), marketStrategy: { ...strategyOf(TENANT_A.orgId), competitors: [{ name: 'Stored\u200bRival', description: 'x' }] } });
    expect((await update(owner, { competitors: [{ name: 'StoredRival', description: 'y' }] })).isError).toBe(false);
    expect(strategyOf(TENANT_A.orgId).competitors).toEqual([{ name: 'Stored\u200bRival', description: 'y' }]);
  });

  it('when two stored entries differ only by case, the one with the exact spelling is the one updated', async () => {
    fake.seed('AW-Organizations', { ...orgRow(TENANT_A.orgId), marketStrategy: { ...strategyOf(TENANT_A.orgId), competitors: [{ name: 'Acme', description: 'one' }, { name: 'ACME', description: 'two' }] } });
    const r = await update(owner, { competitors: [{ name: 'ACME', description: 'changed' }] });
    expect(r.isError).toBe(false);
    expect(strategyOf(TENANT_A.orgId).competitors).toEqual([{ name: 'Acme', description: 'one' }, { name: 'ACME', description: 'changed' }]);
  });

  it('stored lists that are not lists block only an update of that list: an overview-only update goes through and leaves them as they are', async () => {
    fake.seed('AW-Organizations', { ...orgRow(TENANT_A.orgId), marketStrategy: { ...strategyOf(TENANT_A.orgId), competitors: 'oops' } });
    const r = await update(owner, { businessOverview: 'Fixed overview' });
    expect(r.isError).toBe(false);
    expect(strategyOf(TENANT_A.orgId).businessOverview).toBe('Fixed overview');
    expect(strategyOf(TENANT_A.orgId).competitors).toBe('oops');
  });
});

describe('update: third round', () => {
  it('a stored entry that is a bare string is matched by its text, not duplicated, and becomes an entry holding that name', async () => {
    fake.seed('AW-Organizations', { ...orgRow(TENANT_A.orgId), marketStrategy: { ...strategyOf(TENANT_A.orgId), competitors: ['HubSpot', { name: 'Gamma', description: 'x' }], icp: ['IT Director', { title: 'Founder' }] } });
    expect((await read(owner, { competitorNames: ['hubspot'] })).json.competitorLookup).toEqual([{ name: 'hubspot', stored: true, offset: 0 }]);
    const r = await update(owner, { competitors: [{ name: 'hubspot', description: 'CRM' }], icp: [{ title: ' it  director ', description: 'Runs the stack' }] });
    expect(r.isError).toBe(false);
    expect(r.json.competitors).toMatchObject({ added: [], updated: ['HubSpot'], total: 2 });
    expect(r.json.icp).toMatchObject({ added: [], updated: ['IT Director'], total: 2 });
    expect(strategyOf(TENANT_A.orgId).competitors).toEqual([{ name: 'HubSpot', description: 'CRM' }, { name: 'Gamma', description: 'x' }]);
    expect(strategyOf(TENANT_A.orgId).icp).toEqual([{ title: 'IT Director', description: 'Runs the stack' }, { title: 'Founder' }]);
  });

  it('a bare-string entry sent again by name alone is unchanged (it stays as it is)', async () => {
    fake.seed('AW-Organizations', { ...orgRow(TENANT_A.orgId), marketStrategy: { ...strategyOf(TENANT_A.orgId), competitors: ['HubSpot'] } });
    const r = await update(owner, { competitors: [{ name: 'HubSpot' }] });
    expect(r.json.changed).toBe(false);
    expect(strategyOf(TENANT_A.orgId).competitors).toEqual(['HubSpot']);
  });

  it('the parts carried along do not chain: a part counts for a minute from the save that changed it, not from later saves that only carried it', async () => {
    const now = Date.now();
    const spy = jest.spyOn(Date, 'now');
    try {
      const posts: Array<string[]> = [];
      const at = async (ms: number, args: Record<string, unknown>) => {
        spy.mockReturnValue(now + ms);
        const got = await recordStrategyPosts(async () => { expect((await update(owner, args)).isError).toBe(false); });
        posts.push(Object.keys(got[0]).sort());
      };
      await at(0, { icp: [{ title: 'Analyst' }] });
      await at(40_000, { competitors: [{ name: 'Delta' }] });
      await at(80_000, { businessOverview: 'Later overview' });
      await at(130_000, { competitors: [{ name: 'Epsilon' }] });
      expect(posts).toEqual([
        ['icp'],
        ['competitors', 'icp'], // the ICP save is 40 s old
        ['businessOverview', 'competitors'], // the ICP save is 80 s old and no longer counts; the competitors save is 40 s old
        ['businessOverview', 'competitors'], // the competitors save is 90 s old; the overview save is 50 s old
      ]);
    } finally {
      spy.mockRestore();
    }
  });

  it('null is the same as not sent, for refused arguments too', async () => {
    const r = await update(owner, { competitors: [{ name: 'Delta' }], positioning: null, targetAudience: null });
    expect(r.isError).toBe(false);
    expect(r.json.ignoredArguments).toBeUndefined();
  });

  it('a read of an account whose stored competitors are not a list says so instead of reporting none', async () => {
    fake.seed('AW-Organizations', { ...orgRow(TENANT_A.orgId), marketStrategy: { ...strategyOf(TENANT_A.orgId), competitors: 'oops' } });
    const r = await read(owner);
    expect(r.isError).toBe(false);
    expect(r.json.warning).toMatch(/stored competitors are not a list/);
    expect(r.json.data.competitors).toEqual([]);
  });

  it.each([
    ['cannot be read', () => jest.spyOn(userDb, 'getUserByIdConsistent').mockRejectedValueOnce(new Error('lookup boom arn:aws:iam::123456789012:role/internal-role'))],
    ['has no record', () => jest.spyOn(userDb, 'getUserByIdConsistent').mockResolvedValueOnce(undefined)],
  ])('refuses the call when the caller\'s record %s, instead of locking per user', async (_label, arrange) => {
    const spy = arrange();
    const before = JSON.stringify(orgRow(TENANT_A.orgId));
    try {
      const r = await update(owner, { competitors: [{ name: 'Delta' }] });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/strategy: the account could not be identified.*nothing was changed/);
      // The lookup's own message (it can name roles and tables) stays in the log.
      expect(r.text).not.toMatch(/arn:aws|lookup boom/);
    } finally {
      spy.mockRestore();
    }
    expect(JSON.stringify(orgRow(TENANT_A.orgId))).toBe(before);
  });

  it('a refusal inside the lock releases it: the next call goes through', async () => {
    expect((await update(member, { competitors: [{ name: 'AlphaRival', description: 'Different' }] })).isError).toBe(true);
    expect((await update(owner, { competitors: [{ name: 'Delta' }] })).isError).toBe(false);
    expect(names(strategyOf(TENANT_A.orgId).competitors)).toContain('Delta');
  });

  it('more than 100 profiles in one call are refused, and an empty competitorNames list adds no lookup', async () => {
    const r = await update(owner, { icp: Array.from({ length: 101 }, (_, i) => ({ title: `P${i}` })) });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/icp may hold at most 100 entries per call/);
    expect((await read(owner, { competitorNames: [] })).json.competitorLookup).toBeUndefined();
  });

  it('identity-style arguments are listed on the answer of a call that changes nothing too', async () => {
    const r = await update(owner, { competitors: [{ name: 'AlphaRival', description: 'The old incumbent' }], client_id: TENANT_B.owner });
    expect(r.json).toMatchObject({ changed: false, ignoredArguments: ['client_id'] });
  });
});

describe('update: solo accounts, the org flag and the memory\'s end', () => {
  it('a solo user\'s parallel calls are taken in turn too (the commonest case): both land', async () => {
    const [x, y] = await Promise.all([update(solo, { competitors: [{ name: 'Delta' }] }), update(solo, { competitors: [{ name: 'Epsilon' }], icp: [{ title: 'Analyst' }] })]);
    expect(x.isError).toBe(false);
    expect(y.isError).toBe(false);
    const row = fake.items('AW-Users').find((u: any) => u.userId === SOLO).marketStrategy;
    expect(names(row.competitors).sort()).toEqual(['Delta', 'Epsilon', 'SoloRival']);
    expect(row.icp.map((e: any) => e.title)).toEqual(['Solo ICP', 'Analyst']);
  });

  it('an org caller whose read answered with the caller\'s personal strategy (the org read missed) is refused, not merged onto and saved over the org\'s', async () => {
    const before = JSON.stringify(orgRow(TENANT_A.orgId));
    const personal = { success: true, data: { businessOverview: 'Personal', competitors: [{ name: 'PersonalRival' }], icp: [], createdAt: STORED_AT, updatedAt: STORED_AT }, isOrgLevel: false };
    await withStrategyReadsOverridden(() => personal, async () => {
      const r = await update(owner, { competitors: [{ name: 'Delta' }] });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/the organisation's market strategy could not be read.*Nothing was changed/);
    });
    expect(JSON.stringify(orgRow(TENANT_A.orgId))).toBe(before);
  });

  it('an org caller whose read answered with an EMPTY personal strategy (no createdAt, not the org\'s) is refused too, and so is one whose second read is the personal strategy', async () => {
    const before = JSON.stringify(orgRow(TENANT_A.orgId));
    const emptyPersonal = { success: true, data: { businessOverview: '', competitors: [], icp: [] }, isOrgLevel: false };
    await withStrategyReadsOverridden(() => emptyPersonal, async () => {
      const r = await update(owner, { competitors: [{ name: 'Delta' }] });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/the organisation's market strategy could not be read.*Try again\. Nothing was changed/);
    });
    const personal = { success: true, data: { businessOverview: 'Personal', competitors: [{ name: 'PersonalRival' }], icp: [], createdAt: STORED_AT, updatedAt: STORED_AT }, isOrgLevel: false };
    // The first read is flagged as the org's but shows nothing stored, so the tool reads again; the second read is the personal strategy: its flag is the one that counts.
    const emptyOrgLevel = { success: true, data: { businessOverview: '', competitors: [], icp: [] }, isOrgLevel: true };
    await withStrategyReadsOverridden((call) => (call === 1 ? emptyOrgLevel : personal), async () => {
      const r = await update(owner, { competitors: [{ name: 'Delta' }] });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/the organisation's market strategy could not be read/);
    });
    expect(JSON.stringify(orgRow(TENANT_A.orgId))).toBe(before);
  });

  it('text with nothing visible in it (only invisible characters) is "not given" and never overwrites stored text; text that merely contains a joiner is kept', async () => {
    const before = JSON.stringify(orgRow(TENANT_A.orgId));
    const same = await update(owner, { businessOverview: '\u200b', competitors: [{ name: 'AlphaRival', description: ' \u200d\u2060 ' }], icp: [{ title: 'Founder', description: '\u00ad', buyerPersonas: ['\u200b'] }] });
    expect(same.isError).toBe(false);
    expect(same.json.changed).toBe(false);
    expect(JSON.stringify(orgRow(TENANT_A.orgId))).toBe(before);
    const emoji = '\u{1F468}\u200d\u{1F469}\u200d\u{1F467} family';
    expect((await update(owner, { competitors: [{ name: 'AlphaRival', description: emoji }] })).isError).toBe(false);
    expect(strategyOf(TENANT_A.orgId).competitors[0].description).toBe(emoji);
  });

  it('after a minute the memory is gone: a read that is older than our last save (a writer with an older stamp) is used, not replaced by the saved copy', async () => {
    const now = Date.now();
    const spy = jest.spyOn(Date, 'now');
    try {
      spy.mockReturnValue(now);
      expect((await update(owner, { competitors: [{ name: 'Delta' }] })).isError).toBe(false);
      // A foreign writer (for example an onboarding mirror stamping a backdated time) changes the strategy and leaves an older updatedAt than our save.
      const saved = strategyOf(TENANT_A.orgId);
      fake.seed('AW-Organizations', { ...orgRow(TENANT_A.orgId), marketStrategy: { ...saved, updatedAt: STORED_AT, competitors: [...saved.competitors, { name: 'Foreign' }] } });
      spy.mockReturnValue(now + 61_000);
      // The call changes the competitors, so the merge baseline matters: inside the minute it would be our saved copy (without 'Foreign'); after it, the read.
      expect((await update(owner, { competitors: [{ name: 'Epsilon' }] })).isError).toBe(false);
    } finally {
      spy.mockRestore();
    }
    expect(names(strategyOf(TENANT_A.orgId).competitors)).toEqual(['AlphaRival', 'Beta Corp', 'Gamma', 'Delta', 'Foreign', 'Epsilon']);
  });
});

describe('the action', () => {
  it('is matched without regard to case, and anything else is refused (it used to be taken as an update)', async () => {
    expect((await owner.call('manage_market_strategy', { action: ' Read ' })).isError).toBe(false);
    const before = JSON.stringify(orgRow(TENANT_A.orgId));
    for (const args of [{ action: 'delete', competitors: [{ name: 'Delta' }] }, { competitors: [{ name: 'Delta' }] }, { action: 7 }]) {
      const r = await owner.call('manage_market_strategy', args);
      expect({ args, isError: r.isError }).toEqual({ args, isError: true });
      expect(r.text).toMatch(/action must be "read" or "update"/);
    }
    expect(JSON.stringify(orgRow(TENANT_A.orgId))).toBe(before);
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
