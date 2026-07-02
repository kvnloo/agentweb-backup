/**
 * shipNotifyService — Slack ping in the customer's own channel when an item they
 * reported (feature-request post / bug canonical) ships. Contract under test
 * (ENG-170 acceptance criteria):
 *   - mapped channel  -> exactly ONE Slack message (first channel) with title + link
 *   - no mapped channel -> no Slack call ('no_channel'; the email path is untouched)
 *   - opt-out (slackShipNotifyDisabled) -> no Slack call
 *   - already notified for the same item -> no double-post
 *   - any failure (Slack API, user lookup) -> NEVER throws ('failed')
 */
import { notifyReporterShipped, notifyPostShippedRecipients } from '../services/shipNotifyService';

jest.mock('../services/db', () => ({
  userDb: { getUserByEmail: jest.fn(), getUserById: jest.fn() },
  orgDb: { getOrgById: jest.fn() },
}));
jest.mock('../services/settingsService', () => ({
  settingsService: { getSetting: jest.fn(), setSetting: jest.fn() },
}));
jest.mock('../services/slackService', () => {
  const actual = jest.requireActual('../services/slackService');
  return { ...actual, postSlackMessage: jest.fn() };
});
jest.mock('../services/featurebaseService', () => ({
  getPost: jest.fn(),
  listPostVoters: jest.fn(),
}));

const { userDb, orgDb } = require('../services/db');
const { settingsService } = require('../services/settingsService');
const { postSlackMessage } = require('../services/slackService');
const fb = require('../services/featurebaseService');

const base = {
  email: 'u@e.com',
  itemId: 'post-1',
  title: 'Dark mode',
  url: 'https://fb/p/dark',
  kind: 'feature_request' as const,
};

beforeEach(() => {
  jest.clearAllMocks();
  settingsService.getSetting.mockResolvedValue(null);
  settingsService.setSetting.mockResolvedValue({});
  postSlackMessage.mockResolvedValue({ ts: '1', channel: 'C1' });
});

describe('notifyReporterShipped — recipient resolution', () => {
  it('unknown email -> no_user, no Slack post', async () => {
    userDb.getUserByEmail.mockResolvedValue(null);
    await expect(notifyReporterShipped(base)).resolves.toBe('no_user');
    expect(postSlackMessage).not.toHaveBeenCalled();
  });

  it('opt-out flag -> opted_out, no Slack post', async () => {
    userDb.getUserByEmail.mockResolvedValue({ userId: 'u1', slackChannels: ['C1'], slackShipNotifyDisabled: true });
    await expect(notifyReporterShipped(base)).resolves.toBe('opted_out');
    expect(postSlackMessage).not.toHaveBeenCalled();
  });

  it('no mapped channel anywhere -> no_channel (email-only behavior preserved)', async () => {
    userDb.getUserByEmail.mockResolvedValue({ userId: 'u1' });
    await expect(notifyReporterShipped(base)).resolves.toBe('no_channel');
    expect(postSlackMessage).not.toHaveBeenCalled();
    expect(settingsService.setSetting).not.toHaveBeenCalled();
  });

  it('legacy singular slackChannel is honored', async () => {
    userDb.getUserByEmail.mockResolvedValue({ userId: 'u1', slackChannel: 'C9' });
    await expect(notifyReporterShipped(base)).resolves.toBe('sent');
    expect(postSlackMessage).toHaveBeenCalledWith('C9', expect.any(String));
  });

  it('org fallback: no personal channels -> org.slackChannel', async () => {
    userDb.getUserByEmail.mockResolvedValue({ userId: 'u1', orgId: 'o1' });
    orgDb.getOrgById.mockResolvedValue({ orgId: 'o1', slackChannel: 'C5' });
    await expect(notifyReporterShipped(base)).resolves.toBe('sent');
    expect(postSlackMessage).toHaveBeenCalledWith('C5', expect.any(String));
  });
});

describe('notifyReporterShipped — sending', () => {
  it('multiple channels -> ONE post to the FIRST channel, with title + link, marker recorded', async () => {
    userDb.getUserByEmail.mockResolvedValue({ userId: 'u1', slackChannels: ['C1', 'C2'] });
    await expect(notifyReporterShipped(base)).resolves.toBe('sent');
    expect(postSlackMessage).toHaveBeenCalledTimes(1);
    const [channel, text] = postSlackMessage.mock.calls[0];
    expect(channel).toBe('C1');
    expect(text).toContain('Dark mode');
    expect(text).toContain('https://fb/p/dark');
    expect(settingsService.setSetting).toHaveBeenCalledWith(
      'ship-notify:post-1',
      expect.stringContaining('u@e.com'),
    );
  });

  it('feature_request vs bug wording', async () => {
    userDb.getUserByEmail.mockResolvedValue({ userId: 'u1', slackChannels: ['C1'] });
    await notifyReporterShipped(base);
    expect(postSlackMessage.mock.calls[0][1]).toContain('Shipped');
    await notifyReporterShipped({ ...base, itemId: 'issue-2', kind: 'bug' });
    expect(postSlackMessage.mock.calls[1][1]).toContain('Resolved');
  });

  it('no url -> message still sends without a dangling link line', async () => {
    userDb.getUserByEmail.mockResolvedValue({ userId: 'u1', slackChannels: ['C1'] });
    await expect(notifyReporterShipped({ ...base, url: undefined })).resolves.toBe('sent');
    const text = postSlackMessage.mock.calls[0][1];
    expect(text).toContain('Dark mode');
    expect(text).not.toContain('undefined');
  });
});

describe('notifyReporterShipped — idempotency', () => {
  it('already notified for this item -> already_sent, no repost', async () => {
    userDb.getUserByEmail.mockResolvedValue({ userId: 'u1', slackChannels: ['C1'] });
    settingsService.getSetting.mockResolvedValue({
      settingName: 'ship-notify:post-1',
      settingValue: JSON.stringify(['u@e.com']),
    });
    await expect(notifyReporterShipped(base)).resolves.toBe('already_sent');
    expect(postSlackMessage).not.toHaveBeenCalled();
  });

  it('marker for a DIFFERENT reporter of the same item does not block this one', async () => {
    userDb.getUserByEmail.mockResolvedValue({ userId: 'u1', slackChannels: ['C1'] });
    settingsService.getSetting.mockResolvedValue({
      settingName: 'ship-notify:post-1',
      settingValue: JSON.stringify(['other@e.com']),
    });
    await expect(notifyReporterShipped(base)).resolves.toBe('sent');
    // marker now holds both reporters
    const stored = JSON.parse(settingsService.setSetting.mock.calls[0][1]);
    expect(stored.sort()).toEqual(['other@e.com', 'u@e.com']);
  });
});

describe('notifyPostShippedRecipients — feature-request fan-out', () => {
  beforeEach(() => {
    fb.listPostVoters.mockResolvedValue([]);
    // Every recipient resolves to a channel-mapped user unless a test overrides.
    userDb.getUserByEmail.mockResolvedValue({ userId: 'u1', slackChannels: ['C1'] });
  });

  it('notifies author + voters, deduped by email', async () => {
    fb.listPostVoters.mockResolvedValue([{ email: 'v1@e.com' }, { email: 'U@E.com' }, { name: 'no-email-guest' }]);
    const r = await notifyPostShippedRecipients({ postId: 'post-1', title: 'Dark mode', url: 'https://fb/p/dark', authorEmail: 'u@e.com' });
    // author u@e.com + voter v1 (voter U@E.com dedupes onto the author, guest has no email)
    expect(r.sent).toBe(2);
    expect(postSlackMessage).toHaveBeenCalledTimes(2);
    expect(fb.getPost).not.toHaveBeenCalled(); // payload had author + url — no API fill needed
  });

  it('fills missing author email + url from the Featurebase API', async () => {
    fb.getPost.mockResolvedValue({ id: 'post-1', title: 'Dark mode', url: 'https://fb/p/dark', authorEmail: 'a@e.com' });
    const r = await notifyPostShippedRecipients({ postId: 'post-1', title: 'Dark mode' });
    expect(fb.getPost).toHaveBeenCalledWith('post-1');
    expect(r.sent).toBe(1);
    expect(postSlackMessage.mock.calls[0][1]).toContain('https://fb/p/dark');
  });

  it('voter fetch failure degrades to author-only', async () => {
    fb.listPostVoters.mockRejectedValue(new Error('voters down'));
    const r = await notifyPostShippedRecipients({ postId: 'post-1', title: 'T', url: 'u', authorEmail: 'u@e.com' });
    expect(r.sent).toBe(1);
    expect(r.outcomes['u@e.com']).toBe('sent');
  });

  it('everything failing -> sent 0, never throws', async () => {
    fb.getPost.mockRejectedValue(new Error('down'));
    fb.listPostVoters.mockRejectedValue(new Error('down'));
    await expect(notifyPostShippedRecipients({ postId: 'post-1', title: 'T' })).resolves.toEqual({ sent: 0, outcomes: {} });
    expect(postSlackMessage).not.toHaveBeenCalled();
  });
});

describe('notifyReporterShipped — never throws (AC6)', () => {
  it('Slack API failure -> failed, no marker recorded', async () => {
    userDb.getUserByEmail.mockResolvedValue({ userId: 'u1', slackChannels: ['C1'] });
    postSlackMessage.mockRejectedValueOnce(new Error('slack down'));
    await expect(notifyReporterShipped(base)).resolves.toBe('failed');
    expect(settingsService.setSetting).not.toHaveBeenCalled();
  });

  it('user lookup throwing -> failed, never throws', async () => {
    userDb.getUserByEmail.mockRejectedValueOnce(new Error('dynamo down'));
    await expect(notifyReporterShipped(base)).resolves.toBe('failed');
    expect(postSlackMessage).not.toHaveBeenCalled();
  });

  it('marker write failure after a successful post -> still reports sent (post already happened)', async () => {
    userDb.getUserByEmail.mockResolvedValue({ userId: 'u1', slackChannels: ['C1'] });
    settingsService.setSetting.mockRejectedValueOnce(new Error('settings down'));
    await expect(notifyReporterShipped(base)).resolves.toBe('sent');
    expect(postSlackMessage).toHaveBeenCalledTimes(1);
  });
});
