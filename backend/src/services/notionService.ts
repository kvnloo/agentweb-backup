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
  const RUI_USER_ID = '1c8d872b-594c-816c-8935-00027d2a3a90';
  const HARSHA_USER_ID = '1c8d872b-594c-8168-8c1b-00022b54e40d';
  const ownerId = /^onboarding/i.test(title) ? HARSHA_USER_ID : RUI_USER_ID;

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
        'Owner': { people: [{ id: ownerId }] },
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

