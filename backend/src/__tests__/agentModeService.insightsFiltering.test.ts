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

/**
 * ENG-630 — `call_meta_ads_insights_api` request/response contract.
 *
 * These assert the wiring: that the normalizer is actually applied to what goes
 * on the wire, and that a Meta 400 reaches the caller with its detail intact.
 */
describe('AgentModeService - callMetaAdsInsightsApiWrapper filtering + error detail', () => {
  let service: AgentModeService;
  const userId = 'user-123';
  let mockUserDb: any;

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
          account_type: 'ad_account',
        },
      },
    ],
  };

  /** Drive one full submit -> poll -> fetch cycle and return the resolved result. */
  const runReport = async (args: any) => {
    mockedAxios.post.mockResolvedValueOnce({
      status: 200,
      data: { report_run_id: 'report-123' },
    } as any);
    mockedAxios.get.mockResolvedValueOnce({
      status: 200,
      data: { async_status: 'Job Completed' },
    } as any);
    mockedAxios.get.mockResolvedValueOnce({
      status: 200,
      data: { data: [{ impressions: '100' }], paging: {} },
    } as any);

    const promise = service.callMetaAdsInsightsApiWrapper(userId, args);
    await jest.runAllTimersAsync();
    return promise;
  };

  /** The request body actually POSTed to Meta's insights endpoint. */
  const submittedBody = () => (mockedAxios.post as jest.Mock).mock.calls[0][1];

  beforeEach(async () => {
    jest.clearAllMocks();
    service = new AgentModeService();
    jest.useFakeTimers();
    const db = await import('../services/db');
    mockUserDb = db.userDb;
    mockUserDb.getUserById.mockResolvedValue(mockUser);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('AC1/AC4 — the wire always carries an array', () => {
    it('sends a JSON-string filter as a real array (the production repro)', async () => {
      const result = await runReport({
        account_id: '922903076601160',
        object_type: 'account',
        fields: ['impressions'],
        date_preset: 'last_30d',
        filtering: '[{"field":"campaign.id","operator":"IN","value":["120210000000000001"]}]',
      });

      expect(result.success).toBe(true);
      const body = submittedBody();
      expect(Array.isArray(body.filtering)).toBe(true);
      expect(typeof body.filtering).not.toBe('string');
      expect(body.filtering).toEqual([
        { field: 'campaign.id', operator: 'IN', value: ['120210000000000001'] },
      ]);
    });

    it('sends a bare filter object as a one-element array instead of dropping it', async () => {
      // Regression guard for the silent-wrong-answer path: previously
      // `filtering?.length` was undefined for an object, the key was omitted,
      // and Meta returned whole-account rows presented as campaign-scoped.
      await runReport({
        account_id: '922903076601160',
        object_type: 'account',
        fields: ['impressions'],
        date_preset: 'last_30d',
        filtering: { field: 'campaign.id', operator: 'IN', value: '120210000000000001' } as any,
      });

      const body = submittedBody();
      expect(Array.isArray(body.filtering)).toBe(true);
      expect(body.filtering).toEqual([
        { field: 'campaign.id', operator: 'IN', value: ['120210000000000001'] },
      ]);
    });

    it('reports the normalized filter back in metadata.query', async () => {
      const result = await runReport({
        account_id: '922903076601160',
        object_type: 'account',
        fields: ['impressions'],
        date_preset: 'last_30d',
        filtering: { field: 'campaign.id', operator: 'IN', value: '1' } as any,
      });

      expect(Array.isArray(result.metadata.query.filtering)).toBe(true);
    });
  });

  describe('AC2 — empty and multi-filter requests stay correct', () => {
    it('omits the filtering key entirely when no filter was requested', async () => {
      await runReport({
        account_id: '922903076601160',
        object_type: 'account',
        fields: ['impressions'],
        date_preset: 'last_30d',
      });

      expect(submittedBody()).not.toHaveProperty('filtering');
    });

    it('omits the filtering key for an empty array', async () => {
      await runReport({
        account_id: '922903076601160',
        object_type: 'account',
        fields: ['impressions'],
        date_preset: 'last_30d',
        filtering: [],
      });

      expect(submittedBody()).not.toHaveProperty('filtering');
    });

    it('forwards multiple filters in order', async () => {
      await runReport({
        account_id: '922903076601160',
        object_type: 'account',
        fields: ['impressions'],
        date_preset: 'last_30d',
        filtering: [
          { field: 'campaign.id', operator: 'IN', value: ['1', '2'] },
          { field: 'spend', operator: 'GREATER_THAN', value: 10 },
        ],
      });

      const body = submittedBody();
      expect(body.filtering).toHaveLength(2);
      expect(body.filtering[0].field).toBe('campaign.id');
      expect(body.filtering[1].field).toBe('spend');
    });
  });

  describe('an un-honourable filter fails before we spend an API call', () => {
    it('rejects a malformed filter without calling Meta', async () => {
      const result = await service.callMetaAdsInsightsApiWrapper(userId, {
        account_id: '922903076601160',
        object_type: 'account',
        fields: ['impressions'],
        date_preset: 'last_30d',
        filtering: 'not json at all' as any,
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/filtering/i);
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    it('rejects a filter entry missing its operator without calling Meta', async () => {
      const result = await service.callMetaAdsInsightsApiWrapper(userId, {
        account_id: '922903076601160',
        object_type: 'account',
        fields: ['impressions'],
        date_preset: 'last_30d',
        filtering: [{ field: 'campaign.id', value: ['1'] }] as any,
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/operator/i);
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });
  });

  describe('AC3 — a Meta 400 keeps its actionable detail', () => {
    const metaRejection = (error: Record<string, any>) =>
      Object.assign(new Error('Request failed with status code 400'), {
        isAxiosError: true,
        response: { status: 400, data: { error } },
      });

    it('surfaces Meta\'s own message rather than the axios status line', async () => {
      mockedAxios.post.mockRejectedValueOnce(
        metaRejection({
          message: '(#100) param filtering must be an array',
          type: 'OAuthException',
          code: 100,
        })
      );

      const promise = service.callMetaAdsInsightsApiWrapper(userId, {
        account_id: '922903076601160',
        object_type: 'account',
        fields: ['impressions'],
        date_preset: 'last_30d',
      });
      await jest.runAllTimersAsync();
      const result = await promise;

      expect(result.success).toBe(false);
      expect(result.error).toContain('param filtering must be an array');
      expect(result.error).not.toBe('Request failed with status code 400');
    });

    it('does not leak fbtrace_id or the access token in the surfaced error', async () => {
      mockedAxios.post.mockRejectedValueOnce(
        metaRejection({
          message: 'Invalid OAuth access token EAAsecretTokenValue123456 - cannot parse',
          code: 190,
          fbtrace_id: 'TRACEID999',
        })
      );

      const promise = service.callMetaAdsInsightsApiWrapper(userId, {
        account_id: '922903076601160',
        object_type: 'account',
        fields: ['impressions'],
        date_preset: 'last_30d',
      });
      await jest.runAllTimersAsync();
      const result = await promise;

      expect(result.success).toBe(false);
      expect(result.error).not.toContain('TRACEID999');
      expect(result.error).not.toContain('EAAsecretTokenValue123456');
    });

    it('keeps the original message when the failure is not a Graph error', async () => {
      mockedAxios.post.mockRejectedValueOnce(new Error('socket hang up'));

      const promise = service.callMetaAdsInsightsApiWrapper(userId, {
        account_id: '922903076601160',
        object_type: 'account',
        fields: ['impressions'],
        date_preset: 'last_30d',
      });
      await jest.runAllTimersAsync();
      const result = await promise;

      expect(result.success).toBe(false);
      expect(result.error).toBe('socket hang up');
    });

    it('still rethrows an auth error so the ENG-629 re-consent channel is unaffected', async () => {
      mockedAxios.post.mockRejectedValueOnce(
        Object.assign(new Error('needs reconnect'), { isMetaAuthError: true })
      );

      const assertion = expect(
        service.callMetaAdsInsightsApiWrapper(userId, {
          account_id: '922903076601160',
          object_type: 'account',
          fields: ['impressions'],
          date_preset: 'last_30d',
        })
      ).rejects.toThrow('needs reconnect');

      await jest.runAllTimersAsync();
      await assertion;
    });
  });
});
