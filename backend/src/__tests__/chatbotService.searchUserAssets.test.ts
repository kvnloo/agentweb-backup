import { chatbotDb } from '../services/chatbotService';
import { taskDb } from '../services/db';

const queryPromiseMock = jest.fn();
const batchGetPromiseMock = jest.fn();

jest.mock('aws-sdk', () => {
  return {
    DynamoDB: {
      DocumentClient: jest.fn(() => ({
        query: jest.fn(() => ({ promise: queryPromiseMock })),
        get: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
        put: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
        update: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
        batchWrite: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
        batchGet: jest.fn(() => ({ promise: batchGetPromiseMock })),
      })),
    },
    S3: jest.fn(() => ({
      upload: jest.fn().mockReturnThis(),
      promise: jest.fn(),
    })),
    config: { update: jest.fn() },
  };
});

jest.mock('openai', () => jest.fn(() => ({})));
jest.mock('@google-cloud/discoveryengine', () => ({
  EngineServiceClient: jest.fn(),
  SearchServiceClient: jest.fn(),
}));
jest.mock('@google-cloud/storage', () => ({ Storage: jest.fn() }));
jest.mock('../controllers/guide', () => ({ getGuide: jest.fn() }));
jest.mock('../controllers/release', () => ({ getReleases: jest.fn() }));
jest.mock('../controllers/api', () => ({ getApiDocs: jest.fn() }));
jest.mock('../controllers/user-guide', () => ({ getUserGuide: jest.fn() }));
jest.mock('../controllers/docsController', () => ({ getUserReleaseNotes: jest.fn() }));
jest.mock('../services/db', () => ({
  taskDb: {
    getAllTaskExecutionsByUserId: jest.fn(),
    getTasksByUserId: jest.fn(),
  },
}));
jest.mock('../utils/secretsManager', () => ({ getGCSPPrivateKey: jest.fn() }));

const SESSION_WITH_ASSETS = {
  sessionId: 'sess-1',
  userId: 'user-1',
  portalType: 'agent',
  title: 'My Session',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
  assetCache: {
    images: [
      { url: 'https://s3.example.com/img1.png', filename: 'img1.png', generatedAt: '2026-01-02T00:00:00Z' },
      { url: 'https://s3.example.com/img2.png', filename: 'img2.png', generatedAt: '2026-01-01T00:00:00Z' },
    ],
    videos: [],
    htmlReports: [],
  },
  favorites: { 'https://s3.example.com/img1.png': true },
};

const SESSION_WITHOUT_FAVORITES = {
  sessionId: 'sess-2',
  userId: 'user-1',
  portalType: 'agent',
  title: 'Session 2',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  assetCache: {
    images: [
      { url: 'https://s3.example.com/img3.png', filename: 'img3.png', generatedAt: '2026-01-01T12:00:00Z' },
    ],
    videos: [],
    htmlReports: [],
  },
};

function mockSessions(sessions: object[]) {
  queryPromiseMock.mockResolvedValue({ Items: sessions });
}

describe('searchUserAssets', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    batchGetPromiseMock.mockResolvedValue({ Responses: {} });
    (taskDb.getAllTaskExecutionsByUserId as jest.Mock).mockResolvedValue([]);
    (taskDb.getTasksByUserId as jest.Mock).mockResolvedValue([]);
  });

  it('returns all assets with isFavorited flag when no filters applied', async () => {
    mockSessions([SESSION_WITH_ASSETS]);
    const results = await chatbotDb.searchUserAssets('user-1');
    expect(results).toHaveLength(2);
    const favorited = results.find(r => r.url === 'https://s3.example.com/img1.png');
    const notFavorited = results.find(r => r.url === 'https://s3.example.com/img2.png');
    expect(favorited?.isFavorited).toBe(true);
    expect(notFavorited?.isFavorited).toBe(false);
  });

  it('returns only favorited assets when favoritesOnly=true', async () => {
    mockSessions([SESSION_WITH_ASSETS]);
    const results = await chatbotDb.searchUserAssets('user-1', 'all', undefined, true);
    expect(results).toHaveLength(1);
    expect(results[0].url).toBe('https://s3.example.com/img1.png');
    expect(results[0].isFavorited).toBe(true);
  });

  it('returns empty array when favoritesOnly=true and no favorites exist', async () => {
    mockSessions([SESSION_WITHOUT_FAVORITES]);
    const results = await chatbotDb.searchUserAssets('user-1', 'all', undefined, true);
    expect(results).toHaveLength(0);
  });

  it('returns all assets across sessions when favoritesOnly=false', async () => {
    mockSessions([SESSION_WITH_ASSETS, SESSION_WITHOUT_FAVORITES]);
    const results = await chatbotDb.searchUserAssets('user-1', 'all', undefined, false);
    expect(results).toHaveLength(3);
  });

  it('returns only approved assets when approvedOnly=true', async () => {
    mockSessions([SESSION_WITH_ASSETS]);
    batchGetPromiseMock.mockResolvedValue({
      Responses: {
        'AW-AssetApprovals': [
          { assetUrl: 'https://s3.example.com/img1.png', status: 'approved', userId: 'user-1', filename: 'img1.png', assetType: 'image', slackChannel: 'C123', slackChannelName: 'approvals', slackMessageTs: null, createdAt: '', updatedAt: '' },
        ],
      },
    });
    const results = await chatbotDb.searchUserAssets('user-1', 'all', undefined, false, true);
    expect(results).toHaveLength(1);
    expect(results[0].url).toBe('https://s3.example.com/img1.png');
    expect(results[0].approvalStatus).toBe('approved');
  });

  it('excludes pending/rejected assets when approvedOnly=true', async () => {
    mockSessions([SESSION_WITH_ASSETS]);
    batchGetPromiseMock.mockResolvedValue({
      Responses: {
        'AW-AssetApprovals': [
          { assetUrl: 'https://s3.example.com/img1.png', status: 'pending', userId: 'user-1', filename: 'img1.png', assetType: 'image', slackChannel: 'C123', slackChannelName: 'approvals', slackMessageTs: null, createdAt: '', updatedAt: '' },
        ],
      },
    });
    const results = await chatbotDb.searchUserAssets('user-1', 'all', undefined, false, true);
    expect(results).toHaveLength(0);
  });

  it('combines favoritesOnly and approvedOnly filters', async () => {
    mockSessions([SESSION_WITH_ASSETS]);
    batchGetPromiseMock.mockResolvedValue({
      Responses: {
        'AW-AssetApprovals': [
          { assetUrl: 'https://s3.example.com/img1.png', status: 'approved', userId: 'user-1', filename: 'img1.png', assetType: 'image', slackChannel: 'C123', slackChannelName: 'approvals', slackMessageTs: null, createdAt: '', updatedAt: '' },
        ],
      },
    });
    const results = await chatbotDb.searchUserAssets('user-1', 'images', undefined, true, true);
    expect(results).toHaveLength(1);
    expect(results[0].isFavorited).toBe(true);
    expect(results[0].approvalStatus).toBe('approved');
  });

  it('returns assets sorted newest first', async () => {
    mockSessions([SESSION_WITH_ASSETS]);
    const results = await chatbotDb.searchUserAssets('user-1');
    expect(results[0].generatedAt > results[1].generatedAt).toBe(true);
  });

  it('includes isFavorited=false for assets from sessions with no favorites field', async () => {
    mockSessions([SESSION_WITHOUT_FAVORITES]);
    const results = await chatbotDb.searchUserAssets('user-1');
    expect(results).toHaveLength(1);
    expect(results[0].isFavorited).toBe(false);
  });

  it('finds HTML reports in uncached sessions by scanning messages', async () => {
    const uncachedSession = {
      sessionId: 'sess-uncached',
      userId: 'user-1',
      portalType: 'agent',
      title: 'Uncached Session',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z',
      // no assetCache
    };
    const htmlMessage = {
      messageIndex: 0,
      message: {
        role: 'tool',
        timestamp: '2026-01-02T00:00:00Z',
        metadata: {
          toolCalls: [{
            name: 'save_file',
            result: {
              file_url: 'https://agentweb-user-files.s3.us-west-2.amazonaws.com/users/user-1/files/123/abc/report.html',
              file_name: 'report.html',
            },
          }],
        },
      },
    };
    // First call returns sessions, second call returns messages for the uncached session
    queryPromiseMock
      .mockResolvedValueOnce({ Items: [uncachedSession] })
      .mockResolvedValueOnce({ Items: [htmlMessage] });
    const results = await chatbotDb.searchUserAssets('user-1', 'htmlReports');
    expect(results).toHaveLength(1);
    expect(results[0].url).toBe('https://agentweb-user-files.s3.us-west-2.amazonaws.com/users/user-1/files/123/abc/report.html');
    expect(results[0].assetType).toBe('htmlReport');
    expect(results[0].sessionId).toBe('sess-uncached');
  });

  it('skips archived sessions even when uncached', async () => {
    const archivedSession = {
      sessionId: 'sess-archived',
      userId: 'user-1',
      portalType: 'agent',
      title: 'Archived Session',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      archived: true,
      // no assetCache
    };
    queryPromiseMock.mockResolvedValueOnce({ Items: [archivedSession] });
    const results = await chatbotDb.searchUserAssets('user-1');
    expect(results).toHaveLength(0);
  });

  it('returns empty when uncached session has no matching messages', async () => {
    const uncachedSession = {
      sessionId: 'sess-empty',
      userId: 'user-1',
      portalType: 'agent',
      title: 'Empty Session',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };
    queryPromiseMock
      .mockResolvedValueOnce({ Items: [uncachedSession] })
      .mockResolvedValueOnce({ Items: [] });
    const results = await chatbotDb.searchUserAssets('user-1');
    expect(results).toHaveLength(0);
  });

  it('finds HTML reports from task execution result_files', async () => {
    queryPromiseMock.mockResolvedValueOnce({ Items: [] }); // no sessions
    (taskDb.getAllTaskExecutionsByUserId as jest.Mock).mockResolvedValue([{
      executionId: 'exec-1',
      taskId: 'task-1',
      startTime: '2026-01-05T00:00:00Z',
      archived: false,
      result_files: [{
        filename: 'html_1774280127396_xCures_Google_Search_Ads_Campaign_v6.html',
        url: 'https://agentweb-user-files.s3.us-west-2.amazonaws.com/users/user-1/files/1774280127396/abc/html_1774280127396_xCures.html',
      }],
    }]);
    (taskDb.getTasksByUserId as jest.Mock).mockResolvedValue([{
      taskId: 'task-1',
      name: 'xCures Campaign Report',
      status: 'completed',
    }]);
    const results = await chatbotDb.searchUserAssets('user-1', 'htmlReports');
    expect(results).toHaveLength(1);
    expect(results[0].assetType).toBe('htmlReport');
    expect(results[0].sessionId).toBe('task-exec-1');
    expect(results[0].sessionTitle).toBe('xCures Campaign Report');
    expect(results[0].filename).toBe('html_1774280127396_xCures_Google_Search_Ads_Campaign_v6.html');
  });

  it('filters task execution results by keyword query', async () => {
    queryPromiseMock.mockResolvedValueOnce({ Items: [] });
    (taskDb.getAllTaskExecutionsByUserId as jest.Mock).mockResolvedValue([{
      executionId: 'exec-2',
      taskId: 'task-2',
      startTime: '2026-01-05T00:00:00Z',
      archived: false,
      result_files: [
        { filename: 'xcures_report.html', url: 'https://s3.example.com/xcures_report.html' },
        { filename: 'other_report.html', url: 'https://s3.example.com/other_report.html' },
      ],
    }]);
    (taskDb.getTasksByUserId as jest.Mock).mockResolvedValue([{ taskId: 'task-2', name: 'My Task', status: 'completed' }]);
    const results = await chatbotDb.searchUserAssets('user-1', 'htmlReports', 'xcures');
    expect(results).toHaveLength(1);
    expect(results[0].filename).toBe('xcures_report.html');
  });

  it('skips archived task executions', async () => {
    queryPromiseMock.mockResolvedValueOnce({ Items: [] });
    (taskDb.getAllTaskExecutionsByUserId as jest.Mock).mockResolvedValue([{
      executionId: 'exec-3',
      taskId: 'task-3',
      startTime: '2026-01-05T00:00:00Z',
      archived: true,
      result_files: [{ filename: 'report.html', url: 'https://s3.example.com/report.html' }],
    }]);
    (taskDb.getTasksByUserId as jest.Mock).mockResolvedValue([{ taskId: 'task-3', name: 'Archived Task', status: 'completed' }]);
    const results = await chatbotDb.searchUserAssets('user-1', 'htmlReports');
    expect(results).toHaveLength(0);
  });
});
