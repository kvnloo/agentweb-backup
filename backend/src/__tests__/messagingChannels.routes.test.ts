/**
 * Per-user messaging channel configuration routes (ENG-273).
 *
 * The consent behavior is the point of this suite. Meta requires recorded opt-in
 * before the first outbound WhatsApp message, so a phone number saved without it
 * would be a destination we are not permitted to message — the route must refuse
 * rather than store it and find out later.
 */

import express from 'express';
import request from 'supertest';

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: 'u1', email: 'u@e.com' };
    next();
  },
}));
jest.mock('../services/db', () => ({
  userDb: { getUserById: jest.fn(), updateUser: jest.fn() },
  orgDb: { getOrgById: jest.fn() },
}));
jest.mock('../services/whatsappService', () => ({
  toE164: jest.requireActual('../services/whatsappService').toE164,
  isOptedOut: jest.fn(),
}));

const { userDb } = require('../services/db');
const { isOptedOut } = require('../services/whatsappService');

import messagingChannelsRouter from '../routes/messagingChannels';

const app = express();
app.use(express.json());
app.use('/api/messaging-channels', messagingChannelsRouter);

beforeEach(() => {
  jest.resetAllMocks();
  isOptedOut.mockResolvedValue(false);
  userDb.updateUser.mockResolvedValue(undefined);
});

describe('GET /', () => {
  it('returns legacy Slack config normalized, with no migration', async () => {
    userDb.getUserById.mockResolvedValue({ userId: 'u1', slackChannels: ['C1'] });
    const res = await request(app).get('/api/messaging-channels');
    expect(res.status).toBe(200);
    expect(res.body.channels).toEqual([{ channel: 'slack', destination: 'C1', enabled: true }]);
    expect(userDb.updateUser).not.toHaveBeenCalled();
  });

  it('flags a WhatsApp destination that has texted STOP', async () => {
    // Without this the UI would show a healthy row for a number we cannot reach.
    userDb.getUserById.mockResolvedValue({
      userId: 'u1',
      messagingChannels: [{ channel: 'whatsapp', destination: '+14155550123', enabled: true }],
    });
    isOptedOut.mockResolvedValue(true);
    const res = await request(app).get('/api/messaging-channels');
    expect(res.body.channels[0].optedOut).toBe(true);
  });

  it('404s for an unknown user', async () => {
    userDb.getUserById.mockResolvedValue(null);
    expect((await request(app).get('/api/messaging-channels')).status).toBe(404);
  });
});

describe('PUT /whatsapp', () => {
  beforeEach(() => {
    userDb.getUserById.mockResolvedValue({ userId: 'u1', slackChannels: ['C1'] });
  });

  it('saves a valid number with a recorded opt-in', async () => {
    const res = await request(app)
      .put('/api/messaging-channels/whatsapp')
      .send({ phone: '+1 415 555 0123', optIn: true });
    expect(res.status).toBe(200);
    const saved = userDb.updateUser.mock.calls[0][1].messagingChannels;
    const wa = saved.find((c: any) => c.channel === 'whatsapp');
    expect(wa.destination).toBe('+14155550123');
    expect(wa.optIn.source).toBe('settings_ui');
    expect(typeof wa.optIn.at).toBe('string');
  });

  it('refuses to store a number without an explicit opt-in', async () => {
    const res = await request(app)
      .put('/api/messaging-channels/whatsapp')
      .send({ phone: '+14155550123' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/opt-in/i);
    expect(userDb.updateUser).not.toHaveBeenCalled();
  });

  it('treats a truthy-but-not-true optIn as missing consent', async () => {
    const res = await request(app)
      .put('/api/messaging-channels/whatsapp')
      .send({ phone: '+14155550123', optIn: 'yes' });
    expect(res.status).toBe(400);
    expect(userDb.updateUser).not.toHaveBeenCalled();
  });

  it('rejects an unparseable number with a message naming the country code', async () => {
    const res = await request(app)
      .put('/api/messaging-channels/whatsapp')
      .send({ phone: '555-CALL-NOW', optIn: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/country code/i);
    expect(userDb.updateUser).not.toHaveBeenCalled();
  });

  it('rejects a national number with no country code rather than guessing US', async () => {
    const res = await request(app)
      .put('/api/messaging-channels/whatsapp')
      .send({ phone: '4155550123', optIn: true });
    expect(res.status).toBe(400);
  });

  it('does NOT copy a legacy Slack channel into messagingChannels', async () => {
    // Greptile P1. Persisting the normalized list would write the user's CURRENT
    // Slack destination in as an explicit entry, and an explicit entry outranks the
    // legacy field — so a later admin re-mapping of their Slack channel would be
    // silently ignored and notifications would keep going to the old channel.
    // Configuring WhatsApp must not freeze Slack routing.
    await request(app)
      .put('/api/messaging-channels/whatsapp')
      .send({ phone: '+14155550123', optIn: true });
    const saved = userDb.updateUser.mock.calls[0][1].messagingChannels;
    expect(saved.some((c: any) => c.channel === 'slack')).toBe(false);
    expect(saved).toHaveLength(1);
  });

  it('leaves a legacy Slack user still resolvable on Slack after adding WhatsApp', async () => {
    // The other half of the same guarantee: not persisting Slack must not mean
    // losing it. It still resolves through the legacy field at read time.
    await request(app)
      .put('/api/messaging-channels/whatsapp')
      .send({ phone: '+14155550123', optIn: true });
    const saved = userDb.updateUser.mock.calls[0][1].messagingChannels;
    userDb.getUserById.mockResolvedValue({
      userId: 'u1',
      slackChannels: ['C-remapped-by-admin'],
      messagingChannels: saved,
    });
    const res = await request(app).get('/api/messaging-channels');
    const slack = res.body.channels.find((c: any) => c.channel === 'slack');
    // The admin's NEW channel, not the one present when WhatsApp was configured.
    expect(slack.destination).toBe('C-remapped-by-admin');
  });

  it('preserves an explicitly-configured non-WhatsApp entry', async () => {
    userDb.getUserById.mockResolvedValue({
      userId: 'u1',
      messagingChannels: [{ channel: 'slack', destination: 'C-explicit', enabled: true }],
    });
    await request(app)
      .put('/api/messaging-channels/whatsapp')
      .send({ phone: '+14155550123', optIn: true });
    const saved = userDb.updateUser.mock.calls[0][1].messagingChannels;
    expect(saved.find((c: any) => c.channel === 'slack')?.destination).toBe('C-explicit');
  });

  it('replaces an existing WhatsApp entry rather than adding a second', async () => {
    userDb.getUserById.mockResolvedValue({
      userId: 'u1',
      messagingChannels: [{ channel: 'whatsapp', destination: '+14155550000', enabled: true }],
    });
    await request(app)
      .put('/api/messaging-channels/whatsapp')
      .send({ phone: '+14155550123', optIn: true });
    const saved = userDb.updateUser.mock.calls[0][1].messagingChannels;
    expect(saved.filter((c: any) => c.channel === 'whatsapp')).toHaveLength(1);
    expect(saved[0].destination).toBe('+14155550123');
  });

  it('records a caller-supplied opt-in source', async () => {
    await request(app)
      .put('/api/messaging-channels/whatsapp')
      .send({ phone: '+14155550123', optIn: true, source: 'onboarding_call' });
    const saved = userDb.updateUser.mock.calls[0][1].messagingChannels;
    expect(saved.find((c: any) => c.channel === 'whatsapp').optIn.source).toBe('onboarding_call');
  });
});

describe('DELETE /whatsapp', () => {
  it('removes the WhatsApp entry and keeps explicitly-configured others', async () => {
    userDb.getUserById.mockResolvedValue({
      userId: 'u1',
      messagingChannels: [
        { channel: 'slack', destination: 'C-explicit', enabled: true },
        { channel: 'whatsapp', destination: '+14155550123', enabled: true },
      ],
    });
    const res = await request(app).delete('/api/messaging-channels/whatsapp');
    expect(res.status).toBe(200);
    const saved = userDb.updateUser.mock.calls[0][1].messagingChannels;
    expect(saved.some((c: any) => c.channel === 'whatsapp')).toBe(false);
    expect(saved.some((c: any) => c.channel === 'slack')).toBe(true);
  });

  it('does not pin a legacy Slack destination as a side effect of removing WhatsApp', async () => {
    // Same Greptile P1 as the PUT path: removing WhatsApp must not write the
    // current Slack destination in as an explicit entry.
    userDb.getUserById.mockResolvedValue({
      userId: 'u1',
      slackChannels: ['C1'],
      messagingChannels: [{ channel: 'whatsapp', destination: '+14155550123', enabled: true }],
    });
    await request(app).delete('/api/messaging-channels/whatsapp');
    const saved = userDb.updateUser.mock.calls[0][1].messagingChannels;
    expect(saved).toEqual([]);
  });

  it('is a no-op-shaped success when no WhatsApp entry exists', async () => {
    userDb.getUserById.mockResolvedValue({ userId: 'u1', slackChannels: ['C1'] });
    expect((await request(app).delete('/api/messaging-channels/whatsapp')).status).toBe(200);
  });
});
