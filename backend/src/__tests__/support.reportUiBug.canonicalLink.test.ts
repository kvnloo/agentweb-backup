/**
 * ENG-289 Desired behavior #1 for the in-app reporter (POST /report-ui-bug): an INTERNAL submitter
 * (admin, delegated-admin session, or @agentweb.pro reporter) gets the canonical Linear link back in
 * the response; an external customer does not. The internal team email always carries the link.
 */
import express from 'express';
import request from 'supertest';
import supportRouter from '../routes/support';

const CANON = 'https://linear.app/emmabyaw/issue/ENG-289';

jest.mock('../services/intakeService', () => ({
  fileUserIssue: jest.fn().mockResolvedValue({
    pageId: '7',
    trackerUrl: 'https://featurebase.example/t/7',
    userUrl: 'https://featurebase.example/t/7',
    canonicalUrl: CANON,
    deduped: false,
    tracker: 'Featurebase',
  }),
}));
jest.mock('../services/resendService', () => ({
  resendService: { sendEmail: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../services/settingsService', () => ({
  settingsService: { getJsonArraySetting: jest.fn().mockResolvedValue(['founders@agentweb.pro']) },
}));

// Mutable holders so each test controls the reporter identity + delegation.
let reporterRecord: any = { userId: 'user-123', email: 'user@example.com', displayName: 'Test User' };
let delegateInfo: any = undefined;

jest.mock('../services/db', () => ({
  userDb: { getUserById: jest.fn(async () => reporterRecord) },
}));
jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: 'user-123', email: reporterRecord.email, isAdmin: reporterRecord.isAdmin === true };
    if (delegateInfo) req.delegateInfo = delegateInfo;
    next();
  },
}));

const { resendService } = require('../services/resendService');

function buildApp() {
  const app = express();
  app.use(express.json({ limit: '15mb' }));
  app.use('/api/support', supportRouter);
  return app;
}

async function report() {
  return request(buildApp())
    .post('/api/support/report-ui-bug')
    .send({ description: 'Landing page builder keeps failing', reportType: 'bug' });
}

describe('POST /api/support/report-ui-bug — canonical link exposure (ENG-289 #1)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    reporterRecord = { userId: 'user-123', email: 'user@example.com', displayName: 'Test User' };
    delegateInfo = undefined;
  });

  it('external customer: response omits the canonical Linear link', async () => {
    const res = await report();
    expect(res.status).toBe(200);
    expect(res.body.canonicalUrl).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('linear.app');
  });

  it('internal admin reporter: response includes the canonical Linear link', async () => {
    reporterRecord = { userId: 'user-123', email: 'user@example.com', displayName: 'Admin', isAdmin: true };
    const res = await report();
    expect(res.status).toBe(200);
    expect(res.body.canonicalUrl).toBe(CANON);
  });

  it('@agentweb.pro reporter: response includes the canonical Linear link', async () => {
    reporterRecord = { userId: 'user-123', email: 'harsha@agentweb.pro', displayName: 'Harsha' };
    const res = await report();
    expect(res.status).toBe(200);
    expect(res.body.canonicalUrl).toBe(CANON);
  });

  it('delegated-admin session: response includes the canonical Linear link', async () => {
    delegateInfo = { isDelegated: true, adminEmail: 'harsha@agentweb.pro' };
    const res = await report();
    expect(res.status).toBe(200);
    expect(res.body.canonicalUrl).toBe(CANON);
  });

  it('always renders the canonical row in the internal team email, even for an external customer', async () => {
    await report();
    const html = (resendService.sendEmail as jest.Mock).mock.calls.at(-1)![0].html as string;
    expect(html).toContain(CANON);
    expect(html).toContain('Open canonical in Linear');
  });
});
