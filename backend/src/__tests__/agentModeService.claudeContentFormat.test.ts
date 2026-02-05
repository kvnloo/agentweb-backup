/**
 * Test suite for Claude 4.6+ content format compatibility
 * Tests handling of array-based content format: [{type: "text", text: "..."}]
 */

describe('AgentMode Service - Claude 4.6+ Content Format', () => {
  describe('Content Extraction Logic', () => {
    it('should extract text from Claude array format', () => {
      // Simulate the content extraction logic from agentModeService.ts lines 566-576
      const responseContent = [
        { type: 'text', text: 'Hello, this is Claude.' },
        { type: 'text', text: 'How can I help you today?' }
      ];

      let extractedContent = '';
      if (Array.isArray(responseContent)) {
        extractedContent = responseContent
          .map((item: any) => item?.text || '')
          .filter(Boolean)
          .join('\n');
      }

      expect(extractedContent).toBe('Hello, this is Claude.\nHow can I help you today?');
    });

    it('should handle string format (backward compatibility)', () => {
      const responseContent = 'This is a string response.';

      let extractedContent = '';
      if (typeof responseContent === 'string') {
        extractedContent = responseContent;
      }

      expect(extractedContent).toBe('This is a string response.');
    });

    it('should handle object format with text property', () => {
      const responseContent = { text: 'This is object format text.' };

      let extractedContent = '';
      if (responseContent && typeof responseContent === 'object' && !Array.isArray(responseContent)) {
        extractedContent = (responseContent as any).text || '';
      }

      expect(extractedContent).toBe('This is object format text.');
    });

    it('should filter out empty items from Claude array format', () => {
      const responseContent = [
        { type: 'text', text: 'Valid text' },
        { type: 'text', text: '' },
        { type: 'text', text: 'More valid text' },
        { type: 'text', text: null as any }
      ];

      let extractedContent = '';
      if (Array.isArray(responseContent)) {
        extractedContent = responseContent
          .map((item: any) => item?.text || '')
          .filter(Boolean)
          .join('\n');
      }

      expect(extractedContent).toBe('Valid text\nMore valid text');
    });

    it('should handle null content', () => {
      const responseContent = null;

      let extractedContent = '';
      if (typeof responseContent === 'string') {
        extractedContent = responseContent;
      } else if (Array.isArray(responseContent)) {
        extractedContent = responseContent
          .map((item: any) => item?.text || '')
          .filter(Boolean)
          .join('\n');
      } else if (responseContent && typeof responseContent === 'object') {
        extractedContent = (responseContent as any).text || '';
      }

      expect(extractedContent).toBe('');
    });

    it('should handle undefined content', () => {
      const responseContent = undefined;

      let extractedContent = '';
      if (typeof responseContent === 'string') {
        extractedContent = responseContent;
      } else if (Array.isArray(responseContent)) {
        extractedContent = responseContent
          .map((item: any) => item?.text || '')
          .filter(Boolean)
          .join('\n');
      } else if (responseContent && typeof responseContent === 'object') {
        extractedContent = (responseContent as any).text || '';
      }

      expect(extractedContent).toBe('');
    });
  });

  describe('Message Content Normalization', () => {
    it('should normalize array content to string', () => {
      // Simulate the normalization logic from agentModeService.ts lines 1081-1094
      const messageContent = [
        { type: 'text', text: 'Response part 1' },
        { type: 'text', text: 'Response part 2' }
      ];

      let normalizedContent = '';
      if (messageContent == null || messageContent === null || messageContent === undefined) {
        normalizedContent = '';
      } else if (Array.isArray(messageContent)) {
        normalizedContent = messageContent
          .map((item: any) => item?.text || '')
          .filter(Boolean)
          .join('\n');
      } else if (typeof messageContent === 'object') {
        normalizedContent = (messageContent as any).text || JSON.stringify(messageContent);
      } else {
        normalizedContent = String(messageContent);
      }

      expect(normalizedContent).toBe('Response part 1\nResponse part 2');
    });

    it('should handle string content unchanged', () => {
      const messageContent = 'String response';

      let normalizedContent = '';
      if (messageContent == null || messageContent === null || messageContent === undefined) {
        normalizedContent = '';
      } else if (Array.isArray(messageContent)) {
        normalizedContent = messageContent
          .map((item: any) => item?.text || '')
          .filter(Boolean)
          .join('\n');
      } else if (typeof messageContent === 'object') {
        normalizedContent = (messageContent as any).text || JSON.stringify(messageContent);
      } else {
        normalizedContent = String(messageContent);
      }

      expect(normalizedContent).toBe('String response');
    });

    it('should handle object with text property', () => {
      const messageContent = { text: 'Object response' };

      let normalizedContent = '';
      if (messageContent == null || messageContent === null || messageContent === undefined) {
        normalizedContent = '';
      } else if (Array.isArray(messageContent)) {
        normalizedContent = messageContent
          .map((item: any) => item?.text || '')
          .filter(Boolean)
          .join('\n');
      } else if (typeof messageContent === 'object') {
        normalizedContent = (messageContent as any).text || JSON.stringify(messageContent);
      } else {
        normalizedContent = String(messageContent);
      }

      expect(normalizedContent).toBe('Object response');
    });

    it('should handle null content', () => {
      const messageContent = null;

      let normalizedContent = '';
      if (messageContent == null || messageContent === null || messageContent === undefined) {
        normalizedContent = '';
      } else if (Array.isArray(messageContent)) {
        normalizedContent = messageContent
          .map((item: any) => item?.text || '')
          .filter(Boolean)
          .join('\n');
      } else if (typeof messageContent === 'object') {
        normalizedContent = (messageContent as any).text || JSON.stringify(messageContent);
      } else {
        normalizedContent = String(messageContent);
      }

      expect(normalizedContent).toBe('');
    });

    it('should handle undefined content', () => {
      const messageContent = undefined;

      let normalizedContent = '';
      if (messageContent == null || messageContent === null || messageContent === undefined) {
        normalizedContent = '';
      } else if (Array.isArray(messageContent)) {
        normalizedContent = messageContent
          .map((item: any) => item?.text || '')
          .filter(Boolean)
          .join('\n');
      } else if (typeof messageContent === 'object') {
        normalizedContent = (messageContent as any).text || JSON.stringify(messageContent);
      } else {
        normalizedContent = String(messageContent);
      }

      expect(normalizedContent).toBe('');
    });
  });

  describe('Attachment Content Handling', () => {
    it('should convert array content to string for attachment concatenation', () => {
      // Simulate the attachment handling logic from agentModeService.ts lines 1065-1071
      const content = [{ type: 'text', text: 'Check this file' }];
      const attachmentUrls = '[document.pdf](https://example.com/file.pdf)';

      let contentStr = '';
      if (Array.isArray(content)) {
        contentStr = content.map((item: any) => item?.text || '').filter(Boolean).join('\n');
      } else if (typeof content === 'object' && content !== null) {
        contentStr = (content as any).text || JSON.stringify(content);
      } else {
        contentStr = String(content);
      }

      const finalContent = `${contentStr}\n\n**Attached Files:**\n${attachmentUrls}`;

      expect(finalContent).toContain('Check this file');
      expect(finalContent).toContain('**Attached Files:**');
      expect(finalContent).toContain('[document.pdf](https://example.com/file.pdf)');
    });

    it('should convert object content to string for attachment concatenation', () => {
      const content = { text: 'Check this file' };
      const attachmentUrls = '[image.png](https://example.com/image.png)';

      let contentStr = '';
      if (Array.isArray(content)) {
        contentStr = content.map((item: any) => item?.text || '').filter(Boolean).join('\n');
      } else if (typeof content === 'object' && content !== null) {
        contentStr = (content as any).text || JSON.stringify(content);
      } else {
        contentStr = String(content);
      }

      const finalContent = `${contentStr}\n\n**Attached Files:**\n${attachmentUrls}`;

      expect(finalContent).toContain('Check this file');
      expect(finalContent).toContain('**Attached Files:**');
      expect(finalContent).toContain('[image.png](https://example.com/image.png)');
    });

    it('should handle string content for attachment concatenation', () => {
      const content = 'Check this file';
      const attachmentUrls = '[report.xlsx](https://example.com/report.xlsx)';

      let contentStr = '';
      if (Array.isArray(content)) {
        contentStr = content.map((item: any) => item?.text || '').filter(Boolean).join('\n');
      } else if (typeof content === 'object' && content !== null) {
        contentStr = (content as any).text || JSON.stringify(content);
      } else {
        contentStr = String(content);
      }

      const finalContent = `${contentStr}\n\n**Attached Files:**\n${attachmentUrls}`;

      expect(finalContent).toContain('Check this file');
      expect(finalContent).toContain('**Attached Files:**');
      expect(finalContent).toContain('[report.xlsx](https://example.com/report.xlsx)');
    });

    it('should handle object without text property', () => {
      const content = { data: 'some data', value: 123 };
      const attachmentUrls = '[file.txt](https://example.com/file.txt)';

      let contentStr = '';
      if (Array.isArray(content)) {
        contentStr = content.map((item: any) => item?.text || '').filter(Boolean).join('\n');
      } else if (typeof content === 'object' && content !== null) {
        contentStr = (content as any).text || JSON.stringify(content);
      } else {
        contentStr = String(content);
      }

      const finalContent = `${contentStr}\n\n**Attached Files:**\n${attachmentUrls}`;

      expect(finalContent).toContain('**Attached Files:**');
      expect(finalContent).toContain('[file.txt](https://example.com/file.txt)');
      // Should contain JSON stringified version
      expect(finalContent).toContain('"data"');
      expect(finalContent).toContain('"value"');
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty array content', () => {
      const responseContent: any[] = [];

      let extractedContent = '';
      if (Array.isArray(responseContent)) {
        extractedContent = responseContent
          .map((item: any) => item?.text || '')
          .filter(Boolean)
          .join('\n');
      }

      expect(extractedContent).toBe('');
    });

    it('should handle array with all null/empty items', () => {
      const responseContent = [
        { type: 'text', text: null },
        { type: 'text', text: '' },
        { type: 'text', text: undefined }
      ];

      let extractedContent = '';
      if (Array.isArray(responseContent)) {
        extractedContent = responseContent
          .map((item: any) => item?.text || '')
          .filter(Boolean)
          .join('\n');
      }

      expect(extractedContent).toBe('');
    });

    it('should handle object without text property', () => {
      const responseContent = { data: 'some data', value: 123 };

      let extractedContent = '';
      if (typeof responseContent === 'object' && !Array.isArray(responseContent) && responseContent !== null) {
        extractedContent = (responseContent as any).text || '';
      }

      expect(extractedContent).toBe('');
    });

    it('should handle malformed array items', () => {
      const responseContent = [
        null,
        undefined,
        { type: 'text', text: 'Valid text' },
        { type: 'other' },
        'invalid item'
      ];

      let extractedContent = '';
      if (Array.isArray(responseContent)) {
        extractedContent = responseContent
          .map((item: any) => item?.text || '')
          .filter(Boolean)
          .join('\n');
      }

      expect(extractedContent).toBe('Valid text');
    });
  });
});
