/**
 * ENG-490: /forward-lead is public and unauthenticated by design (any generated customer
 * site's capture route must reach it with no login), and always allowed unbounded requests.
 * Before ENG-449 that only risked junk CRM leads; since ENG-449 the same flood also fires a
 * real server-side Meta CAPI send using the actual page owner's own credentials (safely
 * scoped — see metaAccountCredentials.test.ts), so it can now pollute a real customer's live
 * ad account with fake "Lead" conversions and skew their paid campaign's optimization.
 *
 * This file deliberately does NOT rely on the route's own `skip: NODE_ENV === 'test'` guard
 * (added so the OTHER forward-lead test suites, which fire far more than the request cap in
 * a single run, don't trip it) — it flips NODE_ENV for its own duration so the real limiter
 * logic actually runs.
 */

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
(process.env as any).NODE_ENV = 'production';

jest.mock('../services/db', () => ({
  crmDb: {
    getLeadListById: jest.fn(),
    getLeadByEmail: jest.fn(),
    createLead: jest.fn(),
    updateLead: jest.fn(),
    getLeadById: jest.fn(),
  },
  userDb: { getUserById: jest.fn() },
}));
jest.mock('../services/metaAccountCredentials', () => ({
  getMetaAccountCredentials: jest.fn(),
}));
jest.mock('../services/dripSequenceDb', () => ({
  dripSequenceDb: { getSequencesByAutoEnrollList: jest.fn().mockResolvedValue([]), bulkEnroll: jest.fn() },
}));
jest.mock('../services/externalCrmSyncService', () => ({
  externalCrmSyncService: { autoSyncLead: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../services/leadListAlertService', () => ({
  leadListAlertService: { notifyLeadListOwnerIfConfigured: jest.fn() },
}));
jest.mock('../services/leadCaptureFailureService', () => ({
  recordLeadCaptureFailure: jest.fn(),
}));
jest.mock('../services/agentModeService', () => ({
  agentModeService: { updateEmailDraftForLead: jest.fn(), getCrmSenders: jest.fn() },
}));
jest.mock('../services/resendService', () => ({
  resendService: { sendEmail: jest.fn(), sendSystemEmail: jest.fn().mockResolvedValue({ id: 'email_1' }) },
}));
jest.mock('../services/webhookService', () => ({
  webhookService: {
    initialize: jest.fn(), verifyWebhook: jest.fn(),
    extractEmailDomain: jest.fn(), generateEventId: jest.fn(),
  },
}));
jest.mock('../services/emailEventsDb', () => ({
  emailEventsDb: { eventExists: jest.fn(), addEmailEvent: jest.fn() },
}));

import request from 'supertest';
import express from 'express';
import { crmDb } from '../services/db';

describe('forward-lead rate limiting (ENG-490)', () => {
  let app: express.Express;

  beforeAll(() => {
    // Import the router only after NODE_ENV is flipped and mocks are registered, and
    // build a FRESH app/router per suite run so each test's own request count doesn't
    // carry over between test files (express-rate-limit's in-memory store is scoped to
    // the middleware instance created at module load).
    const webhookRouter = require('../routes/webhooks').default;
    app = express();
    app.use(express.json());
    app.use('/api/webhooks', webhookRouter);
  });

  afterAll(() => {
    (process.env as any).NODE_ENV = ORIGINAL_NODE_ENV;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    (crmDb.getLeadListById as jest.Mock).mockResolvedValue({
      listId: 'list_123', userId: 'user_123', name: 'Test List', publicAccessEnabled: true,
    });
    (crmDb.getLeadByEmail as jest.Mock).mockResolvedValue(null);
    (crmDb.createLead as jest.Mock).mockImplementation((listId: string, data: any) =>
      Promise.resolve({ leadId: `lead_${Math.random()}`, listId, ...data }),
    );
  });

  // One test, not two: express-rate-limit's in-memory store is shared by the one router
  // instance built in beforeAll, so a separate "first 20 succeed" test run before this one
  // would leave the 21st request's counter already exhausted (or a separate "21st fails"
  // test run alone wouldn't have made the first 20 real requests itself) — same window,
  // same key, must be asserted in one continuous sequence.
  it('SUCCESS then FAIL: the first 20 requests from the same address succeed, the 21st is rejected with 429', async () => {
    for (let i = 0; i < 20; i++) {
      const res = await request(app)
        .post('/api/webhooks/forward-lead')
        .send({ listId: 'list_123', email: `lead${i}@example.com` });
      expect(res.status).toBe(201);
    }

    const res = await request(app)
      .post('/api/webhooks/forward-lead')
      .send({ listId: 'list_123', email: 'lead21@example.com' });

    expect(res.status).toBe(429);
    expect(res.body.success).toBe(false);
  });
});
