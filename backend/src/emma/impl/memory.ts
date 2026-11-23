/**
 * ENG-2840 (W2-1): the four memory tool bodies (`save_memory`, `delete_memory`, `save_org_memory`, `delete_org_memory`),
 * moved out of `emma/tools.ts` so Emma's tools and, later, the MCP tools run one set of guards.
 *
 * The guards are unchanged: the caller's identity comes from the session context and never from an argument; a user who turned
 * memory off, an org with no org memory, and a member who lacks `org:configure` are refused with the same messages; content over
 * 2,000 characters is split into rows of at most 2,000 and content over 8,000 is rejected.
 *
 * What changed, each one a defect found on 2026-11-23:
 *  - the arguments are checked BEFORE anything is embedded. An invalid category used to be embedded (and billed to the caller's
 *    cap) and only then refused by the database layer;
 *  - whitespace-only content over 2,000 characters used to split into nothing and answer `success: true` with no row saved;
 *  - content that was not text used to throw after the earlier rows were already saved, so a retry saved them twice;
 *  - the 8,000-character limit was enforced only by the agent-mode tool schema; it is now enforced here too, so a caller that
 *    skips that schema (the MCP path) cannot write a larger memory;
 *  - a delete of an id that does not exist used to answer "deleted".
 *
 * `services/db` and `utils/embeddings` are required inside each function body, never at module scope: the first builds a
 * DynamoDB client when it loads and the second pulls in the LLM clients (see the other `*.moduleIsolation.test.ts` files).
 */
import { MEMORY_CATEGORIES, isMemoryCategory, type MemoryCategory } from '../../utils/memoryCategories';
import { MEMORY_AUTOSPLIT_MAX_CHARS, memoryContentLength, splitMemoryContent } from '../../utils/memoryContentLimit';
import { can } from '../../services/orgAuthz';

export interface MemoryToolContext {
  userId?: string;
  agentUserId?: string;
  sessionId?: string;
}

/**
 * A check a CALLER adds in front of a save, after the shared guards (memory switched on, org found, arguments valid) and before anything
 * is embedded or written: the MCP tools use it for their per-account cap and duplicate check. Return a result to answer the call with it
 * instead of writing; return nothing to go on. Emma's own tools pass none, so their behaviour and order of checks are unchanged.
 */
export type MemoryWriteGate = (request: {
  scope: 'user' | 'org';
  ownerId: string;
  content: string;
  category: MemoryCategory;
  chunkCount: number;
}) => Promise<Record<string, unknown> | undefined>;

function callerId(context?: MemoryToolContext): string {
  const userId = context?.userId || context?.agentUserId;
  if (!userId) throw new Error('Authentication required');
  return userId;
}

/**
 * Check a save call's arguments. A bad category and blank or missing content give the same messages `services/db` throws for them, so a
 * caller sees the same words whether the check happens here or there. Content that is not text (`Content must be text`) and content over
 * 8,000 characters are new refusals: before, the first threw after saving and the second was stopped only by the agent-mode schema.
 */
export function checkMemorySaveArgs(args: { content?: unknown; category?: unknown } | undefined): { content: string; category: MemoryCategory } {
  const category = args?.category;
  if (!isMemoryCategory(category)) {
    throw new Error(`Invalid category: ${String(category)}. Must be one of: ${MEMORY_CATEGORIES.join(', ')}`);
  }
  const content = args?.content;
  if (content === undefined || content === null) throw new Error('Content is required');
  if (typeof content !== 'string') throw new Error('Content must be text');
  if (content.trim().length === 0) throw new Error('Content is required');
  const length = memoryContentLength(content);
  if (length > MEMORY_AUTOSPLIT_MAX_CHARS) {
    throw new Error(
      `Content must be ${MEMORY_AUTOSPLIT_MAX_CHARS} characters or less — this content is ${length} characters, `
      + `${length - MEMORY_AUTOSPLIT_MAX_CHARS} over the limit. Do NOT retry the same text: it will fail identically. `
      + `Shorten it to the essential fact, or save it as several memories.`,
    );
  }
  return { content, category };
}

function checkMemoryId(args: { memoryId?: unknown } | undefined): string {
  const memoryId = args?.memoryId;
  if (typeof memoryId !== 'string' || memoryId.trim().length === 0) throw new Error('memoryId is required');
  return memoryId;
}

function previewOf(content: string): string {
  return `"${content.substring(0, 80)}${content.length > 80 ? '...' : ''}"`;
}

/** Embed each chunk and write it with `write`, in order; returns the new memory ids. Embedding is best effort (a failure saves the row without one). */
async function writeChunks(
  userId: string,
  content: string,
  write: (chunk: string, embedding: number[] | undefined) => Promise<{ memoryId?: unknown }>,
): Promise<string[]> {
  const { embedText } = await import('../../utils/embeddings');
  // ENG-2574: content over 2,000 characters is split into rows of at most 2,000 rather than rejected.
  const chunks = splitMemoryContent(content);
  // The arguments were checked non-blank, so a split cannot come back empty; if it ever did, saying "saved" would be a lie.
  if (chunks.length === 0) throw new Error('Content is required');
  const memoryIds: string[] = [];
  for (const chunk of chunks) {
    const embedding = (await embedText(chunk, { userId, feature: 'embeddings' })) ?? undefined;
    const memory = await write(chunk, embedding);
    memoryIds.push(String(memory.memoryId));
  }
  return memoryIds;
}

export async function saveAccountMemory(args: { content?: unknown; category?: unknown }, context?: MemoryToolContext, gate?: MemoryWriteGate) {
  const userId = callerId(context);
  const { userDb, accountMemoryDb } = await import('../../services/db');
  const user = await userDb.getUserById(userId);
  if (user?.memoryEnabled === false) {
    return { success: false, message: 'Memory is disabled for this account.' };
  }
  const { content, category } = checkMemorySaveArgs(args);
  const early = await gate?.({ scope: 'user', ownerId: userId, content, category, chunkCount: splitMemoryContent(content).length });
  if (early) return early;
  const memoryIds = await writeChunks(userId, content, (chunk, embedding) =>
    accountMemoryDb.addMemory(userId, category, chunk, context?.sessionId, embedding),
  );
  const preview = previewOf(content);
  return {
    success: true,
    memoryId: memoryIds[0],
    ...(memoryIds.length > 1 ? { memoryIds } : {}),
    message: memoryIds.length > 1
      ? `Saved memory as ${memoryIds.length} parts (content exceeded 2000 characters): ${preview}`
      : `Saved memory: ${preview}`,
  };
}

export async function deleteAccountMemory(args: { memoryId?: unknown }, context?: MemoryToolContext) {
  const userId = callerId(context);
  const memoryId = checkMemoryId(args);
  const { accountMemoryDb } = await import('../../services/db');
  const deleted = await accountMemoryDb.deleteMemory(userId, memoryId);
  // `false` means the database found no such row. (A caller that returns nothing is treated as before: deleted.)
  if (deleted === false) return { success: false, message: `Memory ${memoryId} was not found; nothing was deleted.` };
  return { success: true, message: `Memory ${memoryId} deleted.` };
}

export async function saveOrgMemory(args: { content?: unknown; category?: unknown }, context?: MemoryToolContext, gate?: MemoryWriteGate) {
  const userId = callerId(context);
  const { userDb, orgDb, orgMemoryDb } = await import('../../services/db');
  const user = await userDb.getUserById(userId);
  if (!user?.orgId) {
    return { success: false, message: 'User is not a member of any organization.' };
  }
  const org = await orgDb.getOrgById(user.orgId);
  if (!org) {
    return { success: false, message: 'Organization not found.' };
  }
  if (org.orgMemoryEnabled === false) {
    return { success: false, message: 'Organization memory is disabled.' };
  }
  const { content, category } = checkMemorySaveArgs(args);
  const orgId = user.orgId;
  const early = await gate?.({ scope: 'org', ownerId: orgId, content, category, chunkCount: splitMemoryContent(content).length });
  if (early) return early;
  const memoryIds = await writeChunks(userId, content, (chunk, embedding) =>
    orgMemoryDb.addMemory(orgId, category, chunk, userId, embedding),
  );
  const preview = previewOf(content);
  return {
    success: true,
    memoryId: memoryIds[0],
    ...(memoryIds.length > 1 ? { memoryIds } : {}),
    message: memoryIds.length > 1
      ? `Saved org memory as ${memoryIds.length} parts (content exceeded 2000 characters): ${preview}`
      : `Saved org memory: ${preview}`,
  };
}

export async function deleteOrgMemory(args: { memoryId?: unknown }, context?: MemoryToolContext) {
  const userId = callerId(context);
  const { userDb, orgDb, orgMemoryDb } = await import('../../services/db');
  const user = await userDb.getUserById(userId);
  if (!user?.orgId) {
    return { success: false, message: 'User is not a member of any organization.' };
  }
  const org = await orgDb.getOrgById(user.orgId);
  if (!org) {
    return { success: false, message: 'Organization not found.' };
  }
  if (!can({ userId, orgId: user.orgId, orgRole: user.orgRole }, org, 'org:configure')) {
    return { success: false, message: 'Only org owners and admins can delete org memories.' };
  }
  const memoryId = checkMemoryId(args);
  const deleted = await orgMemoryDb.deleteMemory(user.orgId, memoryId);
  if (deleted === false) return { success: false, message: `Org memory ${memoryId} was not found; nothing was deleted.` };
  return { success: true, message: `Org memory ${memoryId} deleted.` };
}
