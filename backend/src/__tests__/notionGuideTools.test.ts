/**
 * Tests for manage_user_guide tool in notionGuideTools.ts
 *
 * Covers:
 * - read_structure action
 * - update action: requires block_id and new_text
 * - append action: blocks as array, blocks as JSON string, insert_after_block_id, invalid blocks
 * - delete action: requires block_id
 * - unknown action returns error
 */

jest.mock('../utils/secretsManager', () => ({
  getSecret: jest.fn().mockResolvedValue(JSON.stringify({
    apiToken: 'test-token',
    userGuidePageId: 'test-page-id',
  })),
}));

const mockFetch = jest.fn();
global.fetch = mockFetch as any;

// Load the tool registry (registers all emma tools as a side effect)
import '../emma/notionGuideTools';
import { emmaToolRegistry } from '../emma/registry';

const TOOL = 'manage_user_guide';

describe('manage_user_guide tool', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const sampleBlocks = [{ type: 'heading_3', text: '5.2.1 Test heading' }];

  function mockFetchSuccess(body: any) {
    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve(body),
      status: 200,
    });
  }

  // ── read_structure ──────────────────────────────────────────────────────────

  describe('read_structure', () => {
    it('returns block tree from Notion', async () => {
      mockFetchSuccess({ object: 'list', results: [{ id: 'b1', type: 'paragraph' }], has_more: false });

      const result = await emmaToolRegistry.execute(TOOL, { action: 'read_structure' });

      expect(result.success).toBe(true);
      expect(Array.isArray(result.blocks)).toBe(true);
    });
  });

  // ── update ──────────────────────────────────────────────────────────────────

  describe('update', () => {
    it('returns error when block_id is missing', async () => {
      const result = await emmaToolRegistry.execute(TOOL, { action: 'update', new_text: 'hello' });
      expect(result.success).toBe(false);
      expect(result.message).toContain('block_id is required');
    });

    it('returns error when new_text is missing', async () => {
      const result = await emmaToolRegistry.execute(TOOL, { action: 'update', block_id: 'b1' });
      expect(result.success).toBe(false);
      expect(result.message).toContain('new_text is required');
    });

    it('updates block successfully', async () => {
      // GET block to determine type, then PATCH
      mockFetchSuccess({ object: 'block', type: 'paragraph', paragraph: { rich_text: [] } });
      mockFetchSuccess({ object: 'block', type: 'paragraph' });

      const result = await emmaToolRegistry.execute(TOOL, { action: 'update', block_id: 'b1', new_text: 'New content' });
      expect(result.success).toBe(true);
      expect(result.message).toContain('b1');
    });
  });

  // ── append ──────────────────────────────────────────────────────────────────

  describe('append', () => {
    it('appends blocks when passed as a parsed array', async () => {
      mockFetchSuccess({ object: 'list', results: [{ id: 'new-block' }] });

      const result = await emmaToolRegistry.execute(TOOL, { action: 'append', blocks: sampleBlocks });

      expect(result.success).toBe(true);
      expect(result.message).toContain('1 block(s)');
      expect(result.message).toContain('at the end of the page');
    });

    it('appends blocks when passed as a JSON string (LLM serialization quirk)', async () => {
      mockFetchSuccess({ object: 'list', results: [{ id: 'new-block' }] });

      const result = await emmaToolRegistry.execute(TOOL, { action: 'append', blocks: JSON.stringify(sampleBlocks) });

      expect(result.success).toBe(true);
      expect(result.message).toContain('1 block(s)');
    });

    it('returns error when blocks is invalid', async () => {
      const result = await emmaToolRegistry.execute(TOOL, { action: 'append', blocks: 42 });
      expect(result.success).toBe(false);
      expect(result.message).toContain('blocks must be an array');
    });

    it('uses insert_after_block_id to resolve parent and pass after param', async () => {
      // GET target block to find parent
      mockFetchSuccess({ id: 'target-block', type: 'divider', parent: { type: 'page_id', page_id: 'parent-page-id' } });
      // PATCH append blocks
      mockFetchSuccess({ object: 'list', results: [{ id: 'new-block' }] });

      const result = await emmaToolRegistry.execute(TOOL, {
        action: 'append',
        blocks: sampleBlocks,
        insert_after_block_id: 'target-block',
      });

      expect(result.success).toBe(true);
      expect(result.message).toContain('after block target-block');

      const patchCall = mockFetch.mock.calls[1];
      expect(patchCall[0]).toContain('/blocks/parent-page-id/children');
      const body = JSON.parse(patchCall[1].body);
      expect(body.after).toBe('target-block');
    });
  });

  // ── delete ──────────────────────────────────────────────────────────────────

  describe('delete', () => {
    it('returns error when block_id is missing', async () => {
      const result = await emmaToolRegistry.execute(TOOL, { action: 'delete' });
      expect(result.success).toBe(false);
      expect(result.message).toContain('block_id is required');
    });

    it('deletes block successfully', async () => {
      mockFetchSuccess({ object: 'block', archived: true });

      const result = await emmaToolRegistry.execute(TOOL, { action: 'delete', block_id: 'b1' });
      expect(result.success).toBe(true);
      expect(result.message).toContain('b1');
    });
  });

  // ── unknown action ──────────────────────────────────────────────────────────

  it('returns error for unknown action', async () => {
    const result = await emmaToolRegistry.execute(TOOL, { action: 'fly' });
    expect(result.success).toBe(false);
    expect(result.message).toContain('Unknown action');
  });
});
