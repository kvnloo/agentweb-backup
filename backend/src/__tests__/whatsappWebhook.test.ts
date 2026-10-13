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
  sendText: jest.fn(),
  sendOptOutConfirmation: jest.fn(),
  OPT_IN_CONFIRMATION: 'opt-in-confirmation-copy',
  redactPhone: jest.requireActual('../services/whatsappService').redactPhone,
}));
jest.mock('../services/whatsappVerificationService', () => ({
  handleVerificationMessage: jest.fn(),
  disconnectWhatsAppForNumber: jest.fn(),
  resumeVerificationAfterStart: jest.fn(),
}));
jest.mock('../services/approvalChannelNotifier', () => ({
  handleApprovalButtonTap: jest.fn(),
  lookupApprovalMessage: jest.fn(),
}));
jest.mock('../services/approvalDb', () => ({ approvalDb: { getApproval: jest.fn() } }));
jest.mock('../services/whatsappOwnerNotices', () => ({
  notifyOwnerUnreachable: jest.fn(),
}));
jest.mock('../services/whatsappInboundSupport', () => ({
  handleUnrecognizedMessage: jest.fn(),
}));
jest.mock('../utils/secretsManager', () => ({
  getWhatsAppCredentials: jest.fn(),
}));

const {
  recordInboundMessage,
  recordOptOut,
  recordOptIn,
  sendText,
  sendOptOutConfirmation,
} = require('../services/whatsappService');
const { lookupApprovalMessage } = require('../services/approvalChannelNotifier');
const { notifyOwnerUnreachable } = require('../services/whatsappOwnerNotices');
const { approvalDb } = require('../services/approvalDb');
const { handleVerificationMessage, disconnectWhatsAppForNumber, resumeVerificationAfterStart } = require('../services/whatsappVerificationService');
const { handleApprovalButtonTap } = require('../services/approvalChannelNotifier');
const { handleUnrecognizedMessage } = require('../services/whatsappInboundSupport');
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

  it('takes WhatsApp off the account that holds the number when it texts STOP', async () => {
    disconnectWhatsAppForNumber.mockResolvedValue('user-1');
    await post(inboundPayload('STOP'));
    expect(disconnectWhatsAppForNumber).toHaveBeenCalledWith('+14155550123');
  });

  it('records the opt-out BEFORE disconnecting, and disconnects BEFORE confirming', async () => {
    const order: string[] = [];
    recordOptOut.mockImplementation(async () => void order.push('opt-out'));
    disconnectWhatsAppForNumber.mockImplementation(async () => {
      order.push('disconnect');
      return 'user-1';
    });
    sendOptOutConfirmation.mockImplementation(async () => void order.push('confirm'));
    await post(inboundPayload('STOP'));
    expect(order).toEqual(['opt-out', 'disconnect', 'confirm']);
  });

  it('is fine when no account holds the number', async () => {
    disconnectWhatsAppForNumber.mockResolvedValue(null);
    sendOptOutConfirmation.mockResolvedValue(undefined);
    const res = await post(inboundPayload('STOP'));
    expect(res.status).toBe(200);
    expect(sendOptOutConfirmation).toHaveBeenCalled();
  });

  it('answers 500 (so Meta redelivers) when the disconnect hits a storage error, and confirms nothing yet', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    disconnectWhatsAppForNumber.mockRejectedValue(new Error('dynamo down'));
    const res = await post(inboundPayload('STOP'));
    expect(res.status).toBe(500);
    expect(recordOptOut).toHaveBeenCalled(); // the opt-out itself is already safe
    expect(sendOptOutConfirmation).not.toHaveBeenCalled();
  });

  it('START finishes a connection that was waiting on it, and sends the opt-in text only when nothing was waiting', async () => {
    resumeVerificationAfterStart.mockResolvedValue(true);
    await post(inboundPayload('START'));
    expect(resumeVerificationAfterStart).toHaveBeenCalledWith('+14155550123');
    expect(sendText).not.toHaveBeenCalled(); // the resume already replied "You're connected"
  });

  it('START with nothing waiting sends the ordinary opt-in confirmation', async () => {
    resumeVerificationAfterStart.mockResolvedValue(false);
    sendText.mockResolvedValue(undefined);
    await post(inboundPayload('START'));
    expect(sendText).toHaveBeenCalledWith('+14155550123', 'opt-in-confirmation-copy');
  });

  it('START answers 500 (Meta redelivers) when finishing the waiting connection hits a storage error', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    resumeVerificationAfterStart.mockRejectedValue(new Error('dynamo down'));
    const res = await post(inboundPayload('START'));
    expect(res.status).toBe(500);
    expect(recordOptIn).toHaveBeenCalled(); // the opt-in itself is already safe
  });

  it('does not disconnect anyone for START / UNSTOP', async () => {
    await post(inboundPayload('UNSTOP'));
    expect(disconnectWhatsAppForNumber).not.toHaveBeenCalled();
  });

  it('records an opt-out on STOP', async () => {
    await post(inboundPayload('STOP'));
    expect(recordOptOut).toHaveBeenCalledWith('+14155550123');
  });

  it('treats stop keywords case- and whitespace-insensitively', async () => {
    await post(inboundPayload('  stop  '));
    expect(recordOptOut).toHaveBeenCalledWith('+14155550123');
  });

  it.each(['Stop.', 'STOP!', 'please stop', 'Stop please.', 'stop all'])(
    'treats %s as an opt-out',
    async (text) => {
      await post(inboundPayload(text));
      expect(recordOptOut).toHaveBeenCalledWith('+14155550123');
    },
  );

  it.each([
    'Stop 🛑',
    'stop 👋',
    'ＳＴＯＰ',
    'stop…',
    '"stop"',
    'STOP\u200b',
    'Stop 。',
    'stop  all',
    '  STOP\n  ',
  ])('treats %j as an opt-out (emoji, quotes, fullwidth and zero-width noise)', async (text) => {
    await post(inboundPayload(text));
    expect(recordOptOut).toHaveBeenCalledWith('+14155550123');
  });

  it.each(['cancel my order', 'please stop by the office tomorrow', "don't stop", 'stop 2 items', 'what is the end date'])(
    'does NOT treat %j as an opt-out',
    async (text) => {
      await post(inboundPayload(text));
      expect(recordOptOut).not.toHaveBeenCalled();
    },
  );

  it('logs a FAILED delivery receipt by message id and never opens a window', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    await post(statusPayload('failed'));
    expect(errSpy.mock.calls.flat().join(' ')).toMatch(/…[\w.]+ FAILED to deliver/);
    expect(errSpy.mock.calls.flat().join(' ')).not.toContain('4155550123');
    expect(recordInboundMessage).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('emails the owner when a failed receipt belongs to an approval request', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    lookupApprovalMessage.mockResolvedValue({ assetUrl: 'https://a/x.png', userId: 'user-1' });
    approvalDb.getApproval.mockResolvedValue({ assetUrl: 'https://a/x.png', userId: 'user-1', status: 'pending' });
    await post(statusPayload('failed'));
    expect(lookupApprovalMessage).toHaveBeenCalledWith('wamid.OUT1');
    expect(notifyOwnerUnreachable).toHaveBeenCalledWith('user-1');
  });

  it.each(['approved', 'rejected', 'needs_changes'])(
    'does NOT email the owner when the approval is already %s (the results are not on hold)',
    async (status) => {
      jest.spyOn(console, 'error').mockImplementation(() => {});
      lookupApprovalMessage.mockResolvedValue({ assetUrl: 'https://a/x.png', userId: 'user-1' });
      approvalDb.getApproval.mockResolvedValue({ assetUrl: 'https://a/x.png', userId: 'user-1', status });
      await post(statusPayload('failed'));
      expect(notifyOwnerUnreachable).not.toHaveBeenCalled();
    },
  );

  it('does NOT email the owner when the record now belongs to someone else', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    lookupApprovalMessage.mockResolvedValue({ assetUrl: 'https://a/x.png', userId: 'user-1' });
    approvalDb.getApproval.mockResolvedValue({ assetUrl: 'https://a/x.png', userId: 'user-2', status: 'pending' });
    await post(statusPayload('failed'));
    expect(notifyOwnerUnreachable).not.toHaveBeenCalled();
  });

  it('does not email anyone for a failed receipt that was not an approval request', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    lookupApprovalMessage.mockResolvedValue(null);
    await post(statusPayload('failed'));
    expect(notifyOwnerUnreachable).not.toHaveBeenCalled();
  });

  it('a failure while acting on a receipt never fails the webhook', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    lookupApprovalMessage.mockRejectedValue(new Error('dynamo down'));
    const res = await post(statusPayload('failed'));
    expect(res.status).toBe(200);
  });

  it('stays quiet for a delivered receipt', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    await post(statusPayload('delivered'));
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('records an opt-in on UNSTOP', async () => {
    await post(inboundPayload('UNSTOP'));
    expect(recordOptIn).toHaveBeenCalledWith('+14155550123', 'unstop_keyword');
  });

  it('confirms the opt-out, so a STOP is never answered with silence', async () => {
    await post(inboundPayload('STOP'));
    expect(sendOptOutConfirmation).toHaveBeenCalledWith('+14155550123');
  });

  it('records the opt-out BEFORE confirming it', async () => {
    const order: string[] = [];
    (recordOptOut as jest.Mock).mockImplementationOnce(async () => {
      order.push('record');
    });
    (sendOptOutConfirmation as jest.Mock).mockImplementationOnce(async () => {
      order.push('confirm');
    });
    await post(inboundPayload('STOP'));
    // Recording is the compliance-critical half. If the confirmation were sent first and
    // the process died between the two, the customer would believe they had opted out
    // while still being subscribed — the one ordering that is actually unsafe.
    expect(order).toEqual(['record', 'confirm']);
  });

  it('still records the opt-out when the confirmation fails to send', async () => {
    (sendOptOutConfirmation as jest.Mock).mockRejectedValueOnce(new Error('meta down'));
    const res = await post(inboundPayload('STOP'));
    expect(recordOptOut).toHaveBeenCalledWith('+14155550123');
    // 200, not 500: a retry would re-record an opt-out that already landed and send a
    // second confirmation. The opt-out is not lost, so there is nothing to retry.
    expect(res.status).toBe(200);
  });

  it('confirms the opt-in on UNSTOP through the ordinary send path', async () => {
    await post(inboundPayload('UNSTOP'));
    // Plain sendText, not the opt-out bypass: the number is opted back in by now, so the
    // normal guards are the right ones to apply.
    expect(sendText).toHaveBeenCalledWith('+14155550123', 'opt-in-confirmation-copy');
    expect(sendOptOutConfirmation).not.toHaveBeenCalled();
  });

  it('still records the opt-in when its confirmation fails to send', async () => {
    (sendText as jest.Mock).mockRejectedValueOnce(new Error('meta down'));
    const res = await post(inboundPayload('UNSTOP'));
    expect(recordOptIn).toHaveBeenCalledWith('+14155550123', 'unstop_keyword');
    expect(res.status).toBe(200);
  });

  it('never puts the raw phone number in a STOP/START log line', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    await post(inboundPayload('STOP'));
    await post(inboundPayload('UNSTOP'));
    const logged = logSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
    expect(logged).not.toContain('14155550123');
    expect(logged).toContain('0123'); // still correlatable via the last 4 digits
    logSpy.mockRestore();
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

// ── Number verification ────────────────────────────────────────────────────

describe('POST — number verification', () => {
  const post = (body: string) =>
    request(app)
      .post('/api/webhooks/whatsapp')
      .set('X-Hub-Signature-256', sign(body))
      .set('Content-Type', 'application/json')
      .send(body);

  it("hands a text message to the verification handler with the sender in E.164 form", async () => {
    await post(inboundPayload('Verify K7Q2M9XA'));
    // The handler owns deciding whether it is a verification attempt; the webhook only
    // supplies the text and the normalized number the code will be bound to.
    expect(handleVerificationMessage).toHaveBeenCalledWith('Verify K7Q2M9XA', '+14155550123');
  });

  it('opens the service window first, so the confirmation reply is deliverable', async () => {
    await post(inboundPayload('Verify K7Q2M9XA'));
    expect(recordInboundMessage.mock.invocationCallOrder[0]).toBeLessThan(
      handleVerificationMessage.mock.invocationCallOrder[0],
    );
  });

  it.each(['STOP', 'unsubscribe', 'START', 'unstop'])(
    'does not route the keyword %j to verification',
    async (keyword) => {
      await post(inboundPayload(keyword));
      expect(handleVerificationMessage).not.toHaveBeenCalled();
    },
  );

  it('does not run verification for a delivery status callback', async () => {
    await post(statusPayload('delivered'));
    expect(handleVerificationMessage).not.toHaveBeenCalled();
  });

  it('does not run verification for a badly signed delivery', async () => {
    const body = inboundPayload('Verify K7Q2M9XA');
    const res = await request(app)
      .post('/api/webhooks/whatsapp')
      .set('X-Hub-Signature-256', 'sha256=' + '0'.repeat(64))
      .set('Content-Type', 'application/json')
      .send(body);
    expect(res.status).toBe(401);
    expect(handleVerificationMessage).not.toHaveBeenCalled();
  });

  it('500s when verification storage fails, so Meta retries and the claim is resumed', async () => {
    handleVerificationMessage.mockRejectedValue(new Error('dynamo down'));
    const res = await post(inboundPayload('Verify K7Q2M9XA'));
    expect(res.status).toBe(500);
  });

  it('200s when verification completes, whatever the outcome it chose to reply with', async () => {
    handleVerificationMessage.mockResolvedValue(true);
    expect((await post(inboundPayload('Verify K7Q2M9XA'))).status).toBe(200);
  });
});

describe('POST — tapped buttons', () => {
  const post = (body: string) =>
    request(app)
      .post('/api/webhooks/whatsapp')
      .set('X-Hub-Signature-256', sign(body))
      .set('Content-Type', 'application/json')
      .send(body);

  const envelope = (msg: any) =>
    JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        { id: 'W', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', messages: [msg] } }] },
      ],
    });

  const base = { from: '14155550123', id: 'wamid.IN', timestamp: '1' };

  it('routes a non-template reply button, keeping the id we set', async () => {
    await post(
      envelope({
        ...base,
        type: 'interactive',
        context: { from: 'biz', id: 'wamid.APPROVAL' },
        interactive: { type: 'button_reply', button_reply: { id: 'approve', title: 'Approve' } },
      }),
    );
    expect(handleApprovalButtonTap).toHaveBeenCalledWith({
      phone: '+14155550123',
      approvalMessageId: 'wamid.APPROVAL',
      action: 'approve',
    });
  });

  it('routes a TEMPLATE quick-reply, where Meta sends back the label', async () => {
    await post(
      envelope({
        ...base,
        type: 'button',
        context: { from: 'biz', id: 'wamid.APPROVAL' },
        button: { payload: 'Approve', text: 'Approve' },
      }),
    );
    expect(handleApprovalButtonTap).toHaveBeenCalledWith({
      phone: '+14155550123',
      approvalMessageId: 'wamid.APPROVAL',
      action: 'Approve',
    });
  });

  it('ignores a tap with no context — it cannot be attributed to anything', async () => {
    await post(
      envelope({
        ...base,
        type: 'interactive',
        interactive: { type: 'button_reply', button_reply: { id: 'approve', title: 'Approve' } },
      }),
    );
    expect(handleApprovalButtonTap).not.toHaveBeenCalled();
  });

  it('still opens the service window for a tap', async () => {
    // The tap is a user message; treating it otherwise would leave us unable to reply.
    await post(
      envelope({
        ...base,
        type: 'button',
        context: { from: 'biz', id: 'wamid.APPROVAL' },
        button: { payload: 'Approve', text: 'Approve' },
      }),
    );
    expect(recordInboundMessage).toHaveBeenCalledWith('+14155550123');
  });

  it('does not hand a tap to the verification parser', async () => {
    await post(
      envelope({
        ...base,
        type: 'button',
        context: { from: 'biz', id: 'wamid.APPROVAL' },
        button: { payload: 'Approve', text: 'Approve' },
      }),
    );
    expect(handleVerificationMessage).not.toHaveBeenCalled();
  });

  it('leaves ordinary text alone', async () => {
    await post(inboundPayload('hello there'));
    expect(handleApprovalButtonTap).not.toHaveBeenCalled();
    expect(handleVerificationMessage).toHaveBeenCalled();
  });
});

describe('POST — messages that are not commands', () => {
  const post = (body: string) =>
    request(app)
      .post('/api/webhooks/whatsapp')
      .set('X-Hub-Signature-256', sign(body))
      .set('Content-Type', 'application/json')
      .send(body);

  it('hands an ordinary message to the support hand-off', async () => {
    (handleVerificationMessage as jest.Mock).mockResolvedValue(false);
    await post(inboundPayload('hi'));
    // replaced below with the media-aware assertion
  });

  it('passes a media message\'s caption and where to find the file to the hand-off', async () => {
    (handleVerificationMessage as jest.Mock).mockResolvedValue(false);
    await post(
      JSON.stringify({
        object: 'whatsapp_business_account',
        entry: [{ id: 'W', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', messages: [{
          from: '14155550123', id: 'wamid.M', timestamp: '1', type: 'image',
          image: { id: 'MEDIA-123', caption: 'my dashboard is broken', mime_type: 'image/jpeg' },
        }] } }] }],
      }),
    );
    expect(handleUnrecognizedMessage).toHaveBeenCalledWith(
      '+14155550123', 'my dashboard is broken', 'image', 'image, media id MEDIA-123', 'wamid.M',
    );
  });

  it('names a document by its filename', async () => {
    (handleVerificationMessage as jest.Mock).mockResolvedValue(false);
    await post(
      JSON.stringify({
        object: 'whatsapp_business_account',
        entry: [{ id: 'W', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', messages: [{
          from: '14155550123', id: 'wamid.D', timestamp: '1', type: 'document',
          document: { id: 'MEDIA-9', filename: 'invoice.pdf' },
        }] } }] }],
      }),
    );
    expect(handleUnrecognizedMessage).toHaveBeenCalledWith(
      '+14155550123', '', 'document', 'document, file "invoice.pdf", media id MEDIA-9', 'wamid.D',
    );
  });

  it('gives plain text no media detail', async () => {
    (handleVerificationMessage as jest.Mock).mockResolvedValue(false);
    await post(inboundPayload('hi'));
    expect(handleUnrecognizedMessage).toHaveBeenCalledWith('+14155550123', 'hi', 'text', '', 'wamid.IN1');
  });

  it('does not greet someone who just sent a verification code', async () => {
    (handleVerificationMessage as jest.Mock).mockResolvedValue(true);
    await post(inboundPayload('Verify ABCD2345'));
    expect(handleUnrecognizedMessage).not.toHaveBeenCalled();
  });

  it.each(['STOP', 'UNSTOP'])('does not greet on %s', async (kw) => {
    await post(inboundPayload(kw));
    expect(handleUnrecognizedMessage).not.toHaveBeenCalled();
  });
});
