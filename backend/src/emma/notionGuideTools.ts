import { emmaToolRegistry } from './registry';
import {
  getUserGuideContent,
  getUserGuideBlocks,
  updateBlock,
  appendBlocks,
  deleteBlock,
  getBlock,
} from '../services/notionService';
import { buildDocumentationReference } from './documentationSite';

// Available to all users — Emma uses this to answer user guide questions
emmaToolRegistry.register({
  name: 'search_user_guide',
  definition: {
    name: 'search_user_guide',
    description: 'Fetch the full user guide content plus the canonical documentation site reference (docs.agentweb.pro). Use this tool when users ask about how to use the portal, need help with features, or ask how to set up/use an integration (e.g. HubSpot). Returns the user guide text and the documentation deep links (e.g. https://docs.agentweb.pro/integrations/hubspot).',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  execute: async () => {
    // The documentation site is a knowledge source Emma always consults so it
    // can return correct integration deep links even when the Notion portal
    // guide has no dedicated walkthrough for the integration in question. Build
    // it up front so the static reference still surfaces if Notion fails.
    const docsReference = buildDocumentationReference();
    try {
      const content = await getUserGuideContent();
      if (!content || content.trim().length === 0) {
        return { success: true, content: docsReference.trim() };
      }
      return { success: true, content: `${content}\n${docsReference}` };
    } catch (error: any) {
      // Notion is an unrelated dependency; if it fails, still return the
      // canonical docs reference so integration deep links remain available.
      return {
        success: true,
        content: `The portal user guide was temporarily unavailable (${error.message}).\n${docsReference}`.trim(),
      };
    }
  },
});

// Admin-only: unified CRUD tool for user guide structure
emmaToolRegistry.register({
  name: 'manage_user_guide',
  definition: {
    name: 'manage_user_guide',
    description: `Read, edit, append, or delete blocks in the user guide Notion page. Admin-only.

Actions:
- **read_structure** — returns the full block tree with IDs, types, and text. Use before update/append/delete to get the block IDs you need.
- **update** — replace the text of an existing block. Requires block_id and new_text.
- **append** — add new blocks to the page. Requires blocks array. Use insert_after_block_id to place them at a specific position (after that block, as siblings) rather than at the end of the page.
- **delete** — permanently remove a block and its children. Requires block_id.

Typical workflow: read_structure → find target block ID → update / append / delete.`,
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['read_structure', 'update', 'append', 'delete'],
          description: 'Operation to perform.',
        },
        block_id: {
          type: 'string',
          description: 'Notion block ID. Required for update and delete. Obtain from read_structure.',
        },
        new_text: {
          type: 'string',
          description: 'Replacement text for the block. Required for update.',
        },
        blocks: {
          type: 'array',
          description: 'Blocks to append. Required for append.',
          items: {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                enum: ['heading_2', 'heading_3', 'paragraph', 'bulleted_list_item'],
              },
              text: { type: 'string' },
            },
            required: ['type', 'text'],
          },
        },
        insert_after_block_id: {
          type: 'string',
          description: 'For append only: insert new blocks immediately after this existing block (as siblings), rather than at the end of the page. Obtain the ID from read_structure.',
        },
      },
      required: ['action'],
    },
  },
  execute: async (args: any) => {
    try {
      switch (args.action) {
        case 'read_structure': {
          const blocks = await getUserGuideBlocks();
          return { success: true, blocks };
        }

        case 'update': {
          if (!args.block_id) return { success: false, message: 'block_id is required for update' };
          if (!args.new_text) return { success: false, message: 'new_text is required for update' };
          await updateBlock(args.block_id, args.new_text);
          return { success: true, message: `Block ${args.block_id} updated successfully.` };
        }

        case 'append': {
          const blocks = typeof args.blocks === 'string' ? JSON.parse(args.blocks) : args.blocks;
          if (!Array.isArray(blocks)) {
            return { success: false, message: 'blocks must be an array of {type, text} objects' };
          }

          const { getNotionCredentials } = await import('../services/notionService');
          const { userGuidePageId } = await getNotionCredentials();

          let parentId = userGuidePageId;
          let afterBlockId: string | undefined;

          if (args.insert_after_block_id) {
            const targetBlock = await getBlock(args.insert_after_block_id);
            const parent = targetBlock?.parent;
            if (!parent) {
              return { success: false, message: `Could not determine parent of block ${args.insert_after_block_id}` };
            }
            parentId = parent.page_id || parent.block_id || userGuidePageId;
            afterBlockId = args.insert_after_block_id;
          }

          const result = await appendBlocks(parentId, blocks, afterBlockId);
          const location = afterBlockId ? `after block ${afterBlockId}` : 'at the end of the page';
          return { success: true, message: `Appended ${blocks.length} block(s) successfully (${location}).`, result };
        }

        case 'delete': {
          if (!args.block_id) return { success: false, message: 'block_id is required for delete' };
          await deleteBlock(args.block_id);
          return { success: true, message: `Block ${args.block_id} deleted successfully.` };
        }

        default:
          return { success: false, message: `Unknown action: ${args.action}. Valid actions: read_structure, update, append, delete.` };
      }
    } catch (error: any) {
      return { success: false, message: `manage_user_guide failed: ${error.message}` };
    }
  },
});
