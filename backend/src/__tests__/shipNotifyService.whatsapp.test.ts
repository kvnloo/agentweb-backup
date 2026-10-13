/**
 * shipNotifyService routed through the channel seam (ENG-273).
 *
 * The pre-existing shipNotifyService.test.ts is the regression proof that Slack-only
 * behavior is unchanged. This file covers what the seam ADDS:
 *   - a WhatsApp-configured user is reached on WhatsApp
 *   - Slack and WhatsApp are peers, not a fallback chain — both get the message
 *   - the idempotency claim covers the reporter, not one channel
 *   - a ship notification carries a template, because it is almost always sent
 *     outside the 24h service window
 */

import { notifyReporterShipped } from '../services/shipNotifyService';
import { TEMPLATES } from '../services/whatsappService';

jest.mock('../services/db', () => ({
  userDb: { getUserByEmail: jest.fn(), getUserById: jest.fn() },
  orgDb: { getOrgById: jest.fn() },
}));
jest.mock('../services/settingsService', () => ({
  settingsService: { claimSetMember: jest.fn(), releaseSetMember: jest.fn() },
}));
jest.mock('../services/slackService', () => ({
  postSlackMessage: jest.fn(),
}));
jest.mock('../services/whatsappService', () => ({
  // The real registry constant — a stub here would let a template rename pass.
  TEMPLATES: jest.requireActual('../services/whatsappService').TEMPLATES,
  redactPhone: jest.requireActual('../services/whatsappService').redactPhone,
  sendMessage: jest.fn(),
}));

const { userDb } = require('../services/db');
const { settingsService } = require('../services/settingsService');
const { postSlackMessage } = require('../services/slackService');
const whatsapp = require('../services/whatsappService');

const base = {
  email: 'u@e.com',
  itemId: 'post-1',
  title: 'Dark mode',
  url: 'https://fb/p/dark',
  kind: 'feature_request' as const,
};

// A verified entry: the person proved they control the number by messaging us a code.
const WA = {
  channel: 'whatsapp' as const,
  destination: '+14155550123',
  enabled: true,
  optIn: { at: '2026-08-01T00:00:00.000Z', source: 'inbound_verification', verifiedAt: '2026-08-01T00:00:00.000Z' },
};

beforeEach(() => {
  jest.resetAllMocks();
  settingsService.claimSetMember.mockResolvedValue(true);
  settingsService.releaseSetMember.mockResolvedValue(undefined);
  postSlackMessage.mockResolvedValue({ ts: '1', channel: 'C1' });
  whatsapp.sendMessage.mockResolvedValue({ messageId: 'wamid.1' });
});

describe('WhatsApp-configured reporter', () => {
  it('sends to WhatsApp when only WhatsApp is configured', async () => {
    userDb.getUserByEmail.mockResolvedValue({ userId: 'u1', messagingChannels: [WA] });
    await expect(notifyReporterShipped(base)).resolves.toBe('sent');
    expect(whatsapp.sendMessage).toHaveBeenCalledTimes(1);
    expect(whatsapp.sendMessage.mock.calls[0][0].destination).toBe('+14155550123');
    expect(postSlackMessage).not.toHaveBeenCalled();
  });

  it('carries the ship-notify template, since the window is almost always closed', async () => {
    userDb.getUserByEmail.mockResolvedValue({ userId: 'u1', messagingChannels: [WA] });
    await notifyReporterShipped(base);
    const sent = whatsapp.sendMessage.mock.calls[0][0];
    expect(sent.template.name).toBe(TEMPLATES.SHIP_NOTIFY.name);
    expect(sent.template.variables).toEqual(['Dark mode', 'https://fb/p/dark']);
  });

  it('passes the declared number of template variables even with no url', async () => {
    // SHIP_NOTIFY declares 2 variables and Meta binds them positionally, so a
    // missing url must become an empty string rather than a shorter array.
    userDb.getUserByEmail.mockResolvedValue({ userId: 'u1', messagingChannels: [WA] });
    await notifyReporterShipped({ ...base, url: undefined });
    const sent = whatsapp.sendMessage.mock.calls[0][0];
    expect(sent.template.variables).toHaveLength(TEMPLATES.SHIP_NOTIFY.variables.length);
  });

  it('does not apply Slack entity escaping to the WhatsApp body', async () => {
    userDb.getUserByEmail.mockResolvedValue({ userId: 'u1', messagingChannels: [WA] });
    await notifyReporterShipped({ ...base, title: 'A < B & C' });
    expect(whatsapp.sendMessage.mock.calls[0][0].text).not.toContain('&lt;');
  });
});

// ENG-273: a customer is on ONE messaging platform. This block used to be titled "Slack and
// WhatsApp as peers" and asserted that an account configured for both is notified on both,
// with per-channel partial-failure handling. That is the double delivery the product rule
// now forbids: an account with a verified WhatsApp number is delivered to on WhatsApp only,
// so at most one channel ever fires. Four of those tests (both-configured delivery,
// one-fails-other-lands, release-only-the-failed-claim, replay-only-the-failed-channel)
// had a premise that no longer exists and are replaced below; the per-channel claim KEYS
// still matter — they are what stops a deploy re-notifying items already sent on Slack —
// and keep their coverage.
describe('one platform per customer', () => {
  const both = () => ({ userId: 'u1', slackChannels: ['C1'], messagingChannels: [WA] });

  it('notifies an account that has both on WhatsApp only', async () => {
    userDb.getUserByEmail.mockResolvedValue(both());
    await expect(notifyReporterShipped(base)).resolves.toBe('sent');
    expect(whatsapp.sendMessage).toHaveBeenCalledTimes(1);
    expect(postSlackMessage).not.toHaveBeenCalled();
  });

  it('takes a single claim for that account, under the WhatsApp key', async () => {
    userDb.getUserByEmail.mockResolvedValue(both());
    await notifyReporterShipped(base);
    const keys = settingsService.claimSetMember.mock.calls.map((c: any[]) => c[0]);
    expect(keys).toEqual(['ship-notify:post-1:whatsapp']);
  });

  it('releases the WhatsApp claim, and reports failed, when the send fails', async () => {
    // So a retry re-sends rather than finding the item "already sent".
    userDb.getUserByEmail.mockResolvedValue({ userId: 'u1', messagingChannels: [WA] });
    whatsapp.sendMessage.mockRejectedValue(new Error('131047 window closed'));
    await expect(notifyReporterShipped(base)).resolves.toBe('failed');
    expect(settingsService.releaseSetMember).toHaveBeenCalledTimes(1);
    expect(settingsService.releaseSetMember).toHaveBeenCalledWith(
      'ship-notify:post-1:whatsapp',
      'u@e.com',
    );
  });

  it('keeps Slack on the legacy un-suffixed key so deploying cannot re-notify', async () => {
    // Items notified before per-channel claims hold a claim under the old key.
    // Suffixing Slack's key would make every one of them look unclaimed and
    // re-deliver "your feature shipped!" on the next replay.
    userDb.getUserByEmail.mockResolvedValue({ userId: 'u1', slackChannels: ['C1'] });
    await notifyReporterShipped(base);
    expect(settingsService.claimSetMember).toHaveBeenCalledWith('ship-notify:post-1', 'u@e.com');
  });

  it('reports already_sent when the claim was taken by a prior delivery', async () => {
    userDb.getUserByEmail.mockResolvedValue({ userId: 'u1', messagingChannels: [WA] });
    settingsService.claimSetMember.mockResolvedValue(false);
    await expect(notifyReporterShipped(base)).resolves.toBe('already_sent');
    expect(postSlackMessage).not.toHaveBeenCalled();
    expect(whatsapp.sendMessage).not.toHaveBeenCalled();
  });

  it('does not apply the Slack-only opt-out flag to WhatsApp', async () => {
    // slackShipNotifyDisabled suppresses only the SLACK ping — its own doc comment on
    // the User model says so. A user who turned that off but verified WhatsApp must
    // still get the WhatsApp notification. This reproduces a real bug: the flag used
    // to return 'opted_out' before channel resolution ran at all, silencing WhatsApp
    // for anyone who had only ever meant to quiet Slack.
    userDb.getUserByEmail.mockResolvedValue({
      userId: 'u1',
      messagingChannels: [WA],
      slackShipNotifyDisabled: true,
    });
    await expect(notifyReporterShipped(base)).resolves.toBe('sent');
    expect(whatsapp.sendMessage).toHaveBeenCalledTimes(1);
    expect(postSlackMessage).not.toHaveBeenCalled();
  });

  it('still reports opted_out when Slack — the only channel that would have fired — is disabled', async () => {
    // The other half of the same fix: the flag must still mean something when Slack
    // really was the only option, rather than degrading to a bare "nothing configured".
    userDb.getUserByEmail.mockResolvedValue({
      userId: 'u1',
      slackChannels: ['C1'],
      slackShipNotifyDisabled: true,
    });
    await expect(notifyReporterShipped(base)).resolves.toBe('opted_out');
    expect(whatsapp.sendMessage).not.toHaveBeenCalled();
    expect(postSlackMessage).not.toHaveBeenCalled();
  });

  it('reports no_channel, not opted_out, when Slack was never reachable to begin with', async () => {
    // Disabling a channel that was never configured is not an opt-out from anything.
    userDb.getUserByEmail.mockResolvedValue({
      userId: 'u1',
      slackShipNotifyDisabled: true,
    });
    await expect(notifyReporterShipped(base)).resolves.toBe('no_channel');
  });

  it('skips a disabled WhatsApp entry', async () => {
    userDb.getUserByEmail.mockResolvedValue({
      userId: 'u1',
      slackChannels: ['C1'],
      messagingChannels: [{ ...WA, enabled: false }],
    });
    await notifyReporterShipped(base);
    expect(whatsapp.sendMessage).not.toHaveBeenCalled();
    expect(postSlackMessage).toHaveBeenCalledTimes(1);
  });
});

describe('unverified WhatsApp entry', () => {
  it('is never messaged, and does not stop Slack from being notified', async () => {
    userDb.getUserByEmail.mockResolvedValue({
      userId: 'u1',
      slackChannels: ['C1'],
      messagingChannels: [{ channel: 'whatsapp', destination: '+14155550123', enabled: true }],
    });
    await expect(notifyReporterShipped(base)).resolves.toBe('sent');
    expect(whatsapp.sendMessage).not.toHaveBeenCalled();
    expect(postSlackMessage).toHaveBeenCalledTimes(1);
  });

  it('reports no_channel when unverified WhatsApp is the only thing configured', async () => {
    userDb.getUserByEmail.mockResolvedValue({
      userId: 'u1',
      messagingChannels: [{ channel: 'whatsapp', destination: '+14155550123', enabled: true }],
    });
    await expect(notifyReporterShipped(base)).resolves.toBe('no_channel');
    expect(whatsapp.sendMessage).not.toHaveBeenCalled();
  });
});

describe('WhatsApp send-failure logging', () => {
  it('does not put the raw phone number or the reporter email in the log line', async () => {
    userDb.getUserByEmail.mockResolvedValue({ userId: 'u1', messagingChannels: [WA] });
    whatsapp.sendMessage.mockRejectedValue(new Error('wa down'));
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    await notifyReporterShipped(base);

    const logged = warnSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
    expect(logged).not.toContain('+14155550123');
    expect(logged).not.toContain(base.email);
    expect(logged).toContain(base.itemId);
    warnSpy.mockRestore();
  });
});
