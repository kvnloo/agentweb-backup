/**
 * ENG-2840 wave 2 (W2-2): the memory tools over MCP. Unit level: registration and scope gating (the inventory snapshot does not record the
 * scope or `apiKeyOnly`, so they are pinned here against the real scope functions), argument validation, the cap and duplicate gate, the org
 * guards and paging. The two-tenant behaviour through the real MCP server is in __tests__/mcp.twoTenantMemory.test.ts.
 */
jest.mock('../../../services/db', () => ({
  userDb: { getUserById: jest.fn(), getUserByIdConsistent: jest.fn() },
  orgDb: { getOrgById: jest.fn() },
  accountMemoryDb: { getUserMemories: jest.fn(), addMemory: jest.fn(), deleteMemory: jest.fn() },
  orgMemoryDb: { getOrgMemories: jest.fn(), addMemory: jest.fn(), deleteMemory: jest.fn() },
}));
jest.mock('../../../utils/embeddings', () => ({ embedText: jest.fn() }));

import { mcpToolRegistry } from '../registry';
import { findApiKeyOnlyToolCallForNonKey, findScopeDenial } from '../apiKeyScopes';
import {
  checkId, exactArgs, listMemories, LIST_MEMORIES_DEFAULT_LIMIT, LIST_MEMORIES_MAX_LIMIT, MCP_EMBED_TIMEOUT_MS, MEMORY_MCP_MAX_ROWS,
} from '../memoryTools';
import { MEMORY_CATEGORIES } from '../../../utils/memoryCategories';
import { userDb, orgDb, accountMemoryDb, orgMemoryDb } from '../../../services/db';
import { embedText } from '../../../utils/embeddings';

const db = { userDb, orgDb, accountMemoryDb, orgMemoryDb } as any;
const TOOLS = ['save_memory', 'delete_memory', 'list_memories', 'save_org_memory', 'delete_org_memory'] as const;
const ORG_WRITE = ['save_org_memory', 'delete_org_memory'];
const ctx = { userId: 'u1', sessionId: 's1' };

const row = (n: number, extra: Record<string, unknown> = {}) => ({
  memoryId: `01MEM${String(n).padStart(4, '0')}`, category: 'insight', content: `fact ${n}`, createdAt: '2026-01-01', updatedAt: '2026-01-01', ...extra,
});
const rows = (count: number, from = 1) => Array.from({ length: count }, (_, k) => row(from + k));

/** Run a registered tool the way the MCP server does and return the parsed JSON of its answer. */
async function run(name: string, args: unknown, context: any = ctx): Promise<any> {
  const result = await mcpToolRegistry.getTool(name)!.execute(args, context);
  return JSON.parse(result.content[0].text);
}

beforeEach(() => {
  jest.clearAllMocks();
  db.userDb.getUserById.mockResolvedValue({ userId: 'u1', memoryEnabled: true, orgId: 'org1', orgRole: 'member' });
  db.userDb.getUserByIdConsistent.mockResolvedValue({ userId: 'u1', memoryEnabled: true, orgId: 'org1', orgRole: 'member' });
  db.orgDb.getOrgById.mockResolvedValue({ orgId: 'org1', orgMemoryEnabled: true, ownerUserId: 'owner1' });
  db.accountMemoryDb.getUserMemories.mockResolvedValue([]);
  db.orgMemoryDb.getOrgMemories.mockResolvedValue([]);
  db.accountMemoryDb.addMemory.mockImplementation(async (_u: string, _c: string, content: string) => ({ memoryId: `01NEW-${content.length}` }));
  db.orgMemoryDb.addMemory.mockImplementation(async (_o: string, _c: string, content: string) => ({ memoryId: `01ORG-${content.length}` }));
  db.accountMemoryDb.deleteMemory.mockResolvedValue(true);
  db.orgMemoryDb.deleteMemory.mockResolvedValue(true);
  (embedText as jest.Mock).mockResolvedValue([0.5]);
});

describe('registration and scope gating', () => {
  it('registers the five tools, all needing a user account', () => {
    for (const name of TOOLS) expect(mcpToolRegistry.getTool(name)).toBeDefined();
    for (const name of TOOLS) expect(mcpToolRegistry.getTool(name)!.requiresUserAccount).toBe(true);
  });

  it('only list_memories is read-only', () => {
    expect(TOOLS.filter((n) => mcpToolRegistry.getTool(n)!.readOnly === true)).toEqual(['list_memories']);
  });

  it('the org write tools need the memory:org scope AND an aw_ key; the user tools need neither', () => {
    for (const name of ORG_WRITE) {
      expect(mcpToolRegistry.getTool(name)).toMatchObject({ requiredScope: 'memory:org', apiKeyOnly: true });
    }
    for (const name of ['save_memory', 'delete_memory', 'list_memories']) {
      expect(mcpToolRegistry.getTool(name)!.requiredScope).toBeUndefined();
      expect(mcpToolRegistry.getTool(name)!.apiKeyOnly).toBeUndefined();
    }
  });

  const lookup = (name: string) => mcpToolRegistry.getTool(name);
  const call = (name: string) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } });

  it('a default key (tools:read + tools:execute) is refused the org write tools, even inside a batch, and may use the rest', () => {
    const defaults = ['tools:read', 'tools:execute'];
    for (const name of ORG_WRITE) expect(findScopeDenial(call(name), defaults, lookup)).toMatchObject({ tool: name, requiredScope: 'memory:org' });
    expect(findScopeDenial([call('list_memories'), call('save_org_memory')], defaults, lookup)).toMatchObject({ tool: 'save_org_memory' });
    for (const name of ['save_memory', 'delete_memory', 'list_memories']) expect(findScopeDenial(call(name), defaults, lookup)).toBeNull();
  });

  it('a key holding memory:org may call the org write tools; the scope alone does not let it write user memory', () => {
    for (const name of ORG_WRITE) expect(findScopeDenial(call(name), ['memory:org'], lookup)).toBeNull();
    expect(findScopeDenial(call('save_memory'), ['memory:org'], lookup)).toMatchObject({ requiredScope: 'tools:execute' });
  });

  it('a read-only key may list but not save or delete', () => {
    const readOnly = ['tools:read'];
    expect(findScopeDenial(call('list_memories'), readOnly, lookup)).toBeNull();
    for (const name of ['save_memory', 'delete_memory']) expect(findScopeDenial(call(name), readOnly, lookup)).toMatchObject({ requiredScope: 'tools:execute' });
  });

  it('an OAuth client (any non-key caller) is refused the org write tools and not the user tools', () => {
    for (const name of ORG_WRITE) expect(findApiKeyOnlyToolCallForNonKey(call(name), lookup)).toMatchObject({ tool: name });
    for (const name of ['save_memory', 'delete_memory', 'list_memories']) expect(findApiKeyOnlyToolCallForNonKey(call(name), lookup)).toBeNull();
    expect(findApiKeyOnlyToolCallForNonKey([call('list_memories'), call('delete_org_memory')], lookup)).toMatchObject({ tool: 'delete_org_memory' });
  });

  it('the category enum in the schemas is the shared category list', () => {
    for (const name of ['save_memory', 'save_org_memory', 'list_memories']) {
      expect(mcpToolRegistry.getTool(name)!.definition.inputSchema.properties.category.enum).toEqual([...MEMORY_CATEGORIES]);
    }
  });
});

describe('argument checks', () => {
  it('exactArgs: none or an object is fine; anything else, and any key that is not an input, is refused by name', () => {
    expect(exactArgs('t', undefined, ['a'])).toEqual({});
    expect(exactArgs('t', null, ['a'])).toEqual({});
    expect(exactArgs('t', { a: 1 }, ['a'])).toEqual({ a: 1 });
    expect(() => exactArgs('t', 'text', ['a'])).toThrow(/arguments must be an object/);
    expect(() => exactArgs('t', [1], ['a'])).toThrow(/arguments must be an object/);
    expect(() => exactArgs('t', { orgId: 'x' }, ['a'])).toThrow(/"orgId" is not an input of t\. Its inputs are: a\. Nothing was changed\./);
    expect(() => exactArgs('t', { x: 1, y: 2 }, ['a'])).toThrow(/"x", "y" are not inputs of t/);
  });

  it('checkId: text with no whitespace or control characters, 1 to 100 long', () => {
    expect(checkId('t', 'memoryId', '01HZ0000000000000000000000')).toBe('01HZ0000000000000000000000');
    expect(checkId('t', 'memoryId', 'ads-learning#abc')).toBe('ads-learning#abc');
    for (const bad of [undefined, null, 7, '', ' a', 'a b', 'a\nb', 'a\u0000b', 'x'.repeat(101), {}]) {
      expect(() => checkId('t', 'memoryId', bad)).toThrow(/memoryId/);
    }
    expect(checkId('t', 'memoryId', 'x'.repeat(100))).toHaveLength(100);
  });
});

describe('save_memory', () => {
  it('saves one memory under the caller, embeds it once, and answers with the id', async () => {
    const out = await run('save_memory', { content: 'prefers short emails', category: 'preference' });
    expect(out).toMatchObject({ success: true, memoryId: expect.any(String) });
    expect(db.accountMemoryDb.addMemory).toHaveBeenCalledWith('u1', 'preference', 'prefers short emails', 's1', [0.5]);
    expect(embedText).toHaveBeenCalledTimes(1);
  });

  it('refuses an argument that is not an input BY NAME and touches nothing (an agent that thinks it chose another account is told it did not)', async () => {
    for (const extra of [{ userId: 'u2' }, { orgId: 'org2' }, { scope: 'org' }]) {
      await expect(run('save_memory', { content: 'x', category: 'insight', ...extra })).rejects.toThrow(/is not an input of save_memory/);
    }
    expect(db.accountMemoryDb.addMemory).not.toHaveBeenCalled();
    expect(db.accountMemoryDb.getUserMemories).not.toHaveBeenCalled();
    expect(embedText).not.toHaveBeenCalled();
  });

  it('the shared guards still apply (bad category, blank, not text, too long): thrown before any read, embedding or write', async () => {
    await expect(run('save_memory', { content: 'x', category: 'other' })).rejects.toThrow(/Invalid category: other/);
    await expect(run('save_memory', { content: '   ', category: 'insight' })).rejects.toThrow(/Content is required/);
    await expect(run('save_memory', { content: 5, category: 'insight' })).rejects.toThrow(/Content must be text/);
    await expect(run('save_memory', { content: 'x'.repeat(8001), category: 'insight' })).rejects.toThrow(/8000 characters or less/);
    expect(db.accountMemoryDb.getUserMemories).not.toHaveBeenCalled();
    expect(db.accountMemoryDb.addMemory).not.toHaveBeenCalled();
    expect(embedText).not.toHaveBeenCalled();
  });

  it('a user who turned memory off is refused BEFORE the cap or duplicate read (the shared order is kept)', async () => {
    db.userDb.getUserById.mockResolvedValue({ userId: 'u1', memoryEnabled: false });
    const out = await run('save_memory', { content: 'x', category: 'insight' });
    expect(out).toEqual({ success: false, message: 'Memory is disabled for this account.' });
    expect(db.accountMemoryDb.getUserMemories).not.toHaveBeenCalled();
  });

  it('reads what is stored strongly consistently, from the table (no category index), newest first, without vectors', async () => {
    await run('save_memory', { content: 'x', category: 'insight' });
    expect(db.accountMemoryDb.getUserMemories).toHaveBeenCalledWith('u1', undefined, undefined, {
      maxRows: 1000, newestFirst: true, omitEmbeddings: true, consistentRead: true,
    });
  });

  it('an exact duplicate (same category, same text, ignoring surrounding whitespace) is not written or embedded again', async () => {
    db.accountMemoryDb.getUserMemories.mockResolvedValue([row(3, { content: 'prefers short emails' }), ...rows(2)]);
    const out = await run('save_memory', { content: '  prefers short emails \n', category: 'insight' });
    expect(out).toMatchObject({ success: true, saved: false, duplicate: true, memoryId: '01MEM0003' });
    expect(db.accountMemoryDb.addMemory).not.toHaveBeenCalled();
    expect(embedText).not.toHaveBeenCalled();
  });

  it('a stored memory with stray whitespace around it still counts as the same text', async () => {
    db.accountMemoryDb.getUserMemories.mockResolvedValue([row(4, { content: '\n  prefers short emails  ' })]);
    const out = await run('save_memory', { content: 'prefers short emails', category: 'insight' });
    expect(out).toMatchObject({ saved: false, duplicate: true, memoryId: '01MEM0004' });
    expect(db.accountMemoryDb.addMemory).not.toHaveBeenCalled();
  });

  it('the same text in ANOTHER category is a different memory and is saved', async () => {
    db.accountMemoryDb.getUserMemories.mockResolvedValue([row(3, { content: 'prefers short emails', category: 'preference' })]);
    const out = await run('save_memory', { content: 'prefers short emails', category: 'insight' });
    expect(out).toMatchObject({ success: true, memoryId: expect.any(String) });
    expect(out.saved).toBeUndefined();
    expect(db.accountMemoryDb.addMemory).toHaveBeenCalledTimes(1);
  });

  describe('a long text that is split into several rows', () => {
    // splitMemoryContent cuts a long text at paragraph, line or sentence ends; these two paragraphs each fit one row.
    const part1 = `${'alpha '.repeat(300)}`.trim();
    const part2 = `${'beta '.repeat(300)}`.trim();
    const long = `${part1}\n\n${part2}`;

    it('is not written again when every part is already stored in that category (a retried long save would otherwise double up to the cap)', async () => {
      db.accountMemoryDb.getUserMemories.mockResolvedValue([row(1, { content: part1 }), row(2, { content: part2 }), ...rows(3, 10)]);
      const out = await run('save_memory', { content: long, category: 'insight' });
      expect(out).toMatchObject({ success: true, saved: false, duplicate: true, memoryId: '01MEM0001', memoryIds: ['01MEM0001', '01MEM0002'] });
      expect(db.accountMemoryDb.addMemory).not.toHaveBeenCalled();
      expect(embedText).not.toHaveBeenCalled();
    });

    it('is written in full when only SOME parts are stored (it cannot be written in part), and when the parts are in another category', async () => {
      db.accountMemoryDb.getUserMemories.mockResolvedValue([row(1, { content: part1 })]);
      expect(await run('save_memory', { content: long, category: 'insight' })).toMatchObject({ success: true });
      expect(db.accountMemoryDb.addMemory).toHaveBeenCalledTimes(2);
      db.accountMemoryDb.addMemory.mockClear();
      db.accountMemoryDb.getUserMemories.mockResolvedValue([row(1, { content: part1, category: 'workflow' }), row(2, { content: part2, category: 'workflow' })]);
      expect(await run('save_memory', { content: long, category: 'insight' })).toMatchObject({ success: true });
      expect(db.accountMemoryDb.addMemory).toHaveBeenCalledTimes(2);
    });
  });

  describe('the cap of 200 stored memories', () => {
    it('is 200', () => expect(MEMORY_MCP_MAX_ROWS).toBe(200));

    it('refuses a save when 200 are stored, with how many, the limit and how to make room; nothing is written or embedded', async () => {
      db.accountMemoryDb.getUserMemories.mockResolvedValue(rows(200));
      const out = await run('save_memory', { content: 'one more', category: 'insight' });
      expect(out).toMatchObject({ success: false, stored: 200, limit: 200 });
      expect(out.message).toMatch(/200 memories stored.*limit.*200.*list_memories.*delete_memory.*Nothing was saved/s);
      expect(db.accountMemoryDb.addMemory).not.toHaveBeenCalled();
      expect(embedText).not.toHaveBeenCalled();
    });

    it('allows the 200th and refuses the 201st', async () => {
      db.accountMemoryDb.getUserMemories.mockResolvedValue(rows(199));
      expect(await run('save_memory', { content: 'the 200th', category: 'insight' })).toMatchObject({ success: true });
      db.accountMemoryDb.getUserMemories.mockResolvedValue(rows(200));
      expect(await run('save_memory', { content: 'the 201st', category: 'insight' })).toMatchObject({ success: false, stored: 200 });
    });

    it('counts the rows a split save would need: 199 stored plus a two-row save is refused, 198 plus two is allowed', async () => {
      const long = 'b'.repeat(2500);
      db.accountMemoryDb.getUserMemories.mockResolvedValue(rows(199));
      const refused = await run('save_memory', { content: long, category: 'insight' });
      expect(refused).toMatchObject({ success: false, stored: 199 });
      expect(refused.message).toMatch(/needs 2 more rows/);
      expect(db.accountMemoryDb.addMemory).not.toHaveBeenCalled();
      db.accountMemoryDb.getUserMemories.mockResolvedValue(rows(198));
      expect(await run('save_memory', { content: long, category: 'insight' })).toMatchObject({ success: true });
      expect(db.accountMemoryDb.addMemory).toHaveBeenCalledTimes(2);
    });

    it('an account already above the cap keeps its rows and is simply refused further saves', async () => {
      db.accountMemoryDb.getUserMemories.mockResolvedValue(rows(277));
      expect(await run('save_memory', { content: 'more', category: 'insight' })).toMatchObject({ success: false, stored: 277, limit: 200 });
    });

    it('a duplicate into a full store is answered as a duplicate, not refused for the cap', async () => {
      db.accountMemoryDb.getUserMemories.mockResolvedValue([...rows(199), row(500, { content: 'already here' })]);
      expect(await run('save_memory', { content: 'already here', category: 'insight' })).toMatchObject({ saved: false, duplicate: true });
    });
  });

  it('takes the caller from agentUserId when the context has no userId, and never from an argument', async () => {
    await run('save_memory', { content: 'x', category: 'insight' }, { agentUserId: 'agent-owner' });
    expect(db.accountMemoryDb.addMemory.mock.calls[0][0]).toBe('agent-owner');
    await expect(run('save_memory', { content: 'x', category: 'insight' }, {})).rejects.toThrow(/Authentication required/);
  });
});

describe('delete_memory', () => {
  it('deletes under the caller and answers "deleted"', async () => {
    expect(await run('delete_memory', { memoryId: '01MEM0001' })).toEqual({ success: true, message: 'Memory 01MEM0001 deleted.' });
    expect(db.accountMemoryDb.deleteMemory).toHaveBeenCalledWith('u1', '01MEM0001');
  });

  it('answers "not found" for an id that does not exist, as success false', async () => {
    db.accountMemoryDb.deleteMemory.mockResolvedValue(false);
    expect(await run('delete_memory', { memoryId: '01NOPE' })).toMatchObject({ success: false, message: expect.stringMatching(/not found; nothing was deleted/) });
  });

  it('refuses a missing or malformed id and an argument that is not an input, before the database is touched', async () => {
    await expect(run('delete_memory', {})).rejects.toThrow(/memoryId is required/);
    await expect(run('delete_memory', { memoryId: 'a b' })).rejects.toThrow(/not a valid memory id/);
    await expect(run('delete_memory', { memoryId: '01MEM0001', userId: 'u2' })).rejects.toThrow(/"userId" is not an input of delete_memory/);
    expect(db.accountMemoryDb.deleteMemory).not.toHaveBeenCalled();
  });

  it('the structured ads-learning refusal of the database layer reaches the agent', async () => {
    db.accountMemoryDb.deleteMemory.mockRejectedValue(new Error('Structured ads learning must be changed through its review flow.'));
    await expect(run('delete_memory', { memoryId: 'ads-learning#abc' })).rejects.toThrow(/review flow/);
  });
});

describe('save_org_memory and delete_org_memory', () => {
  it('saves under the caller\'s OWN org (from the user record), never one named in the arguments', async () => {
    const out = await run('save_org_memory', { content: 'we sell widgets', category: 'insight' });
    expect(out).toMatchObject({ success: true });
    expect(db.orgMemoryDb.addMemory).toHaveBeenCalledWith('org1', 'insight', 'we sell widgets', 'u1', [0.5]);
    await expect(run('save_org_memory', { content: 'x', category: 'insight', orgId: 'org2' })).rejects.toThrow(/"orgId" is not an input of save_org_memory/);
    expect(db.orgMemoryDb.addMemory).toHaveBeenCalledTimes(1);
  });

  it('the shared org refusals are unchanged: no org, org missing, org memory off', async () => {
    db.userDb.getUserById.mockResolvedValue({ userId: 'u1' });
    expect(await run('save_org_memory', { content: 'x', category: 'insight' })).toEqual({ success: false, message: 'User is not a member of any organization.' });
    db.userDb.getUserById.mockResolvedValue({ userId: 'u1', orgId: 'org1' });
    db.orgDb.getOrgById.mockResolvedValue(null);
    expect(await run('save_org_memory', { content: 'x', category: 'insight' })).toEqual({ success: false, message: 'Organization not found.' });
    db.orgDb.getOrgById.mockResolvedValue({ orgId: 'org1', orgMemoryEnabled: false });
    expect(await run('save_org_memory', { content: 'x', category: 'insight' })).toEqual({ success: false, message: 'Organization memory is disabled.' });
    expect(db.orgMemoryDb.getOrgMemories).not.toHaveBeenCalled();
    expect(db.orgMemoryDb.addMemory).not.toHaveBeenCalled();
  });

  it('applies the cap and the duplicate check to the ORG\'s rows, and says org', async () => {
    db.orgMemoryDb.getOrgMemories.mockResolvedValue(rows(200));
    const full = await run('save_org_memory', { content: 'x', category: 'insight' });
    expect(full).toMatchObject({ success: false, stored: 200 });
    expect(full.message).toMatch(/This organization has 200 memories.*Only an organization owner or admin can delete/s); // the default test user is a plain member
    expect(db.orgMemoryDb.getOrgMemories).toHaveBeenCalledWith('org1', undefined, undefined, { maxRows: 1000, newestFirst: true, omitEmbeddings: true, consistentRead: true });
    expect(db.accountMemoryDb.getUserMemories).not.toHaveBeenCalled();
    db.orgMemoryDb.getOrgMemories.mockResolvedValue([row(1, { content: 'we sell widgets' })]);
    expect(await run('save_org_memory', { content: 'we sell widgets', category: 'insight' })).toMatchObject({ saved: false, duplicate: true });
  });

  it('delete_org_memory checks its id like delete_memory: missing, malformed or over-long ids are refused before anything is read', async () => {
    db.userDb.getUserById.mockResolvedValue({ userId: 'u1', orgId: 'org1', orgRole: 'admin' });
    await expect(run('delete_org_memory', {})).rejects.toThrow(/memoryId is required/);
    for (const bad of ['a b', 'x'.repeat(101), 'a\nb', 7]) {
      await expect(run('delete_org_memory', { memoryId: bad })).rejects.toThrow(/memoryId/);
    }
    expect(db.userDb.getUserById).not.toHaveBeenCalled();
    expect(db.orgMemoryDb.deleteMemory).not.toHaveBeenCalled();
  });

  it('delete: a member is refused (org:configure), an admin deletes, "not found" is a refusal not a success', async () => {
    expect(await run('delete_org_memory', { memoryId: '01ORG0001' })).toEqual({ success: false, message: 'Only org owners and admins can delete org memories.' });
    expect(db.orgMemoryDb.deleteMemory).not.toHaveBeenCalled();
    db.userDb.getUserById.mockResolvedValue({ userId: 'u1', orgId: 'org1', orgRole: 'admin' });
    expect(await run('delete_org_memory', { memoryId: '01ORG0001' })).toEqual({ success: true, message: 'Org memory 01ORG0001 deleted.' });
    expect(db.orgMemoryDb.deleteMemory).toHaveBeenCalledWith('org1', '01ORG0001');
    db.orgMemoryDb.deleteMemory.mockResolvedValue(false);
    expect(await run('delete_org_memory', { memoryId: '01NOPE' })).toMatchObject({ success: false });
    await expect(run('delete_org_memory', { memoryId: '01ORG0001', orgId: 'org2' })).rejects.toThrow(/"orgId" is not an input/);
  });
});

describe('list_memories', () => {
  const list = (args: unknown = {}, context: any = ctx) => run('list_memories', args, context);

  it('defaults to the caller\'s own memories, newest first, 20 a page, with only the five public fields', async () => {
    db.accountMemoryDb.getUserMemories.mockResolvedValue(rows(30).map((r) => ({ ...r, embedding: [1], sourceSessionId: 's', userId: 'u1' })));
    const out = await list();
    expect(out).toMatchObject({ success: true, scope: 'user', count: LIST_MEMORIES_DEFAULT_LIMIT, total: 30, truncated: false });
    expect(out.memories[0].memoryId).toBe('01MEM0030');
    expect(out.memories[19].memoryId).toBe('01MEM0011');
    expect(Object.keys(out.memories[0]).sort()).toEqual(['category', 'content', 'createdAt', 'memoryId', 'updatedAt']);
    expect(out.nextCursor).toBe('01MEM0011');
  });

  it('orders newest first whatever order the database returned them in', async () => {
    db.accountMemoryDb.getUserMemories.mockResolvedValue([row(2), row(9), row(5), row(1)]);
    expect((await list()).memories.map((m: any) => m.memoryId)).toEqual(['01MEM0009', '01MEM0005', '01MEM0002', '01MEM0001']);
  });

  it('pages by memory id: three pages of 2 over 5 rows cover each row once, then nextCursor is null', async () => {
    db.accountMemoryDb.getUserMemories.mockResolvedValue(rows(5));
    const seen: string[] = [];
    let cursor: string | null | undefined;
    for (let page = 0; page < 5; page++) {
      const out = await list({ limit: 2, ...(cursor ? { cursor } : {}) });
      seen.push(...out.memories.map((m: any) => m.memoryId));
      cursor = out.nextCursor;
      if (cursor === null) break;
    }
    expect(seen).toEqual(['01MEM0005', '01MEM0004', '01MEM0003', '01MEM0002', '01MEM0001']);
    expect(cursor).toBeNull();
  });

  it('a page that ends exactly at the last row has no nextCursor', async () => {
    db.accountMemoryDb.getUserMemories.mockResolvedValue(rows(4));
    expect((await list({ limit: 4 })).nextCursor).toBeNull();
    expect((await list({ limit: 3 })).nextCursor).toBe('01MEM0002');
  });

  it('a cursor can only filter the caller\'s own rows: an id from anywhere else selects nothing it should not', async () => {
    db.accountMemoryDb.getUserMemories.mockResolvedValue(rows(3));
    expect((await list({ cursor: 'ZZZ-someone-elses-id' })).memories.map((m: any) => m.memoryId)).toEqual(['01MEM0003', '01MEM0002', '01MEM0001']);
    expect((await list({ cursor: '000' })).memories).toEqual([]);
    expect(db.accountMemoryDb.getUserMemories.mock.calls.every((c: any[]) => c[0] === 'u1')).toBe(true);
  });

  it('filters a category in code and reads the table (never the category index), consistently', async () => {
    db.accountMemoryDb.getUserMemories.mockResolvedValue([row(1, { category: 'workflow' }), row(2), row(3, { category: 'workflow' })]);
    const out = await list({ category: 'workflow' });
    expect(out.memories.map((m: any) => m.memoryId)).toEqual(['01MEM0003', '01MEM0001']);
    expect(out).toMatchObject({ category: 'workflow', total: 2 });
    expect(db.accountMemoryDb.getUserMemories).toHaveBeenCalledWith('u1', undefined, undefined, expect.objectContaining({ consistentRead: true }));
  });

  it('says so when the view is the newest 1,000 and older rows exist', async () => {
    db.accountMemoryDb.getUserMemories.mockResolvedValue(rows(1000));
    expect(await list({ limit: LIST_MEMORIES_MAX_LIMIT })).toMatchObject({ truncated: true, total: 1000, count: 50 });
  });

  it('org scope reads the caller\'s own org (no argument can name one)', async () => {
    db.orgMemoryDb.getOrgMemories.mockResolvedValue(rows(3));
    const out = await list({ scope: 'org' });
    expect(out).toMatchObject({ success: true, scope: 'org', count: 3 });
    expect(db.orgMemoryDb.getOrgMemories).toHaveBeenCalledWith('org1', undefined, undefined, expect.objectContaining({ consistentRead: true }));
    expect(db.accountMemoryDb.getUserMemories).not.toHaveBeenCalled();
    await expect(list({ scope: 'org', orgId: 'org2' })).rejects.toThrow(/"orgId" is not an input of list_memories/);
  });

  it('a plain member may read org memory (it is what Emma already shows them); a non-member, a missing org and a disabled org get the shared messages', async () => {
    db.orgMemoryDb.getOrgMemories.mockResolvedValue(rows(1));
    expect(await list({ scope: 'org' })).toMatchObject({ success: true });
    db.userDb.getUserById.mockResolvedValue({ userId: 'u1' });
    expect(await list({ scope: 'org' })).toEqual({ success: false, message: 'User is not a member of any organization.' });
    db.userDb.getUserById.mockResolvedValue({ userId: 'u1', orgId: 'org1' });
    db.orgDb.getOrgById.mockResolvedValue(null);
    expect(await list({ scope: 'org' })).toEqual({ success: false, message: 'Organization not found.' });
    db.orgDb.getOrgById.mockResolvedValue({ orgId: 'org1', orgMemoryEnabled: false });
    expect(await list({ scope: 'org' })).toEqual({ success: false, message: 'Organization memory is disabled.' });
  });

  it('a user who turned memory off gets nothing listed', async () => {
    db.userDb.getUserById.mockResolvedValue({ userId: 'u1', memoryEnabled: false });
    expect(await list()).toEqual({ success: false, message: 'Memory is disabled for this account.' });
    expect(db.accountMemoryDb.getUserMemories).not.toHaveBeenCalled();
  });

  it('checks its own arguments: scope, category, limit and cursor, and refuses any other input by name, before any read', async () => {
    await expect(list({ scope: 'team' })).rejects.toThrow(/scope must be "user".*"org"/);
    await expect(list({ category: 'other' })).rejects.toThrow(/Invalid category: other/);
    for (const limit of [0, 51, 1.5, '5', -1, NaN]) await expect(list({ limit })).rejects.toThrow(/limit must be a whole number from 1 to 50/);
    for (const cursor of [7, '', 'a b', 'x'.repeat(101), 'a\nb']) await expect(list({ cursor })).rejects.toThrow(/cursor is not valid/);
    await expect(list({ includeEmbeddings: true })).rejects.toThrow(/"includeEmbeddings" is not an input of list_memories/);
    expect(db.userDb.getUserById).not.toHaveBeenCalled();
    expect(db.accountMemoryDb.getUserMemories).not.toHaveBeenCalled();
  });

  it('a userId argument is refused by name like any other input (the server drops it before a call over MCP, but the tool must not use it either)', async () => {
    await expect(list({ userId: 'u2' })).rejects.toThrow(/"userId" is not an input of list_memories/);
    expect(db.accountMemoryDb.getUserMemories).not.toHaveBeenCalled();
  });

  it('truncated describes the READ (the newest 1,000 stored), not the filtered list: a category with 3 matches in a full read is still truncated', async () => {
    db.accountMemoryDb.getUserMemories.mockResolvedValue([...rows(997).map((r) => ({ ...r, category: 'history' })), row(1001, { category: 'workflow' }), row(1002, { category: 'workflow' }), row(1003, { category: 'workflow' })]);
    expect(await list({ category: 'workflow' })).toMatchObject({ truncated: true, total: 3, count: 3 });
  });

  it('null for an optional input means "not given"', async () => {
    db.accountMemoryDb.getUserMemories.mockResolvedValue(rows(2));
    expect(await list({ scope: null, category: null, limit: null, cursor: null })).toMatchObject({ scope: 'user', count: 2 });
  });

  it('is exported for direct use and answers the same as the registered tool', async () => {
    db.accountMemoryDb.getUserMemories.mockResolvedValue(rows(2));
    expect(await listMemories({}, ctx)).toEqual(await list());
  });
});

describe('audit line', () => {
  it('names the tool, the caller and the outcome, never the memory text', async () => {
    const info = jest.spyOn(console, 'info').mockImplementation(() => {});
    await run('save_memory', { content: 'SECRET-TEXT-123', category: 'insight' }, { userId: 'u1', apiKeyId: 'k1', externalMcp: true });
    await expect(run('save_memory', { content: 'SECRET-TEXT-456', category: 'nope' })).rejects.toThrow();
    const lines = info.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => /"event":"mcp_memory".*"tool":"save_memory".*"userId":"u1".*"apiKeyId":"k1".*"external":true.*"outcome":"ok"/.test(l))).toBe(true);
    expect(lines.some((l) => /"outcome":"error"/.test(l))).toBe(true);
    expect(lines.join('\n')).not.toMatch(/SECRET-TEXT/);
    info.mockRestore();
  });
});

describe('saves run one at a time per account (the cap and the duplicate check cannot interleave with a write)', () => {
  /** A stateful store behind the mocks, so a save that is checked before the previous one is written sees the stale rows. */
  function statefulAccount(initial: number) {
    const store = rows(initial);
    let next = 100000;
    db.accountMemoryDb.getUserMemories.mockImplementation(async () => {
      await Promise.resolve();
      return [...store];
    });
    db.accountMemoryDb.addMemory.mockImplementation(async (_u: string, category: string, content: string) => {
      await new Promise((r) => setTimeout(r, 1)); // a real write takes time: the window a lock must cover
      const memoryId = `01NEW${String(++next)}`;
      store.push(row(next, { memoryId, category, content }) as any);
      return { memoryId };
    });
    return store;
  }

  it('50 different saves sent at once into an account with 199 stored: exactly one is accepted, 49 are refused, 200 are stored', async () => {
    const store = statefulAccount(199);
    const outs = await Promise.all(Array.from({ length: 50 }, (_, i) => run('save_memory', { content: `distinct fact ${i}`, category: 'insight' })));
    expect(outs.filter((o) => o.success === true)).toHaveLength(1);
    expect(outs.filter((o) => o.success === false && o.limit === 200)).toHaveLength(49);
    expect(store).toHaveLength(200);
    expect(db.accountMemoryDb.addMemory).toHaveBeenCalledTimes(1);
    expect(embedText).toHaveBeenCalledTimes(1);
  });

  it('5 identical saves sent at once: one row is written and the other four are answered as duplicates', async () => {
    const store = statefulAccount(0);
    const outs = await Promise.all(Array.from({ length: 5 }, () => run('save_memory', { content: 'the same fact', category: 'insight' })));
    expect(store).toHaveLength(1);
    expect(outs.filter((o) => o.duplicate === true)).toHaveLength(4);
    expect(outs.filter((o) => o.saved === undefined && o.success === true)).toHaveLength(1);
    expect(embedText).toHaveBeenCalledTimes(1);
  });

  it('two members of the same org saving at once share one lock, so the org cap is exact', async () => {
    const store = rows(199);
    db.orgMemoryDb.getOrgMemories.mockImplementation(async () => { await Promise.resolve(); return [...store]; });
    db.orgMemoryDb.addMemory.mockImplementation(async (_o: string, category: string, content: string) => {
      await new Promise((r) => setTimeout(r, 1));
      store.push(row(store.length + 1, { category, content }) as any);
      return { memoryId: `01ORGNEW${store.length}` };
    });
    db.userDb.getUserById.mockImplementation(async (id: string) => ({ userId: id, orgId: 'org1', orgRole: 'member' }));
    db.userDb.getUserByIdConsistent.mockImplementation(async (id: string) => ({ userId: id, orgId: 'org1', orgRole: 'member' }));
    const outs = await Promise.all([
      run('save_org_memory', { content: 'from the first member', category: 'insight' }, { userId: 'member-1' }),
      run('save_org_memory', { content: 'from the second member', category: 'insight' }, { userId: 'member-2' }),
    ]);
    expect(outs.filter((o) => o.success === true)).toHaveLength(1);
    expect(store).toHaveLength(200);
  });

  it('accounts that do not share a lock do not wait for each other', async () => {
    db.userDb.getUserByIdConsistent.mockImplementation(async (id: string) => ({ userId: id, orgId: id === 'a' ? 'org-a' : 'org-b' }));
    db.userDb.getUserById.mockImplementation(async (id: string) => ({ userId: id, memoryEnabled: true }));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    db.accountMemoryDb.addMemory.mockImplementation(async (userId: string) => {
      if (userId === 'a') await gate; // account a's write is stuck
      return { memoryId: `01-${userId}` };
    });
    const stuck = run('save_memory', { content: 'a is slow', category: 'insight' }, { userId: 'a' });
    const free = await run('save_memory', { content: 'b is not', category: 'insight' }, { userId: 'b' });
    expect(free).toMatchObject({ success: true, memoryId: '01-b' });
    release();
    expect(await stuck).toMatchObject({ success: true, memoryId: '01-a' });
  });

  it('a failed save does not block the next one for the same account', async () => {
    db.accountMemoryDb.addMemory.mockRejectedValueOnce(new Error('write failed'));
    await expect(run('save_memory', { content: 'first', category: 'insight' })).rejects.toThrow('write failed');
    expect(await run('save_memory', { content: 'second', category: 'insight' })).toMatchObject({ success: true });
  });

  it('if the account cannot be identified for the lock, the save is refused and nothing is read, embedded or written', async () => {
    db.userDb.getUserByIdConsistent.mockResolvedValue(null);
    await expect(run('save_memory', { content: 'x', category: 'insight' })).rejects.toThrow(/the account could not be identified, so nothing was changed/);
    db.userDb.getUserByIdConsistent.mockRejectedValue(new Error('ResourceNotFound on table AW-Users, role arn:aws:iam::1:role/x'));
    const err = await run('save_org_memory', { content: 'x', category: 'insight' }).catch((e) => e);
    expect(String(err.message)).toMatch(/the account could not be identified/);
    expect(String(err.message)).not.toMatch(/AW-Users|arn:aws/);
    expect(db.accountMemoryDb.getUserMemories).not.toHaveBeenCalled();
    expect(db.orgMemoryDb.getOrgMemories).not.toHaveBeenCalled();
    expect(db.accountMemoryDb.addMemory).not.toHaveBeenCalled();
    expect(embedText).not.toHaveBeenCalled();
  });
});

describe('the lock is bounded and is its own (second review)', () => {
  it('a hung embedding is given up on after the MCP timeout, and the save queued behind it then proceeds', async () => {
    expect(MCP_EMBED_TIMEOUT_MS).toBe(15_000);
    jest.useFakeTimers();
    try {
      (embedText as jest.Mock).mockReturnValueOnce(new Promise(() => {}));
      const first = run('save_memory', { content: 'slow embedding', category: 'insight' });
      const second = run('save_memory', { content: 'queued behind it', category: 'insight' });
      await jest.advanceTimersByTimeAsync(14_000);
      expect(db.accountMemoryDb.addMemory).not.toHaveBeenCalled(); // still waiting, and the second is still queued
      await jest.advanceTimersByTimeAsync(2_000);
      await expect(first).resolves.toMatchObject({ success: true });
      await expect(second).resolves.toMatchObject({ success: true });
      expect(db.accountMemoryDb.addMemory.mock.calls[0][4]).toBeUndefined(); // the slow one is saved without an embedding
      expect(db.accountMemoryDb.addMemory.mock.calls[1][4]).toEqual([0.5]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('a long text is ONE wait, not one per part: three parts under a hung embedding service finish after 15 seconds, unembedded', async () => {
    jest.useFakeTimers();
    try {
      (embedText as jest.Mock).mockReturnValue(new Promise(() => {}));
      const long = ['alpha', 'beta', 'gamma'].map((w) => `${`${w} `.repeat(300)}`.trim()).join('\n\n');
      const pending = run('save_memory', { content: long, category: 'insight' });
      await jest.advanceTimersByTimeAsync(15_001);
      const out = await pending;
      expect(out).toMatchObject({ success: true, memoryIds: expect.any(Array) });
      expect(out.memoryIds.length).toBeGreaterThanOrEqual(3);
      expect(embedText).toHaveBeenCalledTimes(1);
      expect(db.accountMemoryDb.addMemory.mock.calls.every((c: any[]) => c[4] === undefined)).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('the org save has the same bound', async () => {
    jest.useFakeTimers();
    try {
      (embedText as jest.Mock).mockReturnValueOnce(new Promise(() => {}));
      const pending = run('save_org_memory', { content: 'slow org embedding', category: 'insight' });
      await jest.advanceTimersByTimeAsync(15_001);
      await expect(pending).resolves.toMatchObject({ success: true });
      expect(db.orgMemoryDb.addMemory.mock.calls[0][4]).toBeUndefined();
    } finally {
      jest.useRealTimers();
    }
  });

  it('memory saves have their own lock: a write held under the strategy lock for the same account does not hold a save', async () => {
    const { withAccountLock } = await import('../accountLock');
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const strategy = withAccountLock('strategy', { userId: 'u1' }, () => held);
    const out = await run('save_memory', { content: 'not held by the strategy lock', category: 'insight' });
    expect(out).toMatchObject({ success: true });
    release();
    await strategy;
  });
});

describe('the cap message tells the caller what THEY can do (Opslane P1: a member was told to delete, and cannot)', () => {
  it('an org member (cannot delete org memory) is told an owner or admin must make room, and is not told to call delete_org_memory', async () => {
    db.orgMemoryDb.getOrgMemories.mockResolvedValue(rows(200));
    const out = await run('save_org_memory', { content: 'one more', category: 'insight' });
    expect(out).toMatchObject({ success: false, stored: 200, limit: 200 });
    expect(out.message).toMatch(/Only an organization owner or admin can delete organization memories: ask one of them/);
    expect(out.message).toMatch(/list_memories with scope "org" shows what is stored/);
    expect(out.message).not.toMatch(/delete_org_memory/);
    expect(out.message).toMatch(/Nothing was saved\.$/);
  });

  it.each(['admin', 'owner'])('an org %s is told how to delete themselves', async (role) => {
    db.userDb.getUserById.mockResolvedValue({ userId: 'u1', orgId: 'org1', orgRole: role });
    db.orgMemoryDb.getOrgMemories.mockResolvedValue(rows(200));
    const out = await run('save_org_memory', { content: 'one more', category: 'insight' });
    expect(out.message).toMatch(/list_memories with scope "org" finds them, delete_org_memory removes one/);
    expect(out.message).not.toMatch(/Only an organization owner or admin/);
  });

  it('a user over the cap on their OWN memory is always told to delete (they can)', async () => {
    db.accountMemoryDb.getUserMemories.mockResolvedValue(rows(200));
    const out = await run('save_memory', { content: 'one more', category: 'insight' });
    expect(out.message).toMatch(/list_memories finds them, delete_memory removes one/);
  });
});

