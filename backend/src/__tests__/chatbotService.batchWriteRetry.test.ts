import { chatbotDb } from '../services/chatbotService';

// Track batchWrite calls
const batchWriteMock = jest.fn();

// Mock AWS DynamoDB and S3
jest.mock('aws-sdk', () => {
  return {
    DynamoDB: {
      DocumentClient: jest.fn(() => ({
        batchWrite: jest.fn(() => ({ promise: batchWriteMock })),
        query: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({ Items: [] }) })),
        get: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({ Item: null }) })),
        put: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
        update: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
      })),
    },
    S3: jest.fn(() => ({
      upload: jest.fn().mockReturnThis(),
      promise: jest.fn(),
    })),
    config: { update: jest.fn() },
  };
});

// Mock other imports that chatbotService depends on
jest.mock('openai', () => jest.fn(() => ({})));
jest.mock('@google-cloud/discoveryengine', () => ({
  EngineServiceClient: jest.fn(),
  SearchServiceClient: jest.fn(),
}));
jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn(),
}));
jest.mock('../controllers/guide', () => ({ getGuide: jest.fn() }));
jest.mock('../controllers/release', () => ({ getReleases: jest.fn() }));
jest.mock('../controllers/docsController', () => ({ getUserReleaseNotes: jest.fn() }));
jest.mock('../services/db', () => ({ taskDb: {} }));
jest.mock('../utils/secretsManager', () => ({ getGCSPPrivateKey: jest.fn() }));

/**
 * The retry path sleeps for real: `setTimeout(100 * 2 ** retries)`, so the max-retries case
 * costs 200 + 400 + 800 = 1.4s of wall clock. Added to the cost of loading chatbotService's
 * dependency graph, that ran close enough to jest's 5s default to fail intermittently on a
 * loaded CI worker — three runs in a row on one PR, a different case each time.
 *
 * Fake timers remove the wall-clock cost entirely and make the assertions deterministic:
 * the number of batchWrite calls is now a function of the mocked responses alone, not of
 * how busy the machine was.
 */
describe('addMessagesToMessagesTable UnprocessedItems retry', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  /** Drive an async call that awaits real setTimeout delays under fake timers. Advancing in
   *  a loop lets each awaited backoff resolve before the next one is scheduled. */
  const runWithBackoff = async (promise: Promise<unknown>) => {
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(1000);
    }
    return promise;
  };

  it('should retry unprocessed items with exponential backoff', async () => {
    const messages = [
      { role: 'assistant', content: 'msg1', tool_calls: [{ id: 'tc1' }] },
      { role: 'tool', content: 'result1', tool_call_id: 'tc1' },
      { role: 'assistant', content: 'msg2' },
    ];

    const tableName = (chatbotDb as any).messagesTableName;

    // First call: return 1 unprocessed item
    batchWriteMock.mockResolvedValueOnce({
      UnprocessedItems: {
        [tableName]: [
          {
            PutRequest: {
              Item: { sessionId: 'sess1', messageIndex: 0, message: messages[0] },
            },
          },
        ],
      },
    });

    // Second call (retry): all succeed
    batchWriteMock.mockResolvedValueOnce({
      UnprocessedItems: {},
    });

    await runWithBackoff((chatbotDb as any).addMessagesToMessagesTable('sess1', messages, 0));

    // Should have been called twice: initial + 1 retry
    expect(batchWriteMock).toHaveBeenCalledTimes(2);
  });

  it('should succeed when no unprocessed items', async () => {
    const messages = [
      { role: 'assistant', content: 'msg1' },
      { role: 'tool', content: 'result1' },
    ];

    batchWriteMock.mockResolvedValueOnce({
      UnprocessedItems: {},
    });

    await runWithBackoff((chatbotDb as any).addMessagesToMessagesTable('sess1', messages, 0));

    expect(batchWriteMock).toHaveBeenCalledTimes(1);
  });

  it('should stop retrying after max retries', async () => {
    const messages = [
      { role: 'assistant', content: 'msg1' },
    ];

    const tableName = (chatbotDb as any).messagesTableName;
    const unprocessedResponse = {
      UnprocessedItems: {
        [tableName]: [
          {
            PutRequest: {
              Item: { sessionId: 'sess1', messageIndex: 0, message: messages[0] },
            },
          },
        ],
      },
    };

    // Always return unprocessed (simulate persistent throttling)
    batchWriteMock.mockResolvedValue(unprocessedResponse);

    await runWithBackoff((chatbotDb as any).addMessagesToMessagesTable('sess1', messages, 0));

    // 1 initial + 3 retries = 4 calls
    expect(batchWriteMock).toHaveBeenCalledTimes(4);
  });
});
