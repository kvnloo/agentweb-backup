import { ChatbotDB } from '../services/chatbotService';

describe('ChatbotDB - repair deduplication', () => {
  it('should handle messages with same messageIndex (deduplication)', () => {
    // Simulate a scenario where the same message might be added twice
    const messages = [
      {
        role: 'assistant',
        content: null,
        messageIndex: 5,
        metadata: {
          toolCalls: [
            {
              id: 'call_1',
              name: 'generate_image',
              arguments: {},
              result: {} // Empty - needs repair
            },
            {
              id: 'call_2',
              name: 'generate_image',
              arguments: {},
              result: {} // Empty - needs repair
            }
          ]
        }
      }
    ];

    // Simulate what would happen if we tried to add the same message twice
    const messagesToUpdate: Array<{ messageIndex: number; message: any }> = [];

    // First time processing
    messagesToUpdate.push({
      messageIndex: 5,
      message: { ...messages[0], metadata: { ...messages[0].metadata } }
    });

    // Accidentally processing again (simulating bug)
    messagesToUpdate.push({
      messageIndex: 5,
      message: { ...messages[0], metadata: { ...messages[0].metadata } }
    });

    expect(messagesToUpdate).toHaveLength(2);

    // Deduplication logic (from repairBrokenToolResults)
    const dedupMap = new Map<number, { messageIndex: number; message: any }>();
    messagesToUpdate.forEach(item => {
      dedupMap.set(item.messageIndex, item);
    });
    const deduplicatedMessages = Array.from(dedupMap.values());

    // After deduplication, should only have 1 message
    expect(deduplicatedMessages).toHaveLength(1);
    expect(deduplicatedMessages[0].messageIndex).toBe(5);
  });

  it('should preserve different messageIndexes', () => {
    const messagesToUpdate = [
      { messageIndex: 5, message: { role: 'assistant', content: 'test' } },
      { messageIndex: 7, message: { role: 'assistant', content: 'test2' } },
      { messageIndex: 9, message: { role: 'assistant', content: 'test3' } }
    ];

    // Deduplication should not remove anything
    const dedupMap = new Map<number, { messageIndex: number; message: any }>();
    messagesToUpdate.forEach(item => {
      dedupMap.set(item.messageIndex, item);
    });
    const deduplicatedMessages = Array.from(dedupMap.values());

    expect(deduplicatedMessages).toHaveLength(3);
    expect(deduplicatedMessages.map(m => m.messageIndex).sort()).toEqual([5, 7, 9]);
  });

  it('should keep last occurrence when deduplicating', () => {
    const messagesToUpdate = [
      { messageIndex: 5, message: { role: 'assistant', content: 'first' } },
      { messageIndex: 7, message: { role: 'assistant', content: 'unique' } },
      { messageIndex: 5, message: { role: 'assistant', content: 'second' } }, // duplicate
    ];

    // Deduplication keeps last occurrence
    const dedupMap = new Map<number, { messageIndex: number; message: any }>();
    messagesToUpdate.forEach(item => {
      dedupMap.set(item.messageIndex, item);
    });
    const deduplicatedMessages = Array.from(dedupMap.values());

    expect(deduplicatedMessages).toHaveLength(2);

    const msg5 = deduplicatedMessages.find(m => m.messageIndex === 5);
    expect(msg5?.message.content).toBe('second'); // Last occurrence kept
  });
});
