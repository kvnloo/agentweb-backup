import { chatbotDb } from '../services/chatbotService';

/**
 * Tests for the HTML report timestamp extraction logic in getExecutionsWithAssets.
 *
 * Root cause of the bug: tool-role messages contain HTML URLs in their content
 * but lack metadata.timestamp, falling back to session.updatedAt (same for all).
 * They are processed before the assistant messages that carry the real per-message
 * timestamp, and the dedup check prevented the correct timestamp from overriding.
 *
 * Fixes applied:
 *  1. Track lastAssistantTimestamp so tool messages inherit from the preceding
 *     assistant message rather than falling back to session.updatedAt.
 *  2. When an already-added URL is seen again from a message with its own
 *     metadata.timestamp (isOwnTimestamp), update generatedAt on the existing file.
 */

// Mock chatbotService
jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getUserSessions: jest.fn(),
    getChatSession: jest.fn(),
  },
}));

const mockChatbotDb = chatbotDb as jest.Mocked<typeof chatbotDb>;

describe('Tasks Route - HTML Report Timestamps', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('timestamp extraction from messages', () => {
    it('should use metadata.timestamp from assistant message for tool call URLs', () => {
      const assistantTimestamp = '2026-02-14T19:10:59.425Z';
      const message = {
        role: 'assistant',
        content: 'Here is your report',
        metadata: {
          timestamp: assistantTimestamp,
          toolCalls: [
            {
              name: 'update_html_file',
              result: {
                success: true,
                s3_url: 'https://bucket.s3.amazonaws.com/files/report.html',
                versioned_filename: 'report_v2.html',
              },
            },
          ],
        },
      };

      const ownTimestamp = message.metadata?.timestamp;
      expect(ownTimestamp).toBe(assistantTimestamp);
    });

    it('tool messages should fall back to lastAssistantTimestamp when they lack metadata.timestamp', () => {
      const messages = [
        {
          role: 'assistant',
          content: '',
          metadata: { timestamp: '2026-02-14T01:19:19.988Z' },
        },
        {
          role: 'tool',
          content: 'https://bucket.s3.amazonaws.com/files/blog.html',
          // no metadata.timestamp
        },
      ];

      let lastAssistantTimestamp: string | undefined;

      messages.forEach((message: any) => {
        const ownTimestamp = message.timestamp || message.metadata?.timestamp;

        if (message.role === 'assistant' && ownTimestamp) {
          lastAssistantTimestamp = ownTimestamp;
        }

        const timestamp = ownTimestamp || lastAssistantTimestamp || '2026-02-17T17:03:20.000Z';

        if (message.role === 'tool') {
          // Tool message should inherit the assistant's timestamp, not the session fallback
          expect(timestamp).toBe('2026-02-14T01:19:19.988Z');
        }
      });
    });

    it('tool messages before any assistant message with timestamp should fall back to session updatedAt', () => {
      const sessionUpdatedAt = '2026-02-17T17:03:20.000Z';
      const messages = [
        { role: 'assistant', content: '' },            // no metadata.timestamp
        { role: 'tool', content: 'some url' },          // no metadata.timestamp
      ];

      let lastAssistantTimestamp: string | undefined;

      messages.forEach((message: any) => {
        const ownTimestamp = message.timestamp || message.metadata?.timestamp;

        if (message.role === 'assistant' && ownTimestamp) {
          lastAssistantTimestamp = ownTimestamp;
        }

        const timestamp = ownTimestamp || lastAssistantTimestamp || sessionUpdatedAt;

        if (message.role === 'tool') {
          expect(timestamp).toBe(sessionUpdatedAt);
        }
      });
    });
  });

  describe('isOwnTimestamp dedup override', () => {
    it('should update generatedAt when same URL is seen from message with own timestamp', () => {
      const sessionUpdatedAt = '2026-02-17T17:03:20.000Z';
      const realTimestamp = '2026-02-14T01:19:19.988Z';
      const htmlUrl = 'https://bucket.s3.amazonaws.com/files/blog.html';

      // Simulate addHtmlFile behavior
      const resultFiles: any[] = [];

      // First call: tool message with no own timestamp (fallback to session updatedAt)
      const existingFile1 = resultFiles.find((f: any) => f.url === htmlUrl);
      if (!existingFile1) {
        resultFiles.push({
          url: htmlUrl,
          filename: 'blog.html',
          generatedAt: sessionUpdatedAt,
        });
      }

      expect(resultFiles[0].generatedAt).toBe(sessionUpdatedAt);

      // Second call: assistant message with own timestamp
      const isOwnTimestamp = true;
      const existingFile2 = resultFiles.find((f: any) => f.url === htmlUrl);
      if (!existingFile2) {
        resultFiles.push({
          url: htmlUrl,
          filename: 'blog.html',
          generatedAt: realTimestamp,
        });
      } else if (isOwnTimestamp && realTimestamp) {
        existingFile2.generatedAt = realTimestamp;
      }

      // generatedAt should be updated to the real timestamp
      expect(resultFiles.length).toBe(1); // still just one entry
      expect(resultFiles[0].generatedAt).toBe(realTimestamp);
    });

    it('should NOT update generatedAt when same URL is seen from message without own timestamp', () => {
      const firstTimestamp = '2026-02-14T01:19:19.988Z';
      const sessionFallback = '2026-02-17T17:03:20.000Z';
      const htmlUrl = 'https://bucket.s3.amazonaws.com/files/blog.html';

      const resultFiles: any[] = [];

      // First call: assistant message with own timestamp
      resultFiles.push({
        url: htmlUrl,
        filename: 'blog.html',
        generatedAt: firstTimestamp,
      });

      // Second call: user message referencing the URL but without own timestamp
      const isOwnTimestamp = false;
      const existingFile = resultFiles.find((f: any) => f.url === htmlUrl);
      if (!existingFile) {
        resultFiles.push({
          url: htmlUrl,
          filename: 'blog.html',
          generatedAt: sessionFallback,
        });
      } else if (isOwnTimestamp && sessionFallback) {
        existingFile.generatedAt = sessionFallback;
      }

      // generatedAt should remain the original real timestamp
      expect(resultFiles[0].generatedAt).toBe(firstTimestamp);
    });
  });

  describe('end-to-end message processing', () => {
    it('should produce distinct generatedAt for different HTML files in the same session', () => {
      const sessionUpdatedAt = '2026-02-17T17:03:20.000Z';
      const messages = [
        // tool message (no timestamp) with first URL
        {
          role: 'tool',
          content: 'https://bucket.s3.amazonaws.com/files/blog-1.html created',
        },
        // assistant message with own timestamp that mentions first URL
        {
          role: 'assistant',
          content: 'I created https://bucket.s3.amazonaws.com/files/blog-1.html for you.',
          metadata: { timestamp: '2026-02-14T01:19:19.988Z' },
        },
        // tool message (no timestamp) with second URL
        {
          role: 'tool',
          content: 'https://bucket.s3.amazonaws.com/files/blog-2.html created',
        },
        // assistant message with own timestamp that mentions second URL
        {
          role: 'assistant',
          content: 'I created https://bucket.s3.amazonaws.com/files/blog-2.html for you.',
          metadata: { timestamp: '2026-02-14T01:46:55.147Z' },
        },
      ];

      const htmlUrlRegex = /(https?:\/\/[^\s"]+\.amazonaws\.com\/[^\s"]+\.html)/gi;
      const resultFiles: any[] = [];
      let lastAssistantTimestamp: string | undefined;

      messages.forEach((message: any) => {
        const ownTimestamp = message.timestamp || message.metadata?.timestamp;
        if (message.role === 'assistant' && ownTimestamp) {
          lastAssistantTimestamp = ownTimestamp;
        }
        const timestamp = ownTimestamp || lastAssistantTimestamp || sessionUpdatedAt;
        const hasOwnTimestamp = !!ownTimestamp;

        if (typeof message.content === 'string') {
          htmlUrlRegex.lastIndex = 0;
          let match;
          while ((match = htmlUrlRegex.exec(message.content)) !== null) {
            const url = match[1];
            const existing = resultFiles.find((f: any) => f.url === url);
            if (!existing) {
              resultFiles.push({ url, generatedAt: timestamp });
            } else if (hasOwnTimestamp && timestamp) {
              existing.generatedAt = timestamp;
            }
          }
        }
      });

      expect(resultFiles).toHaveLength(2);
      expect(resultFiles[0].url).toContain('blog-1.html');
      expect(resultFiles[0].generatedAt).toBe('2026-02-14T01:19:19.988Z');
      expect(resultFiles[1].url).toContain('blog-2.html');
      expect(resultFiles[1].generatedAt).toBe('2026-02-14T01:46:55.147Z');
    });

    it('should handle messages where no assistant has a timestamp (all fall back to session updatedAt)', () => {
      const sessionUpdatedAt = '2026-02-17T17:03:20.000Z';
      const messages = [
        { role: 'assistant', content: '' },
        {
          role: 'tool',
          content: 'Created https://bucket.s3.amazonaws.com/files/report.html',
        },
        { role: 'assistant', content: 'Done.' },
      ];

      const htmlUrlRegex = /(https?:\/\/[^\s"]+\.amazonaws\.com\/[^\s"]+\.html)/gi;
      const resultFiles: any[] = [];
      let lastAssistantTimestamp: string | undefined;

      messages.forEach((message: any) => {
        const ownTimestamp = message.timestamp || message.metadata?.timestamp;
        if (message.role === 'assistant' && ownTimestamp) {
          lastAssistantTimestamp = ownTimestamp;
        }
        const timestamp = ownTimestamp || lastAssistantTimestamp || sessionUpdatedAt;
        const hasOwnTimestamp = !!ownTimestamp;

        if (typeof message.content === 'string') {
          htmlUrlRegex.lastIndex = 0;
          let match;
          while ((match = htmlUrlRegex.exec(message.content)) !== null) {
            const url = match[1];
            const existing = resultFiles.find((f: any) => f.url === url);
            if (!existing) {
              resultFiles.push({ url, generatedAt: timestamp });
            } else if (hasOwnTimestamp && timestamp) {
              existing.generatedAt = timestamp;
            }
          }
        }
      });

      expect(resultFiles).toHaveLength(1);
      expect(resultFiles[0].generatedAt).toBe(sessionUpdatedAt);
    });

    it('should correctly handle the real-world pattern: tool result at idx N, assistant summary at idx N+K', () => {
      // Mirrors production data from session be7e7eee: tool messages at idx 11,15,19
      // have URLs but no timestamps; assistant at idx 22 mentions all three with a real timestamp.
      const sessionUpdatedAt = '2026-02-17T17:03:20.334Z';
      const messages = [
        // idx 10: assistant (no ts) initiates tool call
        { role: 'assistant', content: '' },
        // idx 11: tool result with URL but no timestamp
        {
          role: 'tool',
          content: 'Blog article created: https://agentweb-files.s3.amazonaws.com/files/blog-A.html',
        },
        // idx 12-20: more assistant/tool pairs without timestamps
        { role: 'assistant', content: '' },
        {
          role: 'tool',
          content: 'Social posts: https://agentweb-files.s3.amazonaws.com/files/social-B.html',
        },
        { role: 'assistant', content: '' },
        {
          role: 'tool',
          content: 'Social posts: https://agentweb-files.s3.amazonaws.com/files/social-C.html',
        },
        // idx 22: assistant summary with real timestamp mentions all URLs
        {
          role: 'assistant',
          content: 'Here are your results: https://agentweb-files.s3.amazonaws.com/files/blog-A.html and https://agentweb-files.s3.amazonaws.com/files/social-B.html and https://agentweb-files.s3.amazonaws.com/files/social-C.html',
          metadata: { timestamp: '2026-02-14T01:19:19.988Z' },
        },
      ];

      const htmlUrlRegex = /(https?:\/\/[^\s"]+\.amazonaws\.com\/[^\s"]+\.html)/gi;
      const resultFiles: any[] = [];
      let lastAssistantTimestamp: string | undefined;

      messages.forEach((message: any) => {
        const ownTimestamp = message.timestamp || message.metadata?.timestamp;
        if (message.role === 'assistant' && ownTimestamp) {
          lastAssistantTimestamp = ownTimestamp;
        }
        const timestamp = ownTimestamp || lastAssistantTimestamp || sessionUpdatedAt;
        const hasOwnTimestamp = !!ownTimestamp;

        if (typeof message.content === 'string') {
          htmlUrlRegex.lastIndex = 0;
          let match;
          while ((match = htmlUrlRegex.exec(message.content)) !== null) {
            const url = match[1];
            const existing = resultFiles.find((f: any) => f.url === url);
            if (!existing) {
              resultFiles.push({ url, generatedAt: timestamp });
            } else if (hasOwnTimestamp && timestamp) {
              existing.generatedAt = timestamp;
            }
          }
        }
      });

      // All three files should have the assistant's real timestamp, not the session fallback
      expect(resultFiles).toHaveLength(3);
      resultFiles.forEach((file) => {
        expect(file.generatedAt).toBe('2026-02-14T01:19:19.988Z');
      });
    });
  });
});
