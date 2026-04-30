import { getSecret } from '../utils/secretsManager';

export interface NotionCredentials {
  apiToken: string;
  userGuidePageId: string;
  sprintTasksDatabaseId?: string;
}

// Data source ID for "Sprint Tasks - Argusoft" (used with API v2025-09-03)
const DEFAULT_SPRINT_TASKS_DB_ID = '2bf09247-c951-812a-bd0a-000bd4c05bbf';

export async function getSprintTasksDatabaseId(): Promise<string> {
  const creds = await getNotionCredentials();
  return creds.sprintTasksDatabaseId || DEFAULT_SPRINT_TASKS_DB_ID;
}

const credentialsCache: Record<string, NotionCredentials> = {};

export async function getNotionCredentials(): Promise<NotionCredentials> {
  const environment = process.env.NODE_ENV || 'development';
  return getNotionCredentialsForEnv(environment === 'production' ? 'production' : 'development');
}

export async function getNotionCredentialsForEnv(env: 'development' | 'production'): Promise<NotionCredentials> {
  if (credentialsCache[env]) return credentialsCache[env];

  const secretName = env === 'production'
    ? 'prod/AgentWeb/Notion'
    : 'dev/AgentWeb/Notion';

  const secretString = await getSecret(secretName);
  if (!secretString || secretString.trim() === '') {
    throw new Error(`Notion credentials secret is empty for ${env}`);
  }

  const credentials = JSON.parse(secretString) as NotionCredentials;
  if (!credentials.apiToken || !credentials.userGuidePageId) {
    throw new Error(`Notion credentials missing apiToken or userGuidePageId for ${env}`);
  }

  credentialsCache[env] = credentials;
  return credentials;
}

const NOTION_API_BASE = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';
const NOTION_MAX_RICH_TEXT_LENGTH = 2000;

/** Split text into multiple rich_text elements, each within Notion's 2000-char limit */
function toRichTextArray(text: string): Array<{ type: 'text'; text: { content: string } }> {
  if (text.length <= NOTION_MAX_RICH_TEXT_LENGTH) {
    return [{ type: 'text', text: { content: text } }];
  }
  const elements: Array<{ type: 'text'; text: { content: string } }> = [];
  for (let i = 0; i < text.length; i += NOTION_MAX_RICH_TEXT_LENGTH) {
    elements.push({ type: 'text', text: { content: text.slice(i, i + NOTION_MAX_RICH_TEXT_LENGTH) } });
  }
  return elements;
}

async function notionFetch(path: string, options: RequestInit = {}): Promise<any> {
  const { apiToken } = await getNotionCredentials();
  const res = await fetch(`${NOTION_API_BASE}${path}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${apiToken}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  const data = await res.json();
  if (data.object === 'error') {
    throw new Error(`Notion API error: ${data.message}`);
  }
  return data;
}

interface NotionBlock {
  id: string;
  type: string;
  text: string;
  children?: NotionBlock[];
}

function extractText(richTextArray: any[]): string {
  if (!Array.isArray(richTextArray)) return '';
  return richTextArray.map((rt: any) => rt.plain_text || '').join('');
}

function blockToText(block: any): string {
  const type = block.type;
  const data = block[type];
  if (!data) return '';

  if (data.rich_text) {
    return extractText(data.rich_text);
  }
  if (type === 'table_row' && Array.isArray(data.cells)) {
    return data.cells.map((cell: any[]) => extractText(cell)).join(' | ');
  }
  return '';
}

export async function getPageBlocks(pageId: string): Promise<NotionBlock[]> {
  const blocks: NotionBlock[] = [];
  let cursor: string | undefined;

  do {
    const params = cursor ? `?start_cursor=${cursor}&page_size=100` : '?page_size=100';
    const data = await notionFetch(`/blocks/${pageId}/children${params}`);

    for (const block of data.results) {
      const parsed: NotionBlock = {
        id: block.id,
        type: block.type,
        text: blockToText(block),
      };

      // Recursively fetch children if has_children is true
      if (block.has_children) {
        parsed.children = await getPageBlocks(block.id);
      }

      blocks.push(parsed);
    }

    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);

  return blocks;
}

function blocksToPlainText(blocks: NotionBlock[], indent: number = 0): string {
  const lines: string[] = [];
  const prefix = '  '.repeat(indent);

  for (const block of blocks) {
    if (block.text) {
      const isHeading = block.type.startsWith('heading_');
      if (isHeading) {
        lines.push(''); // blank line before headings
      }
      lines.push(`${prefix}${block.text}`);
    }
    if (block.children && block.children.length > 0) {
      lines.push(blocksToPlainText(block.children, indent + 1));
    }
  }

  return lines.join('\n');
}

export async function getUserGuideContent(): Promise<string> {
  const { userGuidePageId } = await getNotionCredentials();
  const blocks = await getPageBlocks(userGuidePageId);
  return blocksToPlainText(blocks);
}

export async function getUserGuideBlocks(): Promise<NotionBlock[]> {
  const { userGuidePageId } = await getNotionCredentials();
  return getPageBlocks(userGuidePageId);
}

export async function updateBlock(blockId: string, newText: string): Promise<any> {
  // First get the block to know its type
  const block = await notionFetch(`/blocks/${blockId}`);
  const type = block.type;

  if (!block[type]?.rich_text) {
    throw new Error(`Block type "${type}" does not support rich_text updates`);
  }

  return notionFetch(`/blocks/${blockId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      [type]: {
        rich_text: toRichTextArray(newText),
      },
    }),
  });
}

export async function appendBlocks(parentId: string, blocks: Array<{ type: string; text: string }>, afterBlockId?: string): Promise<any> {
  const children = blocks.map(b => {
    const richText = toRichTextArray(b.text);
    if (b.type === 'heading_2') {
      return {
        object: 'block',
        type: 'heading_2',
        heading_2: { rich_text: richText },
      };
    }
    if (b.type === 'heading_3') {
      return {
        object: 'block',
        type: 'heading_3',
        heading_3: { rich_text: richText },
      };
    }
    if (b.type === 'bulleted_list_item') {
      return {
        object: 'block',
        type: 'bulleted_list_item',
        bulleted_list_item: { rich_text: richText },
      };
    }
    // Default to paragraph
    return {
      object: 'block',
      type: 'paragraph',
      paragraph: { rich_text: richText },
    };
  });

  const body: Record<string, unknown> = { children };
  if (afterBlockId) {
    body.after = afterBlockId;
  }

  return notionFetch(`/blocks/${parentId}/children`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export async function getBlock(blockId: string): Promise<any> {
  return notionFetch(`/blocks/${blockId}`);
}

export async function deleteBlock(blockId: string): Promise<any> {
  return notionFetch(`/blocks/${blockId}`, {
    method: 'DELETE',
  });
}

// --- Oncall item creation ---

export interface CreateOncallItemParams {
  title: string;
  description: string;
  additionalTags?: string[];
  context?: Record<string, any>;
}

export interface CreateOncallItemResult {
  pageId: string;
  notionUrl: string;
}

export async function createOncallItem(params: CreateOncallItemParams): Promise<CreateOncallItemResult> {
  if (process.env.NODE_ENV !== 'production') {
    console.log(`[DEV] Suppressed Notion oncall item: ${params.title}`);
    return { pageId: '', notionUrl: '' };
  }
  const { apiToken } = await getNotionCredentials();
  const databaseId = await getSprintTasksDatabaseId();
  const { title, description, additionalTags = [], context } = params;

  const tags = [{ name: 'Oncall' }, ...additionalTags.map(t => ({ name: t }))];

  const children: any[] = [
    {
      object: 'block',
      type: 'paragraph',
      paragraph: { rich_text: [{ type: 'text', text: { content: description } }] },
    },
  ];

  if (context && Object.keys(context).length > 0) {
    children.push({
      object: 'block',
      type: 'heading_3',
      heading_3: { rich_text: [{ type: 'text', text: { content: 'Context' } }] },
    });
    for (const [key, value] of Object.entries(context)) {
      const displayValue = typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
      const truncated = displayValue.length > 500 ? displayValue.slice(0, 500) + '...' : displayValue;
      children.push({
        object: 'block',
        type: 'bulleted_list_item',
        bulleted_list_item: { rich_text: [{ type: 'text', text: { content: `${key}: ${truncated}` } }] },
      });
    }
  }

  // Use API version 2025-09-03 with data_source_id parent for Notion Projects compatibility
  const res = await fetch(`${NOTION_API_BASE}/pages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiToken}`,
      'Notion-Version': '2025-09-03',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      parent: { type: 'data_source_id', data_source_id: databaseId },
      properties: {
        'Name': { title: [{ text: { content: title } }] },
        'Status': { status: { name: 'To-do' } },
        'Tags': { multi_select: tags },
        'Sprint': { rich_text: [{ type: 'text', text: { content: 'Backlog' } }] },
        'Move to Current Sprint': { checkbox: true },
        'Owner': { people: [{ id: '1c8d872b-594c-816c-8935-00027d2a3a90' }] },
      },
      children,
    }),
  });
  const data = await res.json();
  if (data.object === 'error') {
    throw new Error(`Notion API error: ${data.message}`);
  }

  const pageId: string = data.id;
  const notionUrl = `https://notion.so/${pageId.replace(/-/g, '')}`;

  return { pageId, notionUrl };
}

// --- Sync infrastructure ---

async function notionFetchWithCreds(creds: NotionCredentials, path: string, options: RequestInit = {}): Promise<any> {
  const MAX_RETRIES = 3;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(`${NOTION_API_BASE}${path}`, {
      ...options,
      headers: {
        'Authorization': `Bearer ${creds.apiToken}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get('retry-after') || '1', 10);
      console.log(`[Notion] Rate limited, retrying after ${retryAfter}s (attempt ${attempt + 1}/${MAX_RETRIES})`);
      await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
      continue;
    }

    const data = await res.json();
    if (data.object === 'error') {
      throw new Error(`Notion API error: ${data.message}`);
    }
    return data;
  }
  throw new Error('Notion API: max retries exceeded due to rate limiting');
}

/** Fetch raw Notion block objects recursively */
async function getRawBlocks(creds: NotionCredentials, parentId: string): Promise<any[]> {
  const blocks: any[] = [];
  let cursor: string | undefined;

  do {
    const params = cursor ? `?start_cursor=${cursor}&page_size=100` : '?page_size=100';
    const data = await notionFetchWithCreds(creds, `/blocks/${parentId}/children${params}`);

    for (const block of data.results) {
      if (block.has_children) {
        block._children = await getRawBlocks(creds, block.id);
      }
      blocks.push(block);
    }

    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);

  return blocks;
}

/** Strip read-only fields from a raw Notion block and prepare it for creation */
function transformBlockForCreation(block: any): any {
  const type = block.type;
  const typeData = block[type];

  if (!typeData) return null;

  // Unsupported block types for the API append endpoint
  const unsupportedTypes = ['child_page', 'child_database', 'link_to_page', 'unsupported'];
  if (unsupportedTypes.includes(type)) return null;

  const cleanedTypeData = { ...typeData };

  // Remove read-only fields
  delete cleanedTypeData.id;

  // Remove null values (Notion API rejects null for optional object fields like icon)
  for (const key of Object.keys(cleanedTypeData)) {
    if (cleanedTypeData[key] === null) {
      delete cleanedTypeData[key];
    }
  }

  const created: any = {
    object: 'block',
    type,
    [type]: cleanedTypeData,
  };

  // Add children if present (recursively transformed)
  if (block._children && block._children.length > 0) {
    created[type].children = block._children
      .map(transformBlockForCreation)
      .filter(Boolean);
  }

  return created;
}

/** Delete all top-level blocks from a Notion page */
async function deleteAllPageBlocks(creds: NotionCredentials, pageId: string): Promise<void> {
  // Collect only top-level block IDs (children deleted automatically with parent)
  const blockIds: string[] = [];
  let cursor: string | undefined;

  do {
    const params = cursor ? `?start_cursor=${cursor}&page_size=100` : '?page_size=100';
    const data = await notionFetchWithCreds(creds, `/blocks/${pageId}/children${params}`);
    for (const block of data.results) {
      blockIds.push(block.id);
    }
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);

  console.log(`[UserGuideSync] Deleting ${blockIds.length} top-level blocks...`);

  // Delete in parallel batches of 3 (Notion rate limit is ~3 req/s)
  const BATCH = 3;
  for (let i = 0; i < blockIds.length; i += BATCH) {
    const batch = blockIds.slice(i, i + BATCH);
    await Promise.all(
      batch.map(id => notionFetchWithCreds(creds, `/blocks/${id}`, { method: 'DELETE' }))
    );
    // Small delay between batches to stay under rate limit
    if (i + BATCH < blockIds.length) {
      await new Promise(resolve => setTimeout(resolve, 350));
    }
  }
}

/** Append blocks to a page in batches (Notion API limit: 100 blocks per request) */
async function appendBlocksToPage(creds: NotionCredentials, pageId: string, blocks: any[]): Promise<void> {
  const BATCH_SIZE = 100;
  for (let i = 0; i < blocks.length; i += BATCH_SIZE) {
    const batch = blocks.slice(i, i + BATCH_SIZE);
    await notionFetchWithCreds(creds, `/blocks/${pageId}/children`, {
      method: 'PATCH',
      body: JSON.stringify({ children: batch }),
    });
  }
}

/** Get plain text content of a Notion page using specific credentials */
async function getPagePlainText(creds: NotionCredentials, pageId: string): Promise<string> {
  const rawBlocks = await getRawBlocks(creds, pageId);

  function rawBlocksToText(blocks: any[], indent: number = 0): string {
    const lines: string[] = [];
    const prefix = '  '.repeat(indent);
    for (const block of blocks) {
      const text = blockToText(block);
      if (text) {
        lines.push(`${prefix}${text}`);
      }
      if (block._children && block._children.length > 0) {
        lines.push(rawBlocksToText(block._children, indent + 1));
      }
    }
    return lines.join('\n');
  }

  return rawBlocksToText(rawBlocks);
}

export interface ContentDiff {
  type: 'added' | 'removed' | 'unchanged';
  text: string;
}

/** Compute a simple line-level diff between two texts */
function computeLineDiff(source: string, target: string): ContentDiff[] {
  const sourceLines = source.trim().split('\n');
  const targetLines = target.trim().split('\n');
  const sourceSet = new Set(sourceLines);
  const targetSet = new Set(targetLines);

  const diffs: ContentDiff[] = [];

  // Lines in target but not in source (will be removed by sync)
  for (const line of targetLines) {
    if (!sourceSet.has(line) && line.trim()) {
      diffs.push({ type: 'removed', text: line });
    }
  }

  // Lines in source but not in target (will be added by sync)
  for (const line of sourceLines) {
    if (!targetSet.has(line) && line.trim()) {
      diffs.push({ type: 'added', text: line });
    }
  }

  return diffs;
}

export interface UserGuideSyncStatus {
  inSync: boolean;
  devContentLength: number;
  prodContentLength: number;
  environment: string;
  diff: ContentDiff[];
}

/** Compare user guide content between dev and prod Notion pages */
export async function getUserGuideSyncStatus(): Promise<UserGuideSyncStatus> {
  const environment = process.env.NODE_ENV === 'production' ? 'production' : 'development';
  const [devCreds, prodCreds] = await Promise.all([
    getNotionCredentialsForEnv('development'),
    getNotionCredentialsForEnv('production'),
  ]);

  const [devContent, prodContent] = await Promise.all([
    getPagePlainText(devCreds, devCreds.userGuidePageId),
    getPagePlainText(prodCreds, prodCreds.userGuidePageId),
  ]);

  const inSync = devContent.trim() === prodContent.trim();

  // Compute diff: what would change in target if we sync from source
  // In dev env, source=dev target=prod; in prod env, source=prod target=dev
  const sourceContent = environment === 'development' ? devContent : prodContent;
  const targetContent = environment === 'development' ? prodContent : devContent;
  const diff = inSync ? [] : computeLineDiff(sourceContent, targetContent);

  return {
    inSync,
    devContentLength: devContent.length,
    prodContentLength: prodContent.length,
    environment,
    diff,
  };
}

/** Sync the entire user guide between dev and prod Notion pages */
export async function syncUserGuide(direction: 'dev-to-prod' | 'prod-to-dev'): Promise<{ success: boolean; blocksTransferred: number }> {
  console.log(`[UserGuideSync] Starting sync: ${direction}`);
  const sourceCreds = await getNotionCredentialsForEnv(direction === 'dev-to-prod' ? 'development' : 'production');
  const targetCreds = await getNotionCredentialsForEnv(direction === 'dev-to-prod' ? 'production' : 'development');

  // Read all blocks from source
  console.log('[UserGuideSync] Reading source blocks...');
  const rawBlocks = await getRawBlocks(sourceCreds, sourceCreds.userGuidePageId);
  const transformedBlocks = rawBlocks.map(transformBlockForCreation).filter(Boolean);
  console.log(`[UserGuideSync] Read ${transformedBlocks.length} blocks from source`);

  // Clear target page
  console.log('[UserGuideSync] Clearing target page...');
  await deleteAllPageBlocks(targetCreds, targetCreds.userGuidePageId);
  console.log('[UserGuideSync] Target page cleared');

  // Write transformed blocks to target
  console.log('[UserGuideSync] Writing blocks to target...');
  await appendBlocksToPage(targetCreds, targetCreds.userGuidePageId, transformedBlocks);
  console.log(`[UserGuideSync] Sync complete: ${transformedBlocks.length} blocks transferred`);

  return { success: true, blocksTransferred: transformedBlocks.length };
}
