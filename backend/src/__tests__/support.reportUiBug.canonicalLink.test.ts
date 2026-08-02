/**
 * ENG-289 (in-app "Report a Bug" REST route, POST /report-ui-bug): surfacing the canonical Linear
 * link to admins is Emma-chat-only. This route must NEVER return the Linear link in its response
 * (no frontend renders it, and we don't want it on a customer-facing surface) — regardless of
 * whether the reporter is an admin or a delegated session. The internal team notification email,
 * however, still carries the Linear canonical row.
 */
import express from 'express';
import request from 'supertest';
import supportRouter from '../routes/support';
import { __resetReportIdempotencyForTests } from '../utils/reportIntake';

const CANON ='https://linear.app/emmabyaw/issue/ENG-289';

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

describe('POST /api/support/report-ui-bug — canonical link is NOT exposed in the response (ENG-289, chat-only)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Every case here submits the SAME report text as the same user, which the ENG-529 replay
    // guard would (correctly) collapse onto one filing — reset it so each case files for real.
    __resetReportIdempotencyForTests();
    reporterRecord = { userId: 'user-123', email: 'user@example.com', displayName: 'Test User' };
    delegateInfo = undefined;
  });

  it('external customer: response omits the canonical Linear link', async () => {
    const res = await report();
    expect(res.status).toBe(200);
    expect(res.body.canonicalUrl).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('linear.app');
  });

  it('admin reporter: response STILL omits the canonical Linear link (surfacing is chat-only)', async () => {
    reporterRecord = { userId: 'user-123', email: 'user@example.com', displayName: 'Admin', isAdmin: true };
    const res = await report();
    expect(res.status).toBe(200);
    expect(res.body.canonicalUrl).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('linear.app');
  });

  it('delegated-admin session: response STILL omits the canonical Linear link', async () => {
    delegateInfo = { isDelegated: true, adminEmail: 'harsha@agentweb.pro' };
    const res = await report();
    expect(res.status).toBe(200);
    expect(res.body.canonicalUrl).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('linear.app');
  });

  it('the internal team email still renders the Linear canonical row', async () => {
    await report();
    const html = (resendService.sendEmail as jest.Mock).mock.calls.at(-1)![0].html as string;
    expect(html).toContain(CANON);
    expect(html).toContain('Open canonical in Linear');
  });
});
