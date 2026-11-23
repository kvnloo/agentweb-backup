/**
 * ENG-2840 wave 2 (W2-2): the memory tools for outside agents over MCP (the Hermes agents: Yugo, Hue, Remy).
 *
 * Same names and the same bodies as Emma's memory tools (emma/impl/memory.ts, shared since W2-1), run in process, so every guard Emma's
 * tools have applies unchanged: the caller's identity comes from the key and never from an argument; a user who turned memory off, an org
 * with no org memory and a member who lacks `org:configure` (delete) are refused with the same messages; content over 2,000 characters is
 * split into rows and content over 8,000 is refused.
 *
 * What the MCP path adds, because it is open to any agent and validates nothing against the input schema (SDK low-level server):
 *  - the handler checks its own arguments, and an argument that is not an input of the tool is refused BY NAME ("orgId is not an input
 *    of save_memory"), never ignored: an agent that believes it chose an org must be told it did not;
 *  - a cap of 200 stored memories per account and per org on writes made here (Emma's own tools and the Settings routes have no cap, and
 *    an account already above 200 keeps what it has; its saves are refused until it deletes). Rows carry a 17 KB embedding, so 200 rows
 *    is about 3.4 MB per Emma prompt read. Each save runs under a lock for the account (the org when the caller has one), taken in
 *    order (the caller's record is read first, so "order" is approximate to within that read), so the check and the write cannot interleave
 *    with another save, even inside one JSON-RPC batch. The wait for an embedding while holding it is bounded (MCP_EMBED_TIMEOUT_MS). The lock is per
 *    server process (the same limit as the lead and strategy tools): with several server instances, saves that reach different ones can
 *    each pass the check, so the cap is exact within an instance and approximate across them;
 *  - an exact duplicate (same category, same text; for a split save, every part already stored) is not written again and costs no embedding;
 *  - `list_memories`, new: Emma reads memory by having it put into her prompt, so an agent had no way to learn a memory id.
 *
 * Tools and scopes:
 *  - `save_memory`, `delete_memory`, `list_memories`: the user's own memory. Default scopes (`tools:execute` to write, `tools:read` to list).
 *  - `save_org_memory`, `delete_org_memory`: opt-in scope `memory:org`, `aw_` keys only (`apiKeyOnly`): what an org memory says goes into
 *    EVERY member's Emma prompt, so the scope decides which keys may call THESE TOOLS. A signed-in OAuth client is refused. Reading org
 *    memory (`list_memories` with scope org) needs no opt-in scope: any member may read what Emma already shows them.
 *
 * What the scope does NOT control: a key that may call `emma_send_message`, `emma_run_marketing_task` or `emma_create_session` starts an
 * Emma agent run, and that run has Emma's own `save_org_memory`, with no scope check and no cap. That is how `email:read` and the
 * Smartlead scopes already behave (see AGENT_EXECUTION_TOOLS: an outside agent's allowlist that leaves the agent-run tools out is what
 * closes it, and that control lives with whoever mints and brokers the key, not in this repo).
 *
 * Nothing here adds a stored attribute, a table or an index. The org is always the caller's own (from the user record).
 */
import { mcpToolRegistry } from './registry';
import { jsonResult } from './toolHelpers';
import { withAccountLock } from './accountLock';
import { API_KEY_SCOPE_MEMORY_ORG } from './apiKeyScopes';
import * as memoryImpl from '../../emma/impl/memory';
import { MEMORY_CATEGORIES, isMemoryCategory } from '../../utils/memoryCategories';
import { MEMORY_AUTOSPLIT_MAX_CHARS, splitMemoryContent } from '../../utils/memoryContentLimit';
import { MEMORY_READ_MAX_ROWS_LIST } from '../../utils/memoryReadLimits';

/** Most memories an account (or an org) may hold for a save made through MCP to be accepted. */
export const MEMORY_MCP_MAX_ROWS = 200;
/** How long a save waits for an embedding while it holds the account's lock, in total: after that its rows are saved without one (see MemoryWriteOptions). */
export const MCP_EMBED_TIMEOUT_MS = 15_000;
const WRITE_OPTIONS = { embedTimeoutMs: MCP_EMBED_TIMEOUT_MS } as const;
export const LIST_MEMORIES_DEFAULT_LIMIT = 20;
export const LIST_MEMORIES_MAX_LIMIT = 50;

/**
 * The read these tools make: the newest rows up to the list bound, no embeddings (the Settings screens' read), and STRONGLY CONSISTENT, so
 * a list made right after a save shows it and two saves of the same text in a row see each other (a table read is eventually consistent
 * by default). It reads the table, never a category index (an index cannot be read consistently), so a category is filtered here.
 */
const TOOL_READ = { maxRows: MEMORY_READ_MAX_ROWS_LIST, newestFirst: true, omitEmbeddings: true, consistentRead: true } as const;

function callerId(context: any): string {
  const userId = context?.userId || context?.agentUserId;
  if (!userId) throw new Error('Authentication required');
  return userId;
}

/** The arguments object, or `{}` when none was sent; any key that is not an input of the tool is refused by name. */
export function exactArgs(tool: string, args: unknown, inputs: readonly string[]): Record<string, unknown> {
  if (args === undefined || args === null) return {};
  if (typeof args !== 'object' || Array.isArray(args)) throw new Error(`${tool}: the arguments must be an object. Nothing was changed.`);
  const unknown = Object.keys(args).filter((key) => !inputs.includes(key));
  if (unknown.length > 0) {
    const names = unknown.map((key) => `"${key.slice(0, 40)}"`).join(', ');
    throw new Error(`${tool}: ${names} ${unknown.length > 1 ? 'are not inputs' : 'is not an input'} of ${tool}. Its inputs are: ${inputs.join(', ')}. Nothing was changed.`);
  }
  return args as Record<string, unknown>;
}

/** A memory id as an agent may send it: text, no whitespace or control characters, at most 100 characters (ULIDs are 26). */
export function checkId(tool: string, field: string, value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${tool}: ${field} is required and must be text. Nothing was changed.`);
  if (value.length > 100 || /[\s\u0000-\u001f\u007f-\u009f]/.test(value)) {
    throw new Error(`${tool}: ${field} is not a valid memory id. Use an id returned by save_memory or list_memories. Nothing was changed.`);
  }
  return value;
}

type StoredRow = { memoryId: string; category?: string; content?: string; createdAt?: string; updatedAt?: string };

/** The newest stored rows (no embeddings) of the account or of the org, up to the list bound. */
async function readStored(scope: 'user' | 'org', ownerId: string): Promise<StoredRow[]> {
  const { accountMemoryDb, orgMemoryDb } = await import('../../services/db');
  const rows = scope === 'org'
    ? await orgMemoryDb.getOrgMemories(ownerId, undefined, undefined, TOOL_READ)
    : await accountMemoryDb.getUserMemories(ownerId, undefined, undefined, TOOL_READ);
  return rows as StoredRow[];
}

/** The caps and the duplicate check that only the MCP path applies, run after the shared guards and before anything is embedded. */
export const mcpWriteGate: memoryImpl.MemoryWriteGate = async ({ scope, ownerId, content, category, chunkCount, callerCanDelete }) => {
  const rows = await readStored(scope, ownerId);
  // A duplicate: every part of this save (one part, or each of the parts a long text splits into) is already stored in this category.
  // A retried long save would otherwise write all its parts again, and again, until the cap.
  const sameCategory = rows.filter((row) => row.category === category && typeof row.content === 'string');
  const found = splitMemoryContent(content).map((part) => sameCategory.find((row) => row.content!.trim() === part.trim()));
  if (found.length > 0 && found.every((row) => row !== undefined)) {
    const ids = found.map((row) => row!.memoryId);
    return {
      success: true,
      saved: false,
      duplicate: true,
      memoryId: ids[0],
      ...(ids.length > 1 ? { memoryIds: ids } : {}),
      message: `An identical ${category} memory already exists (${ids.join(', ')}); nothing was saved.`,
    };
  }
  if (rows.length + chunkCount > MEMORY_MCP_MAX_ROWS) {
    const deleteTool = scope === 'org' ? 'delete_org_memory' : 'delete_memory';
    // Tell the caller what THEY can do: a plain org member cannot delete org memory (it needs org:configure), so telling them to is a dead end.
    const listCall = scope === 'org' ? 'list_memories with scope "org"' : 'list_memories';
    const wayOut = callerCanDelete
      ? `Delete memories that are no longer needed first (${listCall} finds them, ${deleteTool} removes one), then save again.`
      : `Only an organization owner or admin can delete organization memories: ask one of them to remove memories that are no longer needed (${listCall} shows what is stored), then save again.`;
    return {
      success: false,
      stored: rows.length,
      limit: MEMORY_MCP_MAX_ROWS,
      message: `This ${scope === 'org' ? 'organization has' : 'account has'} ${rows.length} memories stored and the limit for saving through MCP is ${MEMORY_MCP_MAX_ROWS}; `
        + `this save needs ${chunkCount} more row${chunkCount === 1 ? '' : 's'}. ${wayOut} Nothing was saved.`,
    };
  }
  return undefined;
};

/** The whole save (cap and duplicate check, embedding, writes) runs one at a time per account, or per org for a caller who has one. */
export async function saveMemory(args: unknown, context: any) {
  const input = exactArgs('save_memory', args, ['content', 'category']);
  return withAccountLock('memory', context, () => memoryImpl.saveAccountMemory(input, context, mcpWriteGate, WRITE_OPTIONS));
}

export async function deleteMemory(args: unknown, context: any) {
  const input = exactArgs('delete_memory', args, ['memoryId']);
  return memoryImpl.deleteAccountMemory({ memoryId: checkId('delete_memory', 'memoryId', input.memoryId) }, context);
}

export async function saveOrgMemory(args: unknown, context: any) {
  const input = exactArgs('save_org_memory', args, ['content', 'category']);
  return withAccountLock('memory', context, () => memoryImpl.saveOrgMemory(input, context, mcpWriteGate, WRITE_OPTIONS));
}

export async function deleteOrgMemory(args: unknown, context: any) {
  const input = exactArgs('delete_org_memory', args, ['memoryId']);
  return memoryImpl.deleteOrgMemory({ memoryId: checkId('delete_org_memory', 'memoryId', input.memoryId) }, context);
}

/**
 * List the caller's own memories, or their org's, newest first, a page at a time. The read is the bounded one the Settings screens make
 * (the newest 1,000, no embeddings); the page is cut from it by memory id, so the cursor is just "the ids below this one" and can only
 * ever select rows of the caller's own account or org. Rows of the structured ads-learning kind are never listed (the reader skips them).
 */
export async function listMemories(args: unknown, context: any) {
  const tool = 'list_memories';
  const input = exactArgs(tool, args, ['scope', 'category', 'limit', 'cursor']);

  const scope = input.scope === undefined || input.scope === null ? 'user' : input.scope;
  if (scope !== 'user' && scope !== 'org') throw new Error(`${tool}: scope must be "user" (your own memories) or "org" (your organization's). Nothing was changed.`);

  let category: string | undefined;
  if (input.category !== undefined && input.category !== null) {
    if (!isMemoryCategory(input.category)) throw new Error(`Invalid category: ${String(input.category)}. Must be one of: ${MEMORY_CATEGORIES.join(', ')}`);
    category = input.category;
  }

  let limit = LIST_MEMORIES_DEFAULT_LIMIT;
  if (input.limit !== undefined && input.limit !== null) {
    if (typeof input.limit !== 'number' || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > LIST_MEMORIES_MAX_LIMIT) {
      throw new Error(`${tool}: limit must be a whole number from 1 to ${LIST_MEMORIES_MAX_LIMIT}.`);
    }
    limit = input.limit;
  }

  let cursor: string | undefined;
  if (input.cursor !== undefined && input.cursor !== null) {
    if (typeof input.cursor !== 'string' || input.cursor.length === 0 || input.cursor.length > 100 || /[\s\u0000-\u001f\u007f-\u009f]/.test(input.cursor)) {
      throw new Error(`${tool}: cursor is not valid. Use nextCursor from the previous page, or leave it out for the first page.`);
    }
    cursor = input.cursor;
  }

  const userId = callerId(context);
  const { userDb, orgDb } = await import('../../services/db');
  const user = await userDb.getUserById(userId);

  let ownerId = userId;
  if (scope === 'user') {
    if (user?.memoryEnabled === false) return { success: false, message: 'Memory is disabled for this account.' };
  } else {
    if (!user?.orgId) return { success: false, message: 'User is not a member of any organization.' };
    const org = await orgDb.getOrgById(user.orgId);
    if (!org) return { success: false, message: 'Organization not found.' };
    if (org.orgMemoryEnabled === false) return { success: false, message: 'Organization memory is disabled.' };
    ownerId = user.orgId;
  }

  const rows = await readStored(scope, ownerId);
  // The category is filtered here (the table read is the consistent one) and the rows ordered newest first (ids are ULIDs).
  const ordered = rows
    .filter((row) => typeof row.memoryId === 'string' && (category === undefined || row.category === category))
    .sort((a, b) => (a.memoryId < b.memoryId ? 1 : a.memoryId > b.memoryId ? -1 : 0));
  const remaining = cursor === undefined ? ordered : ordered.filter((row) => row.memoryId < cursor!);
  const page = remaining.slice(0, limit);
  return {
    success: true,
    scope,
    ...(category ? { category } : {}),
    memories: page.map((row) => ({
      memoryId: row.memoryId,
      category: row.category,
      content: row.content,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    })),
    count: page.length,
    // Matching memories in the newest-1,000 view; when `truncated` is true there are older ones this list does not reach.
    total: ordered.length,
    truncated: rows.length >= MEMORY_READ_MAX_ROWS_LIST,
    nextCursor: remaining.length > page.length ? page[page.length - 1].memoryId : null,
  };
}

function register(p: {
  name: string;
  readOnly: boolean;
  orgWrite?: boolean;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (args: unknown, context: any) => Promise<unknown>;
}) {
  mcpToolRegistry.register({
    name: p.name,
    readOnly: p.readOnly,
    ...(p.orgWrite ? { requiredScope: API_KEY_SCOPE_MEMORY_ORG, apiKeyOnly: true } : {}),
    requiresUserAccount: true,
    definition: { name: p.name, description: p.description, inputSchema: p.inputSchema },
    execute: async (args: any, context: any) => {
      // The audit line names the tool, the caller and the outcome; never the memory text.
      const audit = (outcome: 'ok' | 'error', error?: string) =>
        console.info(JSON.stringify({
          event: 'mcp_memory',
          tool: p.name,
          userId: context?.userId,
          apiKeyId: context?.apiKeyId,
          external: context?.externalMcp === true,
          outcome,
          ...(error ? { error: error.slice(0, 200) } : {}),
        }));
      try {
        const result = await p.run(args, context);
        audit('ok');
        return jsonResult(result);
      } catch (err: any) {
        audit('error', String(err?.message ?? err));
        throw err;
      }
    },
  });
}

const CATEGORY_PROPERTY = {
  type: 'string',
  enum: [...MEMORY_CATEGORIES],
  description: 'preference, history, insight or workflow.',
};
const MEMORY_ID_PROPERTY = { type: 'string', description: 'The memory id (from save_memory or list_memories).' };

register({
  name: 'save_memory',
  readOnly: false,
  description: 'Save one fact about the user\'s own account, for Emma to know in future sessions. Content up to 2,000 characters is one memory; up to 8,000 is split into several. '
    + `An identical memory is not saved twice, and at most ${MEMORY_MCP_MAX_ROWS} memories can be stored through MCP (delete some to save more).`,
  inputSchema: {
    type: 'object',
    properties: {
      content: { type: 'string', maxLength: MEMORY_AUTOSPLIT_MAX_CHARS, description: 'The fact. Specific and actionable.' },
      category: CATEGORY_PROPERTY,
    },
    required: ['content', 'category'],
  },
  run: saveMemory,
});

register({
  name: 'delete_memory',
  readOnly: false,
  description: 'Delete one of the user\'s own memories by id. Answers "not found" when there is no such memory.',
  inputSchema: { type: 'object', properties: { memoryId: MEMORY_ID_PROPERTY }, required: ['memoryId'] },
  run: deleteMemory,
});

register({
  name: 'save_org_memory',
  readOnly: false,
  orgWrite: true,
  description: 'Save one fact about the user\'s organization. Every member\'s Emma will know it in future sessions, so keep it to what the whole team should know. '
    + `Same limits as save_memory (at most ${MEMORY_MCP_MAX_ROWS} org memories through MCP).`,
  inputSchema: {
    type: 'object',
    properties: {
      content: { type: 'string', maxLength: MEMORY_AUTOSPLIT_MAX_CHARS, description: 'The org-wide fact. Specific and actionable.' },
      category: CATEGORY_PROPERTY,
    },
    required: ['content', 'category'],
  },
  run: saveOrgMemory,
});

register({
  name: 'delete_org_memory',
  readOnly: false,
  orgWrite: true,
  description: 'Delete one of the organization\'s memories by id. Only org owners and admins can; answers "not found" when there is no such memory.',
  inputSchema: { type: 'object', properties: { memoryId: MEMORY_ID_PROPERTY }, required: ['memoryId'] },
  run: deleteOrgMemory,
});

register({
  name: 'list_memories',
  readOnly: true,
  description: 'List the user\'s own memories (scope "user", the default) or the organization\'s (scope "org"), newest first, a page at a time. '
    + 'Returns id, category, content and dates, never embeddings. Pass nextCursor back as cursor for the next page.',
  inputSchema: {
    type: 'object',
    properties: {
      scope: { type: 'string', enum: ['user', 'org'], description: '"user" (default) or "org".' },
      category: CATEGORY_PROPERTY,
      limit: { type: 'number', description: `Memories per page, 1 to ${LIST_MEMORIES_MAX_LIMIT} (default ${LIST_MEMORIES_DEFAULT_LIMIT}).` },
      cursor: { type: 'string', description: 'nextCursor from the previous page.' },
    },
    required: [],
  },
  run: listMemories,
});
