/**
 * ENG-926 §B — forward-lead persists the Event Match Quality signals it already had.
 *
 * `client_ip_address` and `client_user_agent` are, in Meta's own guidance, among the most
 * commonly skipped and most valuable EMQ inputs. This handler already read both off the
 * request, spent them on the immediate Lead event, and then discarded them — so every
 * conversion §C relays WEEKS later, when a deal closes in the CRM, reached Meta with less
 * identity than we held at the moment of capture, for no reason other than nothing kept them.
 *
 * The backfill contract mirrors the click-ID denorm: written once, never overwritten. A
 * returning visitor's IP and device are not the ones that acquired them, so refreshing on a
 * repeat touch would quietly degrade the signal this exists to strengthen.
 */

import request from 'supertest';
import express from 'express';
import webhookRouter from '../routes/webhooks';
import { crmDb, userDb } from '../services/db';

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
jest.mock('../services/metaAccountCredentials', () => ({ getMetaAccountCredentials: jest.fn() }));
jest.mock('../services/dripSequenceDb', () => ({
  dripSequenceDb: { getSequencesByAutoEnrollList: jest.fn().mockResolvedValue([]), bulkEnroll: jest.fn() },
}));
jest.mock('../services/externalCrmSyncService', () => ({
  externalCrmSyncService: { autoSyncLead: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../services/leadListAlertService', () => ({
  leadListAlertService: { notifyLeadListOwnerIfConfigured: jest.fn() },
}));
jest.mock('../services/leadCaptureFailureService', () => ({ recordLeadCaptureFailure: jest.fn() }));
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

const app = express();
app.use(express.json());
app.use('/api/webhooks', webhookRouter);

const flush = async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
};

const createdLead = () => (crmDb.createLead as jest.Mock).mock.calls[0][1];
const leadUpdates = () => (crmDb.updateLead as jest.Mock).mock.calls[0][2];

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)';

describe('forward-lead — Event Match Quality signals persisted (ENG-926 §B)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (crmDb.getLeadListById as jest.Mock).mockResolvedValue({
      listId: 'list_123', userId: 'user_123', name: 'Test List',
      publicAccessEnabled: true, autoDraftEnabled: false,
    });
    (crmDb.getLeadByEmail as jest.Mock).mockResolvedValue(null);
    (crmDb.createLead as jest.Mock).mockResolvedValue({ leadId: 'lead_1', listId: 'list_123', email: 'a@b.com' });
    (crmDb.updateLead as jest.Mock).mockResolvedValue({ leadId: 'lead_1', listId: 'list_123' });
    (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'user_123', connected_accounts: [] });
  });

  it('stores the client IP and user agent on a new lead', async () => {
    const res = await request(app)
      .post('/api/webhooks/forward-lead')
      .set('X-Forwarded-For', '203.0.113.7')
      .set('User-Agent', UA)
      .send({ listId: 'list_123', email: 'a@b.com' });
    await flush();

    expect(res.status).toBe(201);
    expect(createdLead().clientIp).toBe('203.0.113.7');
    expect(createdLead().clientUserAgent).toBe(UA);
  });

  it('takes the FIRST hop of a multi-proxy X-Forwarded-For chain', async () => {
    // Later entries are the proxies themselves; the originating client is first.
    await request(app)
      .post('/api/webhooks/forward-lead')
      .set('X-Forwarded-For', '203.0.113.7, 70.41.3.18, 150.172.238.178')
      .set('User-Agent', UA)
      .send({ listId: 'list_123', email: 'a@b.com' });
    await flush();

    expect(createdLead().clientIp).toBe('203.0.113.7');
  });

  it('never stores the "unknown" sentinel the CAPI call falls back to', async () => {
    await request(app)
      .post('/api/webhooks/forward-lead')
      .set('User-Agent', UA)
      .send({ listId: 'list_123', email: 'a@b.com' });
    await flush();

    expect(createdLead().clientIp).not.toBe('unknown');
  });

  it('stores NEITHER value when the caller is a forwarding server, not a browser', async () => {
    // The production case: landing pages POST to their own Next.js route, which calls this
    // endpoint server-side from Vercel. A real end-to-end run recorded 44.202.76.171 + 'node'
    // for a lead that came from an actual iPhone. A wrong IP is worse than no IP — Meta
    // reads it as a match signal and a datacenter address matches nobody — and these
    // attributes are WRITE-ONCE in db.ts, so a wrong one can never be replaced.
    await request(app)
      .post('/api/webhooks/forward-lead')
      .set('X-Forwarded-For', '44.202.76.171')
      .set('User-Agent', 'node')
      .send({ listId: 'list_123', email: 'server@example.com' });
    await flush();

    expect(createdLead().clientIp).toBeUndefined();
    expect(createdLead().clientUserAgent).toBeUndefined();
  });

  it('stores neither when no User-Agent arrives at all', async () => {
    // Every real browser sends one; its absence means the caller is not a visitor.
    await request(app)
      .post('/api/webhooks/forward-lead')
      .set('X-Forwarded-For', '44.202.76.171')
      .send({ listId: 'list_123', email: 'noua@example.com' });
    await flush();

    expect(createdLead().clientIp).toBeUndefined();
    expect(createdLead().clientUserAgent).toBeUndefined();
  });

  it('omits the user agent entirely when the request carries none', async () => {
    await request(app)
      .post('/api/webhooks/forward-lead')
      .set('User-Agent', '')
      .send({ listId: 'list_123', email: 'a@b.com' });
    await flush();

    expect(createdLead().clientUserAgent).toBeUndefined();
  });

  it('backfills both onto an existing lead that has neither', async () => {
    (crmDb.getLeadByEmail as jest.Mock).mockResolvedValue({
      leadId: 'lead_1', listId: 'list_123', email: 'a@b.com', customFields: {},
    });

    await request(app)
      .post('/api/webhooks/forward-lead')
      .set('X-Forwarded-For', '203.0.113.7')
      .set('User-Agent', UA)
      .send({ listId: 'list_123', email: 'a@b.com' });
    await flush();

    expect(leadUpdates().clientIp).toBe('203.0.113.7');
    expect(leadUpdates().clientUserAgent).toBe(UA);
  });

  it('never overwrites values already on the lead — the acquiring touch wins', async () => {
    (crmDb.getLeadByEmail as jest.Mock).mockResolvedValue({
      leadId: 'lead_1', listId: 'list_123', email: 'a@b.com', customFields: {},
      clientIp: '198.51.100.1', clientUserAgent: 'OriginalAgent/1.0',
    });

    await request(app)
      .post('/api/webhooks/forward-lead')
      .set('X-Forwarded-For', '203.0.113.7')
      .set('User-Agent', UA)
      .send({ listId: 'list_123', email: 'a@b.com' });
    await flush();

    expect(leadUpdates()).not.toHaveProperty('clientIp');
    expect(leadUpdates()).not.toHaveProperty('clientUserAgent');
  });

  it('backfills metaFbp on a repeat touch — the field that shipped doing nothing', async () => {
    // metaFbp was accepted by createLead only, so a lead that first arrived without an fbp
    // and later submitted with one never received it. db.ts names this exact case.
    (crmDb.getLeadByEmail as jest.Mock).mockResolvedValue({
      leadId: 'lead_1', listId: 'list_123', email: 'a@b.com', customFields: {},
    });

    await request(app)
      .post('/api/webhooks/forward-lead')
      .send({ listId: 'list_123', email: 'a@b.com', fbp: 'fb.1.1754000000000.987654321' });
    await flush();

    expect(leadUpdates().metaFbp).toBe('fb.1.1754000000000.987654321');
  });

  it('a metadata-only backfill must NOT report the lead as updated', async () => {
    // The defect this pins was introduced while writing this feature and caught by an
    // existing suite. `isUpdated` gates drip-sequence auto-enrolment, external CRM push and
    // the owner notification — real outbound email. Counting a silent match-quality backfill
    // as a lead update would enrol a returning visitor into a sequence and email the owner
    // because we quietly stored an IP. The row is still written; only the claim is withheld.
    (crmDb.getLeadByEmail as jest.Mock).mockResolvedValue({
      leadId: 'lead_1', listId: 'list_123', email: 'a@b.com', customFields: { source: 'api' },
      firstName: '', lastName: '', phone: '', company: '', title: '', notes: '', linkedin: '',
    });

    const res = await request(app)
      .post('/api/webhooks/forward-lead')
      .set('X-Forwarded-For', '203.0.113.7')
      .set('User-Agent', UA)
      .send({ listId: 'list_123', email: 'a@b.com' });
    await flush();

    expect(res.body.event).toBe('lead.unchanged');
    // ...and the write still happened, carrying only the metadata fields.
    expect(leadUpdates()).toEqual({ clientIp: '203.0.113.7', clientUserAgent: UA });
  });

  it('still reports lead.updated when a real field changes alongside the backfill', async () => {
    (crmDb.getLeadByEmail as jest.Mock).mockResolvedValue({
      leadId: 'lead_1', listId: 'list_123', email: 'a@b.com', customFields: { source: 'api' },
      firstName: 'Old', lastName: '', phone: '', company: '', title: '', notes: '', linkedin: '',
    });

    const res = await request(app)
      .post('/api/webhooks/forward-lead')
      .set('X-Forwarded-For', '203.0.113.7')
      .set('User-Agent', UA)
      .send({ listId: 'list_123', email: 'a@b.com', firstName: 'New' });
    await flush();

    expect(res.body.event).toBe('lead.updated');
    expect(leadUpdates().firstName).toBe('New');
    expect(leadUpdates().clientIp).toBe('203.0.113.7');
  });

  it('does not overwrite an fbp the lead already carries', async () => {
    (crmDb.getLeadByEmail as jest.Mock).mockResolvedValue({
      leadId: 'lead_1', listId: 'list_123', email: 'a@b.com', customFields: {},
      metaFbp: 'fb.1.1700000000000.111111111',
    });

    await request(app)
      .post('/api/webhooks/forward-lead')
      .send({ listId: 'list_123', email: 'a@b.com', fbp: 'fb.1.1754000000000.987654321' });
    await flush();

    expect(leadUpdates()).not.toHaveProperty('metaFbp');
  });
});
