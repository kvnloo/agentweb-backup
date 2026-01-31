import { ChatbotDB } from '../services/chatbotService';

describe('ChatbotDB - recoverToolResultsFromMessages', () => {
  let chatbotDb: ChatbotDB;

  beforeEach(() => {
    chatbotDb = new ChatbotDB();
  });

  it('should recover empty tool results from MCP format tool messages', () => {
    const messages = [
      // Assistant message with empty tool results
      {
        role: 'assistant',
        content: 'Generating images...',
        metadata: {
          toolCalls: [
            {
              id: 'call_1',
              name: 'generate_image',
              arguments: { prompt: 'test', filename: 'test.png' },
              result: {} // Empty result!
            }
          ]
        }
      },
      // Tool message with nested MCP format
      {
        role: 'tool',
        tool_call_id: 'call_1',
        name: 'generate_image',
        content: JSON.stringify({
          content: JSON.stringify({
            success: true,
            imageUrl: 'https://test.s3.amazonaws.com/image.png',
            filename: 'test.png'
          })
        })
      }
    ];

    // Call the private method through any
    const recovered = (chatbotDb as any).recoverToolResultsFromMessages(messages);

    // Verify the result was recovered
    expect(recovered[0].metadata.toolCalls[0].result).toEqual({
      success: true,
      imageUrl: 'https://test.s3.amazonaws.com/image.png',
      filename: 'test.png'
    });
  });

  it('should recover multiple parallel tool calls', () => {
    const messages = [
      // Assistant message with 2 empty tool results
      {
        role: 'assistant',
        content: null,
        metadata: {
          toolCalls: [
            {
              id: 'call_1',
              name: 'generate_image',
              arguments: {},
              result: {}
            },
            {
              id: 'call_2',
              name: 'generate_image',
              arguments: {},
              result: {}
            }
          ]
        }
      },
      // Tool message 1
      {
        role: 'tool',
        tool_call_id: 'call_1',
        name: 'generate_image',
        content: JSON.stringify({
          content: JSON.stringify({
            success: true,
            imageUrl: 'https://test.s3.amazonaws.com/image1.png',
            filename: 'image1.png'
          })
        })
      },
      // Tool message 2
      {
        role: 'tool',
        tool_call_id: 'call_2',
        name: 'generate_image',
        content: JSON.stringify({
          content: JSON.stringify({
            success: true,
            imageUrl: 'https://test.s3.amazonaws.com/image2.png',
            filename: 'image2.png'
          })
        })
      }
    ];

    const recovered = (chatbotDb as any).recoverToolResultsFromMessages(messages);

    // Verify both results were recovered
    expect(recovered[0].metadata.toolCalls[0].result.imageUrl).toBe('https://test.s3.amazonaws.com/image1.png');
    expect(recovered[0].metadata.toolCalls[1].result.imageUrl).toBe('https://test.s3.amazonaws.com/image2.png');
  });

  it('should not modify messages without empty results', () => {
    const messages = [
      {
        role: 'assistant',
        content: 'Image generated',
        metadata: {
          toolCalls: [
            {
              id: 'call_1',
              name: 'generate_image',
              arguments: {},
              result: {
                success: true,
                imageUrl: 'https://test.s3.amazonaws.com/existing.png',
                filename: 'existing.png'
              }
            }
          ]
        }
      }
    ];

    const recovered = (chatbotDb as any).recoverToolResultsFromMessages(messages);

    // Should keep existing result unchanged
    expect(recovered[0].metadata.toolCalls[0].result.imageUrl).toBe('https://test.s3.amazonaws.com/existing.png');
  });

  it('should handle video generation recovery', () => {
    const messages = [
      {
        role: 'assistant',
        content: 'Generating video...',
        metadata: {
          toolCalls: [
            {
              id: 'call_1',
              name: 'generate_video',
              arguments: {},
              result: {}
            }
          ]
        }
      },
      {
        role: 'tool',
        tool_call_id: 'call_1',
        name: 'generate_video',
        content: JSON.stringify({
          content: JSON.stringify({
            success: true,
            videoUrl: 'https://test.s3.amazonaws.com/video.mp4',
            filename: 'video.mp4'
          })
        })
      }
    ];

    const recovered = (chatbotDb as any).recoverToolResultsFromMessages(messages);

    expect(recovered[0].metadata.toolCalls[0].result).toEqual({
      success: true,
      videoUrl: 'https://test.s3.amazonaws.com/video.mp4',
      filename: 'video.mp4'
    });
  });

  it('should extract only URL data to keep results minimal', () => {
    const messages = [
      {
        role: 'assistant',
        content: null,
        metadata: {
          toolCalls: [
            {
              id: 'call_1',
              name: 'generate_image',
              arguments: {},
              result: {}
            }
          ]
        }
      },
      {
        role: 'tool',
        tool_call_id: 'call_1',
        name: 'generate_image',
        content: JSON.stringify({
          content: JSON.stringify({
            success: true,
            imageUrl: 'https://test.s3.amazonaws.com/image.png',
            filename: 'test.png',
            prompt: 'very long prompt text...',
            size: '1024x1024',
            quality: 'high',
            otherData: 'not needed'
          })
        })
      }
    ];

    const recovered = (chatbotDb as any).recoverToolResultsFromMessages(messages);

    // Should only have success, imageUrl, filename
    const result = recovered[0].metadata.toolCalls[0].result;
    expect(result).toEqual({
      success: true,
      imageUrl: 'https://test.s3.amazonaws.com/image.png',
      filename: 'test.png'
    });
    expect(result.prompt).toBeUndefined();
    expect(result.size).toBeUndefined();
    expect(result.quality).toBeUndefined();
  });
});
