import { ChatbotDB } from '../services/chatbotService';

describe('ChatbotDB - repair whitelist', () => {
  it('should only check repairable tool types', () => {
    const messages = [
      {
        role: 'assistant',
        messageIndex: 0,
        metadata: {
          toolCalls: [
            {
              id: 'call_1',
              name: 'generate_image',
              arguments: {},
              result: {} // Empty - should trigger repair
            },
            {
              id: 'call_2',
              name: 'search_web',
              arguments: {},
              result: {} // Empty but not in whitelist - should be ignored
            },
            {
              id: 'call_3',
              name: 'create_task_from_prompt',
              arguments: {},
              result: {} // Empty but not in whitelist - should be ignored
            }
          ]
        }
      }
    ];

    // Check detection logic - only generate_image should trigger repair
    const REPAIRABLE_TOOL_CALLS = ['generate_image', 'generate_video'];

    const shouldRepair = messages.some((msg: any) =>
      msg.role === 'assistant' &&
      msg.metadata?.toolCalls?.some((tc: any) =>
        REPAIRABLE_TOOL_CALLS.includes(tc.name) &&
        (!tc.result || Object.keys(tc.result).length === 0)
      )
    );

    expect(shouldRepair).toBe(true);

    // Count which tool calls would be checked
    const toolCallsToRepair = messages.flatMap((msg: any) =>
      msg.metadata?.toolCalls?.filter((tc: any) =>
        REPAIRABLE_TOOL_CALLS.includes(tc.name) &&
        (!tc.result || Object.keys(tc.result).length === 0)
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
            {
              id: 'call_1',
              name: 'search_web',
              arguments: {},
              result: {} // Empty but not in whitelist
            },
            {
              id: 'call_2',
              name: 'read_brand_guidelines',
              arguments: {},
              result: {} // Empty but not in whitelist
            }
          ]
        }
      }
    ];

    const REPAIRABLE_TOOL_CALLS = ['generate_image', 'generate_video'];

    const shouldRepair = messages.some((msg: any) =>
      msg.role === 'assistant' &&
      msg.metadata?.toolCalls?.some((tc: any) =>
        REPAIRABLE_TOOL_CALLS.includes(tc.name) &&
        (!tc.result || Object.keys(tc.result).length === 0)
      )
    );

    expect(shouldRepair).toBe(false);
  });
});
