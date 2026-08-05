/**
 * Error and fallback paths across the ENG-273 channel code.
 *
 * These are the branches that only run when something is already going wrong —
 * credentials unavailable, a store throwing, a vendor returning a shape we did not
 * expect. They are exactly the paths least likely to be exercised by hand and most
 * likely to turn a recoverable failure into an outage, so they are pinned here
 * rather than left to the happy-path suites.
 */

import express from 'express';
import request from 'supertest';
import crypto from 'crypto';

jest.mock('../services/settingsService', () => ({
  settingsService: { getSetting: jest.fn(), setSetting: jest.fn(), deleteSetting: jest.fn() },
}));
jest.mock('../utils/secretsManager', () => ({ getWhatsAppCredentials: jest.fn() }));
jest.mock('../services/db', () => ({
  userDb: { getUserById: jest.fn(), getUserByEmail: jest.fn(), updateUser: jest.fn() },
  orgDb: { getOrgById: jest.fn() },
}));
jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: 'u1' };
    next();
  },
}));
jest.mock('../services/slackService', () => ({ postSlackMessage: jest.fn() }));

const { settingsService } = require('../services/settingsService');
const { getWhatsAppCredentials } = require('../utils/secretsManager');
const { userDb, orgDb } = require('../services/db');
const { postSlackMessage } = require('../services/slackService');

import {
  toE164,
  sendTemplate,
  sendMessage,
  TEMPLATES,
  WhatsAppError,
  WhatsAppRateLimitError,
} from '../services/whatsappService';
import { resolveDestination } from '../services/messagingChannelService';
import { slackChannelAdapter } from '../services/slackChannelAdapter';
import whatsappWebhookRouter from '../routes/whatsappWebhook';
import messagingChannelsRouter from '../routes/messagingChannels';

const CREDS = {
  phoneNumberId: '111',
  wabaId: '222',
  accessToken: 'tok',
  appSecret: 'sec',
  webhookVerifyToken: 'verify',
};

const webhookApp = express();
webhookApp.use('/wh', express.raw({ type: '*/*' }), whatsappWebhookRouter);

const configApp = express();
configApp.use(express.json());
configApp.use('/cfg', messagingChannelsRouter);

beforeEach(() => {
  jest.resetAllMocks();
  getWhatsAppCredentials.mockResolvedValue(CREDS);
  settingsService.getSetting.mockResolvedValue(null);
  settingsService.setSetting.mockResolvedValue(undefined);
  (global as any).fetch = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ messages: [{ id: 'wamid.1' }] }),
  });
});

// ── whatsappService ────────────────────────────────────────────────────────

describe('whatsappService fallbacks', () => {
  it('returns null for a non-string destination rather than throwing', () => {
    expect(toE164(undefined as any)).toBeNull();
    expect(toE164(null as any)).toBeNull();
    expect(toE164(12345 as any)).toBeNull();
  });

  it('returns null when the parser throws on a pathological input', () => {
    // libphonenumber throws rather than returning false on some malformed inputs;
    // a messaging destination must degrade to "unknown", never to an exception.
    expect(toE164('+'.repeat(400))).toBeNull();
  });

  it('maps a 429 with no recognizable subcode to a rate-limit error', () => {
    (global as any).fetch.mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({ error: { message: 'slow down' } }),
    });
    return expect(
      sendTemplate('+14155550123', TEMPLATES.SHIP_NOTIFY, ['a', 'b']),
    ).rejects.toBeInstanceOf(WhatsAppRateLimitError);
  });

  it('rejects an unknown template name and lists the approved ones', async () => {
    const err = await sendMessage({
      destination: '+14155550123',
      text: 'x',
      template: { name: 'agentweb_not_a_real_template', variables: [] },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(WhatsAppError);
    expect(err.message).toContain(TEMPLATES.SHIP_NOTIFY.name);
  });

  it('surfaces a credential-fetch failure instead of sending unauthenticated', async () => {
    getWhatsAppCredentials.mockRejectedValue(new Error('secret missing'));
    await expect(
      sendTemplate('+14155550123', TEMPLATES.SHIP_NOTIFY, ['a', 'b']),
    ).rejects.toThrow();
    expect((global as any).fetch).not.toHaveBeenCalled();
  });
});

// ── messagingChannelService ────────────────────────────────────────────────

describe('resolveDestination fallbacks', () => {
  it('returns null when the org owner has no channel either', async () => {
    orgDb.getOrgById.mockResolvedValue({ ownerUserId: 'owner1' });
    userDb.getUserById.mockResolvedValue({ userId: 'owner1' });
    await expect(resolveDestination({ orgId: 'o1' }, 'slack')).resolves.toBeNull();
  });

  it('returns null when the org owner lookup itself fails', async () => {
    orgDb.getOrgById.mockResolvedValue({ ownerUserId: 'owner1' });
    userDb.getUserById.mockRejectedValue(new Error('dynamo down'));
    await expect(resolveDestination({ orgId: 'o1' }, 'slack')).resolves.toBeNull();
  });

  it('returns null when the org record has no owner and no channel', async () => {
    orgDb.getOrgById.mockResolvedValue({});
    await expect(resolveDestination({ orgId: 'o1' }, 'slack')).resolves.toBeNull();
  });
});

// ── slackChannelAdapter ────────────────────────────────────────────────────

describe('slackChannelAdapter error wrapping', () => {
  it('stringifies a non-Error rejection rather than emitting [object Object]', async () => {
    postSlackMessage.mockRejectedValue('plain string failure');
    await expect(
      slackChannelAdapter.sendMessage({ destination: 'C1', text: 'x' }),
    ).rejects.toThrow(/plain string failure/);
  });

  it('normalizes a missing ts on a threaded send to null', async () => {
    postSlackMessage.mockResolvedValue({ channel: 'C1' });
    await expect(
      slackChannelAdapter.sendMessage({ destination: 'C1', text: 'x', replyToMessageId: '1.0' }),
    ).resolves.toEqual({ messageId: null });
  });
});

// ── webhook ────────────────────────────────────────────────────────────────

describe('webhook failure handling', () => {
  const sign = (body: string) =>
    'sha256=' + crypto.createHmac('sha256', CREDS.appSecret).update(Buffer.from(body)).digest('hex');

  it('403s the GET challenge when credentials cannot be read', async () => {
    getWhatsAppCredentials.mockRejectedValue(new Error('secret missing'));
    const res = await request(webhookApp)
      .get('/wh')
      .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'verify', 'hub.challenge': 'c' });
    expect(res.status).toBe(403);
  });

  it('echoes an empty string when Meta omits hub.challenge', async () => {
    const res = await request(webhookApp)
      .get('/wh')
      .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'verify' });
    expect(res.status).toBe(200);
    expect(res.text).toBe('');
  });

  it('401s the POST when credentials cannot be read — fails closed', async () => {
    // Never process unverified input just because the secret store is down.
    const body = JSON.stringify({ entry: [] });
    getWhatsAppCredentials.mockRejectedValue(new Error('secret missing'));
    const res = await request(webhookApp)
      .post('/wh')
      .set('X-Hub-Signature-256', sign(body))
      .set('Content-Type', 'application/json')
      .send(body);
    expect(res.status).toBe(401);
  });

  it('rejects a signature of the right shape but wrong length', async () => {
    const body = JSON.stringify({ entry: [] });
    const res = await request(webhookApp)
      .post('/wh')
      .set('X-Hub-Signature-256', 'sha256=abc')
      .set('Content-Type', 'application/json')
      .send(body);
    expect(res.status).toBe(401);
  });

  it('ignores an inbound message with no usable sender', async () => {
    const body = JSON.stringify({
      entry: [{ changes: [{ value: { messages: [{ id: 'x', type: 'text' }] } }] }],
    });
    const res = await request(webhookApp)
      .post('/wh')
      .set('X-Hub-Signature-256', sign(body))
      .set('Content-Type', 'application/json')
      .send(body);
    expect(res.status).toBe(200);
  });

  it('tolerates an entry with no changes array', async () => {
    const body = JSON.stringify({ entry: [{ id: '222' }] });
    const res = await request(webhookApp)
      .post('/wh')
      .set('X-Hub-Signature-256', sign(body))
      .set('Content-Type', 'application/json')
      .send(body);
    expect(res.status).toBe(200);
  });
});

// ── config routes ──────────────────────────────────────────────────────────

describe('config route failure handling', () => {
  it('500s the listing when the user lookup throws', async () => {
    userDb.getUserById.mockRejectedValue(new Error('dynamo down'));
    expect((await request(configApp).get('/cfg')).status).toBe(500);
  });

  it('500s the save when the write throws', async () => {
    userDb.getUserById.mockResolvedValue({ userId: 'u1' });
    userDb.updateUser.mockRejectedValue(new Error('dynamo down'));
    const res = await request(configApp)
      .put('/cfg/whatsapp')
      .send({ phone: '+14155550123', optIn: true });
    expect(res.status).toBe(500);
  });

  it('500s the delete when the write throws', async () => {
    userDb.getUserById.mockResolvedValue({ userId: 'u1' });
    userDb.updateUser.mockRejectedValue(new Error('dynamo down'));
    expect((await request(configApp).delete('/cfg/whatsapp')).status).toBe(500);
  });

  it('404s the save for an unknown user', async () => {
    userDb.getUserById.mockResolvedValue(null);
    const res = await request(configApp)
      .put('/cfg/whatsapp')
      .send({ phone: '+14155550123', optIn: true });
    expect(res.status).toBe(404);
  });

  it('404s the delete for an unknown user', async () => {
    userDb.getUserById.mockResolvedValue(null);
    expect((await request(configApp).delete('/cfg/whatsapp')).status).toBe(404);
  });

  it('rejects a non-string phone without attempting to parse it', async () => {
    userDb.getUserById.mockResolvedValue({ userId: 'u1' });
    const res = await request(configApp).put('/cfg/whatsapp').send({ phone: 12345, optIn: true });
    expect(res.status).toBe(400);
  });

  it('drops a malformed stored entry from the listing', async () => {
    userDb.getUserById.mockResolvedValue({
      userId: 'u1',
      messagingChannels: [{ channel: 'whatsapp' }, null],
    });
    const res = await request(configApp).get('/cfg');
    expect(res.body.channels).toEqual([]);
  });
});
