import { emmaToolRegistry } from './registry';
import {
  getUserGuideContent,
  getUserGuideBlocks,
  updateBlock,
  appendBlocks,
  deleteBlock,
  getBlock,
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
    description: `Append new blocks to the user guide page. Each block needs a type (heading_2, heading_3, paragraph, bulleted_list_item) and text.

To insert blocks at a specific location in the page (not just the end), use insertAfterBlockId:
- insertAfterBlockId: the ID of an existing block — new blocks will be inserted immediately after it as siblings.
  Example: to insert after the CRM section divider, pass the divider's block ID here.

Do NOT use parentBlockId to point at a heading or paragraph block — those don't support children and will fail.
If neither parameter is provided, blocks are appended to the very end of the page.`,
    inputSchema: {
      type: 'object',
      properties: {
        insertAfterBlockId: {
          type: 'string',
          description: 'Insert new blocks immediately after this existing block (as siblings). Use this to place content mid-page rather than at the end. Obtain the block ID from read_user_guide_structure.',
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

      let parentId = userGuidePageId;
      let afterBlockId: string | undefined;

      if (args.insertAfterBlockId) {
        // Fetch the target block to determine its parent
        const targetBlock = await getBlock(args.insertAfterBlockId);
        const parent = targetBlock?.parent;
        if (!parent) {
          return { success: false, message: `Could not determine parent of block ${args.insertAfterBlockId}` };
        }
        parentId = parent.page_id || parent.block_id || userGuidePageId;
        afterBlockId = args.insertAfterBlockId;
      }

      const blocks = typeof args.blocks === 'string' ? JSON.parse(args.blocks) : args.blocks;
      if (!Array.isArray(blocks)) {
        return { success: false, message: 'blocks must be an array of {type, text} objects' };
      }

      const result = await appendBlocks(parentId, blocks, afterBlockId);
      const location = afterBlockId
        ? `after block ${afterBlockId}`
        : 'at the end of the page';
      return { success: true, message: `Appended ${blocks.length} block(s) successfully (${location}).`, result };
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
