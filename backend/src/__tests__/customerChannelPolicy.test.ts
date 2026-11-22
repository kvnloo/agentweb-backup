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
  getPlatformSummary,
  hasOwnSlack,
  hasWhatsApp,
  PlatformConflictError,
} from '../services/customerChannelPolicy';
import { resolveDestination } from '../services/messagingChannelService';

const verifiedWhatsApp = {
  channel: 'whatsapp' as const,
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
    expect(JSON.stringify(await getPlatformSummary(onWhatsApp))).not.toContain('918005326946');
  });

  it('does not count an unverified WhatsApp entry', () => {
    const unverified = { ...verifiedWhatsApp, optIn: { at: 'x', source: 's' } } as any;
    expect(hasWhatsApp({ messagingChannels: [unverified] })).toBe(false);
  });

  it('is Slack for an assigned or linked channel', async () => {
    await expect(getPlatformSummary(onSlack)).resolves.toMatchObject({ platform: 'slack', source: 'account' });
  });

  it('is Slack for the deprecated single-channel field too', async () => {
    await expect(getPlatformSummary({ userId: 'u', slackChannel: 'C0OLD' })).resolves.toMatchObject({
      platform: 'slack',
    });
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
    await expect(getPlatformSummary(inSlackOrg)).resolves.toMatchObject({ source: 'organisation' });
  });

  it('is neither for a member of an organisation with no Slack', async () => {
    orgDb.getOrgById.mockResolvedValue({ orgId: 'org-1' });
    await expect(getPlatformSummary(inSlackOrg)).resolves.toMatchObject({ platform: null });
  });

  it('does NOT treat a Slack Connect support room as a platform', async () => {
    // Nothing delivers notifications to it, so counting it only ever blocked WhatsApp.
    const account = { userId: 'u', slackConnectChannelId: 'C0CONNECT', slackConnectStatus: 'created' };
    await expect(getPlatformSummary(account)).resolves.toMatchObject({ platform: null });
    expect(hasOwnSlack(account)).toBe(false);
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

describe('an account that has both a verified WhatsApp number and Slack', () => {
  // However the two came to coexist — an organisation gaining a channel, its owner being
  // assigned one, a WhatsApp user joining it, or an account that predates the rule — it is
  // on WhatsApp everywhere: the screen says so and the sends follow.
  const bothOwn = { ...onWhatsApp, slackChannels: ['C0OWN'] };
  const bothViaOrg = { ...onWhatsApp, orgId: 'org-1' };
  beforeEach(() => orgDb.getOrgById.mockResolvedValue({ orgId: 'org-1', slackChannel: 'C0ORG' }));

  it('is reported as WhatsApp', async () => {
    await expect(getPlatformSummary(bothOwn)).resolves.toMatchObject({ platform: 'whatsapp' });
    await expect(getPlatformSummary(bothViaOrg)).resolves.toMatchObject({ platform: 'whatsapp' });
  });

  it('is not delivered to on its own Slack channel', async () => {
    await expect(resolveDestination(bothOwn as any, 'slack')).resolves.toBeNull();
    await expect(resolveDestination(bothOwn as any, 'whatsapp')).resolves.toBe('+918005326946');
  });

  it('is not delivered to on its organisation Slack channel', async () => {
    await expect(resolveDestination(bothViaOrg as any, 'slack')).resolves.toBeNull();
  });

  it('leaves every other member of the organisation on Slack', async () => {
    await expect(resolveDestination(inSlackOrg as any, 'slack')).resolves.toBe('C0ORG');
  });
});

describe('connecting a second platform', () => {
  it('refuses WhatsApp for an account with a Slack channel of its own', async () => {
    await expect(assertCanConnect(onSlack, 'whatsapp')).rejects.toMatchObject({
      name: 'PlatformConflictError',
      connected: 'slack',
      requested: 'whatsapp',
    });
  });

  it('refuses WhatsApp for an account on the deprecated single channel', async () => {
    await expect(assertCanConnect({ userId: 'u', slackChannel: 'C0OLD' }, 'whatsapp')).rejects.toBeInstanceOf(
      PlatformConflictError,
    );
  });

  it('ALLOWS WhatsApp for a member whose only Slack is the organisation channel', async () => {
    // That channel is a default they inherited, and their verified number beats it — so
    // refusing would only trap them, with no control anywhere to remove an organisation's
    // channel from one member.
    orgDb.getOrgById.mockResolvedValue({ orgId: 'org-1', slackChannel: 'C0ORG' });
    await expect(assertCanConnect(inSlackOrg, 'whatsapp')).resolves.toBeUndefined();
  });

  it('ALLOWS WhatsApp when onboarding provisioned a Slack Connect support room', async () => {
    const account = { userId: 'u', slackConnectChannelId: 'C0CONNECT', slackConnectStatus: 'created' };
    await expect(assertCanConnect(account, 'whatsapp')).resolves.toBeUndefined();
  });

  it('refuses Slack for an account on WhatsApp', async () => {
    await expect(assertCanConnect(onWhatsApp, 'slack')).rejects.toBeInstanceOf(PlatformConflictError);
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
