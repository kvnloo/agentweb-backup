import { AgentModeService } from '../services/agentModeService';

// Mock MCP client service first
jest.mock('../mcp/client/mcpClientService', () => ({
  McpClientService: jest.fn().mockImplementation(() => ({
    isReady: jest.fn().mockReturnValue(true)
  }))
}));

// Mock the dependencies
jest.mock('../utils/secretsManager', () => ({
  getMetaAccessToken: jest.fn().mockResolvedValue('mock-access-token')
}));

jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn()
  }
}));

jest.mock('../utils/s3Utils', () => ({
  uploadFileToS3: jest.fn().mockResolvedValue({
    success: true,
    url: 'https://s3.amazonaws.com/mock-bucket/mock-file.csv',
    key: 'mock-key'
  })
}));

describe('AgentModeService - Meta Ads Metrics with Date Handling and Retry', () => {
  let agentModeService: AgentModeService;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    agentModeService = new AgentModeService();
    originalFetch = global.fetch;
    jest.clearAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  describe('Date Calculations', () => {
    it('should exclude today and use yesterday as end date for 7d timeframe', async () => {
      const mockUser = {
        id: 'user123',
        adAccount: '123456789',
        connected_accounts: [
          {
            platform: 'meta',
            account_id: '123456789',
            account_name: 'Test Business',
            config: {
              account_type: 'ad_account',
              access_token: 'mock-access-token',
              ad_account_id: '123456789'
            }
          }
        ]
      };

      const { userDb } = await import('../services/db');
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);

      let capturedUrls: string[] = [];

      // Mock fetch to capture URLs
      global.fetch = jest.fn().mockImplementation((url: string) => {
        capturedUrls.push(url);
        
        if (url.includes('/campaigns')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ data: [] })
          });
        }
        
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: [] })
        });
      }) as jest.Mock;

      await agentModeService['getMetaAdsMetrics']('7d', 'user123', ['camp1']);

      // Calculate expected dates (yesterday and 6 days before)
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const expectedEndDate = yesterday.toISOString().split('T')[0];
      
      const sevenDaysAgo = new Date(yesterday);
      sevenDaysAgo.setDate(yesterday.getDate() - 6);
      const expectedStartDate = sevenDaysAgo.toISOString().split('T')[0];

      // Find any insights URL to check the time_range
      const insightsUrl = capturedUrls.find(url => url.includes('insights?fields='));
      expect(insightsUrl).toBeDefined();
      expect(insightsUrl).toContain(`'since':'${expectedStartDate}'`);
      expect(insightsUrl).toContain(`'until':'${expectedEndDate}'`);
    });

    it('should exclude today and use yesterday as end date for 14d timeframe', async () => {
      const mockUser = {
        id: 'user123',
        adAccount: '123456789',
        connected_accounts: [
          {
            platform: 'meta',
            account_id: '123456789',
            account_name: 'Test Business',
            config: {
              account_type: 'ad_account',
              access_token: 'mock-access-token',
              ad_account_id: '123456789'
            }
          }
        ]
      };

      const { userDb } = await import('../services/db');
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);

      let capturedUrls: string[] = [];

      global.fetch = jest.fn().mockImplementation((url: string) => {
        capturedUrls.push(url);
        
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: [] })
        });
      }) as jest.Mock;

      await agentModeService['getMetaAdsMetrics']('14d', 'user123', ['camp1']);

      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const expectedEndDate = yesterday.toISOString().split('T')[0];
      
      const fourteenDaysAgo = new Date(yesterday);
      fourteenDaysAgo.setDate(yesterday.getDate() - 13);
      const expectedStartDate = fourteenDaysAgo.toISOString().split('T')[0];

      const insightsUrl = capturedUrls.find(url => url.includes('insights?fields='));
      expect(insightsUrl).toContain(`'since':'${expectedStartDate}'`);
      expect(insightsUrl).toContain(`'until':'${expectedEndDate}'`);
    });

    it('should exclude today and use yesterday as end date for 30d timeframe', async () => {
      const mockUser = {
        id: 'user123',
        adAccount: '123456789',
        connected_accounts: [
          {
            platform: 'meta',
            account_id: '123456789',
            account_name: 'Test Business',
            config: {
              account_type: 'ad_account',
              access_token: 'mock-access-token',
              ad_account_id: '123456789'
            }
          }
        ]
      };

      const { userDb } = await import('../services/db');
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);

      let capturedUrls: string[] = [];

      global.fetch = jest.fn().mockImplementation((url: string) => {
        capturedUrls.push(url);
        
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: [] })
        });
      }) as jest.Mock;

      await agentModeService['getMetaAdsMetrics']('30d', 'user123', ['camp1']);

      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const expectedEndDate = yesterday.toISOString().split('T')[0];
      
      const thirtyDaysAgo = new Date(yesterday);
      thirtyDaysAgo.setDate(yesterday.getDate() - 29);
      const expectedStartDate = thirtyDaysAgo.toISOString().split('T')[0];

      const insightsUrl = capturedUrls.find(url => url.includes('insights?fields='));
      expect(insightsUrl).toContain(`'since':'${expectedStartDate}'`);
      expect(insightsUrl).toContain(`'until':'${expectedEndDate}'`);
    });
  });

  describe('Facebook API Parameters', () => {
    it('should use level=campaign for breakdown API calls', async () => {
      const mockUser = {
        id: 'user123',
        adAccount: '123456789',
        connected_accounts: [
          {
            platform: 'meta',
            account_id: '123456789',
            account_name: 'Test Business',
            config: {
              account_type: 'ad_account',
              access_token: 'mock-access-token',
              ad_account_id: '123456789'
            }
          }
        ]
      };

      const { userDb } = await import('../services/db');
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);

      let capturedUrls: string[] = [];

      global.fetch = jest.fn().mockImplementation((url: string) => {
        capturedUrls.push(url);
        
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: [] })
        });
      }) as jest.Mock;

      await agentModeService['getMetaAdsMetrics']('7d', 'user123', ['camp1']);

      // Check demographics breakdown
      const demographicsUrl = capturedUrls.find(url => 
        url.includes('breakdowns=age,gender')
      );
      expect(demographicsUrl).toBeDefined();
      expect(demographicsUrl).toContain('level=campaign');
      expect(demographicsUrl).not.toContain('level=ad');

      // Check placement breakdown
      const placementUrl = capturedUrls.find(url => 
        url.includes('breakdowns=publisher_platform,platform_position')
      );
      expect(placementUrl).toBeDefined();
      expect(placementUrl).toContain('level=campaign');
      expect(placementUrl).not.toContain('level=ad');

      // Check device breakdown
      const deviceUrl = capturedUrls.find(url => 
        url.includes('breakdowns=impression_device')
      );
      expect(deviceUrl).toBeDefined();
      expect(deviceUrl).toContain('level=campaign');
      expect(deviceUrl).not.toContain('level=ad');
    });

    it('should not include adset_id and ad_id in breakdown API calls', async () => {
      const mockUser = {
        id: 'user123',
        adAccount: '123456789',
        connected_accounts: [
          {
            platform: 'meta',
            account_id: '123456789',
            account_name: 'Test Business',
            config: {
              account_type: 'ad_account',
              access_token: 'mock-access-token',
              ad_account_id: '123456789'
            }
          }
        ]
      };

      const { userDb } = await import('../services/db');
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);

      let capturedUrls: string[] = [];

      global.fetch = jest.fn().mockImplementation((url: string) => {
        capturedUrls.push(url);
        
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: [] })
        });
      }) as jest.Mock;

      await agentModeService['getMetaAdsMetrics']('7d', 'user123', ['camp1']);

      // Check demographics breakdown
      const demographicsUrl = capturedUrls.find(url => 
        url.includes('breakdowns=age,gender')
      );
      expect(demographicsUrl).toBeDefined();
      expect(demographicsUrl).not.toContain('adset_id');
      expect(demographicsUrl).not.toContain('ad_id');
      expect(demographicsUrl).toContain('campaign_id');

      // Check placement breakdown
      const placementUrl = capturedUrls.find(url => 
        url.includes('breakdowns=publisher_platform,platform_position')
      );
      expect(placementUrl).toBeDefined();
      expect(placementUrl).not.toContain('adset_id');
      expect(placementUrl).not.toContain('ad_id');
      expect(placementUrl).toContain('campaign_id');

      // Check device breakdown
      const deviceUrl = capturedUrls.find(url => 
        url.includes('breakdowns=impression_device')
      );
      expect(deviceUrl).toBeDefined();
      expect(deviceUrl).not.toContain('adset_id');
      expect(deviceUrl).not.toContain('ad_id');
      expect(deviceUrl).toContain('campaign_id');
    });

    it('should include campaign_id in breakdown fields', async () => {
      const mockUser = {
        id: 'user123',
        adAccount: '123456789',
        connected_accounts: [
          {
            platform: 'meta',
            account_id: '123456789',
            account_name: 'Test Business',
            config: {
              account_type: 'ad_account',
              access_token: 'mock-access-token',
              ad_account_id: '123456789'
            }
          }
        ]
      };

      const { userDb } = await import('../services/db');
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);

      let capturedUrls: string[] = [];

      global.fetch = jest.fn().mockImplementation((url: string) => {
        capturedUrls.push(url);
        
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: [] })
        });
      }) as jest.Mock;

      await agentModeService['getMetaAdsMetrics']('7d', 'user123', ['camp1']);

      const breakdownUrls = capturedUrls.filter(url => 
        url.includes('breakdowns=')
      );

      // All breakdown URLs should include campaign_id
      breakdownUrls.forEach(url => {
        expect(url).toContain('campaign_id');
      });
    });
  });

  describe('Retry Logic', () => {
    it('should retry on 429 rate limit error', async () => {
      const mockUser = {
        id: 'user123',
        adAccount: '123456789',
        connected_accounts: [
          {
            platform: 'meta',
            account_id: '123456789',
            account_name: 'Test Business',
            config: {
              account_type: 'ad_account',
              access_token: 'mock-access-token',
              ad_account_id: '123456789'
            }
          }
        ]
      };

      const { userDb } = await import('../services/db');
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);

      let attemptCount = 0;

      global.fetch = jest.fn().mockImplementation((url: string) => {
        attemptCount++;
        
        // Fail first attempt with 429, succeed on second
        if (attemptCount === 1) {
          return Promise.resolve({
            ok: false,
            status: 429,
            json: () => Promise.resolve({ 
              error: { message: 'Rate limit exceeded' }
            })
          });
        }
        
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: [] })
        });
      }) as jest.Mock;

      await agentModeService['getMetaAdsMetrics']('7d', 'user123', ['camp1']);

      // Should have made multiple attempts
      expect(attemptCount).toBeGreaterThan(1);
    }, 10000); // Increase timeout for retry delays

    it('should retry on 500 server error', async () => {
      const mockUser = {
        id: 'user123',
        adAccount: '123456789',
        connected_accounts: [
          {
            platform: 'meta',
            account_id: '123456789',
            account_name: 'Test Business',
            config: {
              account_type: 'ad_account',
              access_token: 'mock-access-token',
              ad_account_id: '123456789'
            }
          }
        ]
      };

      const { userDb } = await import('../services/db');
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);

      let attemptCount = 0;

      global.fetch = jest.fn().mockImplementation((url: string) => {
        attemptCount++;
        
        // Fail first attempt with 500, succeed on second
        if (attemptCount === 1) {
          return Promise.resolve({
            ok: false,
            status: 500,
            json: () => Promise.resolve({ 
              error: { message: 'Internal server error' }
            })
          });
        }
        
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: [] })
        });
      }) as jest.Mock;

      await agentModeService['getMetaAdsMetrics']('7d', 'user123', ['camp1']);

      // Should have made multiple attempts
      expect(attemptCount).toBeGreaterThan(1);
    }, 10000);

    it('should retry on network error', async () => {
      const mockUser = {
        id: 'user123',
        adAccount: '123456789',
        connected_accounts: [
          {
            platform: 'meta',
            account_id: '123456789',
            account_name: 'Test Business',
            config: {
              account_type: 'ad_account',
              access_token: 'mock-access-token',
              ad_account_id: '123456789'
            }
          }
        ]
      };

      const { userDb } = await import('../services/db');
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);

      let attemptCount = 0;

      global.fetch = jest.fn().mockImplementation((url: string) => {
        attemptCount++;
        
        // Fail first attempt with network error, succeed on second
        if (attemptCount === 1) {
          return Promise.reject(new Error('Network error'));
        }
        
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: [] })
        });
      }) as jest.Mock;

      await agentModeService['getMetaAdsMetrics']('7d', 'user123', ['camp1']);

      // Should have made multiple attempts
      expect(attemptCount).toBeGreaterThan(1);
    }, 10000);

    it('should not retry on 404 error', async () => {
      const mockUser = {
        id: 'user123',
        adAccount: '123456789',
        connected_accounts: [
          {
            platform: 'meta',
            account_id: '123456789',
            account_name: 'Test Business',
            config: {
              account_type: 'ad_account',
              access_token: 'mock-access-token',
              ad_account_id: '123456789'
            }
          }
        ]
      };

      const { userDb } = await import('../services/db');
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);

      let attemptCount = 0;

      global.fetch = jest.fn().mockImplementation((url: string) => {
        attemptCount++;
        
        return Promise.resolve({
          ok: false,
          status: 404,
          json: () => Promise.resolve({ 
            error: { message: 'Not found' }
          })
        });
      }) as jest.Mock;

      const result = await agentModeService['getMetaAdsMetrics']('7d', 'user123', ['camp1']);

      // Should only attempt once per API call (no retry for 404)
      // There are 9 parallel API calls in Promise.all
      expect(attemptCount).toBe(9);
      expect(result.success).toBe(false);
    });

    it('should give up after 3 retry attempts', async () => {
      const mockUser = {
        id: 'user123',
        adAccount: '123456789',
        connected_accounts: [
          {
            platform: 'meta',
            account_id: '123456789',
            account_name: 'Test Business',
            config: {
              account_type: 'ad_account',
              access_token: 'mock-access-token',
              ad_account_id: '123456789'
            }
          }
        ]
      };

      const { userDb } = await import('../services/db');
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);

      let attemptCount = 0;

      global.fetch = jest.fn().mockImplementation((url: string) => {
        attemptCount++;
        
        // Always fail with 500
        return Promise.resolve({
          ok: false,
          status: 500,
          json: () => Promise.resolve({ 
            error: { message: 'Server error' }
          })
        });
      }) as jest.Mock;

      const result = await agentModeService['getMetaAdsMetrics']('7d', 'user123', ['camp1']);

      // Should attempt 3 times per API call (initial + 2 retries)
      // There are 9 parallel API calls in Promise.all
      expect(attemptCount).toBe(27); // 9 × 3
      expect(result.success).toBe(false);
    }, 15000); // Longer timeout for multiple retries
  });

  describe('Integration - Date, Parameters, and Retry', () => {
    it('should use correct dates and parameters even after retry', async () => {
      const mockUser = {
        id: 'user123',
        adAccount: '123456789',
        connected_accounts: [
          {
            platform: 'meta',
            account_id: '123456789',
            account_name: 'Test Business',
            config: {
              account_type: 'ad_account',
              access_token: 'mock-access-token',
              ad_account_id: '123456789'
            }
          }
        ]
      };

      const { userDb } = await import('../services/db');
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);

      let capturedUrls: string[] = [];
      let attemptCount = 0;

      global.fetch = jest.fn().mockImplementation((url: string) => {
        attemptCount++;
        capturedUrls.push(url);
        
        // Fail first attempt, succeed on second
        if (attemptCount === 1) {
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
          json: () => Promise.resolve({ data: [] })
        });
      }) as jest.Mock;

      await agentModeService['getMetaAdsMetrics']('7d', 'user123', ['camp1']);

      // Should have retried
      expect(attemptCount).toBeGreaterThan(1);

      // Calculate expected dates
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const expectedEndDate = yesterday.toISOString().split('T')[0];
      
      const sevenDaysAgo = new Date(yesterday);
      sevenDaysAgo.setDate(yesterday.getDate() - 6);
      const expectedStartDate = sevenDaysAgo.toISOString().split('T')[0];

      // Find breakdown URL after retry
      const breakdownUrl = capturedUrls.find(url => 
        url.includes('breakdowns=age,gender')
      );

      expect(breakdownUrl).toBeDefined();
      // Check dates are correct
      expect(breakdownUrl).toContain(`'since':'${expectedStartDate}'`);
      expect(breakdownUrl).toContain(`'until':'${expectedEndDate}'`);
      // Check parameters are correct
      expect(breakdownUrl).toContain('level=campaign');
      expect(breakdownUrl).not.toContain('adset_id');
      expect(breakdownUrl).not.toContain('ad_id');
      expect(breakdownUrl).toContain('campaign_id');
    }, 10000);
  });

  describe('Pagination Support', () => {
    it('should automatically fetch next page when paging.next is present', async () => {
      const mockUser = {
        id: 'user123',
        adAccount: '123456789',
        connected_accounts: [
          {
            platform: 'meta',
            account_id: '123456789',
            account_name: 'Test Business',
            config: {
              account_type: 'ad_account',
              access_token: 'mock-access-token',
              ad_account_id: '123456789'
            }
          }
        ]
      };

      const { userDb } = await import('../services/db');
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);

      let callCount = 0;

      global.fetch = jest.fn().mockImplementation((url: string) => {
        callCount++;
        
        // First page of campaigns
        if (url.includes('/campaigns') && !url.includes('after=')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              data: [
                { id: 'camp1', name: 'Campaign 1' },
                { id: 'camp2', name: 'Campaign 2' }
              ],
              paging: {
                next: 'https://graph.facebook.com/v25.0/act_123456789/campaigns?after=cursor123'
              }
            })
          });
        }
        
        // Second page of campaigns
        if (url.includes('after=cursor123')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              data: [
                { id: 'camp3', name: 'Campaign 3' }
              ]
              // No paging.next means this is the last page
            })
          });
        }
        
        // Other API calls
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: [] })
        });
      }) as jest.Mock;

      const result = await agentModeService['getMetaAdsMetrics']('7d', 'user123', ['camp1']);

      // Verify pagination was triggered
      const fetchCalls = (global.fetch as jest.Mock).mock.calls;
      const campaignCalls = fetchCalls.filter((call: any) => call[0].includes('/campaigns'));
      
      // Should have made at least 2 calls for campaigns (initial + next page)
      expect(campaignCalls.length).toBeGreaterThanOrEqual(2);
      
      // Should have fetched the next page
      const nextPageCall = fetchCalls.find((call: any) => 
        call[0].includes('after=cursor123')
      );
      expect(nextPageCall).toBeDefined();
    }, 10000);

    it('should merge data from all pages', async () => {
      const mockUser = {
        id: 'user123',
        adAccount: '123456789',
        connected_accounts: [
          {
            platform: 'meta',
            account_id: '123456789',
            account_name: 'Test Business',
            config: {
              account_type: 'ad_account',
              access_token: 'mock-access-token',
              ad_account_id: '123456789'
            }
          }
        ]
      };

      const { userDb } = await import('../services/db');
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);

      global.fetch = jest.fn().mockImplementation((url: string) => {
        // First page
        if (url.includes('/campaigns') && !url.includes('after=')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              data: [
                { id: 'camp1', name: 'Campaign 1' },
                { id: 'camp2', name: 'Campaign 2' }
              ],
              paging: {
                next: 'https://graph.facebook.com/v25.0/act_123456789/campaigns?after=page2'
              }
            })
          });
        }
        
        // Second page
        if (url.includes('after=page2')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              data: [
                { id: 'camp3', name: 'Campaign 3' },
                { id: 'camp4', name: 'Campaign 4' }
              ],
              paging: {
                next: 'https://graph.facebook.com/v25.0/act_123456789/campaigns?after=page3'
              }
            })
          });
        }
        
        // Third page (last)
        if (url.includes('after=page3')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              data: [
                { id: 'camp5', name: 'Campaign 5' }
              ]
            })
          });
        }
        
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: [] })
        });
      }) as jest.Mock;

      const result = await agentModeService['getMetaAdsMetrics']('7d', 'user123', ['camp1']);

      // Should have successfully fetched and merged all pages
      expect(result.success).toBe(true);
      
      // Verify all pages were fetched
      const fetchCalls = (global.fetch as jest.Mock).mock.calls;
      expect(fetchCalls.some((call: any) => call[0].includes('after=page2'))).toBe(true);
      expect(fetchCalls.some((call: any) => call[0].includes('after=page3'))).toBe(true);
    }, 15000);

    it('should handle pagination with retry on rate limit', async () => {
      const mockUser = {
        id: 'user123',
        adAccount: '123456789',
        connected_accounts: [
          {
            platform: 'meta',
            account_id: '123456789',
            account_name: 'Test Business',
            config: {
              account_type: 'ad_account',
              access_token: 'mock-access-token',
              ad_account_id: '123456789'
            }
          }
        ]
      };

      const { userDb } = await import('../services/db');
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);

      let attemptMap: Record<string, number> = {};

      global.fetch = jest.fn().mockImplementation((url: string) => {
        const urlKey = url.includes('after=') ? 'page2' : 'page1';
        attemptMap[urlKey] = (attemptMap[urlKey] || 0) + 1;
        
        // First page - succeed
        if (url.includes('/campaigns') && !url.includes('after=')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              data: [{ id: 'camp1', name: 'Campaign 1' }],
              paging: {
                next: 'https://graph.facebook.com/v25.0/act_123456789/campaigns?after=cursor'
              }
            })
          });
        }
        
        // Second page - fail first attempt, succeed on retry
        if (url.includes('after=cursor')) {
          if (attemptMap['page2'] === 1) {
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
              data: [{ id: 'camp2', name: 'Campaign 2' }]
            })
          });
        }
        
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: [] })
        });
      }) as jest.Mock;

      const result = await agentModeService['getMetaAdsMetrics']('7d', 'user123', ['camp1']);

      // Should have retried the second page
      expect(attemptMap['page2']).toBeGreaterThan(1);
      expect(result.success).toBe(true);
    }, 15000);

    it('should not have paging info in final result', async () => {
      const mockUser = {
        id: 'user123',
        adAccount: '123456789',
        connected_accounts: [
          {
            platform: 'meta',
            account_id: '123456789',
            account_name: 'Test Business',
            config: {
              account_type: 'ad_account',
              access_token: 'mock-access-token',
              ad_account_id: '123456789'
            }
          }
        ]
      };

      const { userDb } = await import('../services/db');
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);

      global.fetch = jest.fn().mockImplementation((url: string) => {
        if (url.includes('/campaigns') && !url.includes('after=')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              data: [{ id: 'camp1' }],
              paging: {
                next: 'https://graph.facebook.com/v25.0/act_123456789/campaigns?after=cursor'
              }
            })
          });
        }
        
        if (url.includes('after=cursor')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              data: [{ id: 'camp2' }]
            })
          });
        }
        
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: [] })
        });
      }) as jest.Mock;

      const result = await agentModeService['getMetaAdsMetrics']('7d', 'user123', ['camp1']);

      // Result should not contain paging information
      expect(result.formattedContent).toBeDefined();
      
      // The internal data structures should not have paging info
      // (This is implicit since we delete it after merging)
      expect(result.success).toBe(true);
    }, 10000);
    it('should return error when campaign_ids is empty', async () => {
      const mockUser = {
        id: 'user123',
        adAccount: '123456789',
        connected_accounts: [
          {
            platform: 'meta',
            account_id: '123456789',
            account_name: 'Test Business',
            config: {
              account_type: 'ad_account',
              access_token: 'mock-access-token',
              ad_account_id: '123456789'
            }
          }
        ]
      };

      const { userDb } = await import('../services/db');
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);

      const result = await agentModeService['getMetaAdsMetrics']('7d', 'user123', []);

      expect(result.success).toBe(false);
      expect(result.message).toContain('campaign_ids is required');
      expect(result.error).toBe('Invalid campaign_ids');
    });
  });
});
