/**
 * ENG-926 §A — forward-lead promotes attribution out of customFields.
 *
 * A lander can capture click IDs and UTMs perfectly and still deliver a lead carrying
 * no attribution at all, by posting them into the free-form `customFields` bag instead
 * of the structured envelope. Nothing structured reads that container.
 *
 * `hireemma.ai` is the live instance, found 2026-08-16 while chasing §F's one true
 * blackout alert. Its popup reads first-touch correctly and its own /api/lead route
 * (`buildForwardLeadBody`) forwards NO `attribution` and NO `utm` — every captured
 * value is flattened into `customFields`. So the lead landed with no `firstTouch`
 * whatsoever: click-ID coverage read 0 of 63, and §C could not rebuild `fbc`.
 *
 * This is NOT the RankAI failure. RankAI discarded the values at the capture call.
 * Here they are captured, transmitted and persisted — just filed where nothing looks.
 * A field-shape mismatch, and the reason it is fixed once in the backend rather than
 * per site is that the failure is invisible by construction: the site looks right, the
 * POST returns 201, the row appears. Any other bespoke lander making the same
 * reasonable-looking mistake is silently broken now, and there is no inventory of them.
 */

import request from 'supertest';
import express from 'express';
import webhookRouter from '../routes/webhooks';
import { crmDb, userDb } from '../services/db';
import { buildLeadAttributionFields } from '../utils/leadSchema';

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

/** The exact body hireemma.ai's own /api/lead route forwards. */
const hireemmaBody = (overrides: Record<string, unknown> = {}) => ({
  listId: 'list_123',
  email: 'visitor@example.com',
  firstName: 'Visitor',
  source: 'ai-readiness-popup',
  customFields: {
    campaign: 'ai-readiness-popup',
    offer: 'ai_readiness_roadmap',
    surface: 'site_popup',
    completion_step: 4,
    partial: false,
    utm_source: 'facebook',
    utm_medium: 'paid_social',
    utm_campaign: 'ICP1-PLG',
    fbclid: 'FB_REAL_CLICK',
    first_touch_page: '/first-ai-dollar',
    ...overrides,
  },
});

describe('forward-lead — attribution promoted out of customFields', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (crmDb.getLeadListById as jest.Mock).mockResolvedValue({
      listId: 'list_123', userId: 'user_123', name: 'Test List',
      publicAccessEnabled: true, autoDraftEnabled: false,
    });
    (crmDb.getLeadByEmail as jest.Mock).mockResolvedValue(null);
    (crmDb.createLead as jest.Mock).mockResolvedValue({ leadId: 'lead_1', listId: 'list_123', email: 'visitor@example.com' });
    (crmDb.updateLead as jest.Mock).mockResolvedValue({ leadId: 'lead_1', listId: 'list_123' });
    (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'user_123', connected_accounts: [] });
  });

  it('gives a hireemma.ai lead the firstTouch it previously had none of', async () => {
    const res = await request(app).post('/api/webhooks/forward-lead').send(hireemmaBody());
    await flush();

    expect(res.status).toBe(201);
    const lead = createdLead();
    expect(lead.firstTouch?.clickIds).toEqual({ fbclid: 'FB_REAL_CLICK' });
    expect(lead.firstTouch?.utm).toEqual({
      source: 'facebook', medium: 'paid_social', campaign: 'ICP1-PLG',
    });
    expect(lead.lastTouch).toEqual(lead.firstTouch);
  });

  it('reaches the TOP-LEVEL clickIds map that §F coverage actually reads', async () => {
    // The whole point. metaAttributionCoverage reads `lead.clickIds`, never
    // `firstTouch.clickIds` — a firstTouch exists for organic visitors too. createLead
    // denormalizes one from the other via buildLeadAttributionFields, so this asserts
    // the full chain rather than the half of it this route owns.
    await request(app).post('/api/webhooks/forward-lead').send(hireemmaBody());
    await flush();

    const stored = buildLeadAttributionFields({
      firstTouch: createdLead().firstTouch,
      lastTouch: createdLead().lastTouch,
    });
    expect(stored.clickIds).toEqual({ fbclid: 'FB_REAL_CLICK' });
    expect(stored.utmSource).toBe('facebook');
  });

  it('leaves the original customFields values in place — promotion is additive', async () => {
    await request(app).post('/api/webhooks/forward-lead').send(hireemmaBody());
    await flush();

    const cf = createdLead().customFields;
    expect(cf.fbclid).toBe('FB_REAL_CLICK');
    expect(cf.utm_source).toBe('facebook');
    expect(cf.completion_step).toBe(4);
  });

  it('never lets a bare `campaign` customField become a UTM campaign', async () => {
    // buildForwardLeadBody sets customFields.campaign = the lead SOURCE. Promoting it
    // would report every hireemma lead as campaign 'ai-readiness-popup' — attribution
    // no visitor ever carried, indistinguishable in a report from the real thing.
    await request(app).post('/api/webhooks/forward-lead').send({
      listId: 'list_123',
      email: 'organic@example.com',
      source: 'ai-readiness-popup',
      customFields: { campaign: 'ai-readiness-popup', offer: 'ai_readiness_roadmap' },
    });
    await flush();

    expect(createdLead().firstTouch).toBeUndefined();
  });

  it('does not invent attribution for a lead that carries none', async () => {
    await request(app).post('/api/webhooks/forward-lead').send({
      listId: 'list_123',
      email: 'plain@example.com',
      customFields: { role: 'CTO', partial: false, q1: 3 },
    });
    await flush();

    const lead = createdLead();
    expect(lead.firstTouch).toBeUndefined();
    expect(lead.lastTouch).toBeUndefined();
  });

  it('lets a structured attribution envelope win over customFields', async () => {
    const res = await request(app).post('/api/webhooks/forward-lead').send({
      listId: 'list_123',
      email: 'both@example.com',
      attribution: {
        utm: { source: 'linkedin' },
        clickIds: { gclid: 'STRUCTURED_G' },
        landingUrl: 'https://example.com/lp',
      },
      customFields: { gclid: 'CUSTOMFIELD_G', fbclid: 'CUSTOMFIELD_FB', utm_medium: 'paid_social' },
    });
    await flush();

    expect(res.status).toBe(201);
    const touch = createdLead().firstTouch;
    // Declared values untouched; only the ABSENT keys are filled. A `??` fallback
    // would have skipped this payload entirely and lost the fbclid.
    expect(touch.clickIds).toEqual({ gclid: 'STRUCTURED_G', fbclid: 'CUSTOMFIELD_FB' });
    expect(touch.utm).toEqual({ source: 'linkedin', medium: 'paid_social' });
    expect(touch.landingUrl).toBe('https://example.com/lp');
  });

  it('covers a lander that posts its click IDs FLAT at the top level', async () => {
    // This handler destructures a fixed field list, so a top-level `fbclid` is not read
    // as attribution — it lands in passthrough and then customFields. Promotion sources
    // from the merged view, so that lander is covered by the same fix.
    await request(app).post('/api/webhooks/forward-lead').send({
      listId: 'list_123',
      email: 'flat@example.com',
      fbclid: 'FLAT_FB',
      utm_source: 'facebook',
    });
    await flush();

    expect(createdLead().firstTouch?.clickIds).toEqual({ fbclid: 'FLAT_FB' });
    expect(createdLead().firstTouch?.utm).toEqual({ source: 'facebook' });
  });

  it('promotes on the repeat-touch merge path too, backfilling a lead that has no firstTouch', async () => {
    (crmDb.getLeadByEmail as jest.Mock).mockResolvedValue({
      leadId: 'lead_1', listId: 'list_123', email: 'visitor@example.com', customFields: {},
    });

    await request(app).post('/api/webhooks/forward-lead').send(hireemmaBody());
    await flush();

    const updates = leadUpdates();
    expect(updates.firstTouch?.clickIds).toEqual({ fbclid: 'FB_REAL_CLICK' });
    expect(updates.lastTouch?.clickIds).toEqual({ fbclid: 'FB_REAL_CLICK' });
    // Denormalized on the merge path by the route itself, not by createLead.
    expect(updates.clickIds).toEqual({ fbclid: 'FB_REAL_CLICK' });
    expect(updates.utmSource).toBe('facebook');
  });

  it('does not coerce a non-string customField into a click ID', async () => {
    await request(app).post('/api/webhooks/forward-lead').send({
      listId: 'list_123',
      email: 'coerce@example.com',
      customFields: { fbclid: false, gclid: 12345, partial: true },
    });
    await flush();

    // A coerced "false"/"12345" would satisfy attribute_exists(clickIds) and report an
    // organic lead as paid-acquired — the exact reading `clickIds` carries downstream.
    expect(createdLead().firstTouch).toBeUndefined();
  });
});
