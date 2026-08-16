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

/**
 * ENG-1048: ENG-946 bounded ONLY addMessagesToMessagesTable. Three other paths
 * write a message item to AW-ChatMessages — the session→table migration, the
 * repair pass, and the single-message update — and each wrote the message raw,
 * so an oversized item still threw `ValidationException: Item size has exceeded
 * the maximum allowed size` there. Same table, same 400KB ceiling, same guard.
 */
describe('every AW-ChatMessages write path is size-bounded', () => {
  const tableName = (chatbotDb as any).messagesTableName;
  // Comfortably over the 350,000-byte budget.
  const huge = () => ({ role: 'assistant', content: 'z'.repeat(500_000) });

  beforeEach(() => {
    jest.clearAllMocks();
    lastBatchWriteParams = null;
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const fits = (message: any) =>
    Buffer.byteLength(JSON.stringify(message) ?? '', 'utf8') <= 350_000;

  // FAIL: the migration path wrote the raw message
  it('bounds messages migrated from the session record', async () => {
    batchWriteMock.mockResolvedValueOnce({ UnprocessedItems: {} });

    await (chatbotDb as any).migrateMessagesToMessagesTable('sess-migrate', [huge()]);

    const written = lastBatchWriteParams.RequestItems[tableName][0].PutRequest.Item.message;
    expect(fits(written)).toBe(true);
    expect(written.content).toContain('[Truncated — original size:');
  });

  // FAIL: the repair pass wrote the raw message
  it('bounds messages rewritten by the repair pass', async () => {
    batchWriteMock.mockResolvedValueOnce({ UnprocessedItems: {} });

    await (chatbotDb as any).updateMessagesInDatabase('sess-repair', [
      { messageIndex: 4, message: huge() },
    ]);

    const request = lastBatchWriteParams.RequestItems[tableName][0].PutRequest.Item;
    expect(request.messageIndex).toBe(4);
    expect(fits(request.message)).toBe(true);
  });

  // The guard is a ceiling, so the interesting inputs are the two messages either
  // side of it: exactly at budget must survive intact, one byte over must be shrunk.
  const atExactly = (bytes: number) => {
    const overhead = Buffer.byteLength(JSON.stringify({ role: 'assistant', content: '' }), 'utf8');
    return { role: 'assistant', content: 'z'.repeat(bytes - overhead) };
  };

  // BOUNDARY: a message sized exactly to the budget is not oversized — leave it whole
  it('writes a message that is exactly at the budget through untouched', async () => {
    const exact = atExactly(350_000);
    expect(Buffer.byteLength(JSON.stringify(exact), 'utf8')).toBe(350_000);

    batchWriteMock.mockResolvedValueOnce({ UnprocessedItems: {} });
    await (chatbotDb as any).migrateMessagesToMessagesTable('sess-exact', [exact]);

    expect(lastBatchWriteParams.RequestItems[tableName][0].PutRequest.Item.message).toBe(exact);
  });

  // BOUNDARY: one byte past the budget is oversized, on the repair path too
  it('shrinks a message that is one byte over the budget', async () => {
    const over = atExactly(350_001);

    batchWriteMock.mockResolvedValueOnce({ UnprocessedItems: {} });
    await (chatbotDb as any).updateMessagesInDatabase('sess-over', [{ messageIndex: 2, message: over }]);

    const written = lastBatchWriteParams.RequestItems[tableName][0].PutRequest.Item.message;
    expect(written).not.toBe(over);
    expect(fits(written)).toBe(true);
  });

  // ERROR PATH: the guard runs before the write, so a rejected batch still surfaces
  it('surfaces a write failure rather than reporting an oversized message as stored', async () => {
    batchWriteMock.mockRejectedValueOnce(Object.assign(new Error('throttled'), {
      code: 'ProvisionedThroughputExceededException',
    }));
    jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      (chatbotDb as any).migrateMessagesToMessagesTable('sess-fail', [huge()]),
    ).rejects.toThrow('throttled');
  });

  // SUCCESS: a message that already fits is written through untouched
  it('leaves a normal message alone on both paths', async () => {
    const small = { role: 'assistant', content: 'short answer' };

    batchWriteMock.mockResolvedValueOnce({ UnprocessedItems: {} });
    await (chatbotDb as any).migrateMessagesToMessagesTable('sess-ok', [small]);
    expect(lastBatchWriteParams.RequestItems[tableName][0].PutRequest.Item.message).toBe(small);

    batchWriteMock.mockResolvedValueOnce({ UnprocessedItems: {} });
    await (chatbotDb as any).updateMessagesInDatabase('sess-ok', [{ messageIndex: 0, message: small }]);
    expect(lastBatchWriteParams.RequestItems[tableName][0].PutRequest.Item.message).toBe(small);
  });
});
