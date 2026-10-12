/**
 * Per-user messaging channel configuration routes (ENG-273).
 *
 * The consent behavior is the point of this suite. Meta requires recorded opt-in
 * before the first outbound WhatsApp message, and AgentWeb messages from ONE shared
 * business number, so a number someone merely typed in — a typo, or a stranger's — must
 * never become a destination. There is therefore no endpoint that saves a phone number:
 * the user starts a verification, messages a code to the business number, and only the
 * webhook connects the sender (see whatsappVerificationService).
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
  isOptedOut: jest.fn(),
  getDisplayPhoneNumber: jest.fn(),
  unbindPhone: jest.fn(),
}));
jest.mock('../services/whatsappVerificationService', () => ({
  startVerification: jest.fn(),
  getVerificationStatus: jest.fn(),
  // The real disconnect: the DELETE tests below assert on what it writes.
  disconnectWhatsApp: jest.requireActual('../services/whatsappVerificationService').disconnectWhatsApp,
}));

const { userDb } = require('../services/db');
const { isOptedOut, getDisplayPhoneNumber } = require('../services/whatsappService');
const whatsapp = require('../services/whatsappService');
const { startVerification, getVerificationStatus } = require('../services/whatsappVerificationService');

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

  it('tells the UI whether a WhatsApp destination has been verified', async () => {
    userDb.getUserById.mockResolvedValue({
      userId: 'u1',
      messagingChannels: [
        {
          channel: 'whatsapp',
          destination: '+14155550123',
          enabled: true,
          optIn: { at: 'a', source: 'inbound_verification', verifiedAt: 'b' },
        },
      ],
    });
    expect((await request(app).get('/api/messaging-channels')).body.channels[0].verified).toBe(true);

    userDb.getUserById.mockResolvedValue({
      userId: 'u1',
      messagingChannels: [{ channel: 'whatsapp', destination: '+14155550123', enabled: true }],
    });
    expect((await request(app).get('/api/messaging-channels')).body.channels[0].verified).toBe(false);
  });

  it('404s for an unknown user', async () => {
    userDb.getUserById.mockResolvedValue(null);
    expect((await request(app).get('/api/messaging-channels')).status).toBe(404);
  });
});

describe('there is no way to save a typed-in number', () => {
  // Removed with the PUT route: its tests asserted that a number the user typed was
  // stored on the strength of a self-declared opt-in. That is exactly what verification
  // replaces — the same invariants (legacy Slack not frozen, other channels kept, one
  // WhatsApp entry) now live in whatsappVerificationService.test.ts, where the write is.
  it('has no PUT /whatsapp, and a request to it writes nothing', async () => {
    userDb.getUserById.mockResolvedValue({ userId: 'u1' });
    const res = await request(app)
      .put('/api/messaging-channels/whatsapp')
      .send({ phone: '+14155550123', optIn: true });
    expect(res.status).toBe(404);
    expect(userDb.updateUser).not.toHaveBeenCalled();
  });

  it('never writes a user record when a verification is merely started', async () => {
    getDisplayPhoneNumber.mockResolvedValue('14155550100');
    startVerification.mockResolvedValue({ code: 'K7Q2M9XA', expiresAt: '2026-09-21T12:10:00.000Z' });
    await request(app).post('/api/messaging-channels/whatsapp/verification').send({ optIn: true });
    expect(userDb.updateUser).not.toHaveBeenCalled();
  });
});

describe('GET / — which platform the account is on', () => {
  it('reports Slack for a Slack customer', async () => {
    userDb.getUserById.mockResolvedValue({ userId: 'u1', slackChannels: ['C1'] });
    const res = await request(app).get('/api/messaging-channels');
    expect(res.body.platform).toBe('slack');
    expect(res.body.platformSource).toBe('account');
  });

  it('reports WhatsApp for a customer with a verified number', async () => {
    isOptedOut.mockResolvedValue(false);
    userDb.getUserById.mockResolvedValue({
      userId: 'u1',
      messagingChannels: [
        { channel: 'whatsapp', destination: '+14155550123', enabled: true, optIn: { verifiedAt: 'y' } },
      ],
    });
    const res = await request(app).get('/api/messaging-channels');
    expect(res.body.platform).toBe('whatsapp');
  });

  it('reports no platform for an account that has connected neither', async () => {
    userDb.getUserById.mockResolvedValue({ userId: 'u1' });
    const res = await request(app).get('/api/messaging-channels');
    expect(res.body.platform).toBeNull();
  });
});

describe('POST /whatsapp/verification', () => {
  beforeEach(() => {
    getDisplayPhoneNumber.mockResolvedValue('14155550100');
    startVerification.mockResolvedValue({ code: 'K7Q2M9XA', expiresAt: '2026-09-21T12:10:00.000Z' });
    userDb.getUserById.mockResolvedValue({ userId: 'u1' });
  });

  it('refuses an account that is already on Slack — one platform per customer', async () => {
    userDb.getUserById.mockResolvedValue({ userId: 'u1', slackChannels: ['C1'] });
    const res = await request(app)
      .post('/api/messaging-channels/whatsapp/verification')
      .send({ optIn: true });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('platform_conflict');
    expect(res.body.connected).toBe('slack');
    expect(res.body.error).toMatch(/already connected to Slack/);
    // No code is issued for a connection that would be refused at the other end.
    expect(startVerification).not.toHaveBeenCalled();
  });

  it('allows re-verifying for an account already on WhatsApp', async () => {
    userDb.getUserById.mockResolvedValue({
      userId: 'u1',
      messagingChannels: [
        { channel: 'whatsapp', destination: '+14155550123', enabled: true, optIn: { verifiedAt: 'y' } },
      ],
    });
    const res = await request(app)
      .post('/api/messaging-channels/whatsapp/verification')
      .send({ optIn: true });
    expect(res.status).toBe(200);
  });

  it('starts a verification and returns the code with a ready-to-tap WhatsApp link', async () => {
    const res = await request(app)
      .post('/api/messaging-channels/whatsapp/verification')
      .send({ optIn: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      code: 'K7Q2M9XA',
      expiresAt: '2026-09-21T12:10:00.000Z',
      message: 'Verify K7Q2M9XA',
      displayNumber: '+14155550100',
      link: 'https://wa.me/14155550100?text=Verify%20K7Q2M9XA',
    });
  });

  it('starts it for the signed-in user, stamping when consent was acknowledged', async () => {
    const before = Date.now();
    await request(app).post('/api/messaging-channels/whatsapp/verification').send({ optIn: true });
    const [userId, acknowledgedAt] = startVerification.mock.calls[0];
    expect(userId).toBe('u1');
    expect(Date.parse(acknowledgedAt)).toBeGreaterThanOrEqual(before);
  });

  it('must not be cached, since the response carries a live credential', async () => {
    const res = await request(app)
      .post('/api/messaging-channels/whatsapp/verification')
      .send({ optIn: true });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('refuses without an explicit opt-in, and issues no code', async () => {
    const res = await request(app).post('/api/messaging-channels/whatsapp/verification').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/opt-in/i);
    expect(startVerification).not.toHaveBeenCalled();
  });

  it('treats a truthy-but-not-true optIn as missing consent', async () => {
    const res = await request(app)
      .post('/api/messaging-channels/whatsapp/verification')
      .send({ optIn: 'yes' });
    expect(res.status).toBe(400);
    expect(startVerification).not.toHaveBeenCalled();
  });

  it('is unavailable — and issues no code — when the business number cannot be read', async () => {
    // A code the user has no link to send it to would just be a dead credential.
    getDisplayPhoneNumber.mockRejectedValue(new Error('Graph is down'));
    const res = await request(app)
      .post('/api/messaging-channels/whatsapp/verification')
      .send({ optIn: true });
    expect(res.status).toBe(503);
    expect(startVerification).not.toHaveBeenCalled();
  });

  it('500s when the verification cannot be stored', async () => {
    startVerification.mockRejectedValue(new Error('dynamo down'));
    const res = await request(app)
      .post('/api/messaging-channels/whatsapp/verification')
      .send({ optIn: true });
    expect(res.status).toBe(500);
  });
});

describe('GET /whatsapp/verification', () => {
  it("returns where the caller's verification stands, uncached", async () => {
    getVerificationStatus.mockResolvedValue({ state: 'pending', expiresAt: '2026-09-21T12:10:00.000Z' });
    const res = await request(app).get('/api/messaging-channels/whatsapp/verification');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, state: 'pending', expiresAt: '2026-09-21T12:10:00.000Z' });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(getVerificationStatus).toHaveBeenCalledWith('u1');
  });

  it('reports a STOPped number so the UI can explain why nothing happened', async () => {
    getVerificationStatus.mockResolvedValue({ state: 'opted_out', expiresAt: 'x' });
    const res = await request(app).get('/api/messaging-channels/whatsapp/verification');
    expect(res.body.state).toBe('opted_out');
  });

  it('500s when the status cannot be read', async () => {
    getVerificationStatus.mockRejectedValue(new Error('dynamo down'));
    expect((await request(app).get('/api/messaging-channels/whatsapp/verification')).status).toBe(500);
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
    // Same Greptile P1 as the verification write: removing WhatsApp must not write the
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

  it('clears the phone -> user index for the removed number', async () => {
    // Left behind, a disconnected number keeps resolving to this account and could
    // still answer its inbound actions.
    userDb.getUserById.mockResolvedValue({
      userId: 'u1',
      messagingChannels: [{ channel: 'whatsapp', destination: '+14155550123', enabled: true }],
    });
    await request(app).delete('/api/messaging-channels/whatsapp');
    // Conditional on the account still owning the row, so a number re-bound elsewhere is left alone.
    expect(whatsapp.unbindPhone).toHaveBeenCalledWith('+14155550123', 'u1');
  });

  it('does not try to clear an index when there was no number', async () => {
    userDb.getUserById.mockResolvedValue({ userId: 'u1', slackChannels: ['C1'] });
    await request(app).delete('/api/messaging-channels/whatsapp');
    expect(whatsapp.unbindPhone).not.toHaveBeenCalled();
  });

  it('still reports success when clearing the index fails', async () => {
    // The index self-heals on read, so a failure here must not turn a disconnect the
    // user already completed into an error.
    whatsapp.unbindPhone.mockRejectedValueOnce(new Error('dynamo down'));
    userDb.getUserById.mockResolvedValue({
      userId: 'u1',
      messagingChannels: [{ channel: 'whatsapp', destination: '+14155550123', enabled: true }],
    });
    const res = await request(app).delete('/api/messaging-channels/whatsapp');
    expect(res.status).toBe(200);
  });
});
