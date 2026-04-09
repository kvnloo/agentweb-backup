/**
 * Tests for notionService rich_text splitting logic.
 *
 * The Notion API has a 2,000-character limit per rich_text element.
 * These tests verify that updateBlock and appendBlocks correctly split
 * long text into multiple rich_text elements.
 */

// Mock the fetch and secrets before importing
jest.mock('../utils/secretsManager', () => ({
  getSecret: jest.fn().mockResolvedValue(JSON.stringify({
    apiToken: 'test-token',
    userGuidePageId: 'test-page-id',
  })),
}));

// Capture fetch calls
const mockFetch = jest.fn();
global.fetch = mockFetch as any;

import { updateBlock, appendBlocks } from '../services/notionService';

describe('notionService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: successful Notion API responses
    mockFetch.mockResolvedValue({
      json: () => Promise.resolve({ object: 'block', type: 'paragraph', paragraph: { rich_text: [] } }),
      status: 200,
    });
  });

  describe('updateBlock - rich_text splitting', () => {
    it('should use a single rich_text element for text under 2000 chars', async () => {
      const shortText = 'Hello world';
      // First call: GET block to determine type. Second call: PATCH to update.
      mockFetch
        .mockResolvedValueOnce({
          json: () => Promise.resolve({ object: 'block', type: 'paragraph', paragraph: { rich_text: [] } }),
          status: 200,
        })
        .mockResolvedValueOnce({
          json: () => Promise.resolve({ object: 'block', type: 'paragraph' }),
          status: 200,
        });

      await updateBlock('block-123', shortText);

      const patchCall = mockFetch.mock.calls[1];
      const body = JSON.parse(patchCall[1].body);
      expect(body.paragraph.rich_text).toHaveLength(1);
      expect(body.paragraph.rich_text[0].text.content).toBe(shortText);
    });

    it('should split text exceeding 2000 chars into multiple rich_text elements', async () => {
      const longText = 'A'.repeat(4500); // Should produce 3 elements: 2000 + 2000 + 500
      mockFetch
        .mockResolvedValueOnce({
          json: () => Promise.resolve({ object: 'block', type: 'paragraph', paragraph: { rich_text: [] } }),
          status: 200,
        })
        .mockResolvedValueOnce({
          json: () => Promise.resolve({ object: 'block', type: 'paragraph' }),
          status: 200,
        });

      await updateBlock('block-456', longText);

      const patchCall = mockFetch.mock.calls[1];
      const body = JSON.parse(patchCall[1].body);
      expect(body.paragraph.rich_text).toHaveLength(3);
      expect(body.paragraph.rich_text[0].text.content).toHaveLength(2000);
      expect(body.paragraph.rich_text[1].text.content).toHaveLength(2000);
      expect(body.paragraph.rich_text[2].text.content).toHaveLength(500);
      // Concatenated content should equal the original
      const combined = body.paragraph.rich_text.map((rt: any) => rt.text.content).join('');
      expect(combined).toBe(longText);
    });

    it('should handle text exactly 2000 chars as a single element', async () => {
      const exactText = 'B'.repeat(2000);
      mockFetch
        .mockResolvedValueOnce({
          json: () => Promise.resolve({ object: 'block', type: 'heading_2', heading_2: { rich_text: [] } }),
          status: 200,
        })
        .mockResolvedValueOnce({
          json: () => Promise.resolve({ object: 'block', type: 'heading_2' }),
          status: 200,
        });

      await updateBlock('block-789', exactText);

      const patchCall = mockFetch.mock.calls[1];
      const body = JSON.parse(patchCall[1].body);
      expect(body.heading_2.rich_text).toHaveLength(1);
      expect(body.heading_2.rich_text[0].text.content).toBe(exactText);
    });

    it('should throw for block types without rich_text', async () => {
      mockFetch.mockResolvedValueOnce({
        json: () => Promise.resolve({ object: 'block', type: 'image', image: { file: { url: 'test' } } }),
        status: 200,
      });

      await expect(updateBlock('block-img', 'some text')).rejects.toThrow(
        'Block type "image" does not support rich_text updates'
      );
    });
  });

  describe('appendBlocks - rich_text splitting', () => {
    it('should split long paragraph text into multiple rich_text elements', async () => {
      const longText = 'C'.repeat(3000); // 2000 + 1000
      mockFetch.mockResolvedValueOnce({
        json: () => Promise.resolve({ object: 'list', results: [] }),
        status: 200,
      });

      await appendBlocks('page-123', [{ type: 'paragraph', text: longText }]);

      const patchCall = mockFetch.mock.calls[0];
      const body = JSON.parse(patchCall[1].body);
      const paragraph = body.children[0].paragraph;
      expect(paragraph.rich_text).toHaveLength(2);
      expect(paragraph.rich_text[0].text.content).toHaveLength(2000);
      expect(paragraph.rich_text[1].text.content).toHaveLength(1000);
    });

    it('should split long heading text', async () => {
      const longText = 'D'.repeat(2500);
      mockFetch.mockResolvedValueOnce({
        json: () => Promise.resolve({ object: 'list', results: [] }),
        status: 200,
      });

      await appendBlocks('page-123', [{ type: 'heading_2', text: longText }]);

      const patchCall = mockFetch.mock.calls[0];
      const body = JSON.parse(patchCall[1].body);
      const heading = body.children[0].heading_2;
      expect(heading.rich_text).toHaveLength(2);
    });

    it('should split long bulleted_list_item text', async () => {
      const longText = 'E'.repeat(2100);
      mockFetch.mockResolvedValueOnce({
        json: () => Promise.resolve({ object: 'list', results: [] }),
        status: 200,
      });

      await appendBlocks('page-123', [{ type: 'bulleted_list_item', text: longText }]);

      const patchCall = mockFetch.mock.calls[0];
      const body = JSON.parse(patchCall[1].body);
      const item = body.children[0].bulleted_list_item;
      expect(item.rich_text).toHaveLength(2);
      expect(item.rich_text[0].text.content).toHaveLength(2000);
      expect(item.rich_text[1].text.content).toHaveLength(100);
    });

    it('should not split short text', async () => {
      mockFetch.mockResolvedValueOnce({
        json: () => Promise.resolve({ object: 'list', results: [] }),
        status: 200,
      });

      await appendBlocks('page-123', [
        { type: 'heading_3', text: 'Short heading' },
        { type: 'paragraph', text: 'Short paragraph' },
      ]);

      const patchCall = mockFetch.mock.calls[0];
      const body = JSON.parse(patchCall[1].body);
      expect(body.children[0].heading_3.rich_text).toHaveLength(1);
      expect(body.children[1].paragraph.rich_text).toHaveLength(1);
    });

    it('should NOT include after field when afterBlockId is omitted', async () => {
      mockFetch.mockResolvedValueOnce({
        json: () => Promise.resolve({ object: 'list', results: [] }),
        status: 200,
      });

      await appendBlocks('page-123', [{ type: 'paragraph', text: 'Hello' }]);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.after).toBeUndefined();
      expect(body.children).toHaveLength(1);
    });

    it('should include after field when afterBlockId is provided', async () => {
      mockFetch.mockResolvedValueOnce({
        json: () => Promise.resolve({ object: 'list', results: [] }),
        status: 200,
      });

      await appendBlocks('page-123', [{ type: 'paragraph', text: 'Hello' }], 'block-after-id');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.after).toBe('block-after-id');
      expect(body.children).toHaveLength(1);
    });
  });
});
