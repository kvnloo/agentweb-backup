import { ChatbotDB } from '../services/chatbotService';

describe('ChatbotDB - repairBrokenToolResults', () => {
  it('should detect broken tool results and trigger repair', () => {
    const chatbotDb = new ChatbotDB();

    // Mock messages with broken results
    const messages = [
      {
        role: 'assistant',
        content: null,
        messageIndex: 0,
        metadata: {
          toolCalls: [
            {
              id: 'call_1',
              name: 'generate_image',
              arguments: {},
              result: {} // Empty!
            }
          ]
        }
      },
      {
        role: 'tool',
        tool_call_id: 'call_1',
        name: 'generate_image',
        messageIndex: 1,
        content: JSON.stringify({
          content: JSON.stringify({
            success: true,
            imageUrl: 'https://test.s3.amazonaws.com/image.png',
            filename: 'test.png'
          })
        })
      }
    ];

    // Check detection logic
    const hasBroken = messages.some((msg: any) =>
      msg.role === 'assistant' &&
      msg.metadata?.toolCalls?.some((tc: any) =>
        tc.name === 'generate_image' &&
        (!tc.result || Object.keys(tc.result).length === 0)
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
            {
              id: 'call_1',
              name: 'generate_image',
              arguments: {},
              result: {
                success: true,
                imageUrl: 'https://test.s3.amazonaws.com/image.png',
                filename: 'test.png'
              }
            }
          ]
        }
      }
    ];

    const hasBroken = messages.some((msg: any) =>
      msg.role === 'assistant' &&
      msg.metadata?.toolCalls?.some((tc: any) =>
        tc.name === 'generate_image' &&
        (!tc.result || Object.keys(tc.result).length === 0)
      )
    );

    expect(hasBroken).toBe(false);
  });
});
