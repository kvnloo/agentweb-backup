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

const WA = { channel: 'whatsapp' as const, destination: '+14155550123', enabled: true };

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

describe('Slack and WhatsApp as peers', () => {
  it('sends to both when both are configured', async () => {
    userDb.getUserByEmail.mockResolvedValue({
      userId: 'u1',
      slackChannels: ['C1'],
      messagingChannels: [WA],
    });
    await expect(notifyReporterShipped(base)).resolves.toBe('sent');
    expect(postSlackMessage).toHaveBeenCalledTimes(1);
    expect(whatsapp.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('still reports sent when one channel fails and the other lands', async () => {
    userDb.getUserByEmail.mockResolvedValue({
      userId: 'u1',
      slackChannels: ['C1'],
      messagingChannels: [WA],
    });
    whatsapp.sendMessage.mockRejectedValue(new Error('131047 window closed'));
    await expect(notifyReporterShipped(base)).resolves.toBe('sent');
  });

  it('releases ONLY the failed channel claim, so a retry re-sends just that one', async () => {
    // Greptile P1. Claims are per channel, so the failed channel can be retried
    // without re-delivering the Slack message that already landed.
    userDb.getUserByEmail.mockResolvedValue({
      userId: 'u1',
      slackChannels: ['C1'],
      messagingChannels: [WA],
    });
    whatsapp.sendMessage.mockRejectedValue(new Error('boom'));
    await notifyReporterShipped(base);
    expect(settingsService.releaseSetMember).toHaveBeenCalledTimes(1);
    expect(settingsService.releaseSetMember).toHaveBeenCalledWith(
      'ship-notify:post-1:whatsapp',
      'u@e.com',
    );
  });

  it('re-sends only the previously-failed channel on a replay', async () => {
    // The behavior the per-channel claim exists for: Slack already landed (its claim
    // is held), WhatsApp did not (its claim is free). A retry must reach WhatsApp
    // and must NOT re-ping Slack.
    userDb.getUserByEmail.mockResolvedValue({
      userId: 'u1',
      slackChannels: ['C1'],
      messagingChannels: [WA],
    });
    settingsService.claimSetMember.mockImplementation(async (key: string) =>
      key !== 'ship-notify:post-1',
    );
    await expect(notifyReporterShipped(base)).resolves.toBe('sent');
    expect(whatsapp.sendMessage).toHaveBeenCalledTimes(1);
    expect(postSlackMessage).not.toHaveBeenCalled();
  });

  it('keeps Slack on the legacy un-suffixed key so deploying cannot re-notify', async () => {
    // Items notified before per-channel claims hold a claim under the old key.
    // Suffixing Slack's key would make every one of them look unclaimed and
    // re-deliver "your feature shipped!" on the next replay.
    userDb.getUserByEmail.mockResolvedValue({ userId: 'u1', slackChannels: ['C1'] });
    await notifyReporterShipped(base);
    expect(settingsService.claimSetMember).toHaveBeenCalledWith('ship-notify:post-1', 'u@e.com');
  });

  it('releases the claim only when every channel failed', async () => {
    userDb.getUserByEmail.mockResolvedValue({
      userId: 'u1',
      slackChannels: ['C1'],
      messagingChannels: [WA],
    });
    postSlackMessage.mockRejectedValue(new Error('slack down'));
    whatsapp.sendMessage.mockRejectedValue(new Error('wa down'));
    await expect(notifyReporterShipped(base)).resolves.toBe('failed');
    expect(settingsService.releaseSetMember).toHaveBeenCalledWith('ship-notify:post-1', 'u@e.com');
  });

  it('takes one claim per channel, under distinct keys', async () => {
    userDb.getUserByEmail.mockResolvedValue({
      userId: 'u1',
      slackChannels: ['C1'],
      messagingChannels: [WA],
    });
    await notifyReporterShipped(base);
    const keys = settingsService.claimSetMember.mock.calls.map((c: any[]) => c[0]);
    expect(keys).toEqual(['ship-notify:post-1', 'ship-notify:post-1:whatsapp']);
  });

  it('reports already_sent when every channel was claimed by a prior delivery', async () => {
    userDb.getUserByEmail.mockResolvedValue({
      userId: 'u1',
      slackChannels: ['C1'],
      messagingChannels: [WA],
    });
    settingsService.claimSetMember.mockResolvedValue(false);
    await expect(notifyReporterShipped(base)).resolves.toBe('already_sent');
    expect(postSlackMessage).not.toHaveBeenCalled();
    expect(whatsapp.sendMessage).not.toHaveBeenCalled();
  });

  it('honors the ship-notify opt-out for every channel, not just Slack', async () => {
    userDb.getUserByEmail.mockResolvedValue({
      userId: 'u1',
      messagingChannels: [WA],
      slackShipNotifyDisabled: true,
    });
    await expect(notifyReporterShipped(base)).resolves.toBe('opted_out');
    expect(whatsapp.sendMessage).not.toHaveBeenCalled();
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
