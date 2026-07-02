/**
 * Featurebase webhook -> Slack ship notification (ENG-170).
 *
 * Contract under test:
 *   - endpoint is DARK (200, no-op) until FEATUREBASE_WEBHOOK_SECRET is set
 *   - HMAC-SHA256 over `${timestamp}.${rawBody}` (X-Webhook-Signature hex,
 *     X-Webhook-Timestamp unix seconds, ±5 min freshness) — bad/stale -> 401
 *   - only `post.updated` events whose changes include `status` AND whose new
 *     status type is `completed` trigger notification
 *   - handler errors return 200 (never let Featurebase auto-suspend the webhook)
 */
import request from 'supertest';
import express from 'express';
import crypto from 'crypto';

jest.mock('../services/shipNotifyService', () => ({
  notifyPostShippedRecipients: jest.fn().mockResolvedValue({ sent: 1, outcomes: {} }),
}));

import integrationsRouter from '../routes/integrations';
const shipNotify = require('../services/shipNotifyService');

const app = express();
// Mirror app.ts: raw body for the featurebase webhook path, json elsewhere.
app.use('/api/integrations/featurebase/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use('/api/integrations', integrationsRouter);

const SECRET = 'whsec_test_secret';
const PATH = '/api/integrations/featurebase/webhook';

function sign(body: string, ts: number, secret = SECRET): { sig: string; ts: string } {
  const sig = crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
  return { sig, ts: String(ts) };
}

function completedEvent(overrides: Record<string, any> = {}): any {
  return {
    object: 'notification_event',
    id: 'notif_1',
    topic: 'post.updated',
    data: {
      item: {
        object: 'post',
        id: 'post-1',
        title: 'Dark mode',
        postUrl: 'https://fb/p/dark',
        status: { name: 'Completed', type: 'completed' },
        author: { email: 'u@e.com', name: 'U' },
      },
      changes: [{ field: 'status', oldValue: 'In Review', newValue: 'Completed' }],
    },
    ...overrides,
  };
}

async function post(body: any, opts: { sig?: string; ts?: string } = {}): Promise<request.Response> {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const signed = sign(raw, Math.floor(Date.now() / 1000));
  let req = request(app).post(PATH).set('Content-Type', 'application/json');
  req = req.set('X-Webhook-Signature', opts.sig ?? signed.sig).set('X-Webhook-Timestamp', opts.ts ?? signed.ts);
  return req.send(raw);
}

const realSecret = process.env.FEATUREBASE_WEBHOOK_SECRET;
beforeEach(() => {
  jest.clearAllMocks();
  process.env.FEATUREBASE_WEBHOOK_SECRET = SECRET;
});
afterAll(() => {
  process.env.FEATUREBASE_WEBHOOK_SECRET = realSecret;
});

describe('POST /api/integrations/featurebase/webhook — gating + auth', () => {
  it('secret unset -> 200 dark no-op, notifier never called', async () => {
    delete process.env.FEATUREBASE_WEBHOOK_SECRET;
    const res = await post(completedEvent());
    expect(res.status).toBe(200);
    expect(res.body.ignored).toBe('not configured');
    expect(shipNotify.notifyPostShippedRecipients).not.toHaveBeenCalled();
  });

  it('wrong signature -> 401, notifier never called', async () => {
    const res = await post(completedEvent(), { sig: 'f'.repeat(64) });
    expect(res.status).toBe(401);
    expect(shipNotify.notifyPostShippedRecipients).not.toHaveBeenCalled();
  });

  it('signature from a different secret -> 401', async () => {
    const raw = JSON.stringify(completedEvent());
    const bad = sign(raw, Math.floor(Date.now() / 1000), 'whsec_other');
    const res = await post(raw, { sig: bad.sig, ts: bad.ts });
    expect(res.status).toBe(401);
  });

  it('stale timestamp (> 5 min) -> 401 even with a valid signature over it', async () => {
    const raw = JSON.stringify(completedEvent());
    const staleTs = Math.floor(Date.now() / 1000) - 600;
    const stale = sign(raw, staleTs);
    const res = await post(raw, { sig: stale.sig, ts: stale.ts });
    expect(res.status).toBe(401);
    expect(shipNotify.notifyPostShippedRecipients).not.toHaveBeenCalled();
  });

  it('missing timestamp header -> 401', async () => {
    const res = await post(completedEvent(), { ts: '' });
    expect(res.status).toBe(401);
  });
});

describe('POST /api/integrations/featurebase/webhook — event filtering', () => {
  it('post.updated with a status change to completed -> notifies author + voters', async () => {
    const res = await post(completedEvent());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, notified: 1 });
    expect(shipNotify.notifyPostShippedRecipients).toHaveBeenCalledWith({
      postId: 'post-1',
      title: 'Dark mode',
      url: 'https://fb/p/dark',
      authorEmail: 'u@e.com',
    });
  });

  it('post.updated WITHOUT a status field change -> no-op (title edit on a completed post)', async () => {
    const ev = completedEvent();
    ev.data.changes = [{ field: 'title', oldValue: 'a', newValue: 'b' }];
    const res = await post(ev);
    expect(res.status).toBe(200);
    expect(res.body.notified).toBe(0);
    expect(shipNotify.notifyPostShippedRecipients).not.toHaveBeenCalled();
  });

  it('status change to a non-completed type -> no-op', async () => {
    const ev = completedEvent();
    ev.data.item.status = { name: 'In Progress', type: 'active' };
    const res = await post(ev);
    expect(res.body.notified).toBe(0);
    expect(shipNotify.notifyPostShippedRecipients).not.toHaveBeenCalled();
  });

  it('other topics (post.created) -> no-op', async () => {
    const res = await post(completedEvent({ topic: 'post.created' }));
    expect(res.body.notified).toBe(0);
    expect(shipNotify.notifyPostShippedRecipients).not.toHaveBeenCalled();
  });

  it('malformed JSON with a valid signature -> 200 ok:false (no throw, no retry storm)', async () => {
    const res = await post('{not-json');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
  });
});
