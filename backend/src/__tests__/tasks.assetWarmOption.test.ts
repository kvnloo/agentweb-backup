/**
 * ENG-2840 (W2-10): `getExecutionsWithAssets(..., { warm: false })` writes no session asset cache (no background warm of uncached
 * sessions, no incremental cache update), and with `backfill: false` as well the call is a pure read: no report fetch, no classifier, no
 * write of any kind. The default (warm on) is unchanged. The last block drives POST /api/emma/user-assets (routes/emmaAssetRoutes.ts)
 * through the REAL getExecutionsWithAssets, so the MCP route's "pure read" claim is checked end to end, not only its arguments.
 */
import axios from 'axios';
import express, { Router } from 'express';
import request from 'supertest';
import { ChatbotDB, chatbotDb } from '../services/chatbotService';
import { taskDb } from '../services/db';
import { classifyReport } from '../services/reportClassificationService';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

jest.mock('aws-sdk', () => ({
  config: { update: jest.fn() },
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      get: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      put: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      query: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({ Items: [] }) }),
      update: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      delete: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      scan: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({ Items: [] }) }),
    })),
  },
  S3: jest.fn(() => ({
    upload: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({ Location: '', Key: '' }) }),
    getObject: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
    getSignedUrl: jest.fn(),
  })),
  SecretsManager: jest.fn(() => ({
    getSecretValue: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({ SecretString: '{}' }) }),
  })),
}));

jest.mock('../services/chatbotService');
jest.mock('../services/db', () => ({
  taskDb: {
    getAllTaskExecutionsByUserId: jest.fn(),
    getTasksByUserId: jest.fn(),
    updateTaskExecutionResultFiles: jest.fn(),
  },
}));
jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: 'user123', isAdmin: false };
    next();
  },
}));
jest.mock('../services/reportClassificationService', () => ({ classifyReport: jest.fn().mockResolvedValue('research') }));

const { getExecutionsWithAssets } = require('../routes/tasks');
const { registerAssetAndOutreachAccountRoutes } = require('../routes/emmaAssetRoutes');

const proto = ChatbotDB.prototype as unknown as Record<string, jest.Mock>;
const REPORT_URL = 'https://bucket.s3.amazonaws.com/u/report.html';
const TASK_REPORT_URL = 'https://bucket.s3.amazonaws.com/u/task-report.html';
const IMAGE_URL = 'https://bucket.s3.amazonaws.com/u/new.png';

/** A message that holds a generated image (the scanner finds it in toolCalls). */
const imageMessage = (index: number) => ({
  role: 'assistant',
  content: 'Generated image',
  timestamp: '2026-11-01T12:00:00Z',
  messageIndex: index,
  metadata: { portalType: 'agent', timestamp: '2026-11-01T12:00:00Z', toolCalls: [{ id: `t${index}`, name: 'generate_image', arguments: {}, result: { success: true, imageUrl: IMAGE_URL, filename: 'new.png' } }] },
});

const uncached = { sessionId: 'uncached-1', userId: 'user123', title: 'Uncached', createdAt: '2026-11-01T00:00:00Z', archived: false, messageCount: 1, messages: [] };
const cached = {
  sessionId: 'cached-1', userId: 'user123', title: 'Cached', createdAt: '2026-11-01T00:00:00Z', archived: false,
  messageCount: 3, assetScanIndex: 2,
  assetCache: { images: [], videos: [], htmlReports: [{ url: REPORT_URL, filename: 'report.html', generatedAt: '2026-11-02T00:00:00Z' }] },
  messages: [],
};

async function settle() {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** Every write and paid call the asset read could make. */
function expectNoWriteNoFetchNoClassifier() {
  expect(proto.updateAssetCache).not.toHaveBeenCalled();
  expect(proto.persistSearchableTexts).not.toHaveBeenCalled();
  expect(proto.persistReportTypes).not.toHaveBeenCalled();
  expect(taskDb.updateTaskExecutionResultFiles).not.toHaveBeenCalled();
  expect(mockedAxios.get).not.toHaveBeenCalled();
  expect(classifyReport).not.toHaveBeenCalled();
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedAxios.get.mockResolvedValue({ data: '<html><body>Report</body></html>', status: 200, statusText: 'OK', headers: {}, config: {} as any });
  proto.getSessionsWithoutMessages.mockResolvedValue([uncached, cached].map((s) => JSON.parse(JSON.stringify(s))));
  proto.getMessagesFromMessagesTable.mockResolvedValue([imageMessage(0)]);
  proto.getMessagesFromIndex.mockResolvedValue([imageMessage(2)]);
  proto.updateAssetCache.mockResolvedValue(undefined);
  proto.persistSearchableTexts.mockResolvedValue(undefined);
  proto.persistReportTypes.mockResolvedValue(undefined);
  (taskDb.updateTaskExecutionResultFiles as jest.Mock).mockResolvedValue(undefined);
  (taskDb.getAllTaskExecutionsByUserId as jest.Mock).mockResolvedValue([
    { executionId: 'e1', taskId: 't1', status: 'completed', startTime: '2026-11-03T00:00:00Z', result_files: [{ url: TASK_REPORT_URL, filename: 'task-report.html', token: '' }] },
  ]);
  (taskDb.getTasksByUserId as jest.Mock).mockResolvedValue([{ taskId: 't1', name: 'Weekly report', status: 'active' }]);
});

describe('getExecutionsWithAssets warm option', () => {
  it('default (warm on): uncached sessions are warmed in the background and their caches written (unchanged behaviour)', async () => {
    await getExecutionsWithAssets('user123', 'html-reports', '', { backfill: false });
    await settle();
    expect(proto.getMessagesFromMessagesTable).toHaveBeenCalledWith('uncached-1');
    expect(proto.updateAssetCache).toHaveBeenCalledWith('uncached-1', expect.any(Object), expect.any(Number));
    // the stale cached session is caught up and written too
    expect(proto.updateAssetCache).toHaveBeenCalledWith('cached-1', expect.any(Object), 3);
  });

  it('warm: false with backfill: false (html-reports): no warm, no cache write, no fetch, no classifier; cached and task reports still returned', async () => {
    const result = await getExecutionsWithAssets('user123', 'html-reports', '', { backfill: false, warm: false });
    await settle();
    expect(proto.getMessagesFromMessagesTable).not.toHaveBeenCalledWith('uncached-1');
    expectNoWriteNoFetchNoClassifier();
    expect(proto.getSessionsWithoutMessages).toHaveBeenCalledWith('user123', 'agent');
    expect(taskDb.getAllTaskExecutionsByUserId).toHaveBeenCalledWith('user123');
    expect(taskDb.getTasksByUserId).toHaveBeenCalledWith('user123');
    expect(result.t1.executions[0].result_files[0].url).toBe(TASK_REPORT_URL);
    expect(result['agent-mode-cached-1'].executions[0].result_files[0].url).toBe(REPORT_URL);
  });

  it('warm: false (images): sessions are still scanned (a read) but no cache is written', async () => {
    const result = await getExecutionsWithAssets('user123', 'images', '', { backfill: false, warm: false });
    await settle();
    expect(proto.getMessagesFromMessagesTable).toHaveBeenCalledWith('uncached-1');
    expect(proto.getMessagesFromIndex).toHaveBeenCalledWith('cached-1', 2);
    expectNoWriteNoFetchNoClassifier();
    expect(result['agent-mode-uncached-1'].executions[0].result_files[0].url).toBe(IMAGE_URL);
  });

  it('control: backfill on (the reports page default) does fetch and classify, so the test above would catch a regression', async () => {
    await getExecutionsWithAssets('user123', 'html-reports', '');
    await settle();
    expect(mockedAxios.get).toHaveBeenCalled();
    expect(classifyReport).toHaveBeenCalled();
  });
});

describe('POST /api/emma/user-assets through the real getExecutionsWithAssets', () => {
  const router = Router();
  router.use((req: any, _res: any, next: any) => {
    req.user = { userId: 'user123', email: 'u@example.com', isAdmin: false };
    next();
  });
  registerAssetAndOutreachAccountRoutes(router);
  const app = express();
  app.use(express.json());
  app.use('/api/emma', router);

  it('a pure read for every type: nothing written, fetched or classified; only the caller\'s own records are read', async () => {
    (chatbotDb.searchUserAssets as jest.Mock).mockResolvedValue([]);
    for (const type of [undefined, 'all', 'htmlReports', 'images', 'videos']) {
      const res = await request(app).post('/api/emma/user-assets').send(type ? { type } : {});
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    }
    await settle();
    expectNoWriteNoFetchNoClassifier();
    for (const call of (taskDb.getAllTaskExecutionsByUserId as jest.Mock).mock.calls) expect(call).toEqual(['user123']);
    for (const call of proto.getSessionsWithoutMessages.mock.calls) expect(call[0]).toBe('user123');
    for (const call of (chatbotDb.searchUserAssets as jest.Mock).mock.calls) expect(call[0]).toBe('user123');
  });

  it('returns the task report as a fixed-field asset, without session ids or searchable text', async () => {
    (chatbotDb.searchUserAssets as jest.Mock).mockResolvedValue([]);
    const res = await request(app).post('/api/emma/user-assets').send({ type: 'htmlReports' });
    expect(res.body).toStrictEqual({
      success: true, total: 1, count: 1,
      assets: [{ url: TASK_REPORT_URL, filename: 'task-report.html', asset_type: 'htmlReport', generated_at: '2026-11-03T00:00:00Z', session_title: 'Weekly report', is_favorited: false }],
    });
  });
});
