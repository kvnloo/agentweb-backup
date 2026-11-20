/**
 * ENG-2840 wave 1, PR C: what an outside agent may write to the brand guidelines through manage_brand, proved through the REAL path (MCP client ->
 * MCP server -> tool -> mcpFetch -> the real Express app -> db.ts -> in-memory DynamoDB), the same path as mcp.twoTenantIsolation.test.ts.
 *
 * The tool mapped six fields onto POST /api/brand/guidelines. The route also takes tagline, domain, brand values, brand personality and the
 * founders; it REPLACES the stored founder list (an empty list wipes it). Emma treats a non-empty founders list as the complete roster (a founder
 * left out is removed). Over MCP founders MERGE by name and are removed only by name in remove_founders (owner's decision, 2026-11-19).
 */
jest.mock('aws-sdk', () => {
  const actual = jest.requireActual('aws-sdk');
  const { makeTwoTenantFake } = jest.requireActual('./helpers/twoTenantMcpHarness');
  const fake = makeTwoTenantFake();
  (global as any).__brandWritesFake = fake;
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
  clearRecentBrandWrites,
  MAX_STORED_FOUNDERS,
  mergeFoundersForMcp,
  validateFounders,
  validateRemoveFounders,
} from '../mcp/server/manageBrandWrites';
import {
  connectCaller,
  installSelfCallFetch,
  seedTwoTenantWorld,
  snapshotTenant,
  TENANT_A,
  TENANT_B,
  type McpCaller,
} from './helpers/twoTenantMcpHarness';

const fake: any = (global as any).__brandWritesFake;
const orgRow = (orgId: string) => fake.items('AW-Organizations').find((o: any) => o.orgId === orgId);
const brandOf = (orgId: string) => orgRow(orgId).brandGuidelines;
const foundersOf = (orgId: string) => brandOf(orgId).brandData.founders;
const names = (list: any[]) => list.map((f) => f.name);
const SOLO = 'user-solo';
const STORED_AT = '2026-10-01T09:00:00.000Z';
const LOGO = { type: 'logo', url: 'https://assets.test/logo.png', key: 'brand/logo.png', filename: 'logo.png' };

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

const SOLO_BRAND = {
  brandData: { brandName: 'SOLO Corp', valueProposition: 'SOLO sells gadgets', founders: [{ name: 'Sol Oh', jobTitle: 'CEO' }] },
  attachments: [],
  createdAt: STORED_AT,
  updatedAt: STORED_AT,
};

beforeEach(() => {
  clearRecentBrandWrites();
  seedTwoTenantWorld(fake);
  fake.seed('AW-Organizations', {
    ...orgRow(TENANT_A.orgId),
    brandGuidelines: {
      brandData: {
        brandName: TENANT_A.brandName,
        valueProposition: 'ALPHA sells widgets',
        tagline: 'Widgets for all',
        keyMessages: ['Fast', 'Cheap'],
        brandValues: ['Honesty'],
        founders: [
          { name: 'Ada Alpha', jobTitle: 'CEO', styleTone: 'Warm', voiceExamples: 'Post one.\n\nPost two.' },
          { name: 'Ben Beta', jobTitle: 'CTO', styleTone: 'Dry' },
          { name: 'Cy Gamma', jobTitle: 'COO' },
        ],
      },
      attachments: [LOGO],
      createdAt: STORED_AT,
      updatedAt: STORED_AT,
    },
  });
  fake.seed('AW-Users', { email: 'solo@solo.test', userId: SOLO, isActive: true, isAdmin: false, roles: ['customer'], brandGuidelines: SOLO_BRAND });
});

const update = (caller: McpCaller, args: Record<string, unknown>) => caller.call('manage_brand', { action: 'update', ...args });
const read = (caller: McpCaller) => caller.call('manage_brand', { action: 'read' });

describe('update: the fields the tool could not set before', () => {
  it('tagline, domain, brand personality and brand values are saved and nothing else moves', async () => {
    const r = await update(owner, { tagline: 'Widgets, done right', domain: 'alpha.test', brand_personality: 'Plain-spoken and kind', brand_values: ['Honesty', 'Craft'] });
    expect(r.isError).toBe(false);
    expect(r.json).toMatchObject({ success: true, changed: true });
    const b = brandOf(TENANT_A.orgId);
    expect(b.brandData).toMatchObject({ tagline: 'Widgets, done right', domain: 'alpha.test', brandPersonality: 'Plain-spoken and kind', brandValues: ['Honesty', 'Craft'], brandName: TENANT_A.brandName, keyMessages: ['Fast', 'Cheap'] });
    expect(names(b.brandData.founders)).toEqual(['Ada Alpha', 'Ben Beta', 'Cy Gamma']);
    expect(b.attachments).toEqual([LOGO]);
  });

  it('the six fields the tool always had still work, and still replace', async () => {
    const r = await update(owner, { company_name: 'ALPHA Inc', mission: 'Better widgets', tone_of_voice: 'Direct', target_audience: 'Makers', key_messages: ['Only one'], visual_identity: { primaryColor: '#112233', fontFamily: 'Inter' } });
    expect(r.isError).toBe(false);
    expect(brandOf(TENANT_A.orgId).brandData).toMatchObject({ brandName: 'ALPHA Inc', valueProposition: 'Better widgets', toneOfVoice: 'Direct', targetAudience: 'Makers', keyMessages: ['Only one'], primaryColor: '#112233', fontFamily: 'Inter' });
    expect(names(foundersOf(TENANT_A.orgId))).toEqual(['Ada Alpha', 'Ben Beta', 'Cy Gamma']);
  });

  it('blank text and an empty list never blank a stored value', async () => {
    const r = await update(owner, { tagline: '   ', brand_values: [], mission: 'Better widgets' });
    expect(r.isError).toBe(false);
    expect(brandOf(TENANT_A.orgId).brandData).toMatchObject({ tagline: 'Widgets for all', brandValues: ['Honesty'], valueProposition: 'Better widgets' });
  });

  it('a call with nothing to change is refused instead of reported as saved', async () => {
    const before = JSON.stringify(orgRow(TENANT_A.orgId));
    for (const args of [{}, { tagline: ' ', brand_values: [], founders: [], remove_founders: [] }]) {
      const r = await update(owner, args);
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/send at least one field to change/);
    }
    expect(JSON.stringify(orgRow(TENANT_A.orgId))).toBe(before);
  });

  it('read is unchanged', async () => {
    const r = await read(owner);
    expect(r.isError).toBe(false);
    expect(r.json.brandData.brandName).toBe(TENANT_A.brandName);
    expect(names(r.json.brandData.founders)).toEqual(['Ada Alpha', 'Ben Beta', 'Cy Gamma']);
  });
});

describe('founders: merged by name, never replaced', () => {
  it('one new founder is added and the stored ones stay (the route alone would have replaced the list)', async () => {
    const r = await update(owner, { founders: [{ name: 'Di Delta', jobTitle: 'CFO' }] });
    expect(r.isError).toBe(false);
    expect(names(foundersOf(TENANT_A.orgId))).toEqual(['Ada Alpha', 'Ben Beta', 'Cy Gamma', 'Di Delta']);
    expect(r.json.founders).toEqual({ added: ['Di Delta'], updated: [], unchanged: [], removed: [], notFound: [], total: 4 });
    expect(brandOf(TENANT_A.orgId).attachments).toEqual([LOGO]);
  });

  it('a stored founder is matched without regard to case and padding, keeps its spelling and the fields the caller did not send', async () => {
    const r = await update(owner, { founders: [{ name: '  ada ALPHA ', voiceExamples: 'A new post.' }] });
    expect(r.isError).toBe(false);
    const list = foundersOf(TENANT_A.orgId);
    expect(list).toHaveLength(3);
    expect(list[0]).toEqual({ name: 'Ada Alpha', jobTitle: 'CEO', styleTone: 'Warm', voiceExamples: 'A new post.' });
    expect(r.json.founders).toMatchObject({ added: [], updated: ['Ada Alpha'], total: 3 });
  });

  it('an empty founders list next to another edit changes no founder (a model default, not a removal)', async () => {
    const r = await update(owner, { tagline: 'New line', founders: [] });
    expect(r.isError).toBe(false);
    expect(names(foundersOf(TENANT_A.orgId))).toEqual(['Ada Alpha', 'Ben Beta', 'Cy Gamma']);
    expect(brandOf(TENANT_A.orgId).brandData.tagline).toBe('New line');
  });

  it('a founder already stored exactly as sent writes nothing', async () => {
    const before = JSON.stringify(orgRow(TENANT_A.orgId));
    const r = await update(owner, { founders: [{ name: 'ben beta', jobTitle: 'CTO', styleTone: 'Dry' }] });
    expect(r.isError).toBe(false);
    expect(r.json).toMatchObject({ success: true, changed: false, founders: { unchanged: ['Ben Beta'], total: 3 } });
    expect(JSON.stringify(orgRow(TENANT_A.orgId))).toBe(before);
  });

  it('founders and other fields in one call land together', async () => {
    const r = await update(owner, { tagline: 'T2', founders: [{ name: 'Di Delta' }] });
    expect(r.isError).toBe(false);
    expect(brandOf(TENANT_A.orgId).brandData.tagline).toBe('T2');
    expect(names(foundersOf(TENANT_A.orgId))).toContain('Di Delta');
  });

  it('works for a solo user (the brand on the user record) the same way', async () => {
    const r = await update(solo, { tagline: 'Solo line', founders: [{ name: 'Una Two' }] });
    expect(r.isError).toBe(false);
    const row = fake.items('AW-Users').find((u: any) => u.userId === SOLO).brandGuidelines;
    expect(names(row.brandData.founders)).toEqual(['Sol Oh', 'Una Two']);
    expect(row.brandData.tagline).toBe('Solo line');
    expect(row.brandData.brandName).toBe('SOLO Corp');
  });
});

describe('founders: removed only by name', () => {
  it('remove_founders removes exactly the named founder and the answer says so', async () => {
    const r = await update(owner, { remove_founders: ['  BEN beta '] });
    expect(r.isError).toBe(false);
    expect(names(foundersOf(TENANT_A.orgId))).toEqual(['Ada Alpha', 'Cy Gamma']);
    expect(r.json.founders).toEqual({ added: [], updated: [], unchanged: [], removed: ['Ben Beta'], notFound: [], total: 2 });
  });

  it('a name that is not stored is reported as not found, and a call with only that changes nothing', async () => {
    const before = JSON.stringify(orgRow(TENANT_A.orgId));
    const r = await update(owner, { remove_founders: ['Nobody Here'] });
    expect(r.isError).toBe(false);
    expect(r.json).toMatchObject({ success: true, changed: false, founders: { removed: [], notFound: ['Nobody Here'], total: 3 } });
    expect(JSON.stringify(orgRow(TENANT_A.orgId))).toBe(before);
  });

  it('adding, updating and removing in one call', async () => {
    const r = await update(owner, { founders: [{ name: 'Di Delta' }, { name: 'Ada Alpha', jobTitle: 'Chief Executive' }], remove_founders: ['Cy Gamma', 'Ghost'] });
    expect(r.isError).toBe(false);
    expect(foundersOf(TENANT_A.orgId).map((f: any) => [f.name, f.jobTitle])).toEqual([['Ada Alpha', 'Chief Executive'], ['Ben Beta', 'CTO'], ['Di Delta', undefined]]);
    expect(r.json.founders).toMatchObject({ added: ['Di Delta'], updated: ['Ada Alpha'], removed: ['Cy Gamma'], notFound: ['Ghost'], total: 3 });
  });

  it('removing every founder one by one is possible, but never by omission or an empty list', async () => {
    await update(owner, { founders: [] , tagline: 'x' });
    expect(foundersOf(TENANT_A.orgId)).toHaveLength(3);
    const r = await update(owner, { remove_founders: ['Ada Alpha', 'Ben Beta', 'Cy Gamma'] });
    expect(r.isError).toBe(false);
    expect(foundersOf(TENANT_A.orgId)).toEqual([]);
  });

  it('a name in both founders and remove_founders is refused', async () => {
    const before = JSON.stringify(orgRow(TENANT_A.orgId));
    const r = await update(owner, { founders: [{ name: 'Ada Alpha', jobTitle: 'X' }], remove_founders: [' ada alpha'] });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/appears in both founders and remove_founders/);
    expect(JSON.stringify(orgRow(TENANT_A.orgId))).toBe(before);
  });
});

describe('update: refusals name the problem and change nothing', () => {
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ['an unsupported founder field', { founders: [{ name: 'X', linkedin: 'https://x.test' }] }, /founders\[0\] has fields that are not stored: "linkedin"/],
    ['a founder without a name', { founders: [{ jobTitle: 'CEO' }] }, /founders\[0\]\.name is required/],
    ['a blank founder name', { founders: [{ name: '  ' }] }, /founders\[0\]\.name is required/],
    ['founders that are not a list', { founders: 'Ada' }, /founders must be a list of objects/],
    ['a founder that is not an object', { founders: ['Ada'] }, /founders\[0\] must be an object/],
    ['a job title that is not text', { founders: [{ name: 'X', jobTitle: 7 }] }, /founders\[0\]\.jobTitle must be text/],
    ['an over-long job title', { founders: [{ name: 'X', jobTitle: 'j'.repeat(201) }] }, /founders\[0\]\.jobTitle must be 200 characters or fewer/],
    ['over-long voice examples', { founders: [{ name: 'X', voiceExamples: 'v'.repeat(20001) }] }, /voiceExamples must be 20000 characters or fewer/],
    ['more than 20 founders', { founders: Array.from({ length: 21 }, (_, i) => ({ name: `F${i}` })) }, /at most 20 entries per call/],
    ['remove_founders that is not a list of text', { remove_founders: 'Ada' }, /remove_founders must be a list of founder names/],
    ['a blank name in remove_founders', { remove_founders: ['Ada Alpha', ' '] }, /remove_founders names must not be blank/],
    ['more than 20 names to remove', { remove_founders: Array.from({ length: 21 }, (_, i) => `F${i}`) }, /remove_founders may hold at most 20/],
    ['a tagline that is not text', { tagline: 5 }, /tagline must be text/],
    ['an over-long tagline', { tagline: 't'.repeat(301) }, /tagline must be 300 characters or fewer/],
    ['an over-long domain', { domain: 'd'.repeat(254) }, /domain must be 253 characters or fewer/],
    ['an over-long brand personality', { brand_personality: 'p'.repeat(2001) }, /brand_personality must be 2000 characters or fewer/],
    ['brand values that are not a list of text', { brand_values: 'Honesty' }, /brand_values must be a list of text/],
    ['too many brand values', { brand_values: Array.from({ length: 51 }, (_, i) => `V${i}`) }, /brand_values may hold at most 50/],
  ];
  it.each(cases)('%s', async (_label, args, message) => {
    const before = JSON.stringify(orgRow(TENANT_A.orgId));
    const r = await update(owner, args);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(message);
    expect(r.text).toMatch(/Nothing was changed/);
    expect(JSON.stringify(orgRow(TENANT_A.orgId))).toBe(before);
  });

  it('one bad founder refuses the whole call: a valid tagline sent with it is not saved either', async () => {
    const before = JSON.stringify(orgRow(TENANT_A.orgId));
    const r = await update(owner, { tagline: 'Should not land', founders: [{ name: 'Di Delta' }, { name: 'Bad', linkedin: 'x' }] });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(orgRow(TENANT_A.orgId))).toBe(before);
  });

  it('a full roster takes no new founder, but its stored founders can still be updated or removed', async () => {
    const full = Array.from({ length: MAX_STORED_FOUNDERS }, (_, i) => ({ name: `Founder ${i}` }));
    fake.seed('AW-Organizations', { ...orgRow(TENANT_A.orgId), brandGuidelines: { ...brandOf(TENANT_A.orgId), brandData: { ...brandOf(TENANT_A.orgId).brandData, founders: full } } });
    const refused = await update(owner, { founders: [{ name: 'One too many' }] });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/would hold 51 founders, over the limit of 50/);
    expect(foundersOf(TENANT_A.orgId)).toHaveLength(MAX_STORED_FOUNDERS);
    expect((await update(owner, { founders: [{ name: 'founder 7', jobTitle: 'Head' }] })).isError).toBe(false);
    expect((await update(owner, { founders: [{ name: 'One more' }], remove_founders: ['Founder 1'] })).isError).toBe(false);
    expect(foundersOf(TENANT_A.orgId)).toHaveLength(MAX_STORED_FOUNDERS);
  });
});

describe('update: the answer reports what is stored', () => {
  it('when the read-back does not show the saved founders, the answer is a failure that says so (not a success)', async () => {
    const realFetch = global.fetch;
    let brandReads = 0;
    // The first read is the merge baseline; the second is the read-back after the save: answer that one with the brand as it was before.
    const stale = JSON.stringify({ exists: true, brandData: { ...brandOf(TENANT_A.orgId).brandData }, attachments: [LOGO] });
    global.fetch = (async (url: any, init: any = {}) => {
      const isBrandRead = String(url).includes('/api/brand/guidelines') && String(init.method || 'GET').toUpperCase() === 'GET';
      if (isBrandRead && ++brandReads === 2) {
        return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => JSON.parse(stale), text: async () => stale } as any;
      }
      return realFetch(url, init);
    }) as any;
    try {
      const r = await update(owner, { founders: [{ name: 'Di Delta' }] });
      expect(r.json).toMatchObject({ success: false });
      expect(r.json.error).toMatch(/could not be verified on read-back/);
    } finally {
      global.fetch = realFetch;
    }
    // The save itself did happen; the answer simply did not claim it.
    expect(names(foundersOf(TENANT_A.orgId))).toContain('Di Delta');
  });
});

/** Put `member` on the org's brandGuidelines editors list. */
const makeMemberEditor = () => {
  const org = orgRow(TENANT_A.orgId);
  fake.seed('AW-Organizations', { ...org, shareSettings: { ...(org.shareSettings || {}), brandGuidelines: { editors: [TENANT_A.member] } } });
};

/** Answer GET /api/brand/guidelines calls with `forced(callNumber)` when it returns a body, and let every other call through to the real app. */
async function withBrandReadsOverridden(forced: (call: number) => unknown, run: () => Promise<void>): Promise<void> {
  const realFetch = global.fetch;
  let call = 0;
  global.fetch = (async (url: any, init: any = {}) => {
    if (String(url).includes('/api/brand/guidelines') && String(init.method || 'GET').toUpperCase() === 'GET') {
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
    const [x, y] = await Promise.all([update(owner, { founders: [{ name: 'From Owner' }] }), update(member, { founders: [{ name: 'From Member' }] })]);
    expect(x.isError).toBe(false);
    expect(y.isError).toBe(false);
    expect(names(foundersOf(TENANT_A.orgId)).sort()).toEqual(['Ada Alpha', 'Ben Beta', 'Cy Gamma', 'From Member', 'From Owner']);
  });

  it('a read that is older than what this process just saved and read back is not merged onto', async () => {
    const stale = { exists: true, brandData: JSON.parse(JSON.stringify(brandOf(TENANT_A.orgId).brandData)), attachments: [LOGO], createdAt: STORED_AT, updatedAt: STORED_AT, isOrgLevel: true };
    expect((await update(owner, { founders: [{ name: 'Di Delta' }] })).isError).toBe(false);
    // Calls so far: baseline read (1) and read-back (2). The second update's baseline read (3) answers with the brand as it was before the first save.
    await withBrandReadsOverridden((call) => (call === 3 ? stale : undefined), async () => {
      const second = await update(owner, { founders: [{ name: 'Ed Epsilon' }] });
      expect(second.isError).toBe(false);
    });
    expect(names(foundersOf(TENANT_A.orgId))).toEqual(['Ada Alpha', 'Ben Beta', 'Cy Gamma', 'Di Delta', 'Ed Epsilon']);
  });

  it('a read that wrongly shows no brand is read once more before it is believed (a missed read must not turn the write into a replace)', async () => {
    await withBrandReadsOverridden((call) => (call === 1 ? { exists: false, message: 'No brand guidelines found' } : undefined), async () => {
      const r = await update(owner, { founders: [{ name: 'Di Delta' }] });
      expect(r.isError).toBe(false);
    });
    expect(names(foundersOf(TENANT_A.orgId))).toEqual(['Ada Alpha', 'Ben Beta', 'Cy Gamma', 'Di Delta']);
  });

  it.each([
    ['text instead of JSON', 'Service Unavailable'],
    ['a body without exists', { message: 'hello' }],
    ['a brand without brand data', { exists: true }],
  ])('an answer from the read that is %s is not a baseline: nothing is changed', async (_label, bad) => {
    const before = JSON.stringify(orgRow(TENANT_A.orgId));
    await withBrandReadsOverridden(() => bad, async () => {
      const r = await update(owner, { founders: [{ name: 'Di Delta' }] });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/could not be read, so nothing was changed/);
    });
    expect(JSON.stringify(orgRow(TENANT_A.orgId))).toBe(before);
  });

  it('a founder name with a doubled space is the same founder, not a second one', async () => {
    const r = await update(owner, { founders: [{ name: 'ada   alpha', jobTitle: 'Chief' }] });
    expect(r.isError).toBe(false);
    expect(foundersOf(TENANT_A.orgId)).toHaveLength(3);
    expect(foundersOf(TENANT_A.orgId)[0]).toMatchObject({ name: 'Ada Alpha', jobTitle: 'Chief' });
  });
});

describe('arguments an update does not take', () => {
  it.each([
    ['one the tool does not store (a logo address)', { tagline: 'T', logo_url: 'https://x.test/logo.png' }, /"logo_url" is not an input of update/],
    ['several, listed together', { tagline: 'T', brandName: 'X', slogan: 'Y' }, /"brandName", "slogan" are not inputs of update/],
  ])('an update with %s is refused by name and writes nothing', async (_label, args, message) => {
    const before = JSON.stringify(orgRow(TENANT_A.orgId));
    const r = await update(owner, args);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(message);
    expect(r.text).toMatch(/Nothing was changed\./);
    expect(JSON.stringify(orgRow(TENANT_A.orgId))).toBe(before);
  });

  it('identity-style arguments are ignored (the brand is always the caller\'s own) and the answer says so', async () => {
    const before = snapshotTenant(fake, TENANT_B);
    const w = await update(owner, { tagline: 'Own line', client_id: TENANT_B.owner, clientId: TENANT_B.owner, user_id: TENANT_B.owner });
    expect(w.isError).toBe(false);
    expect(w.json.ignoredArguments).toEqual(['client_id', 'clientId', 'user_id']);
    expect(brandOf(TENANT_A.orgId).brandData.tagline).toBe('Own line');
    expect(snapshotTenant(fake, TENANT_B)).toBe(before);
    const noop = await update(owner, { founders: [{ name: 'Ben Beta', jobTitle: 'CTO' }], user_id: TENANT_B.owner });
    expect(noop.json).toMatchObject({ changed: false, ignoredArguments: ['user_id'] });
    expect((await update(owner, { tagline: 'Another' })).json.ignoredArguments).toBeUndefined();
  });
});

describe('the action', () => {
  it('is matched without regard to case, and anything else is refused (it used to be taken as an update)', async () => {
    expect((await owner.call('manage_brand', { action: ' Read ' })).isError).toBe(false);
    const before = JSON.stringify(orgRow(TENANT_A.orgId));
    for (const args of [{ action: 'delete', tagline: 'x' }, { tagline: 'x' }, { action: 7 }]) {
      const r = await owner.call('manage_brand', args);
      expect({ args, isError: r.isError }).toEqual({ args, isError: true });
      expect(r.text).toMatch(/action must be "read" or "update"/);
    }
    expect(JSON.stringify(orgRow(TENANT_A.orgId))).toBe(before);
  });
});

describe('update: who may write', () => {
  it('an org member who is not an editor is refused by the route and nothing changes; a listed editor may write', async () => {
    const before = JSON.stringify(orgRow(TENANT_A.orgId));
    const refused = await update(member, { founders: [{ name: 'Di Delta' }] });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/Not authorized to edit brand guidelines/);
    expect(JSON.stringify(orgRow(TENANT_A.orgId))).toBe(before);

    const org = orgRow(TENANT_A.orgId);
    fake.seed('AW-Organizations', { ...org, shareSettings: { ...(org.shareSettings || {}), brandGuidelines: { editors: [TENANT_A.member] } } });
    const ok = await update(member, { founders: [{ name: 'Di Delta' }] });
    expect(ok.isError).toBe(false);
    expect(names(foundersOf(TENANT_A.orgId))).toContain('Di Delta');
  });

  it('another tenant\'s caller writes to its own brand only', async () => {
    const before = snapshotTenant(fake, TENANT_A);
    const r = await update(other, { founders: [{ name: 'Bo Bravo' }], remove_founders: ['Ada Alpha'] });
    expect(r.isError).toBe(false);
    expect(snapshotTenant(fake, TENANT_A)).toBe(before);
    expect(names(foundersOf(TENANT_B.orgId))).toEqual(['Bo Bravo']);
  });
});

describe('update: parallel calls from one agent', () => {
  it('two founder updates sent together both land (each merges onto what the other saved)', async () => {
    const [x, y] = await Promise.all([update(owner, { founders: [{ name: 'Di Delta' }] }), update(owner, { founders: [{ name: 'Ed Epsilon' }] })]);
    expect(x.isError).toBe(false);
    expect(y.isError).toBe(false);
    expect(names(foundersOf(TENANT_A.orgId)).sort()).toEqual(['Ada Alpha', 'Ben Beta', 'Cy Gamma', 'Di Delta', 'Ed Epsilon']);
  });

  it('an add and a removal sent together both land', async () => {
    const [x, y] = await Promise.all([update(owner, { founders: [{ name: 'Di Delta' }] }), update(owner, { remove_founders: ['Ada Alpha'] })]);
    expect(x.isError).toBe(false);
    expect(y.isError).toBe(false);
    expect(names(foundersOf(TENANT_A.orgId)).sort()).toEqual(['Ben Beta', 'Cy Gamma', 'Di Delta']);
  });
});

describe('pure helpers', () => {
  it('validateFounders and validateRemoveFounders leave an unsent value alone and clean a sent one', () => {
    expect(validateFounders(undefined)).toBeUndefined();
    expect(validateRemoveFounders(null)).toBeUndefined();
    expect(validateFounders([{ name: ' A ', jobTitle: ' CEO ', styleTone: '  ' }])).toEqual([{ name: 'A', jobTitle: 'CEO' }]);
    expect(validateRemoveFounders([' A '])).toEqual(['A']);
  });

  it('mergeFoundersForMcp removes nothing it was not asked to, and reports a repeat removal once', () => {
    const stored = [{ name: 'A', jobTitle: 'x', extra: 1 }, { name: 'B' }];
    const out = mergeFoundersForMcp(stored, [{ name: 'a', jobTitle: 'y' }, { name: 'C' }], ['b', 'B', 'Z']);
    expect(out.founders).toEqual([{ name: 'A', jobTitle: 'y', extra: 1 }, { name: 'C' }]);
    expect({ added: out.added, updated: out.updated, removed: out.removed, notFound: out.notFound }).toEqual({ added: ['C'], updated: ['A'], removed: ['B'], notFound: ['Z'] });
    expect(mergeFoundersForMcp(undefined, [{ name: 'X' }], []).founders).toEqual([{ name: 'X' }]);
  });
});
