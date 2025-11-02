import { fetchWithRetry, fetchWithRetryAndPaging } from '../utils/metaApiFetch';

describe('Meta API Fetch Utilities', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    jest.clearAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  describe('fetchWithRetry', () => {
    it('should return response on successful fetch', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: 'test' })
      }) as jest.Mock;

      const response = await fetchWithRetry('https://example.com/api');
      
      expect(response.ok).toBe(true);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('should retry on 429 rate limit error', async () => {
      let attemptCount = 0;
      
      global.fetch = jest.fn().mockImplementation(() => {
        attemptCount++;
        if (attemptCount === 1) {
          return Promise.resolve({
            ok: false,
            status: 429,
            json: () => Promise.resolve({ error: { message: 'Rate limit' } })
          });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: 'success' })
        });
      }) as jest.Mock;

      const response = await fetchWithRetry('https://example.com/api');
      
      expect(response.ok).toBe(true);
      expect(attemptCount).toBe(2);
    }, 10000);

    it('should retry on 500 server error', async () => {
      let attemptCount = 0;
      
      global.fetch = jest.fn().mockImplementation(() => {
        attemptCount++;
        if (attemptCount === 1) {
          return Promise.resolve({
            ok: false,
            status: 500,
            json: () => Promise.resolve({ error: { message: 'Server error' } })
          });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: 'success' })
        });
      }) as jest.Mock;

      const response = await fetchWithRetry('https://example.com/api');
      
      expect(response.ok).toBe(true);
      expect(attemptCount).toBe(2);
    }, 10000);

    it('should not retry on 404 error', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: () => Promise.resolve({ error: { message: 'Not found' } })
      }) as jest.Mock;

      const response = await fetchWithRetry('https://example.com/api');
      
      expect(response.ok).toBe(false);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('should give up after 3 retry attempts', async () => {
      let attemptCount = 0;
      
      global.fetch = jest.fn().mockImplementation(() => {
        attemptCount++;
        return Promise.resolve({
          ok: false,
          status: 429,
          json: () => Promise.resolve({ error: { message: 'Rate limit' } })
        });
      }) as jest.Mock;

      const response = await fetchWithRetry('https://example.com/api');
      
      expect(response.ok).toBe(false);
      expect(attemptCount).toBe(3);
    }, 15000);

    it('should retry on network error', async () => {
      let attemptCount = 0;
      
      global.fetch = jest.fn().mockImplementation(() => {
        attemptCount++;
        if (attemptCount === 1) {
          return Promise.reject(new Error('Network error'));
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: 'success' })
        });
      }) as jest.Mock;

      const response = await fetchWithRetry('https://example.com/api');
      
      expect(response.ok).toBe(true);
      expect(attemptCount).toBe(2);
    }, 10000);

    it('should throw error after exhausting retries on network error', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('Network error')) as jest.Mock;

      await expect(fetchWithRetry('https://example.com/api')).rejects.toThrow('Network error');
      expect(global.fetch).toHaveBeenCalledTimes(3);
    }, 15000);
  });

  describe('fetchWithRetryAndPaging', () => {
    it('should return data without pagination', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          data: [{ id: '1', name: 'Item 1' }]
        })
      }) as jest.Mock;

      const result = await fetchWithRetryAndPaging('https://example.com/api');
      
      expect(result.data).toEqual([{ id: '1', name: 'Item 1' }]);
      expect(result.paging).toBeUndefined();
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('should automatically fetch next page when paging.next is present', async () => {
      global.fetch = jest.fn().mockImplementation((url: string) => {
        if (url.includes('after=cursor')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              data: [{ id: '3', name: 'Item 3' }]
            })
          });
        }
        
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            data: [
              { id: '1', name: 'Item 1' },
              { id: '2', name: 'Item 2' }
            ],
            paging: {
              next: 'https://example.com/api?after=cursor'
            }
          })
        });
      }) as jest.Mock;

      const result = await fetchWithRetryAndPaging('https://example.com/api');
      
      expect(result.data).toHaveLength(3);
      expect(result.data).toEqual([
        { id: '1', name: 'Item 1' },
        { id: '2', name: 'Item 2' },
        { id: '3', name: 'Item 3' }
      ]);
      expect(result.paging).toBeUndefined();
      expect(global.fetch).toHaveBeenCalledTimes(2);
    }, 10000);

    it('should merge data from multiple pages', async () => {
      global.fetch = jest.fn().mockImplementation((url: string) => {
        if (url.includes('after=page3')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              data: [{ id: '5', name: 'Item 5' }]
            })
          });
        }
        
        if (url.includes('after=page2')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              data: [{ id: '4', name: 'Item 4' }],
              paging: {
                next: 'https://example.com/api?after=page3'
              }
            })
          });
        }
        
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            data: [
              { id: '1', name: 'Item 1' },
              { id: '2', name: 'Item 2' },
              { id: '3', name: 'Item 3' }
            ],
            paging: {
              next: 'https://example.com/api?after=page2'
            }
          })
        });
      }) as jest.Mock;

      const result = await fetchWithRetryAndPaging('https://example.com/api');
      
      expect(result.data).toHaveLength(5);
      expect(result.data[0].id).toBe('1');
      expect(result.data[4].id).toBe('5');
      expect(result.paging).toBeUndefined();
      expect(global.fetch).toHaveBeenCalledTimes(3);
    }, 15000);

    it('should handle pagination with retry on rate limit', async () => {
      let page2Attempts = 0;
      
      global.fetch = jest.fn().mockImplementation((url: string) => {
        if (url.includes('after=cursor')) {
          page2Attempts++;
          if (page2Attempts === 1) {
            return Promise.resolve({
              ok: false,
              status: 429,
              json: () => Promise.resolve({
                error: { message: 'Rate limit' }
              })
            });
          }
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              data: [{ id: '2', name: 'Item 2' }]
            })
          });
        }
        
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            data: [{ id: '1', name: 'Item 1' }],
            paging: {
              next: 'https://example.com/api?after=cursor'
            }
          })
        });
      }) as jest.Mock;

      const result = await fetchWithRetryAndPaging('https://example.com/api');
      
      expect(result.data).toHaveLength(2);
      expect(page2Attempts).toBe(2);
      expect(result.paging).toBeUndefined();
    }, 15000);

    it('should handle empty data array', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          data: []
        })
      }) as jest.Mock;

      const result = await fetchWithRetryAndPaging('https://example.com/api');
      
      expect(result.data).toEqual([]);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('should handle response without data field', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          success: true,
          message: 'Operation completed'
        })
      }) as jest.Mock;

      const result = await fetchWithRetryAndPaging('https://example.com/api');
      
      expect(result.success).toBe(true);
      expect(result.message).toBe('Operation completed');
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('Integration - Retry and Pagination', () => {
    it('should combine retry logic with pagination', async () => {
      let firstPageAttempts = 0;
      let secondPageAttempts = 0;
      
      global.fetch = jest.fn().mockImplementation((url: string) => {
        if (url.includes('after=cursor')) {
          secondPageAttempts++;
          if (secondPageAttempts === 1) {
            return Promise.resolve({
              ok: false,
              status: 500,
              json: () => Promise.resolve({
                error: { message: 'Server error' }
              })
            });
          }
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              data: [{ id: '3', name: 'Item 3' }]
            })
          });
        }
        
        firstPageAttempts++;
        if (firstPageAttempts === 1) {
          return Promise.resolve({
            ok: false,
            status: 429,
            json: () => Promise.resolve({
              error: { message: 'Rate limit' }
            })
          });
        }
        
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            data: [
              { id: '1', name: 'Item 1' },
              { id: '2', name: 'Item 2' }
            ],
            paging: {
              next: 'https://example.com/api?after=cursor'
            }
          })
        });
      }) as jest.Mock;

      const result = await fetchWithRetryAndPaging('https://example.com/api');
      
      expect(result.data).toHaveLength(3);
      expect(firstPageAttempts).toBe(2);
      expect(secondPageAttempts).toBe(2);
      expect(result.paging).toBeUndefined();
    }, 15000);
  });
});

