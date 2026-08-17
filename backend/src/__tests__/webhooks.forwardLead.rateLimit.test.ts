/**
 * ENG-492: forward-lead's lead-SAVE path is never rate-limited — a real customer's real lead
 * must never be rejected, no matter how large a legitimate traffic spike (viral post, big ad
 * spend, a featured TV segment can all blow past any fixed request-count we'd pick). An
 * earlier version of this fix gated the whole request; that was reverted after live-testing
 * surfaced two problems: (1) a big enough customer's own real traffic could eventually hit
 * the cap and lose real leads, and (2) this app never configures Express's `trust proxy`
 * (ENG-493), so an IP-keyed limiter would collapse to one shared bucket for every caller.
 *
 * Instead, only the optional, best-effort Meta CAPI send is budgeted (shouldAttemptCapiSend,
 * keyed by listId) — before ENG-449, unbounded abuse here only created junk CRM leads; since
 * ENG-449, pixelId/metaAccountId also flow through to a real server-side Meta CAPI send using
 * the actual page owner's own access token (safely scoped — see metaAccountCredentials.test.ts
 * — so this can't leak a different customer's credentials), which means a scripted flood can
 * pollute a real customer's live ad account with fake "Lead" conversions. Hitting the budget
 * has ZERO customer-visible effect: the lead still saves normally and the response is still
 * 201 — the only consequence is that this one submission doesn't get forwarded to Meta.
 */

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
jest.mock('../services/metaService', () => ({
  metaService: { sendCapiLeadEvent: jest.fn() },
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
import { createServer, Server } from 'http';
import webhookRouter from '../routes/webhooks';
import { crmDb, userDb } from '../services/db';
import { metaService } from '../services/metaService';
import { getMetaAccountCredentials } from '../services/metaAccountCredentials';
import { dripSequenceDb } from '../services/dripSequenceDb';
import { externalCrmSyncService } from '../services/externalCrmSyncService';
import { leadListAlertService } from '../services/leadListAlertService';

const app = express();
app.use(express.json());
app.use('/api/webhooks', webhookRouter);
let rateLimitTestServer: Server;

beforeAll(async () => {
  rateLimitTestServer = createServer(app);
  await new Promise<void>((resolve, reject) => {
    rateLimitTestServer.once('error', reject);
    rateLimitTestServer.listen(0, '127.0.0.1', () => {
      rateLimitTestServer.off('error', reject);
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    rateLimitTestServer.close((error) => (error ? reject(error) : resolve()));
  });
});

const flushAsyncWork = async () => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
};

describe('forward-lead: lead save is never rate-limited (ENG-492)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (crmDb.getLeadListById as jest.Mock).mockImplementation((listId: string) =>
      Promise.resolve({ listId, userId: 'user_123', name: 'Test List', publicAccessEnabled: true }),
    );
    (crmDb.getLeadByEmail as jest.Mock).mockResolvedValue(null);
    (crmDb.createLead as jest.Mock).mockImplementation((listId: string, data: any) =>
      Promise.resolve({ leadId: `lead_${Math.random()}`, listId, ...data }),
    );
  });

  it('SUCCESS: more than 100 submissions to the same list in one window all still save and get a 201 — none are ever rejected', async () => {
    for (let i = 0; i < 105; i++) {
      const res = await request(rateLimitTestServer)
        .post('/api/webhooks/forward-lead')
        .send({ listId: 'list_high_volume_real_customer', email: `real-lead-${i}@example.com` });
      expect(res.status).toBe(201);
    }
  });
});

describe('forward-lead: CAPI send is budgeted per listId, independent of the lead save (ENG-492)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (crmDb.getLeadListById as jest.Mock).mockImplementation((listId: string) =>
      Promise.resolve({ listId, userId: 'user_123', name: 'Test List', publicAccessEnabled: true }),
    );
    (crmDb.getLeadByEmail as jest.Mock).mockResolvedValue(null);
    (crmDb.createLead as jest.Mock).mockImplementation((listId: string, data: any) =>
      Promise.resolve({ leadId: `lead_${Math.random()}`, listId, ...data }),
    );
    (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'user_123', connected_accounts: [] });
    (getMetaAccountCredentials as jest.Mock).mockResolvedValue({ accountId: 'acc1', accessToken: 'tok', accountName: 'Acc 1' });
    (metaService.sendCapiLeadEvent as jest.Mock).mockResolvedValue({ success: true });
  });

  const sendWithCapiFields = (listId: string, email: string) =>
    request(rateLimitTestServer).post('/api/webhooks/forward-lead').send({
      listId,
      email,
      pixelId: '1430870751246428',
      metaAccountId: 'acc1',
      eventId: `evt_${email}`,
    });

  describe('persistent suite transport', () => {
    it('owns one server for the suite instead of constructing a listener per request', () => {
      expect(rateLimitTestServer).toBeDefined();
    });

    it('keeps the shared listener open while budget assertions run', () => {
      expect(rateLimitTestServer.listening).toBe(true);
    });

    it('does not bind new listeners for repeated submissions', async () => {
      const listenSpy = jest.spyOn(Server.prototype, 'listen');

      try {
        await sendWithCapiFields('list_transport_stability', 'one@example.com');
        await sendWithCapiFields('list_transport_stability', 'two@example.com');
        expect(listenSpy).not.toHaveBeenCalled();
      } finally {
        listenSpy.mockRestore();
      }
    });
  });

  it('FAIL: the 101st CAPI-eligible submission to the same list in one window still saves (201), does NOT attempt the CAPI send, and logs the overflow for visibility', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const listId = 'list_capi_flood_target';
    for (let i = 0; i < 100; i++) {
      const res = await sendWithCapiFields(listId, `lead${i}@example.com`);
      expect(res.status).toBe(201);
    }
    await flushAsyncWork();
    expect(metaService.sendCapiLeadEvent).toHaveBeenCalledTimes(100);

    const res = await sendWithCapiFields(listId, 'lead101@example.com');
    await flushAsyncWork();

    expect(res.status).toBe(201); // the lead itself still saves, always
    expect(metaService.sendCapiLeadEvent).toHaveBeenCalledTimes(100); // not 101 — budget held
    // Silent skips would be un-tunable — must be visible in logs so a real customer
    // legitimately hitting this can actually be noticed and the budget adjusted.
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(`[CAPI] Send budget exhausted for list ${listId}`));
    warnSpy.mockRestore();
  });

  it("SUCCESS: a CAPI-send budget exhausted for one listId does not affect a DIFFERENT listId's CAPI budget", async () => {
    const floodedList = 'list_capi_flood_target_2';
    for (let i = 0; i < 100; i++) {
      await sendWithCapiFields(floodedList, `flood${i}@example.com`);
    }
    await sendWithCapiFields(floodedList, 'flood101@example.com');
    await flushAsyncWork();
    expect(metaService.sendCapiLeadEvent).toHaveBeenCalledTimes(100);

    (metaService.sendCapiLeadEvent as jest.Mock).mockClear();
    const otherRes = await sendWithCapiFields('list_unrelated_customer', 'real-lead@example.com');
    await flushAsyncWork();

    expect(otherRes.status).toBe(201);
    expect(metaService.sendCapiLeadEvent).toHaveBeenCalledTimes(1);
  });
});

describe('forward-lead: CAPI paused per Meta ad account on its real Business Use Case rate limit (ENG-449 residual risk)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (crmDb.getLeadListById as jest.Mock).mockImplementation((listId: string) =>
      Promise.resolve({ listId, userId: 'user_123', name: 'Test List', publicAccessEnabled: true }),
    );
    (crmDb.getLeadByEmail as jest.Mock).mockResolvedValue(null);
    (crmDb.createLead as jest.Mock).mockImplementation((listId: string, data: any) =>
      Promise.resolve({ leadId: `lead_${Math.random()}`, listId, ...data }),
    );
    (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'user_123', connected_accounts: [] });
    (getMetaAccountCredentials as jest.Mock).mockResolvedValue({ accountId: 'acc1', accessToken: 'tok', accountName: 'Acc 1' });
  });

  const sendFor = (listId: string, accountId: string, email: string) =>
    request(rateLimitTestServer).post('/api/webhooks/forward-lead').send({
      listId,
      email,
      pixelId: '1430870751246428',
      metaAccountId: accountId,
      eventId: `evt_${email}`,
    });

  it('a real Meta throttle (usage at 100%, real estimated_time_to_regain_access) pauses the NEXT send on the SAME account, even with per-listId budget untouched', async () => {
    (metaService.sendCapiLeadEvent as jest.Mock).mockResolvedValueOnce({
      success: false,
      error: 'User request limit reached',
      usage: { callCountPct: 100, totalTimePct: 40, totalCpuTimePct: 30, estimatedMinutesToRegainAccess: 10 },
    });

    const res1 = await sendFor('list_a', 'acc_throttled', 'first@example.com');
    await flushAsyncWork();
    expect(res1.status).toBe(201);
    expect(metaService.sendCapiLeadEvent).toHaveBeenCalledTimes(1);

    // A DIFFERENT list, same Meta account — its own per-listId budget has plenty of room,
    // but the account-level pause must still block it.
    const res2 = await sendFor('list_b', 'acc_throttled', 'second@example.com');
    await flushAsyncWork();
    expect(res2.status).toBe(201); // lead still saves
    expect(metaService.sendCapiLeadEvent).toHaveBeenCalledTimes(1); // NOT called again
  });

  it('usage below 100% on every metric never pauses the account', async () => {
    (metaService.sendCapiLeadEvent as jest.Mock).mockResolvedValue({
      success: true,
      usage: { callCountPct: 80, totalTimePct: 50, totalCpuTimePct: 20, estimatedMinutesToRegainAccess: undefined },
    });

    await sendFor('list_c', 'acc_healthy', 'a@example.com');
    await flushAsyncWork();
    await sendFor('list_c', 'acc_healthy', 'b@example.com');
    await flushAsyncWork();

    expect(metaService.sendCapiLeadEvent).toHaveBeenCalledTimes(2);
  });

  it('a throttle on one Meta ad account never pauses a DIFFERENT account', async () => {
    (metaService.sendCapiLeadEvent as jest.Mock).mockResolvedValueOnce({
      success: false,
      error: 'User request limit reached',
      usage: { callCountPct: 100, totalTimePct: 100, totalCpuTimePct: 100, estimatedMinutesToRegainAccess: 15 },
    });

    await sendFor('list_d', 'acc_throttled_2', 'x@example.com');
    await flushAsyncWork();
    expect(metaService.sendCapiLeadEvent).toHaveBeenCalledTimes(1);

    (metaService.sendCapiLeadEvent as jest.Mock).mockResolvedValueOnce({ success: true, usage: undefined });
    await sendFor('list_e', 'acc_unrelated', 'y@example.com');
    await flushAsyncWork();
    expect(metaService.sendCapiLeadEvent).toHaveBeenCalledTimes(2); // the unrelated account still gets its send
  });
});

describe('forward-lead: CAPI client IP prefers x-forwarded-for over req.ip (scoped mitigation for ENG-493)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (crmDb.getLeadListById as jest.Mock).mockImplementation((listId: string) =>
      Promise.resolve({ listId, userId: 'user_123', name: 'Test List', publicAccessEnabled: true }),
    );
    (crmDb.getLeadByEmail as jest.Mock).mockResolvedValue(null);
    (crmDb.createLead as jest.Mock).mockImplementation((listId: string, data: any) =>
      Promise.resolve({ leadId: `lead_${Math.random()}`, listId, ...data }),
    );
    (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'user_123', connected_accounts: [] });
    (getMetaAccountCredentials as jest.Mock).mockResolvedValue({ accountId: 'acc1', accessToken: 'tok', accountName: 'Acc 1' });
    (metaService.sendCapiLeadEvent as jest.Mock).mockResolvedValue({ success: true });
  });

  // This app never configures Express's `trust proxy` (ENG-493), so `req.ip` collapses to
  // the same internal/shared value for every caller — actively hurting Meta's match quality
  // since client_ip_address is a real matching signal. Rather than flip the global `trust
  // proxy` setting (which would also change auth.ts's IP-keyed rate limiters — separate,
  // riskier change), this scopes the fix to just this CAPI call site, reusing the pattern
  // already established in loopEvents.ts/assetController.ts.
  it('SUCCESS: uses the first x-forwarded-for IP when present, not req.ip', async () => {
    await request(rateLimitTestServer)
      .post('/api/webhooks/forward-lead')
      .set('X-Forwarded-For', '203.0.113.7, 10.0.0.1')
      // A browser User-Agent is now a precondition for keeping the IP at all: landing pages
      // reach this route via a server-side forward, so a non-browser caller's address is the
      // forwarder's rather than the visitor's (utils/clientIdentity.ts). The x-forwarded-for
      // preference this test asserts is unchanged.
      .set('User-Agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36')
      .send({
        listId: 'list_ip_test',
        email: 'ip-test@example.com',
        pixelId: '1430870751246428',
        metaAccountId: 'acc1',
        eventId: 'evt_ip_test',
      });
    await flushAsyncWork();

    expect(metaService.sendCapiLeadEvent).toHaveBeenCalledWith(
      '1430870751246428',
      'tok',
      expect.objectContaining({ clientIp: '203.0.113.7' }),
    );
  });

  it('SUCCESS: falls back to req.ip when x-forwarded-for is absent', async () => {
    await request(rateLimitTestServer)
      .post('/api/webhooks/forward-lead')
      .set('User-Agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36')
      .send({
        listId: 'list_ip_test_2',
        email: 'ip-test-2@example.com',
        pixelId: '1430870751246428',
        metaAccountId: 'acc1',
        eventId: 'evt_ip_test_2',
      });
    await flushAsyncWork();

    const call = (metaService.sendCapiLeadEvent as jest.Mock).mock.calls[0];
    expect(call[2].clientIp).toBeTruthy();
    expect(call[2].clientIp).not.toBe('203.0.113.7');
  });
});

describe('forward-lead: fbp/fbc forwarded to CAPI when the client sent them (ENG-449 match-quality gap)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (crmDb.getLeadListById as jest.Mock).mockImplementation((listId: string) =>
      Promise.resolve({ listId, userId: 'user_123', name: 'Test List', publicAccessEnabled: true }),
    );
    (crmDb.getLeadByEmail as jest.Mock).mockResolvedValue(null);
    (crmDb.createLead as jest.Mock).mockImplementation((listId: string, data: any) =>
      Promise.resolve({ leadId: `lead_${Math.random()}`, listId, ...data }),
    );
    (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'user_123', connected_accounts: [] });
    (getMetaAccountCredentials as jest.Mock).mockResolvedValue({ accountId: 'acc1', accessToken: 'tok', accountName: 'Acc 1' });
    (metaService.sendCapiLeadEvent as jest.Mock).mockResolvedValue({ success: true });
  });

  it('SUCCESS: fbp/fbc in the request body are passed through to sendCapiLeadEvent', async () => {
    await request(rateLimitTestServer).post('/api/webhooks/forward-lead').send({
      listId: 'list_fbp_test',
      email: 'fbp-test@example.com',
      pixelId: '1430870751246428',
      metaAccountId: 'acc1',
      eventId: 'evt_fbp_test',
      fbp: 'fb.1.1111111111.2222222222',
      fbc: 'fb.1.1111111111.AbCdEf',
    });
    await flushAsyncWork();

    expect(metaService.sendCapiLeadEvent).toHaveBeenCalledWith(
      '1430870751246428',
      'tok',
      expect.objectContaining({ fbp: 'fb.1.1111111111.2222222222', fbc: 'fb.1.1111111111.AbCdEf' }),
    );
  });

  it('SUCCESS: omits fbp/fbc when absent from the request body (does not send undefined fields)', async () => {
    await request(rateLimitTestServer).post('/api/webhooks/forward-lead').send({
      listId: 'list_fbp_test_2',
      email: 'fbp-test-2@example.com',
      pixelId: '1430870751246428',
      metaAccountId: 'acc1',
      eventId: 'evt_fbp_test_2',
    });
    await flushAsyncWork();

    const call = (metaService.sendCapiLeadEvent as jest.Mock).mock.calls[0];
    expect(call[2].fbp).toBeUndefined();
    expect(call[2].fbc).toBeUndefined();
  });
});

describe('forward-lead: synthetic smoke-test leads skip all side effects (ENG-449 gap #3)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (crmDb.getLeadListById as jest.Mock).mockImplementation((listId: string) =>
      Promise.resolve({ listId, userId: 'user_123', name: 'Test List', publicAccessEnabled: true }),
    );
    (crmDb.getLeadByEmail as jest.Mock).mockResolvedValue(null);
    (crmDb.createLead as jest.Mock).mockImplementation((listId: string, data: any) =>
      Promise.resolve({ leadId: `lead_${Math.random()}`, listId, ...data }),
    );
    (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'user_123', connected_accounts: [] });
    (getMetaAccountCredentials as jest.Mock).mockResolvedValue({ accountId: 'acc1', accessToken: 'tok', accountName: 'Acc 1' });
    (metaService.sendCapiLeadEvent as jest.Mock).mockResolvedValue({ success: true });
  });

  it('SUCCESS: a smoke-test lead (smoke-test+<ts>@agentweb.pro) still saves and gets a 201, but skips CAPI/CRM-sync/sequence-enrollment/owner-notify', async () => {
    const res = await request(rateLimitTestServer).post('/api/webhooks/forward-lead').send({
      listId: 'list_smoke_test',
      email: 'smoke-test+1721000000000@agentweb.pro',
      pixelId: '1430870751246428',
      metaAccountId: 'acc1',
      eventId: 'evt_smoke_test',
    });
    await flushAsyncWork();

    expect(res.status).toBe(201);
    expect(metaService.sendCapiLeadEvent).not.toHaveBeenCalled();
    expect(externalCrmSyncService.autoSyncLead).not.toHaveBeenCalled();
    expect(dripSequenceDb.getSequencesByAutoEnrollList).not.toHaveBeenCalled();
    expect(leadListAlertService.notifyLeadListOwnerIfConfigured).not.toHaveBeenCalled();
  });

  it('FAIL (regression guard): a real lead with a similar-looking but non-matching email still gets the full side-effect cascade', async () => {
    await request(rateLimitTestServer).post('/api/webhooks/forward-lead').send({
      listId: 'list_real_lead',
      email: 'smoke-test-but-not-really@agentweb.pro', // doesn't match the strict pattern
      pixelId: '1430870751246428',
      metaAccountId: 'acc1',
      eventId: 'evt_real',
    });
    await flushAsyncWork();

    expect(metaService.sendCapiLeadEvent).toHaveBeenCalled();
    expect(externalCrmSyncService.autoSyncLead).toHaveBeenCalled();
  });
});
