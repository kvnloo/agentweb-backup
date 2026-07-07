/**
 * ENG-187 — /report-ui-bug threads the reporter's funnelStatus into the shared intake service
 * (which owns the Linear-side triage enrichment). intakeService is mocked here; the enrichment
 * behavior itself is covered in intakeService.funnelTriage.test.ts.
 */
import express from 'express';
import request from 'supertest';
import supportRouter from '../routes/support';

jest.mock('../services/intakeService', () => ({
  fileUserIssue: jest.fn().mockResolvedValue({
    pageId: '7', trackerUrl: 'https://fb/t/7', userUrl: 'https://fb/t/7', deduped: false, tracker: 'Featurebase',
  }),
}));
jest.mock('../services/resendService', () => ({
  resendService: { sendEmail: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../services/db', () => ({
  userDb: { getUserById: jest.fn() },
}));
jest.mock('../services/settingsService', () => ({
  settingsService: { getJsonArraySetting: jest.fn().mockResolvedValue(['founders@agentweb.pro']) },
}));
jest.mock('../utils/s3Utils', () => ({
  uploadScreenshotToS3: jest.fn(),
  presignS3Url: jest.fn().mockReturnValue('https://presigned'),
}));
jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: 'user-123', email: 'user@example.com', isAdmin: false };
    next();
  },
}));

const { fileUserIssue } = require('../services/intakeService');
const { userDb } = require('../services/db');

function buildApp() {
  const app = express();
  app.use(express.json({ limit: '15mb' }));
  app.use('/api/support', supportRouter);
  return app;
}

describe('POST /api/support/report-ui-bug — funnelStatus threading (ENG-187)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('passes the reporter user record funnelStatus through to fileUserIssue', async () => {
    userDb.getUserById.mockResolvedValue({
      userId: 'user-123', email: 'user@example.com', displayName: 'Test User',
      funnelStatus: 'paid_retention_handoff',
    });
    const res = await request(buildApp())
      .post('/api/support/report-ui-bug')
      .send({ description: 'Export breaks', reportType: 'bug' });
    expect(res.status).toBe(200);
    expect(fileUserIssue).toHaveBeenCalledWith(expect.objectContaining({
      type: 'bug',
      funnelStatus: 'paid_retention_handoff',
    }));
  });

  it('passes funnelStatus as undefined when the user record has none (still files fine)', async () => {
    userDb.getUserById.mockResolvedValue({ userId: 'user-123', email: 'user@example.com', displayName: 'Test User' });
    const res = await request(buildApp())
      .post('/api/support/report-ui-bug')
      .send({ description: 'Something broke' });
    expect(res.status).toBe(200);
    expect(fileUserIssue).toHaveBeenCalledWith(expect.objectContaining({ funnelStatus: undefined }));
  });
});
