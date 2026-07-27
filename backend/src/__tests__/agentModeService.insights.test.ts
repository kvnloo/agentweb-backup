import { AgentModeService } from '../services/agentModeService';
import axios from 'axios';
import { promises as fs } from 'fs';
import path from 'path';

// Mock dependencies
jest.mock('axios');
jest.mock('fs', () => ({
  promises: {
    writeFile: jest.fn().mockResolvedValue(undefined),
    mkdir: jest.fn().mockResolvedValue(undefined),
    readFile: jest.fn(),
    access: jest.fn(),
    mkdtemp: jest.fn(),
  }
}));

jest.mock('../utils/s3Utils', () => ({
  uploadFileToS3: jest.fn().mockResolvedValue({
    success: true,
    url: 'https://s3.amazonaws.com/mock-bucket/mock-file.json',
    key: 'mock-key'
  })
}));

jest.mock('googleapis', () => ({
  google: {
    youtube: jest.fn(),
    drive: jest.fn(),
  }
}));

jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn().mockImplementation(() => ({
    bucket: jest.fn().mockReturnValue({
      file: jest.fn().mockReturnValue({
        exists: jest.fn().mockResolvedValue([true]),
        save: jest.fn().mockResolvedValue(undefined),
        getSignedUrl: jest.fn().mockResolvedValue(['https://mock-url']),
      }),
    }),
  })),
}));

jest.mock('openai', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    chat: {
      completions: {
        create: jest.fn().mockResolvedValue({
          choices: [{ message: { content: 'mock openai response' } }]
        }),
      },
    },
  })),
}));

jest.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: jest.fn().mockImplementation(() => ({
    getGenerativeModel: jest.fn().mockReturnValue({
      generateContent: jest.fn().mockResolvedValue({
        response: { text: () => 'mock analysis' }
      })
    })
  }))
}));

// Mock secrets manager
jest.mock('../utils/secretsManager', () => ({
  getSecret: jest.fn(),
  getMetaAccessToken: jest.fn().mockResolvedValue('mock-token'),
  getGCSPPrivateKey: jest.fn(),
}));

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    createSession: jest.fn(),
    getSessionById: jest.fn(),
  },
  searchPlatformKnowledgeBase: jest.fn(),
}));

jest.mock('../services/settingsService', () => ({
  settingsService: {
    getSettings: jest.fn(),
  },
}));

jest.mock('../services/skillService', () => ({
  skillService: {
    getSkills: jest.fn(),
  },
}));

jest.mock('../services/subscriptionService', () => ({
  getAllowedSkills: jest.fn(),
  resolveSkillsToToolNames: jest.fn(),
  filterFunctionCalls: jest.fn(),
}));

jest.mock('../mcp/client/mcpClientService', () => ({
  McpClientService: jest.fn().mockImplementation(() => ({
    isReady: jest.fn().mockReturnValue(true),
  })),
}));

jest.mock('../mcp/client/toolRegistry', () => ({
  ToolRegistry: jest.fn().mockImplementation(() => ({
    getTool: jest.fn(),
  })),
}));

// Mock DB
jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn(),
  },
  taskDb: {
    getTaskById: jest.fn(),
    createTask: jest.fn(),
    updateTask: jest.fn(),
  },
  taskTemplateDb: {
    getTemplateById: jest.fn(),
    listTemplates: jest.fn(),
  }
}));

// Mock metaService
jest.mock('../services/metaService', () => ({
  metaService: {
    getPages: jest.fn(),
    listCustomAudiences: jest.fn(),
    createCustomAudience: jest.fn(),
  },
  MetaAdsCampaignParams: jest.fn(),
  MetaAdsAdSetParams: jest.fn(),
  MetaAdsAdCreativeParams: jest.fn(),
  MetaAdsAdParams: jest.fn(),
}));

const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('AgentModeService - callMetaAdsInsightsApiWrapper', () => {
  let service: AgentModeService;
  const userId = 'user-123';
  let mockUserDb: any;
  let mockUploadFileToS3: any;

  beforeEach(async () => {
    jest.clearAllMocks();
    service = new AgentModeService();
    // Speed up polling
    jest.useFakeTimers();

    // Get the mocked userDb
    const db = await import('../services/db');
    mockUserDb = db.userDb;

    // Get the mocked uploadFileToS3
    const s3Utils = await import('../utils/s3Utils');
    mockUploadFileToS3 = s3Utils.uploadFileToS3;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('Validation', () => {
    it('should return error for invalid object_type', async () => {
      const result = await service.callMetaAdsInsightsApiWrapper(userId, {
        account_id: '123',
        object_type: 'invalid' as any,
        fields: ['impressions']
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid object_type: invalid');
    });

    it('should return error for empty fields', async () => {
      const result = await service.callMetaAdsInsightsApiWrapper(userId, {
        account_id: '123',
        object_type: 'account',
        fields: []
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('fields array is required');
    });

    it('should return error when ALL requested fields are invalid', async () => {
      const result = await service.callMetaAdsInsightsApiWrapper(userId, {
        account_id: '123',
        object_type: 'account',
        fields: ['invalid_field']
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid insights fields requested: invalid_field');
      // ENG-511: the error must steer the model away from a blind retry.
      expect(result.error).toContain('do not retry');
    });

    it('should accept cost_per_inline_link_click (ENG-511 whitelist gap)', async () => {
      mockUserDb.getUserById.mockResolvedValue({
        id: userId,
        adAccount: '922903076601160',
      });
      mockedAxios.post.mockResolvedValueOnce({
        status: 200,
        data: { report_run_id: 'report-cplc' }
      } as any);
      mockedAxios.get.mockResolvedValueOnce({
        status: 200,
        data: { async_status: 'Job Completed' }
      } as any);
      mockedAxios.get.mockResolvedValueOnce({
        status: 200,
        data: { data: [{ cost_per_inline_link_click: '1.23' }], paging: {} }
      } as any);

      const insightsPromise = service.callMetaAdsInsightsApiWrapper(userId, {
        account_id: '922903076601160',
        object_type: 'account',
        fields: ['spend', 'cost_per_inline_link_click'],
        date_preset: 'last_30d'
      });
      await jest.runAllTimersAsync();
      const result = await insightsPromise;

      expect(result.success).toBe(true);
      // The field reached Meta rather than being rejected as "invalid".
      const postArgs = mockedAxios.post.mock.calls[0][1] as any;
      expect(postArgs.fields).toContain('cost_per_inline_link_click');
      expect(result.metadata.dropped_fields).toBeUndefined();
    });

    it('should drop unknown fields, proceed with the valid subset, and report the dropped ones (ENG-511)', async () => {
      mockUserDb.getUserById.mockResolvedValue({
        id: userId,
        adAccount: '922903076601160',
      });
      mockedAxios.post.mockResolvedValueOnce({
        status: 200,
        data: { report_run_id: 'report-mixed' }
      } as any);
      mockedAxios.get.mockResolvedValueOnce({
        status: 200,
        data: { async_status: 'Job Completed' }
      } as any);
      mockedAxios.get.mockResolvedValueOnce({
        status: 200,
        data: { data: [{ impressions: '100' }], paging: {} }
      } as any);

      const insightsPromise = service.callMetaAdsInsightsApiWrapper(userId, {
        account_id: '922903076601160',
        object_type: 'account',
        fields: ['impressions', 'made_up_metric'],
        date_preset: 'last_30d'
      });
      await jest.runAllTimersAsync();
      const result = await insightsPromise;

      expect(result.success).toBe(true);
      // Only the valid field is sent to Meta; the unknown one is stripped.
      const postArgs = mockedAxios.post.mock.calls[0][1] as any;
      expect(postArgs.fields).toBe('impressions');
      expect(postArgs.fields).not.toContain('made_up_metric');
      // The dropped field is surfaced so the model does not re-request it.
      expect(result.metadata.dropped_fields).toEqual(['made_up_metric']);
    });

    it('should return error for invalid breakdowns', async () => {
      const result = await service.callMetaAdsInsightsApiWrapper(userId, {
        account_id: '123',
        object_type: 'account',
        fields: ['impressions'],
        breakdowns: ['invalid_breakdown']
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid breakdowns requested: invalid_breakdown');
    });

    it('should return error if both date_preset and time_range are provided', async () => {
      const result = await service.callMetaAdsInsightsApiWrapper(userId, {
        account_id: '123',
        object_type: 'account',
        fields: ['impressions'],
        date_preset: 'today',
        time_range: { since: '2024-01-01', until: '2024-01-02' }
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Provide either date_preset or time_range, not both.');
    });
  });

  describe('Report Execution', () => {
    const mockUser = {
      id: userId,
      connected_accounts: [
        {
          platform: 'meta',
          account_id: '922903076601160',
          account_name: 'AgentWeb Meta Ad Account',
          config: {
            access_token: 'valid-token',
            ad_account_id: '922903076601160',
            account_type: 'ad_account'
          }
        }
      ]
    };

    beforeEach(() => {
      mockUserDb.getUserById.mockResolvedValue(mockUser);
    });

    it('should submit report, poll until complete, and return results inline', async () => {
      // 1. Submit report
      mockedAxios.post.mockResolvedValueOnce({
        status: 200,
        data: { report_run_id: 'report-123' }
      } as any);

      // 2. Poll status (1st: running, 2nd: completed)
      mockedAxios.get.mockResolvedValueOnce({
        status: 200,
        data: { async_status: 'Job Running' }
      } as any);
      mockedAxios.get.mockResolvedValueOnce({
        status: 200,
        data: { async_status: 'Job Completed' }
      } as any);

      // 3. Fetch results
      mockedAxios.get.mockResolvedValueOnce({
        status: 200,
        data: {
          data: [{ impressions: '100', clicks: '10' }],
          paging: {}
        }
      } as any);

      const insightsPromise = service.callMetaAdsInsightsApiWrapper(userId, {
        account_id: '922903076601160',
        object_type: 'account',
        fields: ['impressions', 'clicks'],
        date_preset: 'last_30d'
      });

      // Fast-forward through timers
      await jest.runAllTimersAsync();

      const result = await insightsPromise;

      expect(mockedAxios.post).toHaveBeenCalled();
      expect(mockedAxios.get).toHaveBeenCalledTimes(3);
      // Data is returned inline; the wrapper must NOT do its own S3 upload
      // (large responses are offloaded later by the generic tool pipeline).
      expect(mockUploadFileToS3).not.toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.s3_url).toBeUndefined();
      expect(result.totalRows).toBe(1);
      expect(result.data).toHaveLength(1);
      expect(result.data[0].impressions).toBe('100');
      expect(result.data[0].clicks).toBe('10');
      expect(result.metadata.tool).toBe('call_meta_ads_insights_api');
      expect(result.metadata.object_type).toBe('account');
    });

    it('should handle paginated results and return them inline', async () => {
      mockedAxios.post.mockResolvedValueOnce({
        status: 200,
        data: { report_run_id: 'report-123' }
      } as any);

      mockedAxios.get.mockResolvedValueOnce({
        status: 200,
        data: { async_status: 'Job Completed' }
      } as any);

      // Page 1
      mockedAxios.get.mockResolvedValueOnce({
        status: 200,
        data: {
          data: [{ impressions: '100' }],
          paging: { next: 'https://graph.facebook.com/next-page' }
        }
      } as any);

      // Page 2
      mockedAxios.get.mockResolvedValueOnce({
        status: 200,
        data: {
          data: [{ impressions: '200' }],
          paging: {}
        }
      } as any);

      const insightsPromise = service.callMetaAdsInsightsApiWrapper(userId, {
        account_id: '922903076601160',
        object_type: 'account',
        fields: ['impressions'],
        date_preset: 'last_30d'
      });

      await jest.runAllTimersAsync();
      const result = await insightsPromise;

      expect(mockUploadFileToS3).not.toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.s3_url).toBeUndefined();
      expect(result.totalRows).toBe(2);
      expect(result.data).toHaveLength(2);
      expect(result.data[0].impressions).toBe('100');
      expect(result.data[1].impressions).toBe('200');
    });

    it('should return error if job fails', async () => {
      mockedAxios.post.mockResolvedValueOnce({
        status: 200,
        data: { report_run_id: 'report-123' }
      } as any);

      mockedAxios.get.mockResolvedValueOnce({
        status: 200,
        data: { async_status: 'Job Failed' }
      } as any);

      const insightsPromise = service.callMetaAdsInsightsApiWrapper(userId, {
        account_id: '922903076601160',
        object_type: 'account',
        fields: ['impressions'],
        date_preset: 'last_30d'
      });

      await jest.runAllTimersAsync();
      const result = await insightsPromise;
      expect(result.success).toBe(false);
      expect(result.error).toContain('Meta Insights Job failed: Job Failed');
    });

    it('should return error if polling times out', async () => {
      mockedAxios.post.mockResolvedValueOnce({
        status: 200,
        data: { report_run_id: 'report-123' }
      } as any);

      // Constantly returning running
      mockedAxios.get.mockResolvedValue({
        status: 200,
        data: { async_status: 'Job Running' }
      } as any);

      const insightsPromise = service.callMetaAdsInsightsApiWrapper(userId, {
        account_id: '922903076601160',
        object_type: 'account',
        fields: ['impressions'],
        date_preset: 'last_30d'
      });

      // Run exactly 60 times
      for (let i = 0; i < 60; i++) {
        await jest.advanceTimersByTimeAsync(10000);
      }

      const result = await insightsPromise;
      expect(result.success).toBe(false);
      expect(result.error).toContain('Meta Insights Job timed out.');
    });
  });
});
