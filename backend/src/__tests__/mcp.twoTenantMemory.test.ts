/**
 * Two-tenant isolation for the MCP memory tools (ENG-2840 wave 2, W2-2).
 *
 * The same harness as the wave-1 matrix (helpers/twoTenantMcpHarness.ts: MCP client -> real MCP server -> real tool -> real services/db ->
 * in-memory DynamoDB), with both tenants' memories seeded. The memory tools run in process (no REST self-call), so there is no Express app
 * here. Embedding is the only thing mocked.
 *
 * What it proves, in both directions (A against B, B against A):
 *  1. each caller lists only its own memories and its own org's; the other tenant's text appears nowhere in any answer;
 *  2. an argument that names another tenant (userId, orgId, ...) is refused by name and changes nothing, for all five tools;
 *  3. deleting another tenant's memory id, by user or by org tool, finds nothing and leaves that tenant's rows byte for byte unchanged;
 *     an account memory id is not an org memory id and the other way round;
 *  4. a save lands on the caller's own rows only, and a list made right after it shows it;
 *  5. org roles: a member reads and writes org memory but cannot delete it, an admin and the owner can;
 *  6. memory switched off (user) or org memory switched off refuses writes and listing, for that tenant only;
 *  7. structured ads-learning rows are never listed, counted or deleted through these tools;
 *  8. the 200-row cap and the length limits refuse with their messages, per tenant;
 *  9. a signed-in OAuth client cannot call the org write tools but can use the user's own tools.
 *
 * Scope checks that live in the HTTP layer (a default key refused save_org_memory) are in mcp.memoryScopeGate.test.ts.
 */
jest.mock('aws-sdk', () => {
  const actual = jest.requireActual('aws-sdk');
  const { makeTwoTenantFake } = jest.requireActual('./helpers/twoTenantMcpHarness');
  const fake = makeTwoTenantFake();
  (global as any).__twoTenantMemoryFake = fake;
  actual.DynamoDB.DocumentClient = fake.documentClient;
  return actual;
});
jest.mock('../server', () => ({ io: { to: jest.fn().mockReturnValue({ emit: jest.fn() }), emit: jest.fn() }, app: {} }));
jest.mock('../utils/secretsManager', () => ({
  getMetaAccessToken: jest.fn().mockResolvedValue('mock-token'),
  getSecret: jest.fn().mockResolvedValue('mock-secret'),
}));
jest.mock('../utils/embeddings', () => ({ embedText: jest.fn().mockResolvedValue([0.25, 0.75]) }));

// The memory tools load services/db lazily, so nothing imports aws-sdk yet: load it now, which builds the fake the mock factory shares.
import 'aws-sdk';
import { embedText } from '../utils/embeddings';
import {
  connectCaller, seedTwoTenantWorld, snapshotTenant, TENANT_A, TENANT_B, type McpCaller, type Outcome, type Tenant,
} from './helpers/twoTenantMcpHarness';

const fake: any = (global as any).__twoTenantMemoryFake;
const OTHER = (t: Tenant) => (t.label === 'A' ? TENANT_B : TENANT_A);
const memoryText = (t: Tenant) => [...t.memories, ...t.orgMemories].map((m) => m.content);
const memoryIds = (t: Tenant) => [...t.memories, ...t.orgMemories].map((m) => m.memoryId);
/** Words that identify a tenant's memory rows; they must never appear in the other tenant's answers. */
const markers = (t: Tenant) => [`${t.label === 'A' ? 'ALPHA' : 'BRAVO'}-MEMORY`, `${t.label === 'A' ? 'ALPHA' : 'BRAVO'}-ORGMEMORY`];

const open: McpCaller[] = [];
async function as(userId: string, opts: { scopes?: string[]; authMethod?: 'api_key' | 'oauth' } = {}): Promise<McpCaller> {
  const caller = await connectCaller(userId, opts);
  open.push(caller);
  return caller;
}
const ORG_WRITER = { scopes: ['tools:read', 'tools:execute', 'memory:org'] };

const setUser = (userId: string, orgId: string, patch: Record<string, unknown>) =>
  fake.seed('AW-Users', { email: `${userId}@${orgId}.test`, userId, orgId, orgRole: userId === TENANT_A.owner || userId === TENANT_B.owner ? 'owner' : 'member', isActive: true, isAdmin: false, roles: ['customer'], ...patch });
const setOrg = (t: Tenant, patch: Record<string, unknown>) => {
  const current = fake.items('AW-Organizations').find((o: any) => o.orgId === t.orgId);
  fake.seed('AW-Organizations', { ...current, ...patch });
};
const accountRows = (userId: string) => fake.items('AW-AccountMemory').filter((r: any) => r.userId === userId);
const orgRows = (orgId: string) => fake.items('AW-OrgMemory').filter((r: any) => r.orgId === orgId);
const listedIds = (o: Outcome) => (o.json?.memories ?? []).map((m: any) => m.memoryId);

beforeEach(() => {
  seedTwoTenantWorld(fake);
  (embedText as jest.Mock).mockClear();
});
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

describe.each([[TENANT_A], [TENANT_B]])('tenant %s: the caller reads only its own memory', (t) => {
  const other = OTHER(t);

  it('list_memories (user) returns the owner\'s memories newest first and nothing of the other tenant', async () => {
    const out = await (await as(t.owner)).call('list_memories', {});
    expect(out.isError).toBe(false);
    expect(listedIds(out)).toEqual([...t.memories].reverse().map((m) => m.memoryId));
    for (const text of [...memoryText(other), ...markers(other)]) expect(out.text).not.toContain(text);
    for (const id of memoryIds(other)) expect(out.text).not.toContain(id);
    expect(out.text).not.toContain('embedding');
  });

  it('list_memories (org) returns the org\'s memories to the owner and to a plain member, and nothing of the other org', async () => {
    const memberId = t.member ?? 'user-a2';
    if (t.member) {
      const asMember = await (await as(t.member)).call('list_memories', { scope: 'org' });
      expect(listedIds(asMember)).toEqual([...t.orgMemories].reverse().map((m) => m.memoryId));
    }
    const out = await (await as(t.owner)).call('list_memories', { scope: 'org' });
    expect(listedIds(out)).toEqual([...t.orgMemories].reverse().map((m) => m.memoryId));
    for (const text of [...memoryText(other), ...markers(other)]) expect(out.text).not.toContain(text);
    expect(memberId).toBeTruthy();
  });

  it('a member\'s own account memory is theirs alone: the owner\'s account memories are not in the member\'s list', async () => {
    if (!t.member) return;
    const out = await (await as(t.member)).call('list_memories', {});
    expect(listedIds(out)).toEqual([]);
    for (const text of memoryText(t)) expect(out.text).not.toContain(text);
  });

  it('a category filter and a cursor never reach the other tenant', async () => {
    const caller = await as(t.owner);
    const byCategory = await caller.call('list_memories', { category: 'insight' });
    expect(listedIds(byCategory)).toEqual(t.memories.filter((m) => m.category === 'insight').map((m) => m.memoryId));
    // The other tenant's newest id as a cursor only filters this caller's own rows.
    const cursor = other.memories[other.memories.length - 1].memoryId;
    const out = await caller.call('list_memories', { cursor });
    for (const text of [...memoryText(other), ...markers(other)]) expect(out.text).not.toContain(text);
    expect(listedIds(out).every((id: string) => memoryIds(t).includes(id))).toBe(true);
  });
});

describe.each([[TENANT_A], [TENANT_B]])('tenant %s: naming another tenant', (t) => {
  const other = OTHER(t);
  // The MCP server itself strips userId, sessionId and llmModel from an external caller's arguments (they are context fields for internal
  // clients), so those never reach a tool. Every other name is an argument of the tool, and a tool that does not list it refuses it by name.
  const refusedOverrides: Array<Record<string, unknown>> = [
    { user_id: other.owner }, { orgId: other.orgId }, { org_id: other.orgId }, { clientId: other.owner }, { client_id: other.owner },
  ];
  const calls: Array<[string, Record<string, unknown>]> = [
    ['save_memory', { content: 'x', category: 'insight' }],
    ['delete_memory', { memoryId: '00MEM-X' }],
    ['list_memories', {}],
    ['save_org_memory', { content: 'x', category: 'insight' }],
    ['delete_org_memory', { memoryId: '00ORG-X' }],
  ];

  it.each(calls)('%s: an argument that names the other tenant is refused by name, and nothing changes', async (tool, base) => {
    const caller = await as(t.owner, ORG_WRITER);
    const beforeOther = snapshotTenant(fake, other);
    const beforeOwn = snapshotTenant(fake, t);
    for (const override of refusedOverrides) {
      const out = await caller.call(tool, { ...base, ...override });
      expect(out.isError).toBe(true);
      expect(out.text).toMatch(new RegExp(`${tool}: ".+" is not an input of ${tool}`));
      for (const text of [...memoryText(other), ...markers(other)]) expect(out.text).not.toContain(text);
    }
    expect(snapshotTenant(fake, other)).toBe(beforeOther);
    expect(snapshotTenant(fake, t)).toBe(beforeOwn);
    expect(embedText).not.toHaveBeenCalled();
  });

  it('a userId in the arguments is dropped by the server: the call runs as the caller and writes only to the caller\'s own account', async () => {
    const caller = await as(t.owner);
    const beforeOther = snapshotTenant(fake, other);
    const saved = await caller.call('save_memory', { content: `${t.label} claims to be someone else`, category: 'insight', userId: other.owner });
    expect(saved.json).toMatchObject({ success: true });
    expect(accountRows(t.owner).some((r: any) => r.memoryId === saved.json.memoryId)).toBe(true);
    expect(accountRows(other.owner).some((r: any) => r.memoryId === saved.json.memoryId)).toBe(false);
    const listed = await caller.call('list_memories', { userId: other.owner });
    expect(listed.isError).toBe(false);
    for (const text of [...memoryText(other), ...markers(other)]) expect(listed.text).not.toContain(text);
    const deleted = await caller.call('delete_memory', { memoryId: other.memories[0].memoryId, userId: other.owner });
    expect(deleted.json).toMatchObject({ success: false });
    expect(snapshotTenant(fake, other)).toBe(beforeOther);
  });
});

describe.each([[TENANT_A], [TENANT_B]])('tenant %s: deleting the other tenant\'s memory id finds nothing', (t) => {
  const other = OTHER(t);

  it('delete_memory and delete_org_memory with the other tenant\'s ids answer "not found" and leave both tenants byte for byte unchanged', async () => {
    const caller = await as(t.owner, ORG_WRITER);
    const beforeOther = snapshotTenant(fake, other);
    const beforeOwn = snapshotTenant(fake, t);
    for (const id of memoryIds(other)) {
      for (const tool of ['delete_memory', 'delete_org_memory']) {
        const out = await caller.call(tool, { memoryId: id });
        expect(out.isError).toBe(false);
        expect(out.json).toMatchObject({ success: false });
        expect(out.json.message).toMatch(/not found; nothing was deleted/);
        for (const text of [...memoryText(other), ...markers(other)]) expect(out.text).not.toContain(text);
      }
    }
    expect(snapshotTenant(fake, other)).toBe(beforeOther);
    expect(snapshotTenant(fake, t)).toBe(beforeOwn);
  });

  it('an account memory id is not an org memory id, and the other way round (own ids, wrong table)', async () => {
    const caller = await as(t.owner, ORG_WRITER);
    const before = snapshotTenant(fake, t);
    expect((await caller.call('delete_org_memory', { memoryId: t.memories[0].memoryId })).json).toMatchObject({ success: false });
    expect((await caller.call('delete_memory', { memoryId: t.orgMemories[0].memoryId })).json).toMatchObject({ success: false });
    expect(snapshotTenant(fake, t)).toBe(before);
  });
});

describe.each([[TENANT_A], [TENANT_B]])('tenant %s: a save lands on the caller\'s own rows only', (t) => {
  const other = OTHER(t);

  it('save_memory adds one row to the caller\'s account, none to the other tenant, and a list right after shows it', async () => {
    const caller = await as(t.owner);
    const beforeOther = snapshotTenant(fake, other);
    const out = await caller.call('save_memory', { content: `${t.label}-NEW fact`, category: 'insight' });
    expect(out.json).toMatchObject({ success: true, memoryId: expect.any(String) });
    expect(accountRows(t.owner)).toHaveLength(t.memories.length + 1);
    expect(snapshotTenant(fake, other)).toBe(beforeOther);
    const list = await caller.call('list_memories', {});
    expect(listedIds(list)[0]).toBe(out.json.memoryId);
    expect(list.json.memories[0].content).toBe(`${t.label}-NEW fact`);
    expect(embedText).toHaveBeenCalledTimes(1);
  });

  it('save_org_memory (with memory:org) adds one row to the caller\'s org only, authored by the caller', async () => {
    const caller = await as(t.owner, ORG_WRITER);
    const beforeOther = snapshotTenant(fake, other);
    const out = await caller.call('save_org_memory', { content: `${t.label}-NEW org fact`, category: 'workflow' });
    expect(out.json).toMatchObject({ success: true });
    expect(orgRows(t.orgId)).toHaveLength(t.orgMemories.length + 1);
    expect(orgRows(t.orgId).find((r: any) => r.memoryId === out.json.memoryId)).toMatchObject({ sourceUserId: t.owner, orgId: t.orgId });
    expect(snapshotTenant(fake, other)).toBe(beforeOther);
    const list = await caller.call('list_memories', { scope: 'org' });
    expect(listedIds(list)[0]).toBe(out.json.memoryId);
  });

  it('the same text saved twice in a row is written once (the second sees the first)', async () => {
    const caller = await as(t.owner);
    const first = await caller.call('save_memory', { content: `${t.label} same text`, category: 'insight' });
    const second = await caller.call('save_memory', { content: `${t.label} same text`, category: 'insight' });
    expect(first.json.success).toBe(true);
    expect(second.json).toMatchObject({ success: true, saved: false, duplicate: true, memoryId: first.json.memoryId });
    expect(accountRows(t.owner)).toHaveLength(t.memories.length + 1);
    expect(embedText).toHaveBeenCalledTimes(1);
  });

  it('delete_memory removes the caller\'s own memory and only that row', async () => {
    const caller = await as(t.owner);
    const target = t.memories[1].memoryId;
    const out = await caller.call('delete_memory', { memoryId: target });
    expect(out.json).toMatchObject({ success: true });
    expect(accountRows(t.owner).map((r: any) => r.memoryId)).toEqual(t.memories.filter((m) => m.memoryId !== target).map((m) => m.memoryId));
    expect(orgRows(t.orgId)).toHaveLength(t.orgMemories.length);
  });
});

describe('org roles', () => {
  it('a plain member can write org memory (as Emma allows) but cannot delete it; the owner can; an admin can', async () => {
    const t = TENANT_A;
    const member = await as(t.member!, ORG_WRITER);
    const saved = await member.call('save_org_memory', { content: 'member wrote this', category: 'insight' });
    expect(saved.json).toMatchObject({ success: true });
    expect(orgRows(t.orgId).find((r: any) => r.memoryId === saved.json.memoryId)).toMatchObject({ sourceUserId: t.member });

    const refused = await member.call('delete_org_memory', { memoryId: saved.json.memoryId });
    expect(refused.json).toEqual({ success: false, message: 'Only org owners and admins can delete org memories.' });
    expect(orgRows(t.orgId).some((r: any) => r.memoryId === saved.json.memoryId)).toBe(true);

    setUser('user-a3', t.orgId, { orgRole: 'admin' });
    const byAdmin = await (await as('user-a3', ORG_WRITER)).call('delete_org_memory', { memoryId: saved.json.memoryId });
    expect(byAdmin.json).toMatchObject({ success: true });
    expect(orgRows(t.orgId).some((r: any) => r.memoryId === saved.json.memoryId)).toBe(false);

    const byOwner = await (await as(t.owner, ORG_WRITER)).call('delete_org_memory', { memoryId: t.orgMemories[0].memoryId });
    expect(byOwner.json).toMatchObject({ success: true });
  });

  it('B\'s owner cannot delete A\'s org memory: it is not in B\'s org (and A\'s rows stay)', async () => {
    const before = snapshotTenant(fake, TENANT_A);
    const out = await (await as(TENANT_B.owner, ORG_WRITER)).call('delete_org_memory', { memoryId: TENANT_A.orgMemories[0].memoryId });
    expect(out.json).toMatchObject({ success: false });
    expect(snapshotTenant(fake, TENANT_A)).toBe(before);
  });

  it('a user in no org gets the shared message for any org call', async () => {
    setUser('user-solo', 'none', { orgId: undefined, orgRole: undefined });
    const solo = await as('user-solo', ORG_WRITER);
    expect((await solo.call('list_memories', { scope: 'org' })).json).toEqual({ success: false, message: 'User is not a member of any organization.' });
    expect((await solo.call('save_org_memory', { content: 'x', category: 'insight' })).json).toEqual({ success: false, message: 'User is not a member of any organization.' });
    expect((await solo.call('delete_org_memory', { memoryId: '00ORG-A-0001' })).json).toEqual({ success: false, message: 'User is not a member of any organization.' });
  });
});

describe('memory switched off', () => {
  it('memoryEnabled false: that user cannot save or list, others in the org still can, and nothing is written', async () => {
    const t = TENANT_A;
    setUser(t.owner, t.orgId, { memoryEnabled: false });
    const off = await as(t.owner);
    const before = snapshotTenant(fake, t);
    expect((await off.call('save_memory', { content: 'x', category: 'insight' })).json).toEqual({ success: false, message: 'Memory is disabled for this account.' });
    expect((await off.call('list_memories', {})).json).toEqual({ success: false, message: 'Memory is disabled for this account.' });
    expect(snapshotTenant(fake, t)).toBe(before);
    expect((await (await as(TENANT_B.owner)).call('list_memories', {})).json.success).toBe(true);
    expect(embedText).not.toHaveBeenCalled();
  });

  it('orgMemoryEnabled false: org save and org list are refused for A\'s people, B\'s org is unaffected', async () => {
    setOrg(TENANT_A, { orgMemoryEnabled: false });
    const a = await as(TENANT_A.owner, ORG_WRITER);
    const before = snapshotTenant(fake, TENANT_A);
    expect((await a.call('save_org_memory', { content: 'x', category: 'insight' })).json).toEqual({ success: false, message: 'Organization memory is disabled.' });
    expect((await a.call('list_memories', { scope: 'org' })).json).toEqual({ success: false, message: 'Organization memory is disabled.' });
    expect(snapshotTenant(fake, TENANT_A)).toBe(before);
    expect((await (await as(TENANT_B.owner)).call('list_memories', { scope: 'org' })).json.success).toBe(true);
    // The user's own memory is a separate switch and still works.
    expect((await a.call('list_memories', {})).json.success).toBe(true);
  });
});

describe('structured ads-learning rows', () => {
  const learningId = 'ads-learning#proposal-1';
  beforeEach(() => {
    fake.seed('AW-AccountMemory', {
      userId: TENANT_A.owner, memoryId: learningId, category: 'insight', content: 'ALPHA-MEMORY structured learning payload',
      createdAt: '2026-11-18T10:00:00.000Z', updatedAt: '2026-11-18T10:00:00.000Z',
    });
  });

  it('is never listed, and the list and total count only ordinary memories', async () => {
    const out = await (await as(TENANT_A.owner)).call('list_memories', {});
    expect(listedIds(out)).not.toContain(learningId);
    expect(out.text).not.toContain('structured learning payload');
    expect(out.json.total).toBe(TENANT_A.memories.length);
  });

  it('cannot be deleted through delete_memory (the review flow owns it) and stays in place', async () => {
    const out = await (await as(TENANT_A.owner)).call('delete_memory', { memoryId: learningId });
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/review/i);
    expect(accountRows(TENANT_A.owner).some((r: any) => r.memoryId === learningId)).toBe(true);
  });

  it('does not count toward the cap', async () => {
    for (let i = 0; i < 196; i++) {
      fake.seed('AW-AccountMemory', { userId: TENANT_A.owner, memoryId: `00FILL-${String(i).padStart(4, '0')}`, category: 'history', content: `filler ${i}`, createdAt: 'x', updatedAt: 'x' });
    }
    // 3 seeded + 196 filler = 199 ordinary memories; the learning row would make it 200 if it were counted.
    const out = await (await as(TENANT_A.owner)).call('save_memory', { content: 'the 200th ordinary memory', category: 'insight' });
    expect(out.json).toMatchObject({ success: true });
  });
});

describe('the cap of 200 and the length limits', () => {
  const fill = (table: string, key: 'userId' | 'orgId', owner: string, count: number) => {
    for (let i = 0; i < count; i++) {
      fake.seed(table, { [key]: owner, memoryId: `00FILL-${String(i).padStart(4, '0')}`, category: 'history', content: `filler ${i}`, createdAt: 'x', updatedAt: 'x' });
    }
  };

  it('account: the 200th save is accepted, the 201st refused with the count and the way out, and the other tenant is not affected', async () => {
    fill('AW-AccountMemory', 'userId', TENANT_A.owner, 196);
    const a = await as(TENANT_A.owner);
    expect((await a.call('save_memory', { content: 'the 200th', category: 'insight' })).json).toMatchObject({ success: true });
    const refused = await a.call('save_memory', { content: 'the 201st', category: 'insight' });
    expect(refused.json).toMatchObject({ success: false, stored: 200, limit: 200 });
    expect(refused.json.message).toMatch(/200 memories stored.*list_memories.*delete_memory.*Nothing was saved/s);
    expect(accountRows(TENANT_A.owner)).toHaveLength(200);
    expect((await (await as(TENANT_B.owner)).call('save_memory', { content: 'B is fine', category: 'insight' })).json.success).toBe(true);
    // Deleting one makes room again.
    expect((await a.call('delete_memory', { memoryId: '00FILL-0000' })).json.success).toBe(true);
    expect((await a.call('save_memory', { content: 'room again', category: 'insight' })).json.success).toBe(true);
  });

  it('org: the same cap applies to the org\'s rows, and says organization', async () => {
    fill('AW-OrgMemory', 'orgId', TENANT_A.orgId, 197); // 2 seeded + 197 = 199
    const a = await as(TENANT_A.owner, ORG_WRITER);
    expect((await a.call('save_org_memory', { content: 'the 200th', category: 'insight' })).json.success).toBe(true);
    const refused = await a.call('save_org_memory', { content: 'the 201st', category: 'insight' });
    expect(refused.json).toMatchObject({ success: false, stored: 200 });
    expect(refused.json.message).toMatch(/This organization has 200 memories.*delete_org_memory/s);
    expect(orgRows(TENANT_A.orgId)).toHaveLength(200);
  });

  it('at the org cap a plain member is told an owner or admin must delete, the owner is told how to delete (Opslane P1)', async () => {
    fill('AW-OrgMemory', 'orgId', TENANT_A.orgId, 198); // 2 seeded + 198 = 200
    const member = await (await as(TENANT_A.member!, ORG_WRITER)).call('save_org_memory', { content: 'one more', category: 'insight' });
    expect(member.json).toMatchObject({ success: false, stored: 200 });
    expect(member.json.message).toMatch(/Only an organization owner or admin can delete organization memories/);
    expect(member.json.message).not.toMatch(/delete_org_memory/);
    const owner = await (await as(TENANT_A.owner, ORG_WRITER)).call('save_org_memory', { content: 'one more', category: 'insight' });
    expect(owner.json.message).toMatch(/list_memories with scope "org" finds them, delete_org_memory removes one/);
    // and the way out the owner was shown works: the owner deletes one, the member can save
    expect((await (await as(TENANT_A.owner, ORG_WRITER)).call('delete_org_memory', { memoryId: '00FILL-0000' })).json.success).toBe(true);
    expect((await (await as(TENANT_A.member!, ORG_WRITER)).call('save_org_memory', { content: 'room now', category: 'insight' })).json.success).toBe(true);
  });

  it('a split save counts its rows against the cap', async () => {
    fill('AW-AccountMemory', 'userId', TENANT_A.owner, 196);
    const a = await as(TENANT_A.owner);
    const refused = await a.call('save_memory', { content: `${'word '.repeat(500)}`.trim(), category: 'insight' });
    expect(refused.json).toMatchObject({ success: false, stored: 199 });
    expect(refused.json.message).toMatch(/needs 2 more rows/);
    expect(accountRows(TENANT_A.owner)).toHaveLength(199);
  });

  it('content over 8,000 characters is refused, and 2,500 characters is saved as two rows', async () => {
    const a = await as(TENANT_A.owner);
    const tooLong = await a.call('save_memory', { content: 'x'.repeat(8001), category: 'insight' });
    expect(tooLong.isError).toBe(true);
    expect(tooLong.text).toMatch(/8000 characters or less/);
    const split = await a.call('save_memory', { content: `${'word '.repeat(500)}`.trim(), category: 'insight' });
    expect(split.json).toMatchObject({ success: true, memoryIds: expect.any(Array) });
    expect(split.json.memoryIds).toHaveLength(2);
    expect(accountRows(TENANT_A.owner)).toHaveLength(TENANT_A.memories.length + 2);
  });

  it('an account already above 200 keeps its rows, is refused new saves, and can still list and delete', async () => {
    fill('AW-AccountMemory', 'userId', TENANT_A.owner, 277);
    const a = await as(TENANT_A.owner);
    expect((await a.call('save_memory', { content: 'more', category: 'insight' })).json).toMatchObject({ success: false, stored: 280 });
    expect((await a.call('list_memories', { limit: 50 })).json).toMatchObject({ success: true, count: 50, total: 280 });
    expect((await a.call('delete_memory', { memoryId: '00FILL-0001' })).json.success).toBe(true);
    expect(accountRows(TENANT_A.owner)).toHaveLength(279);
  });
});

describe('a signed-in OAuth client', () => {
  it('cannot call the org write tools (aw_ keys only), and nothing is written or embedded', async () => {
    const oauth = await as(TENANT_A.owner, { authMethod: 'oauth' });
    const before = snapshotTenant(fake, TENANT_A);
    for (const [tool, args] of [['save_org_memory', { content: 'x', category: 'insight' }], ['delete_org_memory', { memoryId: TENANT_A.orgMemories[0].memoryId }]] as const) {
      const out = await oauth.call(tool, args as any);
      expect(out.isError).toBe(true);
    }
    expect(snapshotTenant(fake, TENANT_A)).toBe(before);
    expect(embedText).not.toHaveBeenCalled();
  });

  it('can use the user\'s own memory tools and read org memory', async () => {
    const oauth = await as(TENANT_A.owner, { authMethod: 'oauth' });
    expect((await oauth.call('list_memories', {})).json.success).toBe(true);
    expect((await oauth.call('list_memories', { scope: 'org' })).json.success).toBe(true);
    expect((await oauth.call('save_memory', { content: 'from an OAuth client', category: 'insight' })).json.success).toBe(true);
  });
});

describe('saves sent at the same moment (a JSON-RPC batch or a retry): the cap and the duplicate check hold', () => {
  const fillAccount = (owner: string, count: number) => {
    for (let i = 0; i < count; i++) {
      fake.seed('AW-AccountMemory', { userId: owner, memoryId: `00FILL-${String(i).padStart(4, '0')}`, category: 'history', content: `filler ${i}`, createdAt: 'x', updatedAt: 'x' });
    }
  };

  it('50 different saves at once into an account with 199 stored: one is accepted, 49 refused, 200 stored, 1 embedding billed', async () => {
    fillAccount(TENANT_A.owner, 196); // 3 seeded + 196
    const a = await as(TENANT_A.owner);
    const outs = await Promise.all(Array.from({ length: 50 }, (_, i) => a.call('save_memory', { content: `distinct fact ${i}`, category: 'insight' })));
    expect(outs.filter((o) => o.json?.success === true)).toHaveLength(1);
    expect(outs.filter((o) => o.json?.success === false && o.json?.limit === 200)).toHaveLength(49);
    expect(accountRows(TENANT_A.owner)).toHaveLength(200);
    expect(embedText).toHaveBeenCalledTimes(1);
  });

  it('5 identical saves at once write one row; the other four are answered as duplicates of it', async () => {
    const a = await as(TENANT_A.owner);
    const outs = await Promise.all(Array.from({ length: 5 }, () => a.call('save_memory', { content: 'sent five times at once', category: 'insight' })));
    expect(accountRows(TENANT_A.owner)).toHaveLength(TENANT_A.memories.length + 1);
    expect(outs.filter((o) => o.json?.duplicate === true)).toHaveLength(4);
    expect(embedText).toHaveBeenCalledTimes(1);
  });

  it('the org owner and a member saving at once into an org with 199 stored share the cap: 200 stored, one refused', async () => {
    for (let i = 0; i < 197; i++) {
      fake.seed('AW-OrgMemory', { orgId: TENANT_A.orgId, memoryId: `00FILL-${String(i).padStart(4, '0')}`, category: 'history', content: `filler ${i}`, createdAt: 'x', updatedAt: 'x' });
    }
    const owner = await as(TENANT_A.owner, ORG_WRITER);
    const member = await as(TENANT_A.member!, ORG_WRITER);
    const outs = await Promise.all([
      owner.call('save_org_memory', { content: 'owner fact', category: 'insight' }),
      member.call('save_org_memory', { content: 'member fact', category: 'insight' }),
    ]);
    expect(outs.filter((o) => o.json?.success === true)).toHaveLength(1);
    expect(orgRows(TENANT_A.orgId)).toHaveLength(200);
  });

  it('another tenant saving at the same moment is not counted against the first tenant\'s cap', async () => {
    fillAccount(TENANT_A.owner, 197); // A is full
    const a = await as(TENANT_A.owner);
    const b = await as(TENANT_B.owner);
    const [fromA, fromB] = await Promise.all([
      a.call('save_memory', { content: 'A is full', category: 'insight' }),
      b.call('save_memory', { content: 'B is not', category: 'insight' }),
    ]);
    expect(fromA.json).toMatchObject({ success: false, stored: 200 });
    expect(fromB.json).toMatchObject({ success: true });
  });
});

describe('a long text that is split, saved twice', () => {
  it('the second save is a duplicate of all its parts and writes nothing', async () => {
    const long = `${'alpha '.repeat(300)}`.trim() + '\n\n' + `${'beta '.repeat(300)}`.trim();
    const a = await as(TENANT_A.owner);
    const first = await a.call('save_memory', { content: long, category: 'insight' });
    expect(first.json).toMatchObject({ success: true, memoryIds: expect.any(Array) });
    expect(first.json.memoryIds).toHaveLength(2);
    const again = await a.call('save_memory', { content: long, category: 'insight' });
    expect(again.json).toMatchObject({ success: true, saved: false, duplicate: true, memoryIds: first.json.memoryIds });
    expect(accountRows(TENANT_A.owner)).toHaveLength(TENANT_A.memories.length + 2);
    expect(embedText).toHaveBeenCalledTimes(2);
  });
});

describe('a memory whose text looks like JSON is read back exactly as it was saved', () => {
  // The public-response sanitizer strips internal id fields from JSON-looking text in tool results. A memory is the caller's own text:
  // rewriting it would hand an agent back something other than what it saved.
  const jsonText = '{"apiKeyId":"k-123","note":"hello","nested":{"userId":"u-9","agentUserId":"a-1"}}';

  it('user memory: the save answer and the list carry the text unchanged', async () => {
    const a = await as(TENANT_A.owner);
    const saved = await a.call('save_memory', { content: jsonText, category: 'insight' });
    expect(saved.json.success).toBe(true);
    expect(saved.text).toContain('apiKeyId');
    const listed = await a.call('list_memories', {});
    expect(listed.json.memories[0].content).toBe(jsonText);
    expect(accountRows(TENANT_A.owner).find((r: any) => r.memoryId === saved.json.memoryId).content).toBe(jsonText);
  });

  it('org memory: the same, and a member reads it unchanged', async () => {
    const owner = await as(TENANT_A.owner, ORG_WRITER);
    const saved = await owner.call('save_org_memory', { content: jsonText, category: 'workflow' });
    expect(saved.json.success).toBe(true);
    const listed = await (await as(TENANT_A.member!)).call('list_memories', { scope: 'org' });
    expect(listed.json.memories[0].content).toBe(jsonText);
  });

  it('the sanitizer still removes internal ids from the tools it covers (the exemption is only for the memory tools and the own-file and knowledge-base file reads)', async () => {
    const { shouldSanitizePublicResponse, OWN_CONTENT_TOOL_NAMES } = await import('../mcp/server/publicResponseSanitizer');
    // ENG-2840 (W2-10): read_knowledge_base_files answers fixed fields only (emmaKbFileReadRoutes.ts), so it joins read_file_content.
    expect([...OWN_CONTENT_TOOL_NAMES].sort()).toEqual(['delete_memory', 'delete_org_memory', 'list_memories', 'read_file_content', 'read_knowledge_base_files', 'save_memory', 'save_org_memory']);
    expect(shouldSanitizePublicResponse('manage_leads', {}, { externalMcp: true })).toBe(true);
    expect(shouldSanitizePublicResponse('list_memories', {}, { externalMcp: true })).toBe(false);
  });
});
