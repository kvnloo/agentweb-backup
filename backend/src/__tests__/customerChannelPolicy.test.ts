/**
 * One messaging platform per customer (ENG-273).
 *
 * Uses real account records and the real resolver; only the database lookups behind the
 * organisation fallback are faked.
 */
jest.mock('../services/db', () => ({
  userDb: { getUserById: jest.fn() },
  orgDb: { getOrgById: jest.fn() },
}));
const { userDb, orgDb } = require('../services/db');

import {
  assertCanConnect,
  getConnectedPlatform,
  getPlatformSummary,
  hasSlack,
  hasWhatsApp,
  PlatformConflictError,
} from '../services/customerChannelPolicy';
import { resolveDestination } from '../services/messagingChannelService';

const verifiedWhatsApp = {
  channel: 'whatsapp',
  destination: '+918005326946',
  enabled: true,
  optIn: { at: 'x', source: 'inbound_verification', verifiedAt: 'y' },
};
const onWhatsApp = { userId: 'u', messagingChannels: [verifiedWhatsApp] };
const onSlack = { userId: 'u', slackChannels: ['C0CHANNEL'] };
const inSlackOrg = { userId: 'u', orgId: 'org-1' };

beforeEach(() => {
  jest.resetAllMocks();
  orgDb.getOrgById.mockResolvedValue(null);
  userDb.getUserById.mockResolvedValue(null);
});

describe('which platform a customer is on', () => {
  it('is neither for a fresh account', async () => {
    await expect(getPlatformSummary({ userId: 'u' })).resolves.toEqual({
      platform: null,
      source: null,
      whatsappNumberMasked: null,
    });
  });

  it('is WhatsApp once a number is verified, with the number masked', async () => {
    await expect(getPlatformSummary(onWhatsApp)).resolves.toEqual({
      platform: 'whatsapp',
      source: 'account',
      whatsappNumberMasked: '********6946',
    });
  });

  it('never exposes the full WhatsApp number', async () => {
    const summary = await getPlatformSummary(onWhatsApp);
    expect(JSON.stringify(summary)).not.toContain('918005326946');
  });

  it('does not count an unverified WhatsApp entry', () => {
    const unverified = { ...verifiedWhatsApp, optIn: { at: 'x', source: 's' } };
    expect(hasWhatsApp({ messagingChannels: [unverified] })).toBe(false);
  });

  it('is Slack for an assigned or linked channel', async () => {
    await expect(getPlatformSummary(onSlack)).resolves.toMatchObject({
      platform: 'slack',
      source: 'account',
    });
  });

  it('is Slack for the deprecated single-channel field too', async () => {
    await expect(getConnectedPlatform({ userId: 'u', slackChannel: 'C0OLD' })).resolves.toBe('slack');
  });

  it('is Slack, via the organisation, for a member who inherits its channel', async () => {
    orgDb.getOrgById.mockResolvedValue({ orgId: 'org-1', slackChannel: 'C0ORG' });
    await expect(getPlatformSummary(inSlackOrg)).resolves.toMatchObject({
      platform: 'slack',
      source: 'organisation',
    });
  });

  it('is Slack, via the organisation, when only the owner has a channel', async () => {
    orgDb.getOrgById.mockResolvedValue({ orgId: 'org-1', ownerUserId: 'owner' });
    userDb.getUserById.mockResolvedValue({ userId: 'owner', slackChannels: ['C0OWNER'] });
    await expect(getConnectedPlatform(inSlackOrg)).resolves.toBe('slack');
  });

  it('is neither for a member of an organisation with no Slack', async () => {
    orgDb.getOrgById.mockResolvedValue({ orgId: 'org-1' });
    await expect(getConnectedPlatform(inSlackOrg)).resolves.toBeNull();
  });

  it('is Slack when onboarding provisioned a Slack Connect channel', async () => {
    await expect(
      getPlatformSummary({ slackConnectChannelId: 'C0CONNECT', slackConnectStatus: 'created' }),
    ).resolves.toMatchObject({ platform: 'slack', source: 'slack_connect' });
  });

  it('does not count a Slack Connect attempt that failed', async () => {
    await expect(
      hasSlack({ slackConnectChannelId: 'C0CONNECT', slackConnectStatus: 'failed' }),
    ).resolves.toBe(false);
  });

  it('resolves each organisation once when listing many accounts', async () => {
    orgDb.getOrgById.mockResolvedValue({ orgId: 'org-1', slackChannel: 'C0ORG' });
    const cache = new Map<string, Promise<boolean>>();
    await Promise.all(
      ['a', 'b', 'c', 'd'].map((id) => getPlatformSummary({ userId: id, orgId: 'org-1' }, cache)),
    );
    expect(orgDb.getOrgById).toHaveBeenCalledTimes(1);
  });
});

describe('a WhatsApp member of a Slack organisation', () => {
  const both = { ...onWhatsApp, orgId: 'org-1' };
  beforeEach(() => orgDb.getOrgById.mockResolvedValue({ orgId: 'org-1', slackChannel: 'C0ORG' }));

  it('is on WhatsApp — their own choice beats the inherited default', async () => {
    await expect(getConnectedPlatform(both)).resolves.toBe('whatsapp');
  });

  it('does not inherit the organisation Slack channel, so nothing is delivered twice', async () => {
    // This is what makes the rule hold however the two came to coexist: an org gaining
    // a channel later, the owner being assigned one, or a WhatsApp user joining.
    await expect(resolveDestination(both as any, 'slack')).resolves.toBeNull();
    await expect(resolveDestination(both as any, 'whatsapp')).resolves.toBe('+918005326946');
  });

  it('leaves every other member of that organisation on Slack', async () => {
    await expect(resolveDestination(inSlackOrg, 'slack')).resolves.toBe('C0ORG');
  });

  it('still sees the Slack side when asked whether WhatsApp may be connected', async () => {
    // hasSlack is asked precisely to decide that, so an existing number must not hide it.
    await expect(hasSlack(both)).resolves.toBe(true);
  });
});

describe('connecting a second platform', () => {
  it('refuses WhatsApp for a customer on Slack', async () => {
    await expect(assertCanConnect(onSlack, 'whatsapp')).rejects.toMatchObject({
      name: 'PlatformConflictError',
      connected: 'slack',
      requested: 'whatsapp',
    });
  });

  it('refuses WhatsApp for a member whose organisation is on Slack', async () => {
    orgDb.getOrgById.mockResolvedValue({ orgId: 'org-1', slackChannel: 'C0ORG' });
    await expect(assertCanConnect(inSlackOrg, 'whatsapp')).rejects.toBeInstanceOf(
      PlatformConflictError,
    );
  });

  it('refuses Slack for a customer on WhatsApp', async () => {
    await expect(assertCanConnect(onWhatsApp, 'slack')).rejects.toBeInstanceOf(
      PlatformConflictError,
    );
  });

  it('tells the customer what to do about it', async () => {
    await expect(assertCanConnect(onSlack, 'whatsapp')).rejects.toThrow(
      /already connected to Slack.*disconnect Slack before connecting WhatsApp/,
    );
  });

  it('allows the first connection', async () => {
    await expect(assertCanConnect({ userId: 'u' }, 'whatsapp')).resolves.toBeUndefined();
    await expect(assertCanConnect({ userId: 'u' }, 'slack')).resolves.toBeUndefined();
  });

  it('allows re-connecting the platform already in use', async () => {
    await expect(assertCanConnect(onWhatsApp, 'whatsapp')).resolves.toBeUndefined();
    await expect(assertCanConnect(onSlack, 'slack')).resolves.toBeUndefined();
  });
});
