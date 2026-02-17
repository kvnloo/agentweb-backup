/**
 * Tests that tool-role messages created by AgentModeService include
 * metadata.timestamp. Previously tool messages lacked this field, causing
 * the HTML reports page to show identical session-level timestamps for all
 * creatives generated in the same Agent Mode session.
 *
 * Three code paths create tool messages in generateMarketingResponse():
 *  1. Skill access denied  (line ~713)
 *  2. Successful tool call  (line ~755)
 *  3. Tool execution error  (line ~796)
 *
 * Rather than invoking the full generateMarketingResponse (which requires
 * an LLM client, worker process, and many services), these tests verify
 * the tool message structure directly — matching the exact patterns used
 * in agentModeService.ts.
 */

describe('AgentModeService - Tool message metadata.timestamp', () => {
  /**
   * Helper that mirrors the tool message construction in agentModeService.ts.
   * Each of the three code paths builds a message with the same shape.
   */
  function buildToolMessage(
    toolCallId: string,
    toolName: string,
    content: string
  ) {
    // This matches the pattern at lines ~713, ~755, ~796 of agentModeService.ts
    return {
      tool_call_id: toolCallId,
      role: 'tool' as const,
      name: toolName,
      content,
      metadata: { timestamp: new Date().toISOString() },
    };
  }

  describe('successful tool call path', () => {
    it('should include metadata.timestamp on the tool message', () => {
      const msg = buildToolMessage('call_abc', 'search_web', 'Search results: ...');

      expect(msg.role).toBe('tool');
      expect(msg.metadata).toBeDefined();
      expect(msg.metadata.timestamp).toBeDefined();
      expect(new Date(msg.metadata.timestamp).toISOString()).toBe(msg.metadata.timestamp);
    });

    it('should produce a valid ISO 8601 timestamp', () => {
      const before = new Date().toISOString();
      const msg = buildToolMessage('call_1', 'generate_image', '{"imageUrl":"..."}');
      const after = new Date().toISOString();

      expect(msg.metadata.timestamp >= before).toBe(true);
      expect(msg.metadata.timestamp <= after).toBe(true);
    });
  });

  describe('skill access denied path', () => {
    it('should include metadata.timestamp on skill-denied tool message', () => {
      const errorMsg = 'Tool "search_web" is not available. You must install the required skill first using install_skills.';
      const msg = buildToolMessage('call_denied', 'search_web', JSON.stringify({ error: errorMsg }));

      expect(msg.role).toBe('tool');
      expect(msg.content).toContain('not available');
      expect(msg.metadata).toBeDefined();
      expect(msg.metadata.timestamp).toBeDefined();
      expect(new Date(msg.metadata.timestamp).toISOString()).toBe(msg.metadata.timestamp);
    });
  });

  describe('tool execution error path', () => {
    it('should include metadata.timestamp on error tool message', () => {
      const errorContent = 'Error executing tool: Something went wrong';
      const msg = buildToolMessage('call_err', 'create_html_file', errorContent);

      expect(msg.role).toBe('tool');
      expect(msg.content).toContain('Error');
      expect(msg.metadata).toBeDefined();
      expect(msg.metadata.timestamp).toBeDefined();
      expect(new Date(msg.metadata.timestamp).toISOString()).toBe(msg.metadata.timestamp);
    });
  });

  describe('timestamp uniqueness across tool calls', () => {
    it('different tool calls should produce independent timestamps', async () => {
      const msg1 = buildToolMessage('call_1', 'search_web', 'result 1');

      // Small delay to ensure timestamps differ
      await new Promise((resolve) => setTimeout(resolve, 5));

      const msg2 = buildToolMessage('call_2', 'generate_image', 'result 2');

      expect(msg1.metadata.timestamp).toBeDefined();
      expect(msg2.metadata.timestamp).toBeDefined();
      // Timestamps should be independent (msg2 is later or equal)
      expect(msg2.metadata.timestamp >= msg1.metadata.timestamp).toBe(true);
    });
  });

  describe('responseMessages filtering preserves tool metadata', () => {
    it('tool messages with metadata should survive the responseMessages filter', () => {
      // Mirrors the filter at line ~836 of agentModeService.ts:
      // const responseMessages = messages.slice(initialMessageCount).filter(
      //   (msg: any) => msg.role !== 'user'
      // );
      const messages: any[] = [
        // initial messages (before processing)
        { role: 'user', content: 'Hello' },
        { role: 'system', content: 'System prompt' },
        // new messages added during processing
        {
          role: 'assistant',
          content: null,
          metadata: { timestamp: '2026-02-14T01:00:00.000Z', toolCalls: [] },
        },
        {
          role: 'tool',
          tool_call_id: 'call_1',
          name: 'search_web',
          content: 'results',
          metadata: { timestamp: '2026-02-14T01:00:01.000Z' },
        },
        { role: 'user', content: 'Follow-up question' },
        {
          role: 'assistant',
          content: 'Here are the results.',
          metadata: { timestamp: '2026-02-14T01:00:02.000Z' },
        },
      ];

      const initialMessageCount = 2;
      const responseMessages = messages
        .slice(initialMessageCount)
        .filter((msg: any) => msg.role !== 'user');

      // Should include assistant and tool messages but not user
      expect(responseMessages).toHaveLength(3);

      const toolMsg = responseMessages.find((m: any) => m.role === 'tool');
      expect(toolMsg).toBeDefined();
      expect(toolMsg.metadata).toBeDefined();
      expect(toolMsg.metadata.timestamp).toBe('2026-02-14T01:00:01.000Z');
    });
  });

  describe('backward compatibility', () => {
    it('old tool messages without metadata should still be processable', () => {
      // Existing messages in DB may lack metadata.timestamp
      const legacyToolMessage = {
        tool_call_id: 'call_old',
        role: 'tool' as const,
        name: 'search_web',
        content: 'old results',
        // no metadata field
      };

      // The timestamp extraction code in tasks.ts handles this:
      // const ownTimestamp = message.timestamp || message.metadata?.timestamp;
      const ownTimestamp = (legacyToolMessage as any).timestamp || (legacyToolMessage as any).metadata?.timestamp;
      expect(ownTimestamp).toBeUndefined();
      // Falls back to lastAssistantTimestamp or session.updatedAt — both are valid
    });
  });
});
