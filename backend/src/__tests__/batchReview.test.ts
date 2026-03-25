const mockDocumentClientMethods = {
  put: jest.fn(),
  get: jest.fn(),
  query: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
  batchGet: jest.fn(),
};

jest.mock('aws-sdk', () => ({
  config: { update: jest.fn() },
  DynamoDB: {
    DocumentClient: jest.fn(() => mockDocumentClientMethods),
  },
  S3: jest.fn(() => ({
    upload: jest.fn(),
    getObject: jest.fn(),
    deleteObject: jest.fn(),
  })),
}));

jest.mock('uuid', () => ({
  v4: jest.fn(() => 'test-batch-uuid'),
}));

import { batchReviewDb } from '../services/batchReviewDb';
import { approvalDb } from '../services/approvalDb';

describe('BatchReviewDB', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Object.keys(mockDocumentClientMethods).forEach(method => {
      (mockDocumentClientMethods as any)[method].mockReturnValue({
        promise: jest.fn().mockResolvedValue({}),
      });
    });
  });

  describe('createBatchReview', () => {
    it('should create a batch review with assets and return it', async () => {
      mockDocumentClientMethods.put.mockReturnValue({
        promise: jest.fn().mockResolvedValue({}),
      });

      const result = await batchReviewDb.createBatchReview({
        userId: 'user-123',
        slackChannel: 'C123',
        slackChannelName: 'test-channel',
        note: 'Test note',
        assets: [
          { assetUrl: 'https://example.com/img1.png', filename: 'img1.png', assetType: 'image' },
          { assetUrl: 'https://example.com/img2.png', filename: 'img2.png', assetType: 'image' },
        ],
      });

      expect(result.batchId).toBe('test-batch-uuid');
      expect(result.userId).toBe('user-123');
      expect(result.status).toBe('pending');
      expect(result.assets).toHaveLength(2);
      expect(result.slackChannel).toBe('C123');
      expect(result.note).toBe('Test note');
      expect(result.slackMessageTs).toBeNull();
      expect(mockDocumentClientMethods.put).toHaveBeenCalledTimes(1);
    });
  });

  describe('getBatchReview', () => {
    it('should return batch review when found', async () => {
      const mockBatch = { batchId: 'batch-1', userId: 'user-1', status: 'pending', assets: [] };
      mockDocumentClientMethods.get.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Item: mockBatch }),
      });

      const result = await batchReviewDb.getBatchReview('batch-1');
      expect(result).toEqual(mockBatch);
    });

    it('should return null when batch not found', async () => {
      mockDocumentClientMethods.get.mockReturnValue({
        promise: jest.fn().mockResolvedValue({}),
      });

      const result = await batchReviewDb.getBatchReview('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('updateSlackMessageTs', () => {
    it('should update the slack message timestamp', async () => {
      mockDocumentClientMethods.update.mockReturnValue({
        promise: jest.fn().mockResolvedValue({}),
      });

      await batchReviewDb.updateSlackMessageTs('batch-1', '123456.789');
      expect(mockDocumentClientMethods.update).toHaveBeenCalledWith(
        expect.objectContaining({
          Key: { batchId: 'batch-1' },
          UpdateExpression: 'SET slackMessageTs = :ts, updatedAt = :now',
        })
      );
    });
  });

  describe('updateBatchStatus', () => {
    it('should update batch status to completed', async () => {
      mockDocumentClientMethods.update.mockReturnValue({
        promise: jest.fn().mockResolvedValue({}),
      });

      await batchReviewDb.updateBatchStatus('batch-1', 'completed');
      expect(mockDocumentClientMethods.update).toHaveBeenCalledWith(
        expect.objectContaining({
          Key: { batchId: 'batch-1' },
          ExpressionAttributeValues: expect.objectContaining({ ':status': 'completed' }),
        })
      );
    });
  });
});

describe('ApprovalDB - batchId field', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Object.keys(mockDocumentClientMethods).forEach(method => {
      (mockDocumentClientMethods as any)[method].mockReturnValue({
        promise: jest.fn().mockResolvedValue({}),
      });
    });
  });

  it('should include batchId when creating approval with batchId', async () => {
    mockDocumentClientMethods.put.mockReturnValue({
      promise: jest.fn().mockResolvedValue({}),
    });

    await approvalDb.createApproval({
      assetUrl: 'https://example.com/img.png',
      filename: 'img.png',
      assetType: 'image',
      userId: 'user-1',
      slackChannel: 'C123',
      slackChannelName: 'test',
      slackMessageTs: null,
      batchId: 'batch-123',
    });

    const putCall = mockDocumentClientMethods.put.mock.calls[0][0];
    expect(putCall.Item.batchId).toBe('batch-123');
  });

  it('should not include batchId when creating approval without batchId', async () => {
    mockDocumentClientMethods.put.mockReturnValue({
      promise: jest.fn().mockResolvedValue({}),
    });

    await approvalDb.createApproval({
      assetUrl: 'https://example.com/img.png',
      filename: 'img.png',
      assetType: 'image',
      userId: 'user-1',
      slackChannel: 'C123',
      slackChannelName: 'test',
      slackMessageTs: null,
    });

    const putCall = mockDocumentClientMethods.put.mock.calls[0][0];
    expect(putCall.Item.batchId).toBeUndefined();
  });
});
