/**
 * Emma's Slack tools and one platform per customer (ENG-273).
 *
 * getEffectiveAllowedChannels decides which Slack channels Emma's tools may read and post
 * to on a customer's behalf. An account on WhatsApp has none: it must not be handed an
 * organisation channel, or a channel of its own that predates the rule.
 */
jest.mock('@slack/web-api', () => ({
  WebClient: jest.fn().mockImplementation(() => ({ chat: {}, apiCall: jest.fn() })),
}));
jest.mock('../services/db', () => ({
  userDb: { getUserById: jest.fn() },
  orgDb: { getOrgById: jest.fn() },
}));
process.env.SLACK_BOT_TOKEN = 'xoxb-test';

const { orgDb, userDb } = require('../services/db');
const { getEffectiveAllowedChannels } = require('../services/slackService');

const verifiedWhatsApp = {
  channel: 'whatsapp',
  destination: '+918005326946',
  enabled: true,
  optIn: { at: 'x', source: 'inbound_verification', verifiedAt: 'y' },
};

beforeEach(() => {
  jest.resetAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  orgDb.getOrgById.mockResolvedValue({ orgId: 'org-1', slackChannel: 'C0ORG' });
});

it('gives a Slack customer their own channels', async () => {
  await expect(getEffectiveAllowedChannels({ slackChannels: ['C0OWN'] })).resolves.toEqual(['C0OWN']);
});

it('gives a Slack organisation member the organisation channel', async () => {
  await expect(getEffectiveAllowedChannels({ orgId: 'org-1' })).resolves.toEqual(['C0ORG']);
});

it('gives a WhatsApp customer nothing, even in a Slack organisation', async () => {
  await expect(
    getEffectiveAllowedChannels({ orgId: 'org-1', messagingChannels: [verifiedWhatsApp] } as any),
  ).resolves.toEqual([]);
});

it('gives a WhatsApp customer nothing, even with a channel of their own on record', async () => {
  await expect(
    getEffectiveAllowedChannels({ slackChannels: ['C0OWN'], messagingChannels: [verifiedWhatsApp] } as any),
  ).resolves.toEqual([]);
});

it('is unaffected by a WhatsApp number that was never verified', async () => {
  const unverified = { ...verifiedWhatsApp, optIn: { at: 'x', source: 's' } };
  await expect(
    getEffectiveAllowedChannels({ slackChannels: ['C0OWN'], messagingChannels: [unverified] } as any),
  ).resolves.toEqual(['C0OWN']);
});
export {};
