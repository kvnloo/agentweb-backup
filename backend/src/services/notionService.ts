import { getSecret } from '../utils/secretsManager';

export interface NotionCredentials {
  apiToken: string;
  userGuidePageId: string;
}

let cachedCredentials: NotionCredentials | null = null;

export async function getNotionCredentials(): Promise<NotionCredentials> {
  if (cachedCredentials) return cachedCredentials;

  const environment = process.env.NODE_ENV || 'development';
  const secretName = environment === 'production'
    ? 'prod/AgentWeb/Notion'
    : 'dev/AgentWeb/Notion';

  const secretString = await getSecret(secretName);
  if (!secretString || secretString.trim() === '') {
    throw new Error('Notion credentials secret is empty');
  }

  const credentials = JSON.parse(secretString) as NotionCredentials;
  if (!credentials.apiToken || !credentials.userGuidePageId) {
    throw new Error('Notion credentials missing apiToken or userGuidePageId');
  }

  cachedCredentials = credentials;
  return cachedCredentials;
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
        rich_text: [{ type: 'text', text: { content: newText } }],
      },
    }),
  });
}

export async function appendBlocks(parentId: string, blocks: Array<{ type: string; text: string }>): Promise<any> {
  const children = blocks.map(b => {
    if (b.type === 'heading_2') {
      return {
        object: 'block',
        type: 'heading_2',
        heading_2: { rich_text: [{ type: 'text', text: { content: b.text } }] },
      };
    }
    if (b.type === 'heading_3') {
      return {
        object: 'block',
        type: 'heading_3',
        heading_3: { rich_text: [{ type: 'text', text: { content: b.text } }] },
      };
    }
    if (b.type === 'bulleted_list_item') {
      return {
        object: 'block',
        type: 'bulleted_list_item',
        bulleted_list_item: { rich_text: [{ type: 'text', text: { content: b.text } }] },
      };
    }
    // Default to paragraph
    return {
      object: 'block',
      type: 'paragraph',
      paragraph: { rich_text: [{ type: 'text', text: { content: b.text } }] },
    };
  });

  return notionFetch(`/blocks/${parentId}/children`, {
    method: 'PATCH',
    body: JSON.stringify({ children }),
  });
}

export async function deleteBlock(blockId: string): Promise<any> {
  return notionFetch(`/blocks/${blockId}`, {
    method: 'DELETE',
  });
}
