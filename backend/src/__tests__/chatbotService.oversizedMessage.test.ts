import { chatbotDb } from '../services/chatbotService';

// Track batchWrite calls and capture params
const batchWriteMock = jest.fn();
let lastBatchWriteParams: any = null;

// Mock AWS DynamoDB and S3
jest.mock('aws-sdk', () => {
  return {
    DynamoDB: {
      DocumentClient: jest.fn(() => ({
        batchWrite: jest.fn((params: any) => {
          lastBatchWriteParams = params;
          return { promise: batchWriteMock };
        }),
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
jest.mock('../controllers/api', () => ({ getApiDocs: jest.fn() }));
jest.mock('../controllers/user-guide', () => ({ getUserGuide: jest.fn() }));
jest.mock('../controllers/docsController', () => ({ getUserReleaseNotes: jest.fn() }));
jest.mock('../services/db', () => ({ taskDb: {} }));
jest.mock('../utils/secretsManager', () => ({ getGCSPPrivateKey: jest.fn() }));

describe('addMessagesToMessagesTable oversized message truncation', () => {
  const tableName = (chatbotDb as any).messagesTableName;

  beforeEach(() => {
    jest.clearAllMocks();
    lastBatchWriteParams = null;
  });

  it('normal messages pass through unchanged', async () => {
    const shortContent = 'Hello, this is a normal message';
    const messages = [
      { role: 'assistant', content: shortContent },
      { role: 'tool', content: 'tool result', tool_call_id: 'tc1' },
    ];

    batchWriteMock.mockResolvedValueOnce({ UnprocessedItems: {} });

    await (chatbotDb as any).addMessagesToMessagesTable('sess1', messages, 0);

    expect(batchWriteMock).toHaveBeenCalledTimes(1);

    const writeRequests = lastBatchWriteParams.RequestItems[tableName];
    expect(writeRequests).toHaveLength(2);
    expect(writeRequests[0].PutRequest.Item.message.content).toBe(shortContent);
    expect(writeRequests[1].PutRequest.Item.message.content).toBe('tool result');
  });

  it('oversized tool message content gets truncated', async () => {
    // Create a string that exceeds 350,000 chars
    const oversizedContent = 'x'.repeat(400_000);
    const messages = [
      { role: 'tool', content: oversizedContent, tool_call_id: 'tc1' },
    ];

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    batchWriteMock.mockResolvedValueOnce({ UnprocessedItems: {} });

    await (chatbotDb as any).addMessagesToMessagesTable('sess1', messages, 0);

    expect(batchWriteMock).toHaveBeenCalledTimes(1);

    const writeRequests = lastBatchWriteParams.RequestItems[tableName];
    expect(writeRequests).toHaveLength(1);

    const storedContent = writeRequests[0].PutRequest.Item.message.content as string;

    // Content should start with the truncated portion
    expect(storedContent.startsWith('x'.repeat(100))).toBe(true);
    // Content should end with truncation notice
    expect(storedContent).toContain('[Truncated — original size: 400000 chars]');
    // The truncated portion itself should be 350,000 chars (before the notice)
    expect(storedContent.startsWith('x'.repeat(350_000))).toBe(true);
    // Total length should be 350,000 + the notice suffix
    const expectedSuffix = `\n\n[Truncated — original size: 400000 chars]`;
    expect(storedContent).toBe('x'.repeat(350_000) + expectedSuffix);

    // Should have logged a warning
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('oversized content'),
    );

    warnSpy.mockRestore();
  });

  it('non-string content passes through without truncation or warning', async () => {
    const largeArray = Array.from({ length: 50_000 }, (_, i) => `item-${i}-${'y'.repeat(10)}`);
    const messages = [
      { role: 'tool', content: largeArray, tool_call_id: 'tc1' },
    ];

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    batchWriteMock.mockResolvedValueOnce({ UnprocessedItems: {} });

    await (chatbotDb as any).addMessagesToMessagesTable('sess1', messages, 0);

    expect(batchWriteMock).toHaveBeenCalledTimes(1);

    const writeRequests = lastBatchWriteParams.RequestItems[tableName];
    expect(writeRequests).toHaveLength(1);

    const storedContent = writeRequests[0].PutRequest.Item.message.content;
    expect(Array.isArray(storedContent)).toBe(true);
    expect(storedContent).toEqual(largeArray);

    // Non-string content skips the fast-path check entirely — no warning
    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });
});
