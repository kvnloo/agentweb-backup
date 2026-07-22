import { emmaToolRegistry } from './registry';
import {
  getUserGuideContent,
  getUserGuideBlocks,
  updateBlock,
  appendBlocks,
  deleteBlock,
  getBlock,
} from '../services/notionService';
import { buildDocumentationReference, searchDocumentation } from './documentationSite';

// Available to all users — Emma uses this to answer user guide questions
emmaToolRegistry.register({
  name: 'search_user_guide',
  definition: {
    name: 'search_user_guide',
    description: 'Search the canonical AgentWeb Mintlify documentation at docs.agentweb.pro. Use this before asking a user to complete a manual product or integration step. Pass the exact feature, blockage, or setup step as the query. Returns one bounded relevant excerpt and its canonical source link.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The exact AgentWeb feature, integration, or blocked setup step to look up.',
          maxLength: 500,
        },
      },
      required: [],
    },
  },
  execute: async (args: { query?: string }) => {
    const query = args?.query?.trim() || '';
    const docsReference = buildDocumentationReference();

    if (!query) {
      return { success: true, content: docsReference.trim(), results: [] };
    }

    try {
      const result = await searchDocumentation(query);
      return { success: true, ...result };
    } catch (mintlifyError: any) {
      // The old Notion guide remains a degraded fallback, never the canonical
      // source. This keeps help available during a docs-site outage without
      // making every healthy request depend on Notion.
      try {
        const legacyContent = await getUserGuideContent();
        const fallbackBody = legacyContent?.trim() || 'The legacy portal guide is empty.';
        return {
          success: true,
          content: [
            `Mintlify documentation search is temporarily unavailable (${mintlifyError.message}).`,
            'Legacy fallback from the portal guide:',
            fallbackBody,
            docsReference,
          ].join('\n\n'),
          results: [],
        };
      } catch (notionError: any) {
        return {
          success: true,
          content: [
            `Mintlify documentation search is temporarily unavailable (${mintlifyError.message}).`,
            `Legacy fallback is also unavailable (${notionError.message}).`,
            docsReference,
          ].join('\n\n'),
          results: [],
        };
      }
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
