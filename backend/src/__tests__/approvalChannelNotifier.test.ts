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

const {
  bootstrapMessagingChannels,
  getMessagingChannel,
  resolveDestination,
} = require('../services/messagingChannelService');
const { userDb } = require('../services/db');

import { notifyApprovalOnWhatsApp } from '../services/approvalChannelNotifier';
import { TEMPLATES } from '../services/whatsappService';

const USER = { userId: 'user-1', email: 'reviewer@example.com' };

const params = {
  userId: 'user-1',
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
