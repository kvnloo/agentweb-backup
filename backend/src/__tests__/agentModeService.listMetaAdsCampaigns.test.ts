import { AgentModeService } from '../services/agentModeService';

// Mock the dependencies
jest.mock('../utils/secretsManager', () => ({
  getMetaAccessToken: jest.fn().mockResolvedValue('mock-access-token')
}));

jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn()
  }
}));

jest.mock('../mcp/client/mcpClientService', () => ({
  McpClientService: jest.fn().mockImplementation(() => ({
    isReady: jest.fn().mockReturnValue(true),
  })),
}));

describe('AgentModeService - List Meta Ads Campaigns', () => {
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

  describe('listMetaAdsCampaigns', () => {
    it('should successfully fetch and return campaigns', async () => {
      const mockUser = {
        id: 'user123',
        adAccount: '123456789'
      };

      const { userDb } = await import('../services/db');
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);

      // Mock fetch to return campaign data
      global.fetch = jest.fn().mockImplementation((url: string) => {
        if (url.includes('/campaigns')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              data: [
                {
                  id: '120208234567890123',
                  name: 'Holiday Campaign 2023',
                  status: 'ACTIVE',
                  objective: 'OUTCOME_LEADS'
                },
                {
                  id: '120208234567890124',
                  name: 'Brand Awareness Campaign',
                  status: 'ACTIVE',
                  objective: 'OUTCOME_AWARENESS'
                },
                {
                  id: '120208234567890125',
                  name: 'Retargeting Campaign',
                  status: 'PAUSED',
                  objective: 'OUTCOME_SALES'
                }
              ]
            })
          });
        }

        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: [] })
        });
      }) as jest.Mock;

      const result = await agentModeService['listMetaAdsCampaigns']('user123');

      expect(result.success).toBe(true);
      // A read that really did reach the end of the account is allowed to say so. The two
      // tests at the bottom of this file pin the other half: it must not say so otherwise.
      expect(result.message).toBe('Found 3 campaign(s) (complete list).');
      expect(result.complete).toBe(true);
      expect(result.campaigns).toHaveLength(3);
      expect(result.totalCount).toBe(3);

      // Verify campaign data structure
      expect(result.campaigns[0]).toEqual({
        id: '120208234567890123',
        name: 'Holiday Campaign 2023',
        status: 'ACTIVE',
        objective: 'OUTCOME_LEADS'
      });

      expect(result.campaigns[1]).toEqual({
        id: '120208234567890124',
        name: 'Brand Awareness Campaign',
        status: 'ACTIVE',
        objective: 'OUTCOME_AWARENESS'
      });

      expect(result.campaigns[2]).toEqual({
        id: '120208234567890125',
        name: 'Retargeting Campaign',
        status: 'PAUSED',
        objective: 'OUTCOME_SALES'
      });
    });

    it('should return empty array when no campaigns exist', async () => {
      const mockUser = {
        id: 'user123',
        adAccount: '123456789'
      };

      const { userDb } = await import('../services/db');
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);

      // Mock fetch to return empty campaigns
      global.fetch = jest.fn().mockImplementation(() => {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: [] })
        });
      }) as jest.Mock;

      const result = await agentModeService['listMetaAdsCampaigns']('user123');

      expect(result.success).toBe(true);
      expect(result.message).toBe('Found 0 campaign(s) (complete list).');
      expect(result.campaigns).toHaveLength(0);
      expect(result.totalCount).toBe(0);
    });

    it('should return error when user is not found', async () => {
      const { userDb } = await import('../services/db');
      (userDb.getUserById as jest.Mock).mockResolvedValue(null);

      const result = await agentModeService['listMetaAdsCampaigns']('user123');

      expect(result.success).toBe(false);
      expect(result.message).toBe('User not found');
      expect(result.error).toBe('User not found');
    });

    it('should return error when ad account is not configured', async () => {
      const mockUser = {
        id: 'user123',
        adAccount: ''
      };

      const { userDb } = await import('../services/db');
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);

      const result = await agentModeService['listMetaAdsCampaigns']('user123');

      expect(result.success).toBe(false);
      expect(result.message).toBe('Ad account not configured. Please configure your Meta ad account first.');
      expect(result.error).toBe('Ad account not configured');
    });

    it('should return error when access token cannot be fetched', async () => {
      const mockUser = {
        id: 'user123',
        adAccount: '123456789'
      };

      const { userDb } = await import('../services/db');
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);

      const { getMetaAccessToken } = await import('../utils/secretsManager');
      (getMetaAccessToken as jest.Mock).mockRejectedValueOnce(new Error('Failed to fetch token'));

      const result = await agentModeService['listMetaAdsCampaigns']('user123');

      expect(result.success).toBe(false);
      expect(result.message).toBe('Meta access token not configured. Please contact your administrator.');
      expect(result.error).toBe('Failed to fetch token');
    });

    it('should return error when Meta API returns an error', async () => {
      const mockUser = {
        id: 'user123',
        adAccount: '123456789'
      };

      const { userDb } = await import('../services/db');
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);

      // Mock fetch to return API error
      global.fetch = jest.fn().mockImplementation(() => {
        return Promise.resolve({
          ok: false,
          status: 401,
          json: () => Promise.resolve({
            error: {
              message: 'Invalid OAuth access token',
              code: 190, // Meta's own business code for this — never the HTTP status.
            }
          })
        });
      }) as jest.Mock;

      const result = await agentModeService['listMetaAdsCampaigns']('user123');

      expect(result.success).toBe(false);
      expect(result.message).toContain('Failed to fetch campaigns');
      expect(result.error).toBe('Invalid OAuth access token');
    });

    // ENG-1300: fetchWithRetryAndPaging previously returned the parsed error body
    // with no way for the caller to know the real HTTP status — listMetaAdsCampaigns
    // classified every Meta failure as a generic Error/bug. It now exposes the
    // response status as a non-enumerable __httpStatus field; this proves it survives
    // to the tool result and classifies correctly, distinct from Meta's business code.
    it('ENG-1300: a 401 classifies as auth/config end-to-end, not the Meta business code 190', async () => {
      const mockUser = { id: 'user123', adAccount: '123456789' };
      const { userDb } = await import('../services/db');
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);

      global.fetch = jest.fn().mockImplementation(() => {
        return Promise.resolve({
          ok: false,
          status: 401,
          json: () => Promise.resolve({
            error: { message: 'Invalid OAuth access token', code: 190 }
          })
        });
      }) as jest.Mock;

      const result = await agentModeService['listMetaAdsCampaigns']('user123');

      expect(result.success).toBe(false);
      expect(result.code).toBe(401);

      const { toolResultError } = await import('../utils/toolResultError');
      const { classifyToolErrorClass } = await import('../utils/toolErrorClassifier');
      const { classifyToolFailureType } = await import('../utils/toolFailureType');
      const classified = toolResultError(result);
      expect(classifyToolErrorClass(classified)).toBe('auth');
      expect(classifyToolFailureType(classifyToolErrorClass(classified))).toBe('config');
    });

    it('should handle pagination and return all campaigns', async () => {
      const mockUser = {
        id: 'user123',
        adAccount: '123456789'
      };

      const { userDb } = await import('../services/db');
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);

      let callCount = 0;

      // Mock fetch to return paginated data
      global.fetch = jest.fn().mockImplementation((url: string) => {
        callCount++;

        if (url.includes('/campaigns') && !url.includes('after=')) {
          // First page
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              data: [
                {
                  id: 'camp1',
                  name: 'Campaign 1',
                  status: 'ACTIVE',
                  objective: 'OUTCOME_LEADS'
                },
                {
                  id: 'camp2',
                  name: 'Campaign 2',
                  status: 'ACTIVE',
                  objective: 'OUTCOME_SALES'
                }
              ],
              paging: {
                next: 'https://graph.facebook.com/v25.0/act_123456789/campaigns?after=cursor123'
              }
            })
          });
        }

        if (url.includes('after=cursor123')) {
          // Second page
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              data: [
                {
                  id: 'camp3',
                  name: 'Campaign 3',
                  status: 'PAUSED',
                  objective: 'OUTCOME_AWARENESS'
                }
              ]
            })
          });
        }

        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: [] })
        });
      }) as jest.Mock;

      const result = await agentModeService['listMetaAdsCampaigns']('user123');

      expect(result.success).toBe(true);
      expect(result.campaigns).toHaveLength(3);
      expect(result.totalCount).toBe(3);
      expect(callCount).toBeGreaterThan(1); // Should have made multiple calls for pagination
    });

    /*
     * "(complete list)" is a guarantee, and it was being asserted on a read that could silently
     * drop pages.
     *
     * `fetchWithRetry` RETURNS a non-ok Response once its retries are exhausted rather than
     * throwing, so a persistent 429/403/400 on page 2 arrives as `{ error: {...} }` with no
     * `data` and no `paging`. The paging helper's merge guard skipped it, `pagingTruncated` was
     * never set, and the `campaignsData.error` check here only ever sees PAGE 1 — so page 1's
     * rows came back as `Found 2 campaign(s) (complete list).`
     */
    it('does not call the list complete when a later page failed to read', async () => {
      const { userDb } = await import('../services/db');
      (userDb.getUserById as jest.Mock).mockResolvedValue({ id: 'user123', adAccount: '123456789' });

      global.fetch = jest.fn().mockImplementation((url: string) => {
        if (url.includes('after=cursor123')) {
          // Retries exhausted — fetchWithRetry hands the non-ok Response straight back.
          return Promise.resolve({
            ok: false,
            status: 429,
            json: () => Promise.resolve({ error: { message: '(#4) Application request limit reached', code: 4 } }),
          });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            data: [
              { id: 'camp1', name: 'Campaign 1', status: 'ACTIVE', objective: 'OUTCOME_LEADS' },
              { id: 'camp2', name: 'Campaign 2', status: 'ACTIVE', objective: 'OUTCOME_SALES' },
            ],
            paging: { next: 'https://graph.facebook.com/v25.0/act_123456789/campaigns?after=cursor123' },
          }),
        });
      }) as jest.Mock;

      const result = await agentModeService['listMetaAdsCampaigns']('user123');

      // Page 1's rows are still returned — they were genuinely read.
      expect(result.campaigns).toHaveLength(2);
      expect(result.complete).toBe(false);
      expect(result.hasMore).toBe(true);
      expect(result.message).not.toContain('complete list');
      expect(result.message).toMatch(/INCOMPLETE/);
    });

    it('says WHY the list is short when the failed page reported a Graph error', async () => {
      const { userDb } = await import('../services/db');
      (userDb.getUserById as jest.Mock).mockResolvedValue({ id: 'user123', adAccount: '123456789' });

      global.fetch = jest.fn().mockImplementation((url: string) => {
        if (url.includes('after=cursor123')) {
          return Promise.resolve({
            ok: false,
            status: 429,
            json: () => Promise.resolve({ error: { message: '(#4) Application request limit reached', code: 4 } }),
          });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            data: [{ id: 'camp1', name: 'Campaign 1', status: 'ACTIVE', objective: 'OUTCOME_LEADS' }],
            paging: { next: 'https://graph.facebook.com/v25.0/act_123456789/campaigns?after=cursor123' },
          }),
        });
      }) as jest.Mock;

      const result = await agentModeService['listMetaAdsCampaigns']('user123');

      expect(result.message).toContain('Application request limit reached');
    });
  });
});
