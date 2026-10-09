/**
 * One messaging platform per customer (ENG-273).
 */
jest.mock('../services/messagingChannelService', () => ({
  ...jest.requireActual('../services/messagingChannelService'),
  resolveDestination: jest.fn(),
}));
const { resolveDestination } = require('../services/messagingChannelService');

import {
  assertCanConnect,
  getConnectedPlatform,
  hasSlack,
  hasWhatsApp,
  PlatformConflictError,
} from '../services/customerChannelPolicy';

const verifiedWhatsApp = {
  channel: 'whatsapp',
  destination: '+918005326946',
  enabled: true,
  optIn: { at: 'x', source: 'inbound_verification', verifiedAt: 'y' },
};

beforeEach(() => {
  jest.resetAllMocks();
  resolveDestination.mockResolvedValue(null);
});

describe('which platform a customer is on', () => {
  it('is neither for a fresh account', async () => {
    await expect(getConnectedPlatform({ userId: 'u' })).resolves.toBeNull();
  });

  it('is WhatsApp once a number is verified', async () => {
    await expect(
      getConnectedPlatform({ userId: 'u', messagingChannels: [verifiedWhatsApp] }),
    ).resolves.toBe('whatsapp');
  });

  it('does not count an unverified WhatsApp entry', () => {
    const unverified = { ...verifiedWhatsApp, optIn: { at: 'x', source: 's' } };
    expect(hasWhatsApp({ messagingChannels: [unverified] })).toBe(false);
  });

  it('is Slack when a channel resolves — assigned, linked, or inherited from the org', async () => {
    resolveDestination.mockResolvedValue('C0CHANNEL');
    await expect(getConnectedPlatform({ userId: 'u' })).resolves.toBe('slack');
  });

  it('is Slack when onboarding provisioned a Slack Connect channel', async () => {
    await expect(
      hasSlack({ slackConnectChannelId: 'C0CONNECT', slackConnectStatus: 'created' }),
    ).resolves.toBe(true);
  });

  it('does not count a Slack Connect attempt that failed', async () => {
    await expect(
      hasSlack({ slackConnectChannelId: 'C0CONNECT', slackConnectStatus: 'failed' }),
    ).resolves.toBe(false);
  });
});

describe('connecting a second platform', () => {
  it('refuses WhatsApp for a customer on Slack', async () => {
    resolveDestination.mockResolvedValue('C0CHANNEL');
    await expect(assertCanConnect({ userId: 'u' }, 'whatsapp')).rejects.toMatchObject({
      name: 'PlatformConflictError',
      connected: 'slack',
      requested: 'whatsapp',
    });
  });

  it('refuses Slack for a customer on WhatsApp', async () => {
    await expect(
      assertCanConnect({ userId: 'u', messagingChannels: [verifiedWhatsApp] }, 'slack'),
    ).rejects.toBeInstanceOf(PlatformConflictError);
  });

  it('tells the customer what to do about it', async () => {
    resolveDestination.mockResolvedValue('C0CHANNEL');
    await expect(assertCanConnect({ userId: 'u' }, 'whatsapp')).rejects.toThrow(
      /already connected to Slack.*disconnect Slack before connecting WhatsApp/,
    );
  });

  it('allows the first connection', async () => {
    await expect(assertCanConnect({ userId: 'u' }, 'whatsapp')).resolves.toBeUndefined();
    await expect(assertCanConnect({ userId: 'u' }, 'slack')).resolves.toBeUndefined();
  });

  it('allows re-connecting the platform already in use', async () => {
    await expect(
      assertCanConnect({ userId: 'u', messagingChannels: [verifiedWhatsApp] }, 'whatsapp'),
    ).resolves.toBeUndefined();
    resolveDestination.mockResolvedValue('C0CHANNEL');
    await expect(assertCanConnect({ userId: 'u' }, 'slack')).resolves.toBeUndefined();
  });
});
