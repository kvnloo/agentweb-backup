import { emmaToolRegistry } from './registry';
import {
  getUserGuideContent,
  getUserGuideBlocks,
  updateBlock,
  appendBlocks,
  deleteBlock,
} from '../services/notionService';

// Available to all users — Emma uses this to answer user guide questions
emmaToolRegistry.register({
  name: 'search_user_guide',
  definition: {
    name: 'search_user_guide',
    description: 'Fetch the full user guide content from the Notion page. Use this tool when users ask about how to use the portal, need help with features, or have questions about functionality. Returns the complete user guide text.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  execute: async () => {
    try {
      const content = await getUserGuideContent();
      if (!content || content.trim().length === 0) {
        return { success: false, message: 'User guide page is empty or inaccessible.' };
      }
      return { success: true, content };
    } catch (error: any) {
      return { success: false, message: `Failed to fetch user guide: ${error.message}` };
    }
  },
});

// Admin-only tools below

emmaToolRegistry.register({
  name: 'read_user_guide_structure',
  definition: {
    name: 'read_user_guide_structure',
    description: 'Read the user guide page structure as a block tree with IDs, types, and text content. Use this to understand the page layout before making updates. Returns block IDs needed for update/delete operations.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  execute: async () => {
    try {
      const blocks = await getUserGuideBlocks();
      return { success: true, blocks };
    } catch (error: any) {
      return { success: false, message: `Failed to read user guide structure: ${error.message}` };
    }
  },
});

emmaToolRegistry.register({
  name: 'update_user_guide_block',
  definition: {
    name: 'update_user_guide_block',
    description: 'Update the text content of a specific block in the user guide. Requires the block ID (obtain from read_user_guide_structure) and the new text content.',
    inputSchema: {
      type: 'object',
      properties: {
        blockId: {
          type: 'string',
          description: 'The Notion block ID to update.',
        },
        newText: {
          type: 'string',
          description: 'The new text content for the block.',
        },
      },
      required: ['blockId', 'newText'],
    },
  },
  execute: async (args: any) => {
    try {
      await updateBlock(args.blockId, args.newText);
      return { success: true, message: `Block ${args.blockId} updated successfully.` };
    } catch (error: any) {
      return { success: false, message: `Failed to update block: ${error.message}` };
    }
  },
});

emmaToolRegistry.register({
  name: 'append_to_user_guide',
  definition: {
    name: 'append_to_user_guide',
    description: 'Append new blocks to the user guide page or to a specific parent block. Use this to add new sections, paragraphs, or list items. Each block needs a type (heading_2, heading_3, paragraph, bulleted_list_item) and text.',
    inputSchema: {
      type: 'object',
      properties: {
        parentBlockId: {
          type: 'string',
          description: 'Optional parent block ID to append under. If omitted, appends to the end of the page.',
        },
        blocks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                enum: ['heading_2', 'heading_3', 'paragraph', 'bulleted_list_item'],
                description: 'The block type.',
              },
              text: {
                type: 'string',
                description: 'The text content.',
              },
            },
            required: ['type', 'text'],
          },
          description: 'Array of blocks to append.',
        },
      },
      required: ['blocks'],
    },
  },
  execute: async (args: any, context: any) => {
    try {
      const { getNotionCredentials } = await import('../services/notionService');
      const { userGuidePageId } = await getNotionCredentials();
      const parentId = args.parentBlockId || userGuidePageId;
      const result = await appendBlocks(parentId, args.blocks);
      return { success: true, message: `Appended ${args.blocks.length} block(s) successfully.`, result };
    } catch (error: any) {
      return { success: false, message: `Failed to append blocks: ${error.message}` };
    }
  },
});

emmaToolRegistry.register({
  name: 'delete_user_guide_block',
  definition: {
    name: 'delete_user_guide_block',
    description: 'Delete a specific block from the user guide. Requires the block ID (obtain from read_user_guide_structure). Use with caution — this permanently removes the block and its children.',
    inputSchema: {
      type: 'object',
      properties: {
        blockId: {
          type: 'string',
          description: 'The Notion block ID to delete.',
        },
      },
      required: ['blockId'],
    },
  },
  execute: async (args: any) => {
    try {
      await deleteBlock(args.blockId);
      return { success: true, message: `Block ${args.blockId} deleted successfully.` };
    } catch (error: any) {
      return { success: false, message: `Failed to delete block: ${error.message}` };
    }
  },
});
