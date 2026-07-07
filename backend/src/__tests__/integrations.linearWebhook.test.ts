/**
 * Linear webhook route — resolve bridge + FB-synced issue enrichment (ENG-187 contract #4).
 *
 * Contract under test:
 *   - HMAC-SHA256 signature (`linear-signature` over the raw payload bytes) is enforced for EVERY
 *     event type when LINEAR_WEBHOOK_SECRET is set — including the new Issue-creation branch
 *   - Issue CREATE carrying the "Featurebase" label (the FB->Linear sync's marker) -> funnel
 *     enrichment (intakeService.enrichFeaturebaseSyncedIssue) with the issue id + title
 *   - Issue CREATE without that label (our own bug canonicals / Auto issues) -> untouched
 *   - non-create actions / non-Issue types -> no enrichment
 *   - payload contract drift (labelIds present but no expanded `labels` array) -> LOUD error, no
 *     silent skip
 *   - enrichment errors return 200 (never crash the route — it also serves the resolve bridge)
 *   - the resolve bridge (completed transition -> notifyCanonicalResolved) is unchanged, and an
 *     issue created directly in a completed state routes to the bridge, not enrichment
 */
import request from 'supertest';
import express from 'express';
import crypto from 'crypto';

jest.mock('../services/intakeService', () => ({
  notifyCanonicalResolved: jest.fn().mockResolvedValue({ ticketNumbers: [7] }),
  enrichFeaturebaseSyncedIssue: jest.fn().mockResolvedValue({ labelNames: ['Status: Activation', 'Activated', 'Needs PM'] }),
}));

import integrationsRouter from '../routes/integrations';
const intake = require('../services/intakeService');

const app = express();
// Mirror app.ts: raw body for the linear webhook path, json elsewhere.
app.use('/api/integrations/linear/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use('/api/integrations', integrationsRouter);

const SECRET = 'lin_whsec_test';
const PATH = '/api/integrations/linear/webhook';

function sign(body: string, secret = SECRET): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

/** An Issue-creation event as Featurebase's FB->Linear sync produces it (expanded labels array). */
function fbCreateEvent(overrides: Record<string, any> = {}): any {
  return {
    action: 'create',
    type: 'Issue',
    data: {
      id: 'issue-uuid-1',
      title: 'Add a disable Emma tips toggle',
      labelIds: ['lab-fb'],
      labels: [{ id: 'lab-fb', name: 'Featurebase', color: '#716AE9' }],
      state: { id: 'st-backlog', name: 'Backlog', type: 'backlog' },
      ...overrides.data,
    },
    ...Object.fromEntries(Object.entries(overrides).filter(([k]) => k !== 'data')),
  };
}

async function post(body: any, opts: { sig?: string } = {}): Promise<request.Response> {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  return request(app)
    .post(PATH)
    .set('Content-Type', 'application/json')
    .set('linear-signature', opts.sig ?? sign(raw))
    .send(raw);
}

const realSecret = process.env.LINEAR_WEBHOOK_SECRET;
beforeEach(() => {
  jest.clearAllMocks();
  process.env.LINEAR_WEBHOOK_SECRET = SECRET;
});
afterAll(() => {
  process.env.LINEAR_WEBHOOK_SECRET = realSecret;
});

describe('POST /api/integrations/linear/webhook — FB-synced issue enrichment (ENG-187 #4)', () => {
  it('Issue create with the Featurebase label -> enrichment with issue id + title, no bridge call', async () => {
    const res = await post(fbCreateEvent());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, enriched: true, labels: ['Status: Activation', 'Activated', 'Needs PM'] });
    expect(intake.enrichFeaturebaseSyncedIssue).toHaveBeenCalledWith({
      issueId: 'issue-uuid-1',
      title: 'Add a disable Emma tips toggle',
    });
    expect(intake.notifyCanonicalResolved).not.toHaveBeenCalled();
  });

  it('signature verification stays intact for creation events: bad signature -> 401, no enrichment', async () => {
    const res = await post(fbCreateEvent(), { sig: 'f'.repeat(64) });
    expect(res.status).toBe(401);
    expect(intake.enrichFeaturebaseSyncedIssue).not.toHaveBeenCalled();
  });

  it('Issue create WITHOUT the Featurebase label (our own bug canonical) -> untouched', async () => {
    const ev = fbCreateEvent({
      data: {
        id: 'issue-uuid-2',
        title: 'crash on save',
        labelIds: ['lab-bug', 'lab-crep'],
        labels: [
          { id: 'lab-bug', name: 'Bug', color: '#eb5757' },
          { id: 'lab-crep', name: 'Customer Reported', color: '#95a2b3' },
        ],
        state: { id: 'st-todo', name: 'Todo', type: 'unstarted' },
      },
    });
    const res = await post(ev);
    expect(res.status).toBe(200);
    expect(res.body.enriched).toBeUndefined();
    expect(intake.enrichFeaturebaseSyncedIssue).not.toHaveBeenCalled();
  });

  it('Issue create with NO labels at all -> untouched, no error log', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const ev = fbCreateEvent({ data: { id: 'issue-uuid-3', title: 'plain', labelIds: [], labels: [], state: { type: 'backlog' } } });
    const res = await post(ev);
    expect(res.status).toBe(200);
    expect(intake.enrichFeaturebaseSyncedIssue).not.toHaveBeenCalled();
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('Issue UPDATE with the Featurebase label -> no enrichment (creation-only)', async () => {
    const res = await post(fbCreateEvent({ action: 'update' }));
    expect(res.status).toBe(200);
    expect(intake.enrichFeaturebaseSyncedIssue).not.toHaveBeenCalled();
  });

  it('non-Issue types (Comment create) -> no enrichment', async () => {
    const res = await post({ action: 'create', type: 'Comment', data: { id: 'c1', body: 'hi' } });
    expect(res.status).toBe(200);
    expect(intake.enrichFeaturebaseSyncedIssue).not.toHaveBeenCalled();
  });

  it('payload contract drift (labelIds but NO expanded labels array) -> loud error, no silent skip', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const ev = fbCreateEvent();
    delete ev.data.labels;
    const res = await post(ev);
    expect(res.status).toBe(200);
    expect(intake.enrichFeaturebaseSyncedIssue).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('issue-uuid-1'));
    errSpy.mockRestore();
  });

  it('enrichment throwing -> 200 ok:false (the route also serves the resolve bridge — never crash)', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    intake.enrichFeaturebaseSyncedIssue.mockRejectedValueOnce(new Error('linear down'));
    const res = await post(fbCreateEvent());
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    errSpy.mockRestore();
  });
});

describe('POST /api/integrations/linear/webhook — resolve bridge unchanged (regression)', () => {
  it('Issue update to a completed state still routes to notifyCanonicalResolved', async () => {
    const ev = {
      action: 'update',
      type: 'Issue',
      data: { id: 'issue-uuid-9', title: 'fixed bug', state: { id: 'st-done', name: 'Done', type: 'completed' } },
    };
    const res = await post(ev);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, notified: 1, ticketNumbers: [7] });
    expect(intake.notifyCanonicalResolved).toHaveBeenCalledWith('issue-uuid-9', 'fixed bug');
    expect(intake.enrichFeaturebaseSyncedIssue).not.toHaveBeenCalled();
  });

  it('Issue CREATED directly in a completed state -> bridge, not enrichment', async () => {
    const ev = fbCreateEvent({ data: { id: 'issue-uuid-10', title: 't', labels: [{ id: 'lab-fb', name: 'Featurebase' }], state: { type: 'completed' } } });
    const res = await post(ev);
    expect(res.status).toBe(200);
    expect(intake.notifyCanonicalResolved).toHaveBeenCalledWith('issue-uuid-10', 't');
    expect(intake.enrichFeaturebaseSyncedIssue).not.toHaveBeenCalled();
  });
});
