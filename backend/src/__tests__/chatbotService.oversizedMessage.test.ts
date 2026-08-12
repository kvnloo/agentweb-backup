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

  it('oversized string content gets truncated', async () => {
    // Create a string that exceeds 350,000 chars when serialized
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

    // ENG-946: the budget is the WHOLE ITEM in UTF-8 bytes, not the content string in
    // characters. The old guard sliced content to exactly 350,000 chars and ignored the
    // rest of the item, so the result could still exceed DynamoDB's 400KB limit and be
    // rejected — that is the defect, not the contract. Assert what actually matters:
    // the content is truncated, it keeps its leading data, and the ITEM fits.
    expect(storedContent.startsWith('xxx')).toBe(true);
    expect(storedContent.length).toBeLessThan(400_000);
    expect(storedContent).toContain('[Truncated — original size:');
    expect(
      Buffer.byteLength(JSON.stringify(writeRequests[0].PutRequest.Item.message), 'utf8'),
    ).toBeLessThanOrEqual(350_000);

    // Should have logged a warning
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('oversized serialized size'),
    );

    warnSpy.mockRestore();
  });

  it('oversized non-string content (array) gets serialized and truncated', async () => {
    // Large array whose JSON serialization exceeds 350,000 chars
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

    // Content should be converted to a truncated string (not the original array)
    const storedContent = writeRequests[0].PutRequest.Item.message.content;
    expect(typeof storedContent).toBe('string');
    expect(storedContent).toContain('[Truncated — original size:');

    // Should have logged a warning
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('oversized serialized size'),
    );

    warnSpy.mockRestore();
  });
});
