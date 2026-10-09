/**
 * Approval requests on WhatsApp (ENG-273).
 *
 * The contract this file exists to hold: notifying WhatsApp is ADDITIVE. The Slack
 * message and the approval record are already written by the time this runs, so every
 * failure mode here must end in a no-op, never a throw. An approval that fails because a
 * secondary channel was unreachable is a worse bug than a missing notification.
 */

// Spread the real module rather than replacing it: whatsappService's error classes
// extend MessagingChannelError at module load, so a bare factory leaves them extending
// `undefined` and the suite dies before a single test runs.
jest.mock('../services/messagingChannelService', () => ({
  ...jest.requireActual('../services/messagingChannelService'),
  bootstrapMessagingChannels: jest.fn(),
  getMessagingChannel: jest.fn(),
  resolveDestination: jest.fn(),
}));
jest.mock('../services/db', () => ({
  userDb: { getUserById: jest.fn() },
}));
// Without this the correlation row below hits real DynamoDB from a unit test — the
// write is inside a try/catch, so the suite would pass while quietly calling AWS.
jest.mock('../services/settingsService', () => ({
  settingsService: { setSetting: jest.fn(), getSetting: jest.fn(), deleteSetting: jest.fn() },
}));

const {
  bootstrapMessagingChannels,
  getMessagingChannel,
  resolveDestination,
} = require('../services/messagingChannelService');
const { userDb } = require('../services/db');
const { settingsService } = require('../services/settingsService');

import {
  notifyApprovalOnWhatsApp,
  lookupApprovalMessage,
} from '../services/approvalChannelNotifier';
import { TEMPLATES } from '../services/whatsappService';

const APPROVAL_CHANNEL = 'C0APPROVALS';

// normalizeUserChannels is the REAL implementation here (the mock spreads requireActual),
// so this user genuinely resolves to the approval's Slack channel.
const USER = {
  userId: 'user-1',
  email: 'reviewer@example.com',
  slackChannel: APPROVAL_CHANNEL,
};

const params = {
  userId: 'user-1',
  approvalChannel: APPROVAL_CHANNEL,
  assetType: 'image',
  filename: 'q4-launch-hero.png',
  assetUrl: 'https://assets.example.com/q4-launch-hero.png',
};

describe('notifyApprovalOnWhatsApp', () => {
  let send: jest.Mock;

  beforeEach(() => {
    jest.resetAllMocks();
    send = jest.fn().mockResolvedValue({ messageId: 'wamid.1' });
    (bootstrapMessagingChannels as jest.Mock).mockResolvedValue(undefined);
    (getMessagingChannel as jest.Mock).mockReturnValue({ sendMessage: send });
    (userDb.getUserById as jest.Mock).mockResolvedValue(USER);
    (resolveDestination as jest.Mock).mockResolvedValue('+918005326946');
    (settingsService.setSetting as jest.Mock).mockResolvedValue(undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    (console.warn as jest.Mock).mockRestore?.();
  });

  it('sends the approval template to the reviewer WhatsApp number', async () => {
    await notifyApprovalOnWhatsApp(params);

    expect(getMessagingChannel).toHaveBeenCalledWith('whatsapp');
    const sent = send.mock.calls[0][0];
    expect(sent.destination).toBe('+918005326946');
    expect(sent.template.name).toBe(TEMPLATES.APPROVAL_REQUEST.name);
  });

  it('binds template variables in the order Meta substitutes them', async () => {
    await notifyApprovalOnWhatsApp(params);

    // Meta binds {{1}},{{2}},{{3}} POSITIONALLY. Reordering these does not error at
    // their end — it silently delivers the wrong words to a customer, so the order is
    // asserted against the registry's own declared variable names.
    expect(TEMPLATES.APPROVAL_REQUEST.variables).toEqual([
      'asset_type',
      'asset_name',
      'review_url',
    ]);
    expect(send.mock.calls[0][0].template.variables).toEqual([
      'image',
      'q4-launch-hero.png',
      'https://assets.example.com/q4-launch-hero.png',
    ]);
  });

  it('carries free-form text for the case where the 24h window happens to be open', async () => {
    await notifyApprovalOnWhatsApp(params);
    const sent = send.mock.calls[0][0];
    expect(sent.text).toContain('q4-launch-hero.png');
    expect(sent.text).toContain(params.assetUrl);
  });

  it('does not notify a requester who does not watch the approval channel', async () => {
    // userId on POST /send-approval is the authenticated CALLER, not the reviewer.
    // Notifying on userId alone pings the requester about a decision nobody asked them
    // to make — and, worse, about an asset that may not be theirs.
    (userDb.getUserById as jest.Mock).mockResolvedValue({
      ...USER,
      slackChannel: 'C0SOMETHING-ELSE',
    });
    await notifyApprovalOnWhatsApp(params);
    expect(resolveDestination).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('fails closed when the approval carries no channel', async () => {
    await notifyApprovalOnWhatsApp({ ...params, approvalChannel: '' });
    expect(send).not.toHaveBeenCalled();
  });

  it('notifies a reviewer whose channel is held in the slackChannels list', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue({
      userId: 'user-1',
      slackChannels: ['C0OTHER', APPROVAL_CHANNEL],
    });
    await notifyApprovalOnWhatsApp(params);
    expect(send).toHaveBeenCalled();
  });

  it('does nothing when the user has no WhatsApp destination', async () => {
    (resolveDestination as jest.Mock).mockResolvedValue(null);
    await notifyApprovalOnWhatsApp(params);
    expect(send).not.toHaveBeenCalled();
  });

  it('does nothing when the user record cannot be found', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue(null);
    await notifyApprovalOnWhatsApp(params);
    expect(resolveDestination).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('does nothing, and never looks up a user, without a userId', async () => {
    await notifyApprovalOnWhatsApp({ ...params, userId: '' });
    expect(userDb.getUserById).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('never throws when the send fails', async () => {
    send.mockRejectedValue(new Error('131047 outside service window'));
    await expect(notifyApprovalOnWhatsApp(params)).resolves.toBeUndefined();
  });

  it('never throws when the user lookup fails', async () => {
    (userDb.getUserById as jest.Mock).mockRejectedValue(new Error('dynamo down'));
    await expect(notifyApprovalOnWhatsApp(params)).resolves.toBeUndefined();
  });

  it('keeps the phone number out of the failure log (CWE-532)', async () => {
    send.mockRejectedValue(new Error('send failed'));
    await notifyApprovalOnWhatsApp(params);

    const logged = (console.warn as jest.Mock).mock.calls.flat().join(' ');
    expect(logged).not.toContain('918005326946');
    expect(logged).toContain('user-1');
  });

  it('falls back to readable labels rather than sending empty template variables', async () => {
    // Meta rejects an empty body parameter outright, so an untitled asset must not
    // produce one — the send would fail for a reason unrelated to the approval.
    await notifyApprovalOnWhatsApp({ ...params, assetType: '', filename: '' });
    const vars = send.mock.calls[0][0].template.variables;
    expect(vars[0]).toBeTruthy();
    expect(vars[1]).toBeTruthy();
  });
});

describe('correlating an inbound button tap back to the approval', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    (bootstrapMessagingChannels as jest.Mock).mockResolvedValue(undefined);
    (getMessagingChannel as jest.Mock).mockReturnValue({
      sendMessage: jest.fn().mockResolvedValue({ messageId: 'wamid.ABC' }),
    });
    (userDb.getUserById as jest.Mock).mockResolvedValue(USER);
    (resolveDestination as jest.Mock).mockResolvedValue('+918005326946');
    (settingsService.setSetting as jest.Mock).mockResolvedValue(undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('records the sent message id against the asset', async () => {
    // Meta sets button.payload to the button's own LABEL, so a decision id cannot ride
    // on the button. The tap arrives carrying only context.id — the id of the message
    // the button sat on — which makes this row the only route back to what was approved.
    await notifyApprovalOnWhatsApp(params);

    const [key, value] = (settingsService.setSetting as jest.Mock).mock.calls[0];
    expect(key).toBe('whatsapp:approval-msg:wamid.ABC');
    expect(JSON.parse(value)).toEqual({ assetUrl: params.assetUrl, userId: 'user-1' });
  });

  it('gives the row a TTL in epoch SECONDS, not milliseconds', async () => {
    await notifyApprovalOnWhatsApp(params);
    const ttl = (settingsService.setSetting as jest.Mock).mock.calls[0][4];

    // Milliseconds here would park the row roughly 50,000 years out.
    const days = (ttl - Math.floor(Date.now() / 1000)) / 86400;
    expect(days).toBeGreaterThan(29);
    expect(days).toBeLessThan(31);
  });

  it('does not record anything when the provider returned no id', async () => {
    (getMessagingChannel as jest.Mock).mockReturnValue({
      sendMessage: jest.fn().mockResolvedValue({ messageId: null }),
    });
    await notifyApprovalOnWhatsApp(params);
    expect(settingsService.setSetting).not.toHaveBeenCalled();
  });

  it('still delivers the notification when recording the id fails', async () => {
    (settingsService.setSetting as jest.Mock).mockRejectedValue(new Error('dynamo down'));
    await expect(notifyApprovalOnWhatsApp(params)).resolves.toBeUndefined();
  });

  it('reads the reference back', async () => {
    (settingsService.getSetting as jest.Mock).mockResolvedValue({
      settingValue: JSON.stringify({ assetUrl: 'https://a/x.png', userId: 'user-1' }),
    });
    await expect(lookupApprovalMessage('wamid.ABC')).resolves.toEqual({
      assetUrl: 'https://a/x.png',
      userId: 'user-1',
    });
  });

  it('returns null for an unknown or expired message id', async () => {
    (settingsService.getSetting as jest.Mock).mockResolvedValue(null);
    await expect(lookupApprovalMessage('wamid.GONE')).resolves.toBeNull();
  });

  it('returns null rather than throwing on a corrupt row', async () => {
    (settingsService.getSetting as jest.Mock).mockResolvedValue({ settingValue: 'not json' });
    await expect(lookupApprovalMessage('wamid.BAD')).resolves.toBeNull();
  });
});
