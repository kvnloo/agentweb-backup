/**
 * WhatsApp Cloud API inbound webhook (ENG-273).
 *
 * Three things this endpoint must get right, all of them security- or
 * compliance-load-bearing:
 *
 *  1. SIGNATURE. Meta signs the raw body with the app secret as
 *     X-Hub-Signature-256. Anyone who can POST here can otherwise forge an inbound
 *     message — which opens a 24-hour free-messaging window for an attacker-chosen
 *     number, and can forge a STOP that silences a real customer.
 *  2. STOP. Opt-out must take effect immediately, and must work for a number that
 *     maps to no known user.
 *  3. NO CHAT SESSION. routes/slack.ts opens an Emma chat session on inbound events.
 *     Doing that here would put a general-purpose AI assistant on WhatsApp, which
 *     Meta's Business Solution Terms have prohibited since 2026-01-15.
 */

import express from 'express';
import request from 'supertest';
import crypto from 'crypto';

jest.mock('../services/whatsappService', () => ({
  recordInboundMessage: jest.fn(),
  recordOptOut: jest.fn(),
  recordOptIn: jest.fn(),
}));
jest.mock('../utils/secretsManager', () => ({
  getWhatsAppCredentials: jest.fn(),
}));

const { recordInboundMessage, recordOptOut, recordOptIn } = require('../services/whatsappService');
const { getWhatsAppCredentials } = require('../utils/secretsManager');

import whatsappWebhookRouter from '../routes/whatsappWebhook';

const APP_SECRET = 'test-app-secret';
const VERIFY_TOKEN = 'test-verify-token';

const app = express();
app.use('/api/webhooks/whatsapp', express.raw({ type: '*/*' }), whatsappWebhookRouter);

const sign = (body: string) =>
  'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(Buffer.from(body)).digest('hex');

/** A minimal but structurally real Cloud API inbound-message payload. */
const inboundPayload = (text: string, from = '14155550123') =>
  JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '222',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: '111' },
              messages: [
                { from, id: 'wamid.IN1', timestamp: '1700000000', type: 'text', text: { body: text } },
              ],
            },
          },
        ],
      },
    ],
  });

const statusPayload = (status: string) =>
  JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '222',
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { phone_number_id: '111' },
              statuses: [{ id: 'wamid.OUT1', status, recipient_id: '14155550123' }],
            },
          },
        ],
      },
    ],
  });

beforeEach(() => {
  // resetAllMocks, not clearAllMocks: clear wipes recorded calls but LEAVES the
  // implementation, so one test's mockRejectedValue would leak into the next.
  jest.resetAllMocks();
  getWhatsAppCredentials.mockResolvedValue({
    phoneNumberId: '111',
    wabaId: '222',
    accessToken: 'tok',
    appSecret: APP_SECRET,
    webhookVerifyToken: VERIFY_TOKEN,
  });
});

// ── Subscription verification (GET) ────────────────────────────────────────

describe('GET — subscription challenge', () => {
  it('echoes the challenge when the verify token matches', async () => {
    const res = await request(app).get('/api/webhooks/whatsapp').query({
      'hub.mode': 'subscribe',
      'hub.verify_token': VERIFY_TOKEN,
      'hub.challenge': '12345',
    });
    expect(res.status).toBe(200);
    expect(res.text).toBe('12345');
  });

  it('rejects a wrong verify token', async () => {
    const res = await request(app).get('/api/webhooks/whatsapp').query({
      'hub.mode': 'subscribe',
      'hub.verify_token': 'wrong',
      'hub.challenge': '12345',
    });
    expect(res.status).toBe(403);
  });

  it('rejects a mode other than subscribe', async () => {
    const res = await request(app).get('/api/webhooks/whatsapp').query({
      'hub.mode': 'unsubscribe',
      'hub.verify_token': VERIFY_TOKEN,
      'hub.challenge': '12345',
    });
    expect(res.status).toBe(403);
  });
});

// ── Signature verification (POST) ──────────────────────────────────────────

describe('POST — signature verification', () => {
  it('accepts a correctly signed payload', async () => {
    const body = inboundPayload('hello');
    const res = await request(app)
      .post('/api/webhooks/whatsapp')
      .set('X-Hub-Signature-256', sign(body))
      .set('Content-Type', 'application/json')
      .send(body);
    expect(res.status).toBe(200);
    expect(recordInboundMessage).toHaveBeenCalled();
  });

  it('rejects a payload with a wrong signature and does nothing', async () => {
    const body = inboundPayload('hello');
    const res = await request(app)
      .post('/api/webhooks/whatsapp')
      .set('X-Hub-Signature-256', 'sha256=' + 'a'.repeat(64))
      .set('Content-Type', 'application/json')
      .send(body);
    expect(res.status).toBe(401);
    expect(recordInboundMessage).not.toHaveBeenCalled();
  });

  it('rejects a payload with no signature header', async () => {
    const body = inboundPayload('hello');
    const res = await request(app)
      .post('/api/webhooks/whatsapp')
      .set('Content-Type', 'application/json')
      .send(body);
    expect(res.status).toBe(401);
    expect(recordInboundMessage).not.toHaveBeenCalled();
  });

  it('rejects a signature over DIFFERENT bytes than the delivered body', async () => {
    // The whole reason this route is mounted with express.raw: re-serializing a
    // parsed body changes key order/whitespace and would verify the wrong bytes.
    const res = await request(app)
      .post('/api/webhooks/whatsapp')
      .set('X-Hub-Signature-256', sign(inboundPayload('hello')))
      .set('Content-Type', 'application/json')
      .send(inboundPayload('tampered'));
    expect(res.status).toBe(401);
  });

  it('rejects a malformed signature header without throwing', async () => {
    const body = inboundPayload('hello');
    const res = await request(app)
      .post('/api/webhooks/whatsapp')
      .set('X-Hub-Signature-256', 'garbage')
      .set('Content-Type', 'application/json')
      .send(body);
    expect(res.status).toBe(401);
  });
});

// ── Inbound handling ───────────────────────────────────────────────────────

describe('POST — inbound messages', () => {
  const post = (body: string) =>
    request(app)
      .post('/api/webhooks/whatsapp')
      .set('X-Hub-Signature-256', sign(body))
      .set('Content-Type', 'application/json')
      .send(body);

  it('opens the service window for the sender, in E.164 form', async () => {
    await post(inboundPayload('hello'));
    // Meta reports `from` WITHOUT a leading +; the window key must not depend on
    // which form happened to arrive, or a send would look outside its own window.
    expect(recordInboundMessage).toHaveBeenCalledWith('+14155550123');
  });

  it('records an opt-out on STOP', async () => {
    await post(inboundPayload('STOP'));
    expect(recordOptOut).toHaveBeenCalledWith('+14155550123');
  });

  it('treats stop keywords case- and whitespace-insensitively', async () => {
    await post(inboundPayload('  stop  '));
    expect(recordOptOut).toHaveBeenCalledWith('+14155550123');
  });

  it('records an opt-in on UNSTOP', async () => {
    await post(inboundPayload('UNSTOP'));
    expect(recordOptIn).toHaveBeenCalledWith('+14155550123', 'unstop_keyword');
  });

  it('does not treat a message merely containing "stop" as an opt-out', async () => {
    // "please stop by the office tomorrow" must not silence a customer.
    await post(inboundPayload('please stop by the office tomorrow'));
    expect(recordOptOut).not.toHaveBeenCalled();
  });

  it('acknowledges a delivery status callback without treating it as inbound', async () => {
    // A status callback is OUR message being delivered — it must not open a service
    // window, which would let us send free-form text to someone who never wrote to us.
    const res = await post(statusPayload('delivered'));
    expect(res.status).toBe(200);
    expect(recordInboundMessage).not.toHaveBeenCalled();
  });

  it('never opens an Emma chat session for an inbound message', async () => {
    // Guards the Jan 2026 general-purpose-AI-assistant prohibition. If a future
    // change wires chatbotService in here, this test is the thing that objects.
    jest.isolateModules(() => {
      const source = require('fs').readFileSync(
        require.resolve('../routes/whatsappWebhook'),
        'utf8',
      );
      expect(source).not.toMatch(/chatbotService|agentModeService|createSession/);
    });
  });

  it('200s on an unparseable body so Meta does not retry forever', async () => {
    const body = 'not json at all';
    const res = await request(app)
      .post('/api/webhooks/whatsapp')
      .set('X-Hub-Signature-256', sign(body))
      .set('Content-Type', 'application/json')
      .send(body);
    expect(res.status).toBe(200);
  });

  it('500s when a handler throws, so Meta retries a lost opt-out', async () => {
    // The opposite of the unparseable case: a storage failure IS transient, and
    // silently swallowing it would drop a STOP with nothing to notice the loss.
    recordInboundMessage.mockRejectedValue(new Error('dynamo down'));
    const res = await post(inboundPayload('hello'));
    expect(res.status).toBe(500);
  });

  it('handles a payload with no entries', async () => {
    const res = await post(JSON.stringify({ object: 'whatsapp_business_account', entry: [] }));
    expect(res.status).toBe(200);
    expect(recordInboundMessage).not.toHaveBeenCalled();
  });

  it('processes every message in a batched delivery', async () => {
    const body = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: '111' },
                messages: [
                  { from: '14155550123', id: 'a', type: 'text', text: { body: 'hi' } },
                  { from: '447700900123', id: 'b', type: 'text', text: { body: 'hi' } },
                ],
              },
            },
          ],
        },
      ],
    });
    await request(app)
      .post('/api/webhooks/whatsapp')
      .set('X-Hub-Signature-256', sign(body))
      .set('Content-Type', 'application/json')
      .send(body);
    expect(recordInboundMessage).toHaveBeenCalledWith('+14155550123');
    expect(recordInboundMessage).toHaveBeenCalledWith('+447700900123');
  });
});
