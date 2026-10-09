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
  settingsService: {
    setSetting: jest.fn(), getSetting: jest.fn(), deleteSetting: jest.fn(),
    claimSetMember: jest.fn(), releaseSetMember: jest.fn(),
  },
}));
jest.mock('../services/approvalDb', () => ({
  approvalDb: { updateApprovalStatus: jest.fn() },
}));
jest.mock('../services/whatsappService', () => ({
  ...jest.requireActual('../services/whatsappService'),
  resolveUserIdByPhone: jest.fn(),
  sendText: jest.fn(),
  sendInteractiveButtons: jest.fn(),
  isServiceWindowOpen: jest.fn(),
}));

const {
  bootstrapMessagingChannels,
  getMessagingChannel,
  resolveDestination,
} = require('../services/messagingChannelService');
const { userDb } = require('../services/db');
const { settingsService } = require('../services/settingsService');
const { approvalDb } = require('../services/approvalDb');
const whatsapp = require('../services/whatsappService');

import {
  notifyApprovalOnWhatsApp,
  lookupApprovalMessage,
  handleApprovalButtonTap,
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
    // Window shut by default, so these cases exercise the template path.
    (whatsapp.isServiceWindowOpen as jest.Mock).mockResolvedValue(false);
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
    (whatsapp.isServiceWindowOpen as jest.Mock).mockResolvedValue(false);
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

describe('handleApprovalButtonTap', () => {
  const PHONE = '+918005326946';
  const MSG = 'wamid.ABC';
  const ASSET = 'https://assets.example.com/q4-launch-hero.png';
  const tap = (action = 'approve') =>
    handleApprovalButtonTap({ phone: PHONE, approvalMessageId: MSG, action });

  beforeEach(() => {
    jest.resetAllMocks();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    (settingsService.getSetting as jest.Mock).mockResolvedValue({
      settingValue: JSON.stringify({ assetUrl: ASSET, userId: 'user-1' }),
    });
    (whatsapp.resolveUserIdByPhone as jest.Mock).mockResolvedValue('user-1');
    (settingsService.claimSetMember as jest.Mock).mockResolvedValue(true);
    (approvalDb.updateApprovalStatus as jest.Mock).mockResolvedValue({});
    (whatsapp.sendText as jest.Mock).mockResolvedValue({ messageId: 'wamid.reply' });
  });

  it('records an approval', async () => {
    await tap('approve');
    expect(approvalDb.updateApprovalStatus).toHaveBeenCalledWith(ASSET, 'approved', 'whatsapp:user-1');
  });

  it('records a rejection', async () => {
    await tap('reject');
    expect(approvalDb.updateApprovalStatus).toHaveBeenCalledWith(ASSET, 'rejected', 'whatsapp:user-1');
  });

  it('accepts the LABEL a template quick-reply sends back', async () => {
    // Meta fills a template button's payload with its own label, so the action can
    // arrive capitalised and human-shaped rather than as the id we chose.
    await tap('Approve');
    expect(approvalDb.updateApprovalStatus).toHaveBeenCalledWith(ASSET, 'approved', 'whatsapp:user-1');
  });

  it('ignores a button that is not an approval verdict', async () => {
    await tap('tell-me-more');
    expect(settingsService.claimSetMember).not.toHaveBeenCalled();
    expect(approvalDb.updateApprovalStatus).not.toHaveBeenCalled();
  });

  it('does nothing for a tap on an unknown or expired message', async () => {
    (settingsService.getSetting as jest.Mock).mockResolvedValue(null);
    await tap();
    expect(approvalDb.updateApprovalStatus).not.toHaveBeenCalled();
  });

  it('refuses a tap from someone who does not own the approval', async () => {
    // The number resolves to a real user — just not this approval's owner.
    (whatsapp.resolveUserIdByPhone as jest.Mock).mockResolvedValue('someone-else');
    await tap();
    expect(settingsService.claimSetMember).not.toHaveBeenCalled();
    expect(approvalDb.updateApprovalStatus).not.toHaveBeenCalled();
  });

  it('refuses a tap from an unrecognised number', async () => {
    (whatsapp.resolveUserIdByPhone as jest.Mock).mockResolvedValue(null);
    await tap();
    expect(approvalDb.updateApprovalStatus).not.toHaveBeenCalled();
  });

  it('answers a second tap without re-running the verdict', async () => {
    // THE case this handler exists for. WhatsApp cannot remove the buttons, so they
    // stay tappable forever and approving fans out subscriber email.
    (settingsService.claimSetMember as jest.Mock).mockResolvedValue(false);
    await tap();

    expect(approvalDb.updateApprovalStatus).not.toHaveBeenCalled();
    expect(whatsapp.sendText).toHaveBeenCalledWith(PHONE, expect.stringMatching(/already recorded/i));
  });

  it('claims BEFORE writing the verdict', async () => {
    const order: string[] = [];
    (settingsService.claimSetMember as jest.Mock).mockImplementation(async () => {
      order.push('claim');
      return true;
    });
    (approvalDb.updateApprovalStatus as jest.Mock).mockImplementation(async () => {
      order.push('write');
      return {};
    });
    await tap();
    expect(order).toEqual(['claim', 'write']);
  });

  it('releases the claim when the verdict write fails, so the customer can retry', async () => {
    (approvalDb.updateApprovalStatus as jest.Mock).mockRejectedValue(new Error('dynamo down'));
    await tap();
    expect(settingsService.releaseSetMember).toHaveBeenCalledWith(
      `whatsapp:approval-claim:${ASSET}`,
      'answered',
    );
  });

  it('confirms the verdict back to the customer', async () => {
    // No way to grey the button out, so silence reads as failure.
    await tap('approve');
    expect(whatsapp.sendText).toHaveBeenCalledWith(PHONE, expect.stringMatching(/approved/i));
  });

  it('still records the verdict when the confirmation fails to send', async () => {
    (whatsapp.sendText as jest.Mock).mockRejectedValue(new Error('meta down'));
    await tap();
    expect(approvalDb.updateApprovalStatus).toHaveBeenCalled();
  });

  it('never throws into the webhook', async () => {
    // A throw becomes a 500, Meta retries, and the retry is reported to the customer
    // as "already recorded" — a confusing answer to a tap that genuinely failed.
    (settingsService.getSetting as jest.Mock).mockRejectedValue(new Error('boom'));
    await expect(tap()).resolves.toBeUndefined();
  });

  it('keeps the phone number out of its logs', async () => {
    (whatsapp.resolveUserIdByPhone as jest.Mock).mockResolvedValue(null);
    await tap();
    const logged = (console.warn as jest.Mock).mock.calls.flat().join(' ');
    expect(logged).not.toContain('918005326946');
  });
});

describe('choosing the message shape by window state', () => {
  let send: jest.Mock;

  beforeEach(() => {
    jest.resetAllMocks();
    send = jest.fn().mockResolvedValue({ messageId: 'wamid.T' });
    (bootstrapMessagingChannels as jest.Mock).mockResolvedValue(undefined);
    (getMessagingChannel as jest.Mock).mockReturnValue({ sendMessage: send });
    (userDb.getUserById as jest.Mock).mockResolvedValue(USER);
    (resolveDestination as jest.Mock).mockResolvedValue('+918005326946');
    (settingsService.setSetting as jest.Mock).mockResolvedValue(undefined);
    (whatsapp.sendInteractiveButtons as jest.Mock).mockResolvedValue({ messageId: 'wamid.I' });
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('sends real Approve/Reject buttons when the window is open', async () => {
    // Interactive messages are service messages — no template, no Meta review.
    (whatsapp.isServiceWindowOpen as jest.Mock).mockResolvedValue(true);
    await notifyApprovalOnWhatsApp(params);

    expect(send).not.toHaveBeenCalled();
    const [dest, body, buttons] = (whatsapp.sendInteractiveButtons as jest.Mock).mock.calls[0];
    expect(dest).toBe('+918005326946');
    expect(body).toContain('q4-launch-hero.png');
    expect(buttons).toEqual([
      { id: 'approve', title: 'Approve' },
      { id: 'reject', title: 'Reject' },
    ]);
  });

  it('falls back to the template when the window is shut', async () => {
    // Outside the window a template is the only thing Meta will deliver at all.
    (whatsapp.isServiceWindowOpen as jest.Mock).mockResolvedValue(false);
    await notifyApprovalOnWhatsApp(params);

    expect(whatsapp.sendInteractiveButtons).not.toHaveBeenCalled();
    expect(send.mock.calls[0][0].template.name).toBe(TEMPLATES.APPROVAL_REQUEST.name);
  });

  it('records the message id from the interactive send too', async () => {
    // Without this the buttons it just sent would be untappable — nothing would link
    // the tap back to the asset.
    (whatsapp.isServiceWindowOpen as jest.Mock).mockResolvedValue(true);
    await notifyApprovalOnWhatsApp(params);

    const [key] = (settingsService.setSetting as jest.Mock).mock.calls[0];
    expect(key).toBe('whatsapp:approval-msg:wamid.I');
  });
});
