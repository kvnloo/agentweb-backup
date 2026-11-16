/**
 * Tests for the Teams inbound messaging endpoint (ENG-272).
 *
 * Inbound webhook authentication is a security invariant, which is why this slice carries
 * tests at all under Rule 2. The seven Bot Framework verifications themselves belong to the
 * SDK and are not re-tested here — what is tested is our wiring around it: that the route
 * cannot answer a request it could not authenticate, that it fails CLOSED when credentials
 * are missing rather than open, and that it stays within its slice.
 */

export {}; // isolate module scope so top-level mocks don't collide with sibling test files

import express from 'express';
import request from 'supertest';

const mockProcess = jest.fn();
const mockGetTeamsBotCredentials = jest.fn();

// The SDK is mocked at its module boundary: constructing a real CloudAdapter would try to
// reach Microsoft's OpenID metadata, and asserting on the SDK's own token validation would be
// testing Microsoft's code rather than ours.
jest.mock('botbuilder', () => ({
  CloudAdapter: jest.fn().mockImplementation(() => ({
    process: mockProcess,
    onTurnError: undefined,
  })),
  ConfigurationBotFrameworkAuthentication: jest.fn(),
}));

jest.mock('../utils/secretsManager', () => ({
  getTeamsBotCredentials: (...args: any[]) => mockGetTeamsBotCredentials(...args),
}));

function makeApp() {
  // Mirrors app.ts: parsed JSON, no raw-body middleware. Bot Framework authenticates via a
  // bearer JWT, so unlike Slack/WhatsApp this route never needs the exact received bytes.
  const teamsRouter = require('../routes/teamsMessages').default;
  return express().use(express.json()).use('/api/teams', teamsRouter);
}

const activity = {
  type: 'message',
  channelId: 'msteams',
  text: 'hello there',
  conversation: { id: 'a:1conv', conversationType: 'channel' },
  from: { id: '29:1abc', aadObjectId: 'aad-object-1', name: 'Devan Udeshi' },
  channelData: { tenant: { id: 'tenant-123' } },
  serviceUrl: 'https://smba.trafficmanager.net/teams/',
};

describe('POST /api/teams/messages', () => {
  let errorSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    require('../services/teams/teamsBotAdapter').__resetTeamsBotAdapter?.();
    mockGetTeamsBotCredentials.mockResolvedValue({
      appId: 'app-id-1',
      appPassword: 'app-password-1',
      tenantId: 'tenant-123',
    });
    // The real CloudAdapter writes the HTTP response itself; a mock that resolves without
    // answering just hangs the request, so the default stands in for that behaviour.
    mockProcess.mockImplementation(async (_req: any, res: any, logic: any) => {
      if (logic) await logic({ activity, sendActivity: jest.fn() });
      res.status(200).end();
    });
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('hands the request to the SDK, which owns token validation', async () => {
    const res = await request(makeApp())
      .post('/api/teams/messages')
      .set('Authorization', 'Bearer some.jwt.token')
      .send(activity);

    expect(mockProcess).toHaveBeenCalledTimes(1);
    // Never a hand-rolled check: req, res and the turn logic all go to the adapter.
    expect(typeof mockProcess.mock.calls[0][2]).toBe('function');
    expect(res.status).toBe(200);
  });

  it('fails closed with 401 when credentials are unavailable', async () => {
    // The important direction. An endpoint that cannot authenticate its caller must refuse,
    // not accept: answering 200 here would let anyone who finds the URL drive the bot.
    mockGetTeamsBotCredentials.mockRejectedValue(new Error('secret not found'));

    const res = await request(makeApp())
      .post('/api/teams/messages')
      .set('Authorization', 'Bearer some.jwt.token')
      .send(activity);

    expect(res.status).toBe(401);
    expect(mockProcess).not.toHaveBeenCalled();
  });

  it('never processes an activity the SDK rejected', async () => {
    // On a forged token the SDK answers 401 itself and never invokes our turn logic. Proven
    // by the absence of the activity log line, which is the first thing that logic does.
    mockProcess.mockImplementation(async (_req: any, res: any) => {
      res.status(401).end();
    });

    const res = await request(makeApp())
      .post('/api/teams/messages')
      .set('Authorization', 'Bearer forged.jwt.token')
      .send(activity);

    expect(res.status).toBe(401);
    expect(logSpy.mock.calls.flat().join(' ')).not.toContain('activity received');
  });

  it('replies to a message activity so the outbound path is exercised', async () => {
    const sendActivity = jest.fn();
    mockProcess.mockImplementation(async (_req: any, res: any, logic: any) => {
      await logic({ activity, sendActivity });
      res.status(200).end();
    });

    await request(makeApp())
      .post('/api/teams/messages')
      .set('Authorization', 'Bearer some.jwt.token')
      .send(activity);

    expect(sendActivity).toHaveBeenCalledWith(
      'AgentWeb received your message. Conversation support is landing shortly.',
    );
  });

  it('does not reply to non-message activities', async () => {
    const sendActivity = jest.fn();
    mockProcess.mockImplementation(async (_req: any, res: any, logic: any) => {
      await logic({ activity: { ...activity, type: 'conversationUpdate' }, sendActivity });
      res.status(200).end();
    });

    await request(makeApp())
      .post('/api/teams/messages')
      .set('Authorization', 'Bearer some.jwt.token')
      .send(activity);

    expect(sendActivity).not.toHaveBeenCalled();
  });

  it('logs identifiers but never the message text', async () => {
    // ENG-2054 stripped raw message text out of the Slack route's logs. Reintroducing it
    // for Teams would re-open the same exposure on a second channel.
    mockProcess.mockImplementation(async (_req: any, res: any, logic: any) => {
      await logic({ activity, sendActivity: jest.fn() });
      res.status(200).end();
    });

    await request(makeApp())
      .post('/api/teams/messages')
      .set('Authorization', 'Bearer some.jwt.token')
      .send(activity);

    const logged = JSON.stringify(logSpy.mock.calls);
    expect(logged).not.toContain('hello there');
    expect(logged).toContain('tenant-123');
    expect(logged).toContain('a:1conv');
  });

  it('answers 400 instead of hanging when the SDK rejects a malformed activity', async () => {
    // CloudAdapter rejects a body without `type` before authenticating and writes no response.
    mockProcess.mockRejectedValue(new Error('missing activity type'));

    const res = await request(makeApp()).post('/api/teams/messages').send({ text: 'no type' });

    expect(res.status).toBe(400);
  });

  it('stays inside its slice — no session machinery in this route yet', async () => {
    // Session creation and the Teams adapter over the conversation port are the next change.
    // If a future edit wires them in here, this test is the thing that objects.
    jest.isolateModules(() => {
      const source = require('fs').readFileSync(
        require.resolve('../routes/teamsMessages'),
        'utf8',
      );
      expect(source).not.toMatch(/chatbotService|agentModeService|sessionResponder|createChatSession/);
    });
  });
});
