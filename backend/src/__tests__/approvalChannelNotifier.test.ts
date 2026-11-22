/**
 * Approval requests on WhatsApp, and the taps that answer them (ENG-273).
 *
 * The contract: nothing here throws into its caller; a repeat tap is harmless because the
 * verdict is one atomic conditional write; and a tap can only ever answer an approval that
 * belongs to the account its number resolves to.
 */

jest.mock('../services/messagingChannelService', () => ({
  ...jest.requireActual('../services/messagingChannelService'),
  bootstrapMessagingChannels: jest.fn(),
  getMessagingChannel: jest.fn(),
  resolveDestination: jest.fn(),
}));
jest.mock('../services/db', () => ({ userDb: { getUserById: jest.fn() } }));
// Without this the correlation row hits real DynamoDB from a unit test — the write sits
// inside a try/catch, so the suite would pass while quietly calling AWS.
jest.mock('../services/settingsService', () => ({
  settingsService: { setSetting: jest.fn(), getSetting: jest.fn() },
}));
jest.mock('../services/approvalDb', () => ({ approvalDb: { answerIfOpen: jest.fn() } }));
jest.mock('../services/approvalSubscriberNotify', () => ({ notifySubscribersOfApproval: jest.fn() }));
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
const { notifySubscribersOfApproval } = require('../services/approvalSubscriberNotify');
const whatsapp = require('../services/whatsappService');

import {
  notifyApprovalOnWhatsApp,
  approvalMessageText,
  lookupApprovalMessage,
  handleApprovalButtonTap,
} from '../services/approvalChannelNotifier';
import { TEMPLATES } from '../services/whatsappService';

const USER = { userId: 'user-1', email: 'owner@example.com' };
const PHONE = '+918005326946';
const ASSET = 'https://assets.example.com/q4-launch-hero.png';

const params = {
  userId: 'user-1',
  assetType: 'image',
  filename: 'q4-launch-hero.png',
  assetUrl: ASSET,
};

describe('notifyApprovalOnWhatsApp', () => {
  let send: jest.Mock;

  beforeEach(() => {
    jest.resetAllMocks();
    send = jest.fn().mockResolvedValue({ messageId: 'wamid.T' });
    (bootstrapMessagingChannels as jest.Mock).mockResolvedValue(undefined);
    (getMessagingChannel as jest.Mock).mockReturnValue({ sendMessage: send });
    (userDb.getUserById as jest.Mock).mockResolvedValue(USER);
    (resolveDestination as jest.Mock).mockResolvedValue(PHONE);
    (settingsService.setSetting as jest.Mock).mockResolvedValue(undefined);
    (whatsapp.isServiceWindowOpen as jest.Mock).mockResolvedValue(false);
    (whatsapp.sendInteractiveButtons as jest.Mock).mockResolvedValue({ messageId: 'wamid.I' });
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  describe('outcome', () => {
    it('is delivered once the message is handed to WhatsApp', async () => {
      await expect(notifyApprovalOnWhatsApp(params)).resolves.toBe('delivered');
    });

    it('is not_applicable for an account with no WhatsApp number', async () => {
      (resolveDestination as jest.Mock).mockResolvedValue(null);
      await expect(notifyApprovalOnWhatsApp(params)).resolves.toBe('not_applicable');
      expect(send).not.toHaveBeenCalled();
    });

    it('is not_applicable when the account cannot be found', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue(null);
      await expect(notifyApprovalOnWhatsApp(params)).resolves.toBe('not_applicable');
    });

    it('is not_applicable, and looks nothing up, without a userId', async () => {
      await expect(notifyApprovalOnWhatsApp({ ...params, userId: '' })).resolves.toBe('not_applicable');
      expect(userDb.getUserById).not.toHaveBeenCalled();
    });

    it('is FAILED — not not_applicable — when a reachable account cannot be sent to', async () => {
      // The caller must tell these apart: a customer who can be reached but was not must
      // not be treated as having no channel, or their approval gate is quietly opened.
      send.mockRejectedValue(new Error('131047 outside service window'));
      await expect(notifyApprovalOnWhatsApp(params)).resolves.toBe('failed');
    });

    it('is failed when the account lookup throws, and never throws itself', async () => {
      (userDb.getUserById as jest.Mock).mockRejectedValue(new Error('dynamo down'));
      await expect(notifyApprovalOnWhatsApp(params)).resolves.toBe('failed');
    });

    it('uses the account the caller already loaded instead of reading it again', async () => {
      await notifyApprovalOnWhatsApp({ ...params, user: USER });
      expect(userDb.getUserById).not.toHaveBeenCalled();
    });

    it('keeps the phone number out of its failure log (CWE-532)', async () => {
      send.mockRejectedValue(new Error('send failed'));
      await notifyApprovalOnWhatsApp(params);
      const logged = (console.warn as jest.Mock).mock.calls.flat().join(' ');
      expect(logged).not.toContain('918005326946');
      expect(logged).toContain('user-1');
    });
  });

  describe('message shape follows the 24-hour window', () => {
    it('sends real Approve/Reject buttons when the window is open', async () => {
      (whatsapp.isServiceWindowOpen as jest.Mock).mockResolvedValue(true);
      await notifyApprovalOnWhatsApp(params);

      expect(send).not.toHaveBeenCalled();
      const [dest, body, buttons] = (whatsapp.sendInteractiveButtons as jest.Mock).mock.calls[0];
      expect(dest).toBe(PHONE);
      expect(body).toContain('q4-launch-hero.png');
      expect(buttons).toEqual([
        { id: 'approve', title: 'Approve' },
        { id: 'reject', title: 'Reject' },
      ]);
    });

    it('sends the quick-reply button template when the window is shut', async () => {
      await notifyApprovalOnWhatsApp(params);
      expect(whatsapp.sendInteractiveButtons).not.toHaveBeenCalled();
      expect(send.mock.calls[0][0].template.name).toBe(TEMPLATES.APPROVAL_REQUEST_BUTTONS.name);
      expect(TEMPLATES.APPROVAL_REQUEST_BUTTONS.quickReplies).toEqual(['approve', 'reject']);
    });

    it('falls back to the link-only template while Meta has not approved the button one', async () => {
      send
        .mockRejectedValueOnce(new whatsapp.WhatsAppError('template does not exist', 132001))
        .mockResolvedValueOnce({ messageId: 'wamid.FALLBACK' });
      expect(await notifyApprovalOnWhatsApp(params)).toBe('delivered');
      expect(send.mock.calls[1][0].template.name).toBe(TEMPLATES.APPROVAL_REQUEST.name);
      expect((settingsService.setSetting as jest.Mock).mock.calls[0][0]).toBe(
        'whatsapp:approval-msg:wamid.FALLBACK',
      );
    });

    it('does NOT fall back on any other Meta error', async () => {
      send.mockRejectedValue(new whatsapp.WhatsAppError('quota', 80007));
      expect(await notifyApprovalOnWhatsApp(params)).toBe('failed');
      expect(send).toHaveBeenCalledTimes(1);
    });

    it('binds template variables in the order Meta substitutes them', async () => {
      // Meta binds {{1}},{{2}},{{3}} POSITIONALLY: reordering does not error, it silently
      // delivers the wrong words to a customer.
      expect(TEMPLATES.APPROVAL_REQUEST.variables).toEqual(['asset_type', 'asset_name', 'review_url']);
      await notifyApprovalOnWhatsApp(params);
      expect(TEMPLATES.APPROVAL_REQUEST_BUTTONS.variables).toEqual(TEMPLATES.APPROVAL_REQUEST.variables);
      expect(send.mock.calls[0][0].template.variables).toEqual(['image', 'q4-launch-hero.png', ASSET]);
    });

    it('labels an untitled asset rather than sending an empty template variable', async () => {
      await notifyApprovalOnWhatsApp({ ...params, assetType: '', filename: '' });
      const vars = send.mock.calls[0][0].template.variables;
      expect(vars[0]).toBeTruthy();
      expect(vars[1]).toBeTruthy();
    });
  });

  describe('correlating a tap back to the approval', () => {
    it('records the sent message id against the asset and owner', async () => {
      // Meta sets button.payload to the button's LABEL, so a decision id cannot ride on
      // the button. The tap carries only context.id, which makes this row the only route
      // back to what was being approved.
      await notifyApprovalOnWhatsApp(params);
      const [key, value] = (settingsService.setSetting as jest.Mock).mock.calls[0];
      expect(key).toBe('whatsapp:approval-msg:wamid.T');
      expect(JSON.parse(value)).toEqual({ assetUrl: ASSET, userId: 'user-1' });
    });

    it('records the id of an interactive send too', async () => {
      (whatsapp.isServiceWindowOpen as jest.Mock).mockResolvedValue(true);
      await notifyApprovalOnWhatsApp(params);
      expect((settingsService.setSetting as jest.Mock).mock.calls[0][0]).toBe('whatsapp:approval-msg:wamid.I');
    });

    it('gives the row a TTL in epoch SECONDS, not milliseconds', async () => {
      await notifyApprovalOnWhatsApp(params);
      const ttl = (settingsService.setSetting as jest.Mock).mock.calls[0][4];
      const days = (ttl - Math.floor(Date.now() / 1000)) / 86400;
      expect(days).toBeGreaterThan(29);
      expect(days).toBeLessThan(31);
    });

    it('records nothing when the provider returned no id', async () => {
      send.mockResolvedValue({ messageId: null });
      await notifyApprovalOnWhatsApp(params);
      expect(settingsService.setSetting).not.toHaveBeenCalled();
    });

    it('still reports delivered when recording the id fails', async () => {
      (settingsService.setSetting as jest.Mock).mockRejectedValue(new Error('dynamo down'));
      await expect(notifyApprovalOnWhatsApp(params)).resolves.toBe('delivered');
    });
  });
});

describe('approvalMessageText', () => {
  it('puts the whole link in the message', () => {
    expect(approvalMessageText('image', 'hero.png', ASSET)).toBe(
      `image "hero.png" is waiting for your approval. ${ASSET}`,
    );
  });

  it('caps a very long filename instead of crowding out the link', () => {
    const text = approvalMessageText('image', 'x'.repeat(300), ASSET);
    expect(text.endsWith(ASSET)).toBe(true);
    expect(text.length).toBeLessThan(200);
  });

  it('never cuts a link in half: a link too long to fit is dropped', () => {
    // A body simply truncated at WhatsApp's limit can slice the URL mid-way, leaving a
    // link that opens the wrong thing or nothing.
    const huge = `https://assets.example.com/${'a'.repeat(1200)}.png`;
    const text = approvalMessageText('image', 'hero.png', huge);
    expect(text).not.toContain('https://');
    expect(text).toMatch(/Open AgentWeb to review it/);
    expect(text.length).toBeLessThanOrEqual(1000);
  });
});

describe('approvalMessageText with emoji', () => {
  it('never splits a surrogate pair when it shortens a long filename', () => {
    const text = approvalMessageText('image', 'a'.repeat(78) + '😀' + 'b'.repeat(10), 'https://x/y');
    expect(text).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
    expect(text).toContain('…');
  });
});

describe('lookupApprovalMessage', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
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
  const MSG = 'wamid.ABC';
  const tap = (action = 'approve') =>
    handleApprovalButtonTap({ phone: PHONE, approvalMessageId: MSG, action });
  const answered = (status = 'approved', extra: object = {}) => ({
    answered: true,
    approval: { assetUrl: ASSET, status, executionId: 'exec-9', ...extra },
  });

  beforeEach(() => {
    jest.resetAllMocks();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    (settingsService.getSetting as jest.Mock).mockResolvedValue({
      settingValue: JSON.stringify({ assetUrl: ASSET, userId: 'user-1' }),
    });
    (whatsapp.resolveUserIdByPhone as jest.Mock).mockResolvedValue('user-1');
    (approvalDb.answerIfOpen as jest.Mock).mockResolvedValue(answered());
    (whatsapp.sendText as jest.Mock).mockResolvedValue({ messageId: 'wamid.reply' });
  });

  describe('recording a verdict', () => {
    it('records an approval', async () => {
      await tap('approve');
      expect(approvalDb.answerIfOpen).toHaveBeenCalledWith(ASSET, 'approved', 'whatsapp:user-1', 'user-1');
    });

    it('records a rejection', async () => {
      (approvalDb.answerIfOpen as jest.Mock).mockResolvedValue(answered('rejected'));
      await tap('reject');
      expect(approvalDb.answerIfOpen).toHaveBeenCalledWith(ASSET, 'rejected', 'whatsapp:user-1', 'user-1');
    });

    it('accepts the LABEL a template quick-reply sends back, in any case', async () => {
      await tap('Approve');
      expect(approvalDb.answerIfOpen).toHaveBeenCalledWith(ASSET, 'approved', 'whatsapp:user-1', 'user-1');
    });

    it('confirms the verdict back to the customer', async () => {
      await tap('approve');
      expect(whatsapp.sendText).toHaveBeenCalledWith(PHONE, expect.stringMatching(/approved/i));
    });

    it('still records the verdict when the confirmation fails to send', async () => {
      (whatsapp.sendText as jest.Mock).mockRejectedValue(new Error('meta down'));
      await tap();
      expect(approvalDb.answerIfOpen).toHaveBeenCalled();
    });
  });

  describe('subscriber email', () => {
    it('emails the task subscribers on approval, exactly as Slack does', async () => {
      await tap('approve');
      expect(notifySubscribersOfApproval).toHaveBeenCalledWith(
        expect.objectContaining({ executionId: 'exec-9' }),
      );
    });

    it('does not email subscribers on a rejection', async () => {
      (approvalDb.answerIfOpen as jest.Mock).mockResolvedValue(answered('rejected'));
      await tap('reject');
      expect(notifySubscribersOfApproval).not.toHaveBeenCalled();
    });
  });

  describe('a tap that is not the first answer', () => {
    // WhatsApp can never remove the buttons, so these are the normal case, not an edge.
    it('does not write, email, or confirm — it says what stands', async () => {
      (approvalDb.answerIfOpen as jest.Mock).mockResolvedValue({ answered: false, current: 'approved' });
      await tap('reject');

      expect(notifySubscribersOfApproval).not.toHaveBeenCalled();
      expect(whatsapp.sendText).toHaveBeenCalledTimes(1);
      expect(whatsapp.sendText).toHaveBeenCalledWith(PHONE, expect.stringMatching(/already approved/i));
    });

    it('says rejected when it was rejected', async () => {
      (approvalDb.answerIfOpen as jest.Mock).mockResolvedValue({ answered: false, current: 'rejected' });
      await tap('approve');
      expect(whatsapp.sendText).toHaveBeenCalledWith(PHONE, expect.stringMatching(/already rejected/i));
    });

    it('is told the truth when the portal or Slack answered first', async () => {
      // The conditional write is against the record itself, not a WhatsApp-only flag, so a
      // verdict given anywhere else is respected — the case a separate claim row missed.
      (approvalDb.answerIfOpen as jest.Mock).mockResolvedValue({ answered: false, current: 'approved' });
      await tap('reject');
      expect(approvalDb.answerIfOpen).toHaveBeenCalledWith(ASSET, 'rejected', 'whatsapp:user-1', 'user-1');
      expect(notifySubscribersOfApproval).not.toHaveBeenCalled();
    });

    it('tells a number that is no longer connected to any account, instead of staying silent', async () => {
      (whatsapp.resolveUserIdByPhone as jest.Mock).mockResolvedValue(null);
      await tap();
      expect(approvalDb.answerIfOpen).not.toHaveBeenCalled();
      expect((whatsapp.sendText as jest.Mock).mock.calls[0][1]).toMatch(/isn't connected to an AgentWeb account/i);
    });

    it('stays silent for a number that belongs to a DIFFERENT account (reveals nothing)', async () => {
      (whatsapp.resolveUserIdByPhone as jest.Mock).mockResolvedValue('someone-else');
      await tap();
      expect(whatsapp.sendText).not.toHaveBeenCalled();
      expect(approvalDb.answerIfOpen).not.toHaveBeenCalled();
    });

    it('says the request is gone when the record now belongs to a different account', async () => {
      // Another account re-requested the same asset: the owner-checked write is refused
      // while the record is still open, so these buttons no longer point at this customer.
      (approvalDb.answerIfOpen as jest.Mock).mockResolvedValue({ answered: false, current: 'pending' });
      await tap();
      expect((whatsapp.sendText as jest.Mock).mock.calls[0][1]).toMatch(/no longer available/i);
      expect(notifySubscribersOfApproval).not.toHaveBeenCalled();
    });

    it('tells the customer to tap again when the correlation cannot be read', async () => {
      (settingsService.getSetting as jest.Mock).mockRejectedValue(new Error('dynamo blip'));
      await tap();
      expect((whatsapp.sendText as jest.Mock).mock.calls[0][1]).toMatch(/tap again|couldn.t record/i);
      expect(approvalDb.answerIfOpen).not.toHaveBeenCalled();
    });

    it('does NOT say the request is gone when the standing verdict simply could not be read', async () => {
      (approvalDb.answerIfOpen as jest.Mock).mockResolvedValue({ answered: false, current: 'unknown' });
      await tap();
      const sent = (whatsapp.sendText as jest.Mock).mock.calls[0][1];
      expect(sent).not.toMatch(/no longer available/i);
      expect(sent).toMatch(/already answered/i);
    });

    it('says the request is gone when there is no such approval', async () => {
      (approvalDb.answerIfOpen as jest.Mock).mockResolvedValue({ answered: false, current: null });
      await tap();
      expect(whatsapp.sendText).toHaveBeenCalledWith(PHONE, expect.stringMatching(/no longer available/i));
    });

    it('emails subscribers only for the tap the database says won', async () => {
      // The database gives the condition to one writer and refuses the other; model that.
      let open = true;
      (approvalDb.answerIfOpen as jest.Mock).mockImplementation(async () => {
        if (open) {
          open = false;
          return answered();
        }
        return { answered: false, current: 'approved' };
      });
      await Promise.all([tap('approve'), tap('approve'), tap('approve')]);
      expect(notifySubscribersOfApproval).toHaveBeenCalledTimes(1);
    });
  });

  describe('a failed write', () => {
    it('tells the customer to tap again rather than staying silent', async () => {
      (approvalDb.answerIfOpen as jest.Mock).mockRejectedValue(new Error('Failed to answer approval'));
      await tap();
      expect(whatsapp.sendText).toHaveBeenCalledWith(PHONE, expect.stringMatching(/tap the button again/i));
      expect(notifySubscribersOfApproval).not.toHaveBeenCalled();
    });

    it('does not claim success', async () => {
      (approvalDb.answerIfOpen as jest.Mock).mockRejectedValue(new Error('boom'));
      await tap();
      const sent = (whatsapp.sendText as jest.Mock).mock.calls.flat().join(' ');
      expect(sent).not.toMatch(/recorded\./i);
    });
  });

  describe('who may answer', () => {
    it('ignores a button that is not an approval verdict', async () => {
      await tap('tell-me-more');
      expect(approvalDb.answerIfOpen).not.toHaveBeenCalled();
    });

    it('answers a tap on an unknown or expired message instead of going quiet', async () => {
      // The correlation row is best-effort, so a real approval message can lose it. With no
      // visible state on a WhatsApp button, silence reads as "recorded".
      (settingsService.getSetting as jest.Mock).mockResolvedValue(null);
      await tap();
      expect(approvalDb.answerIfOpen).not.toHaveBeenCalled();
      expect(whatsapp.sendText).toHaveBeenCalledWith(PHONE, expect.stringMatching(/no longer available/i));
    });

    it('refuses a tap from someone who does not own the approval', async () => {
      // The number resolves to a real user — just not this approval's owner.
      (whatsapp.resolveUserIdByPhone as jest.Mock).mockResolvedValue('someone-else');
      await tap();
      expect(approvalDb.answerIfOpen).not.toHaveBeenCalled();
    });

    it('refuses a tap from an unrecognised number', async () => {
      (whatsapp.resolveUserIdByPhone as jest.Mock).mockResolvedValue(null);
      await tap();
      expect(approvalDb.answerIfOpen).not.toHaveBeenCalled();
    });

    it('keeps the phone number out of its logs', async () => {
      (whatsapp.resolveUserIdByPhone as jest.Mock).mockResolvedValue(null);
      await tap();
      const logged = (console.warn as jest.Mock).mock.calls.flat().join(' ');
      expect(logged).not.toContain('918005326946');
    });
  });

  it('never throws into the webhook', async () => {
    // A throw becomes a 500, Meta retries, and the retry would be told "already answered".
    (settingsService.getSetting as jest.Mock).mockRejectedValue(new Error('boom'));
    await expect(tap()).resolves.toBeUndefined();
  });
});
