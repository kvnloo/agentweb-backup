/**
 * Tests for append_to_user_guide tool in notionGuideTools.ts
 *
 * Covers:
 * - blocks passed as a parsed array (normal case)
 * - blocks passed as a JSON string (LLM serialization quirk)
 * - insertAfterBlockId resolves parent and passes after param
 * - invalid blocks input returns a clear error
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

describe('append_to_user_guide tool', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const sampleBlocks = [{ type: 'heading_3', text: '5.2.1 Test heading' }];

  function mockAppendSuccess() {
    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ object: 'list', results: [{ id: 'new-block-id' }] }),
      status: 200,
    });
  }

  function mockGetBlockSuccess(parentPageId = 'parent-page-id') {
    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({
        id: 'target-block-id',
        type: 'divider',
        parent: { type: 'page_id', page_id: parentPageId },
      }),
      status: 200,
    });
  }

  it('appends blocks when passed as a parsed array', async () => {
    mockAppendSuccess();

    const result = await emmaToolRegistry.execute('append_to_user_guide', { blocks: sampleBlocks });

    expect(result.success).toBe(true);
    expect(result.message).toContain('1 block(s)');
    expect(result.message).toContain('at the end of the page');
  });

  it('appends blocks when passed as a JSON string (LLM serialization quirk)', async () => {
    mockAppendSuccess();

    const result = await emmaToolRegistry.execute('append_to_user_guide', {
      blocks: JSON.stringify(sampleBlocks),
    });

    expect(result.success).toBe(true);
    expect(result.message).toContain('1 block(s)');
  });

  it('returns error when blocks is neither array nor valid JSON string', async () => {
    const result = await emmaToolRegistry.execute('append_to_user_guide', {
      blocks: 42,
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('blocks must be an array');
  });

  it('uses insertAfterBlockId to resolve parent and pass after param', async () => {
    mockGetBlockSuccess('resolved-parent-id');
    mockAppendSuccess();

    const result = await emmaToolRegistry.execute('append_to_user_guide', {
      blocks: sampleBlocks,
      insertAfterBlockId: 'target-block-id',
    });

    expect(result.success).toBe(true);
    expect(result.message).toContain('after block target-block-id');

    // Second fetch call is the PATCH to append blocks
    const patchCall = mockFetch.mock.calls[1];
    expect(patchCall[0]).toContain('/blocks/resolved-parent-id/children');
    const body = JSON.parse(patchCall[1].body);
    expect(body.after).toBe('target-block-id');
  });
});
