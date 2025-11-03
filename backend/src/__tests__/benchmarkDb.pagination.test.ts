// Mock AWS SDK BEFORE importing db
jest.mock('aws-sdk', () => {
  const mockDocClient = {
    scan: jest.fn(),
    query: jest.fn(),
    get: jest.fn(),
    put: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  };
  
  return {
    DynamoDB: {
      DocumentClient: jest.fn(() => mockDocClient),
    },
    S3: jest.fn(() => ({
      putObject: jest.fn(),
      getObject: jest.fn(),
      deleteObject: jest.fn(),
    })),
    SecretsManager: jest.fn(),
    config: {
      update: jest.fn(),
    },
  };
});

import { benchmarkTestDb } from '../services/db';
import AWS from 'aws-sdk';

describe('BenchmarkTestDb - Pagination', () => {
  let mockDocClient: any;

  beforeEach(() => {
    jest.clearAllMocks();
    // Get the mocked DocumentClient instance
    const DocumentClient = AWS.DynamoDB.DocumentClient as any;
    mockDocClient = new DocumentClient();
  });

  describe('getAllBenchmarkTests', () => {
    it('should return all items when results fit in single page', async () => {
      const mockItems = [
        { testId: 'test-1', testName: 'Test 1', status: 'active' },
        { testId: 'test-2', testName: 'Test 2', status: 'active' },
        { testId: 'test-3', testName: 'Test 3', status: 'draft' },
      ];

      mockDocClient.scan.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Items: mockItems,
          // No LastEvaluatedKey means no more pages
        }),
      });

      const result = await benchmarkTestDb.getAllBenchmarkTests(100);

      expect(result).toEqual(mockItems);
      expect(result.length).toBe(3);
      expect(mockDocClient.scan).toHaveBeenCalledTimes(1);
      expect(mockDocClient.scan).toHaveBeenCalledWith(
        expect.objectContaining({
          Limit: 100,
        })
      );
    });

    it('should handle pagination across multiple pages', async () => {
      const page1Items = [
        { testId: 'test-1', testName: 'Test 1' },
        { testId: 'test-2', testName: 'Test 2' },
      ];
      const page2Items = [
        { testId: 'test-3', testName: 'Test 3' },
        { testId: 'test-4', testName: 'Test 4' },
      ];
      const page3Items = [
        { testId: 'test-5', testName: 'Test 5' },
      ];

      mockDocClient.scan
        .mockReturnValueOnce({
          promise: jest.fn().mockResolvedValue({
            Items: page1Items,
            LastEvaluatedKey: { testId: 'test-2' },
          }),
        })
        .mockReturnValueOnce({
          promise: jest.fn().mockResolvedValue({
            Items: page2Items,
            LastEvaluatedKey: { testId: 'test-4' },
          }),
        })
        .mockReturnValueOnce({
          promise: jest.fn().mockResolvedValue({
            Items: page3Items,
            // No LastEvaluatedKey - last page
          }),
        });

      const result = await benchmarkTestDb.getAllBenchmarkTests(100);

      expect(result).toEqual([...page1Items, ...page2Items, ...page3Items]);
      expect(result.length).toBe(5);
      expect(mockDocClient.scan).toHaveBeenCalledTimes(3);

      // Verify first call has no ExclusiveStartKey
      expect(mockDocClient.scan).toHaveBeenNthCalledWith(1, 
        expect.not.objectContaining({
          ExclusiveStartKey: expect.anything(),
        })
      );

      // Verify second call has ExclusiveStartKey from page 1
      expect(mockDocClient.scan).toHaveBeenNthCalledWith(2, 
        expect.objectContaining({
          ExclusiveStartKey: { testId: 'test-2' },
        })
      );

      // Verify third call has ExclusiveStartKey from page 2
      expect(mockDocClient.scan).toHaveBeenNthCalledWith(3, 
        expect.objectContaining({
          ExclusiveStartKey: { testId: 'test-4' },
        })
      );
    });

    it('should return empty array when no items exist', async () => {
      mockDocClient.scan.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Items: [],
        }),
      });

      const result = await benchmarkTestDb.getAllBenchmarkTests(100);

      expect(result).toEqual([]);
      expect(result.length).toBe(0);
      expect(mockDocClient.scan).toHaveBeenCalledTimes(1);
    });

    it('should handle empty pages in the middle of pagination', async () => {
      const page1Items = [
        { testId: 'test-1', testName: 'Test 1' },
      ];
      const page3Items = [
        { testId: 'test-3', testName: 'Test 3' },
      ];

      mockDocClient.scan
        .mockReturnValueOnce({
          promise: jest.fn().mockResolvedValue({
            Items: page1Items,
            LastEvaluatedKey: { testId: 'test-1' },
          }),
        })
        .mockReturnValueOnce({
          promise: jest.fn().mockResolvedValue({
            Items: [], // Empty page
            LastEvaluatedKey: { testId: 'test-2' },
          }),
        })
        .mockReturnValueOnce({
          promise: jest.fn().mockResolvedValue({
            Items: page3Items,
            // No LastEvaluatedKey
          }),
        });

      const result = await benchmarkTestDb.getAllBenchmarkTests(100);

      expect(result).toEqual([...page1Items, ...page3Items]);
      expect(result.length).toBe(2);
      expect(mockDocClient.scan).toHaveBeenCalledTimes(3);
    });

    it('should respect the limit parameter for page size', async () => {
      mockDocClient.scan.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Items: [{ testId: 'test-1' }],
        }),
      });

      await benchmarkTestDb.getAllBenchmarkTests(50);

      expect(mockDocClient.scan).toHaveBeenCalledWith(
        expect.objectContaining({
          Limit: 50,
        })
      );
    });

    it('should use default limit of 100 when not specified', async () => {
      mockDocClient.scan.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Items: [{ testId: 'test-1' }],
        }),
      });

      await benchmarkTestDb.getAllBenchmarkTests();

      expect(mockDocClient.scan).toHaveBeenCalledWith(
        expect.objectContaining({
          Limit: 100,
        })
      );
    });

    it('should handle DynamoDB errors gracefully', async () => {
      const dbError = new Error('DynamoDB connection failed');
      mockDocClient.scan.mockReturnValue({
        promise: jest.fn().mockRejectedValue(dbError),
      });

      await expect(benchmarkTestDb.getAllBenchmarkTests(100)).rejects.toThrow('DynamoDB connection failed');
      expect(mockDocClient.scan).toHaveBeenCalledTimes(1);
    });
  });

  describe('getBenchmarkTestsByCreator', () => {
    const createdBy = 'admin-user-123';

    it('should return all items for creator when results fit in single page', async () => {
      const mockItems = [
        { testId: 'test-1', testName: 'Test 1', createdBy, status: 'active' },
        { testId: 'test-2', testName: 'Test 2', createdBy, status: 'active' },
      ];

      mockDocClient.query.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Items: mockItems,
          // No LastEvaluatedKey means no more pages
        }),
      });

      const result = await benchmarkTestDb.getBenchmarkTestsByCreator(createdBy, 50);

      expect(result).toEqual(mockItems);
      expect(result.length).toBe(2);
      expect(mockDocClient.query).toHaveBeenCalledTimes(1);
      expect(mockDocClient.query).toHaveBeenCalledWith(
        expect.objectContaining({
          IndexName: 'CreatedByIndex',
          KeyConditionExpression: 'createdBy = :createdBy',
          ExpressionAttributeValues: {
            ':createdBy': createdBy,
          },
          ScanIndexForward: false,
          Limit: 50,
        })
      );
    });

    it('should handle pagination across multiple pages', async () => {
      const page1Items = [
        { testId: 'test-1', testName: 'Test 1', createdBy },
        { testId: 'test-2', testName: 'Test 2', createdBy },
      ];
      const page2Items = [
        { testId: 'test-3', testName: 'Test 3', createdBy },
      ];

      mockDocClient.query
        .mockReturnValueOnce({
          promise: jest.fn().mockResolvedValue({
            Items: page1Items,
            LastEvaluatedKey: { testId: 'test-2', createdBy },
          }),
        })
        .mockReturnValueOnce({
          promise: jest.fn().mockResolvedValue({
            Items: page2Items,
            // No LastEvaluatedKey - last page
          }),
        });

      const result = await benchmarkTestDb.getBenchmarkTestsByCreator(createdBy, 50);

      expect(result).toEqual([...page1Items, ...page2Items]);
      expect(result.length).toBe(3);
      expect(mockDocClient.query).toHaveBeenCalledTimes(2);

      // Verify first call has no ExclusiveStartKey
      expect(mockDocClient.query).toHaveBeenNthCalledWith(1, 
        expect.not.objectContaining({
          ExclusiveStartKey: expect.anything(),
        })
      );

      // Verify second call has ExclusiveStartKey from page 1
      expect(mockDocClient.query).toHaveBeenNthCalledWith(2, 
        expect.objectContaining({
          ExclusiveStartKey: { testId: 'test-2', createdBy },
        })
      );
    });

    it('should return empty array when creator has no tests', async () => {
      mockDocClient.query.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Items: [],
        }),
      });

      const result = await benchmarkTestDb.getBenchmarkTestsByCreator(createdBy, 50);

      expect(result).toEqual([]);
      expect(result.length).toBe(0);
      expect(mockDocClient.query).toHaveBeenCalledTimes(1);
    });

    it('should maintain descending sort order across pages', async () => {
      const page1Items = [
        { testId: 'test-3', createdAt: '2025-01-03', createdBy },
        { testId: 'test-2', createdAt: '2025-01-02', createdBy },
      ];
      const page2Items = [
        { testId: 'test-1', createdAt: '2025-01-01', createdBy },
      ];

      mockDocClient.query
        .mockReturnValueOnce({
          promise: jest.fn().mockResolvedValue({
            Items: page1Items,
            LastEvaluatedKey: { testId: 'test-2', createdBy },
          }),
        })
        .mockReturnValueOnce({
          promise: jest.fn().mockResolvedValue({
            Items: page2Items,
          }),
        });

      const result = await benchmarkTestDb.getBenchmarkTestsByCreator(createdBy, 50);

      expect(result).toEqual([...page1Items, ...page2Items]);
      // Verify sort order is maintained
      expect(result[0].testId).toBe('test-3');
      expect(result[1].testId).toBe('test-2');
      expect(result[2].testId).toBe('test-1');
    });

    it('should respect the limit parameter for page size', async () => {
      mockDocClient.query.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Items: [{ testId: 'test-1', createdBy }],
        }),
      });

      await benchmarkTestDb.getBenchmarkTestsByCreator(createdBy, 25);

      expect(mockDocClient.query).toHaveBeenCalledWith(
        expect.objectContaining({
          Limit: 25,
        })
      );
    });

    it('should use default limit of 50 when not specified', async () => {
      mockDocClient.query.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Items: [{ testId: 'test-1', createdBy }],
        }),
      });

      await benchmarkTestDb.getBenchmarkTestsByCreator(createdBy);

      expect(mockDocClient.query).toHaveBeenCalledWith(
        expect.objectContaining({
          Limit: 50,
        })
      );
    });

    it('should handle DynamoDB errors gracefully', async () => {
      const dbError = new Error('DynamoDB query failed');
      mockDocClient.query.mockReturnValue({
        promise: jest.fn().mockRejectedValue(dbError),
      });

      await expect(
        benchmarkTestDb.getBenchmarkTestsByCreator(createdBy, 50)
      ).rejects.toThrow('DynamoDB query failed');
      expect(mockDocClient.query).toHaveBeenCalledTimes(1);
    });

    it('should handle large datasets with many pages', async () => {
      // Simulate 10 pages of results
      const pages = Array.from({ length: 10 }, (_, i) => ({
        Items: [
          { testId: `test-${i * 2 + 1}`, createdBy },
          { testId: `test-${i * 2 + 2}`, createdBy },
        ],
        LastEvaluatedKey: i < 9 ? { testId: `test-${i * 2 + 2}`, createdBy } : undefined,
      }));

      pages.forEach((page, index) => {
        mockDocClient.query.mockReturnValueOnce({
          promise: jest.fn().mockResolvedValue(page),
        });
      });

      const result = await benchmarkTestDb.getBenchmarkTestsByCreator(createdBy, 50);

      expect(result.length).toBe(20);
      expect(mockDocClient.query).toHaveBeenCalledTimes(10);
      // Verify all test IDs are present
      expect(result.map(r => r.testId)).toEqual(
        Array.from({ length: 20 }, (_, i) => `test-${i + 1}`)
      );
    });
  });

  describe('Integration scenarios', () => {
    it('should handle getAllBenchmarkTests with 150 total items (2 pages)', async () => {
      const page1 = Array.from({ length: 100 }, (_, i) => ({
        testId: `test-${i + 1}`,
        testName: `Test ${i + 1}`,
      }));
      const page2 = Array.from({ length: 50 }, (_, i) => ({
        testId: `test-${i + 101}`,
        testName: `Test ${i + 101}`,
      }));

      mockDocClient.scan
        .mockReturnValueOnce({
          promise: jest.fn().mockResolvedValue({
            Items: page1,
            LastEvaluatedKey: { testId: 'test-100' },
          }),
        })
        .mockReturnValueOnce({
          promise: jest.fn().mockResolvedValue({
            Items: page2,
          }),
        });

      const result = await benchmarkTestDb.getAllBenchmarkTests(100);

      expect(result.length).toBe(150);
      expect(result[0].testId).toBe('test-1');
      expect(result[149].testId).toBe('test-150');
    });

    it('should handle getBenchmarkTestsByCreator with exactly limit items (no pagination)', async () => {
      const items = Array.from({ length: 50 }, (_, i) => ({
        testId: `test-${i + 1}`,
        createdBy: 'admin-123',
      }));

      mockDocClient.query.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Items: items,
          // No LastEvaluatedKey even though we hit the limit
        }),
      });

      const result = await benchmarkTestDb.getBenchmarkTestsByCreator('admin-123', 50);

      expect(result.length).toBe(50);
      expect(mockDocClient.query).toHaveBeenCalledTimes(1);
    });
  });
});

