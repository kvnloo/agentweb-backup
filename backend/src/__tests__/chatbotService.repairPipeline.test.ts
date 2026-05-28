// Consolidates all chatbotService repair-pipeline tests:
// repairDedup, repairWhitelist, repairToolResults, repairUrlExtraction, recoverToolResults

import { ChatbotDB } from '../services/chatbotService';

// ─── Deduplication ───────────────────────────────────────────────────────────

describe('ChatbotDB - repair deduplication', () => {
  it('should handle messages with same messageIndex (deduplication)', () => {
    const messages = [
      {
        role: 'assistant',
        content: null,
        messageIndex: 5,
        metadata: {
          toolCalls: [
            { id: 'call_1', name: 'generate_image', arguments: {}, result: {} },
            { id: 'call_2', name: 'generate_image', arguments: {}, result: {} },
          ],
        },
      },
    ];

    const messagesToUpdate: Array<{ messageIndex: number; message: any }> = [];
    messagesToUpdate.push({ messageIndex: 5, message: { ...messages[0], metadata: { ...messages[0].metadata } } });
    messagesToUpdate.push({ messageIndex: 5, message: { ...messages[0], metadata: { ...messages[0].metadata } } });

    expect(messagesToUpdate).toHaveLength(2);

    const dedupMap = new Map<number, { messageIndex: number; message: any }>();
    messagesToUpdate.forEach(item => { dedupMap.set(item.messageIndex, item); });
    const deduplicatedMessages = Array.from(dedupMap.values());

    expect(deduplicatedMessages).toHaveLength(1);
    expect(deduplicatedMessages[0].messageIndex).toBe(5);
  });

  it('should preserve different messageIndexes', () => {
    const messagesToUpdate = [
      { messageIndex: 5, message: { role: 'assistant', content: 'test' } },
      { messageIndex: 7, message: { role: 'assistant', content: 'test2' } },
      { messageIndex: 9, message: { role: 'assistant', content: 'test3' } },
    ];

    const dedupMap = new Map<number, { messageIndex: number; message: any }>();
    messagesToUpdate.forEach(item => { dedupMap.set(item.messageIndex, item); });
    const deduplicatedMessages = Array.from(dedupMap.values());

    expect(deduplicatedMessages).toHaveLength(3);
    expect(deduplicatedMessages.map(m => m.messageIndex).sort()).toEqual([5, 7, 9]);
  });

  it('should keep last occurrence when deduplicating', () => {
    const messagesToUpdate = [
      { messageIndex: 5, message: { role: 'assistant', content: 'first' } },
      { messageIndex: 7, message: { role: 'assistant', content: 'unique' } },
      { messageIndex: 5, message: { role: 'assistant', content: 'second' } },
    ];

    const dedupMap = new Map<number, { messageIndex: number; message: any }>();
    messagesToUpdate.forEach(item => { dedupMap.set(item.messageIndex, item); });
    const deduplicatedMessages = Array.from(dedupMap.values());

    expect(deduplicatedMessages).toHaveLength(2);
    const msg5 = deduplicatedMessages.find(m => m.messageIndex === 5);
    expect(msg5?.message.content).toBe('second');
  });
});

// ─── Whitelist ───────────────────────────────────────────────────────────────

describe('ChatbotDB - repair whitelist', () => {
  const REPAIRABLE_TOOL_CALLS = ['generate_image', 'generate_video'];

  it('should only check repairable tool types', () => {
    const messages = [
      {
        role: 'assistant',
        messageIndex: 0,
        metadata: {
          toolCalls: [
            { id: 'call_1', name: 'generate_image', arguments: {}, result: {} },
            { id: 'call_2', name: 'search_web', arguments: {}, result: {} },
            { id: 'call_3', name: 'create_task_from_prompt', arguments: {}, result: {} },
          ],
        },
      },
    ];

    const shouldRepair = messages.some((msg: any) =>
      msg.role === 'assistant' &&
      msg.metadata?.toolCalls?.some((tc: any) =>
        REPAIRABLE_TOOL_CALLS.includes(tc.name) && (!tc.result || Object.keys(tc.result).length === 0)
      )
    );
    expect(shouldRepair).toBe(true);

    const toolCallsToRepair = messages.flatMap((msg: any) =>
      msg.metadata?.toolCalls?.filter((tc: any) =>
        REPAIRABLE_TOOL_CALLS.includes(tc.name) && (!tc.result || Object.keys(tc.result).length === 0)
      ) || []
    );
    expect(toolCallsToRepair).toHaveLength(1);
    expect(toolCallsToRepair[0].name).toBe('generate_image');
  });

  it('should not trigger repair for non-repairable tools', () => {
    const messages = [
      {
        role: 'assistant',
        messageIndex: 0,
        metadata: {
          toolCalls: [
            { id: 'call_1', name: 'search_web', arguments: {}, result: {} },
            { id: 'call_2', name: 'read_brand_guidelines', arguments: {}, result: {} },
          ],
        },
      },
    ];

    const shouldRepair = messages.some((msg: any) =>
      msg.role === 'assistant' &&
      msg.metadata?.toolCalls?.some((tc: any) =>
        REPAIRABLE_TOOL_CALLS.includes(tc.name) && (!tc.result || Object.keys(tc.result).length === 0)
      )
    );
    expect(shouldRepair).toBe(false);
  });
});

// ─── Detection ───────────────────────────────────────────────────────────────

describe('ChatbotDB - repairBrokenToolResults detection', () => {
  it('should detect broken tool results and trigger repair', () => {
    const messages = [
      {
        role: 'assistant',
        content: null,
        messageIndex: 0,
        metadata: { toolCalls: [{ id: 'call_1', name: 'generate_image', arguments: {}, result: {} }] },
      },
      {
        role: 'tool',
        tool_call_id: 'call_1',
        name: 'generate_image',
        messageIndex: 1,
        content: JSON.stringify({ content: JSON.stringify({ success: true, imageUrl: 'https://test.s3.amazonaws.com/image.png', filename: 'test.png' }) }),
      },
    ];

    const hasBroken = messages.some((msg: any) =>
      msg.role === 'assistant' &&
      msg.metadata?.toolCalls?.some((tc: any) =>
        tc.name === 'generate_image' && (!tc.result || Object.keys(tc.result).length === 0)
      )
    );
    expect(hasBroken).toBe(true);
  });

  it('should not trigger repair when results are fine', () => {
    const messages = [
      {
        role: 'assistant',
        content: null,
        messageIndex: 0,
        metadata: {
          toolCalls: [
            { id: 'call_1', name: 'generate_image', arguments: {}, result: { success: true, imageUrl: 'https://test.s3.amazonaws.com/image.png', filename: 'test.png' } },
          ],
        },
      },
    ];

    const hasBroken = messages.some((msg: any) =>
      msg.role === 'assistant' &&
      msg.metadata?.toolCalls?.some((tc: any) =>
        tc.name === 'generate_image' && (!tc.result || Object.keys(tc.result).length === 0)
      )
    );
    expect(hasBroken).toBe(false);
  });
});

// ─── URL extraction ──────────────────────────────────────────────────────────

describe('ChatbotDB - URL extraction from HTML content', () => {
  const urlRegex = /https?:\/\/[^\s<>"]+?\.(png|jpg|jpeg|gif|webp|mp4|mov|avi|webm)/gi;

  it('should extract image URL from HTML content', () => {
    const html = '<strong>Generated image:</strong> <img src="https://example.s3.amazonaws.com/images/test-image.png" alt="Generated" />';
    const matches = html.match(urlRegex);
    expect(matches).toHaveLength(1);
    expect(matches![0]).toBe('https://example.s3.amazonaws.com/images/test-image.png');
  });

  it('should extract video URL from HTML content', () => {
    const html = '<p>Video generated: https://storage.googleapis.com/videos/output.mp4</p>';
    const matches = html.match(urlRegex);
    expect(matches).toHaveLength(1);
    expect(matches![0]).toBe('https://storage.googleapis.com/videos/output.mp4');
  });

  it('should extract URL from JSON string', () => {
    const json = JSON.stringify({ success: true, imageUrl: 'https://test.s3.amazonaws.com/path/to/image.jpg', filename: 'image.jpg' });
    const matches = json.match(urlRegex);
    expect(matches).toHaveLength(1);
    expect(matches![0]).toBe('https://test.s3.amazonaws.com/path/to/image.jpg');
  });

  it('should extract all URLs when multiple exist', () => {
    const content = 'Found images: https://s3.amazonaws.com/img1.png and https://s3.amazonaws.com/img2.png';
    const matches = content.match(urlRegex);
    expect(matches).toHaveLength(2);
    expect(matches![0]).toBe('https://s3.amazonaws.com/img1.png');
  });

  it('should return null for content without URLs', () => {
    expect('No URLs here, just plain text'.match(urlRegex)).toBeNull();
  });

  it('should extract URL without query parameters', () => {
    const content = 'Image URL: https://s3.amazonaws.com/bucket/image.png?v=123&auth=abc';
    const matches = content.match(urlRegex);
    expect(matches).toHaveLength(1);
    expect(matches![0]).toBe('https://s3.amazonaws.com/bucket/image.png');
  });
});

// ─── recoverToolResultsFromMessages ─────────────────────────────────────────

describe('ChatbotDB - recoverToolResultsFromMessages', () => {
  let chatbotDb: ChatbotDB;

  beforeEach(() => {
    chatbotDb = new ChatbotDB();
  });

  it('should recover empty tool results from MCP format tool messages', () => {
    const messages = [
      {
        role: 'assistant',
        content: 'Generating images...',
        metadata: { toolCalls: [{ id: 'call_1', name: 'generate_image', arguments: { prompt: 'test', filename: 'test.png' }, result: {} }] },
      },
      {
        role: 'tool',
        tool_call_id: 'call_1',
        name: 'generate_image',
        content: JSON.stringify({ content: JSON.stringify({ success: true, imageUrl: 'https://test.s3.amazonaws.com/image.png', filename: 'test.png' }) }),
      },
    ];

    const recovered = (chatbotDb as any).recoverToolResultsFromMessages(messages);
    expect(recovered[0].metadata.toolCalls[0].result).toEqual({ success: true, imageUrl: 'https://test.s3.amazonaws.com/image.png', filename: 'test.png' });
  });

  it('should recover multiple parallel tool calls', () => {
    const messages = [
      {
        role: 'assistant',
        content: null,
        metadata: {
          toolCalls: [
            { id: 'call_1', name: 'generate_image', arguments: {}, result: {} },
            { id: 'call_2', name: 'generate_image', arguments: {}, result: {} },
          ],
        },
      },
      {
        role: 'tool', tool_call_id: 'call_1', name: 'generate_image',
        content: JSON.stringify({ content: JSON.stringify({ success: true, imageUrl: 'https://test.s3.amazonaws.com/image1.png', filename: 'image1.png' }) }),
      },
      {
        role: 'tool', tool_call_id: 'call_2', name: 'generate_image',
        content: JSON.stringify({ content: JSON.stringify({ success: true, imageUrl: 'https://test.s3.amazonaws.com/image2.png', filename: 'image2.png' }) }),
      },
    ];

    const recovered = (chatbotDb as any).recoverToolResultsFromMessages(messages);
    expect(recovered[0].metadata.toolCalls[0].result.imageUrl).toBe('https://test.s3.amazonaws.com/image1.png');
    expect(recovered[0].metadata.toolCalls[1].result.imageUrl).toBe('https://test.s3.amazonaws.com/image2.png');
  });

  it('should not modify messages without empty results', () => {
    const messages = [
      {
        role: 'assistant',
        content: 'Image generated',
        metadata: { toolCalls: [{ id: 'call_1', name: 'generate_image', arguments: {}, result: { success: true, imageUrl: 'https://test.s3.amazonaws.com/existing.png', filename: 'existing.png' } }] },
      },
    ];

    const recovered = (chatbotDb as any).recoverToolResultsFromMessages(messages);
    expect(recovered[0].metadata.toolCalls[0].result.imageUrl).toBe('https://test.s3.amazonaws.com/existing.png');
  });

  it('should handle video generation recovery', () => {
    const messages = [
      {
        role: 'assistant',
        content: 'Generating video...',
        metadata: { toolCalls: [{ id: 'call_1', name: 'generate_video', arguments: {}, result: {} }] },
      },
      {
        role: 'tool', tool_call_id: 'call_1', name: 'generate_video',
        content: JSON.stringify({ content: JSON.stringify({ success: true, videoUrl: 'https://test.s3.amazonaws.com/video.mp4', filename: 'video.mp4' }) }),
      },
    ];

    const recovered = (chatbotDb as any).recoverToolResultsFromMessages(messages);
    expect(recovered[0].metadata.toolCalls[0].result).toEqual({ success: true, videoUrl: 'https://test.s3.amazonaws.com/video.mp4', filename: 'video.mp4' });
  });

  it('should extract only URL data to keep results minimal', () => {
    const messages = [
      {
        role: 'assistant',
        content: null,
        metadata: { toolCalls: [{ id: 'call_1', name: 'generate_image', arguments: {}, result: {} }] },
      },
      {
        role: 'tool', tool_call_id: 'call_1', name: 'generate_image',
        content: JSON.stringify({ content: JSON.stringify({ success: true, imageUrl: 'https://test.s3.amazonaws.com/image.png', filename: 'test.png', prompt: 'very long prompt text...', size: '1024x1024', quality: 'high', otherData: 'not needed' }) }),
      },
    ];

    const recovered = (chatbotDb as any).recoverToolResultsFromMessages(messages);
    const result = recovered[0].metadata.toolCalls[0].result;
    expect(result).toEqual({ success: true, imageUrl: 'https://test.s3.amazonaws.com/image.png', filename: 'test.png' });
    expect(result.prompt).toBeUndefined();
    expect(result.size).toBeUndefined();
    expect(result.quality).toBeUndefined();
  });
});
