/**
 * Tests for sendAsSender — routes a CRM sender's send through its real provider
 * (Resend / Gmail / Outlook), bridging ResendSendParams and IEmailService's
 * SendEmailParams.
 */

const mockResendSendEmail = jest.fn();
jest.mock('../services/resendService', () => ({
  resendService: {
    sendEmail: (...args: any[]) => mockResendSendEmail(...args),
  },
}));

const mockGetEmailProvider = jest.fn();
const mockBootstrapEmailProviders = jest.fn();
jest.mock('../services/emailProviderService', () => ({
  getEmailProvider: (...args: any[]) => mockGetEmailProvider(...args),
  bootstrapEmailProviders: (...args: any[]) => mockBootstrapEmailProviders(...args),
}));

const mockReserveSend = jest.fn();
const mockReleaseSend = jest.fn();
jest.mock('../services/senderUsageTrackerFactory', () => ({
  senderUsageTracker: {
    reserveSend: (...args: any[]) => mockReserveSend(...args),
    releaseSend: (...args: any[]) => mockReleaseSend(...args),
    getUsage: jest.fn(),
  },
}));

import { sendAsSender, SenderSendError } from '../services/sendAsSender';
import { SenderDailyLimitExceededError } from '../services/senderUsageTracker';
import { CrmSender } from '../services/crmSenderTypes';

const resendSender: CrmSender = {
  id: 's1',
  email: 'hi@acme.com',
  fromName: 'Acme',
  senderProvider: 'resend',
};

const gmailSender: CrmSender = {
  id: 's2',
  email: 'me@gmail.com',
  fromName: 'Me',
  senderProvider: 'gmail',
  connectedAccountId: 'gm-acct-1',
};

const outlookSender: CrmSender = {
  id: 's3',
  email: 'hunter.alsaeed@baldwin.com',
  fromName: 'Hunter',
  senderProvider: 'outlook',
  connectedAccountId: 'ol-acct-1',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockBootstrapEmailProviders.mockResolvedValue(undefined);
  mockReserveSend.mockResolvedValue('2026-05-04');
  mockReleaseSend.mockResolvedValue(undefined);
});

describe('sendAsSender — FAIL cases', () => {
  it('throws when a mailbox sender is missing connectedAccountId', async () => {
    const broken: CrmSender = { ...gmailSender, connectedAccountId: undefined };
    await expect(
      sendAsSender('u1', broken, { to: 'a@b.com', subject: 's', html: '<p>hi</p>' }),
    ).rejects.toThrow(SenderSendError);
    expect(mockGetEmailProvider).not.toHaveBeenCalled();
  });

  it('throws when Resend returns null (the send failed)', async () => {
    mockResendSendEmail.mockResolvedValue(null);
    await expect(
      sendAsSender('u1', resendSender, { to: 'a@b.com', subject: 's', html: '<p>hi</p>' }),
    ).rejects.toThrow(SenderSendError);
  });

  it('throws for an unrecognized sender provider', async () => {
    const bad = { ...resendSender, senderProvider: 'carrier-pigeon' as any };
    await expect(
      sendAsSender('u1', bad, { to: 'a@b.com', subject: 's', html: '<p>hi</p>' }),
    ).rejects.toThrow(SenderSendError);
  });

  it('throws instead of silently dropping bcc on a Resend sender (Resend has never supported bcc)', async () => {
    await expect(
      sendAsSender('u1', resendSender, { to: 'a@b.com', subject: 's', html: '<p>hi</p>', bcc: 'hidden@example.com' }),
    ).rejects.toThrow(SenderSendError);
    expect(mockResendSendEmail).not.toHaveBeenCalled();
  });

  it('propagates a provider error (e.g. token revoked) rather than swallowing it', async () => {
    class FakeProviderError extends Error {}
    mockGetEmailProvider.mockReturnValue({
      sendEmail: jest.fn().mockRejectedValue(new FakeProviderError('token revoked')),
    });
    await expect(
      sendAsSender('u1', gmailSender, { to: 'a@b.com', subject: 's', html: '<p>hi</p>' }),
    ).rejects.toThrow('token revoked');
  });
});

describe('sendAsSender — text-only sends (no html)', () => {
  it('sends a text-only Resend email without an html key', async () => {
    mockResendSendEmail.mockResolvedValue({ id: 'resend-msg-2' });

    await sendAsSender('u1', resendSender, { to: 'lead@example.com', subject: 'Hi', text: 'hi (plain)' });

    expect(mockResendSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'hi (plain)' }),
    );
    const paramsPassed = mockResendSendEmail.mock.calls[0][0];
    expect(paramsPassed.html).toBeUndefined();
  });

  it('sends a text-only mailbox email as plain text (isHtml: false)', async () => {
    const mockSendEmail = jest.fn().mockResolvedValue({ messageId: 'gm-2', threadId: '' });
    mockGetEmailProvider.mockReturnValue({ sendEmail: mockSendEmail });

    await sendAsSender('u1', gmailSender, { to: 'lead@example.com', subject: 'Hi', text: 'hi (plain)' });

    expect(mockSendEmail).toHaveBeenCalledWith(
      'u1',
      'gm-acct-1',
      expect.objectContaining({ body: 'hi (plain)', isHtml: false }),
    );
  });
});

describe('sendAsSender — SUCCESS cases', () => {
  it('sends via Resend with from/html/text/inReplyTo mapped correctly', async () => {
    mockResendSendEmail.mockResolvedValue({ id: 'resend-msg-1' });

    const result = await sendAsSender('u1', resendSender, {
      to: 'lead@example.com',
      subject: 'Hi',
      html: '<p>hi</p>',
      text: 'hi',
      replyToMessageId: 'rfc-msg-id',
    });

    expect(mockResendSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'Acme <hi@acme.com>',
        to: 'lead@example.com',
        subject: 'Hi',
        html: '<p>hi</p>',
        text: 'hi',
        inReplyTo: 'rfc-msg-id',
      }),
    );
    expect(result).toEqual({ provider: 'resend', messageId: 'resend-msg-1' });
  });

  it('sends via Gmail with body/isHtml, dropping the text alternative', async () => {
    const mockSendEmail = jest.fn().mockResolvedValue({ messageId: 'gm-1', threadId: 'th-1' });
    mockGetEmailProvider.mockReturnValue({ sendEmail: mockSendEmail });

    const result = await sendAsSender('u1', gmailSender, {
      to: 'lead@example.com',
      subject: 'Hi',
      html: '<p>hi</p>',
      text: 'hi (plain)',
    });

    expect(mockBootstrapEmailProviders).toHaveBeenCalled();
    expect(mockGetEmailProvider).toHaveBeenCalledWith('gmail');
    expect(mockSendEmail).toHaveBeenCalledWith(
      'u1',
      'gm-acct-1',
      expect.objectContaining({ to: 'lead@example.com', subject: 'Hi', body: '<p>hi</p>', isHtml: true }),
    );
    const paramsPassed = mockSendEmail.mock.calls[0][2];
    expect(paramsPassed.text).toBeUndefined();
    expect(result).toEqual({ provider: 'gmail', messageId: 'gm-1', threadId: 'th-1' });
  });

  it('sends via Outlook the same way; replyToMessageId passthrough does not throw even though Outlook ignores it', async () => {
    const mockSendEmail = jest.fn().mockResolvedValue({ messageId: 'ol-1', threadId: '' });
    mockGetEmailProvider.mockReturnValue({ sendEmail: mockSendEmail });

    const result = await sendAsSender('u1', outlookSender, {
      to: 'lead@example.com',
      subject: 'Hi',
      html: '<p>hi</p>',
      replyToMessageId: 'some-arbitrary-id',
    });

    expect(mockGetEmailProvider).toHaveBeenCalledWith('outlook');
    expect(mockSendEmail).toHaveBeenCalledWith(
      'u1',
      'ol-acct-1',
      expect.objectContaining({ replyToMessageId: 'some-arbitrary-id' }),
    );
    expect(result).toEqual({ provider: 'outlook', messageId: 'ol-1', threadId: '' });
  });

  it('throttles two back-to-back mailbox sends instead of firing both immediately', async () => {
    const mockSendEmail = jest.fn().mockResolvedValue({ messageId: 'x', threadId: '' });
    mockGetEmailProvider.mockReturnValue({ sendEmail: mockSendEmail });
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');

    await sendAsSender('u1', gmailSender, { to: 'a@b.com', subject: 's', html: 'h' });
    await sendAsSender('u1', gmailSender, { to: 'a@b.com', subject: 's', html: 'h' });

    expect(setTimeoutSpy).toHaveBeenCalled();
    setTimeoutSpy.mockRestore();
  });
});

describe('sendAsSender — daily cap / warmup (ENG-265)', () => {
  it('does not touch the usage tracker at all for a sender with no cap configured', async () => {
    mockResendSendEmail.mockResolvedValue({ id: 'resend-msg' });
    await sendAsSender('u1', resendSender, { to: 'a@b.com', subject: 's', html: 'h' });
    expect(mockReserveSend).not.toHaveBeenCalled();
    expect(mockReleaseSend).not.toHaveBeenCalled();
  });

  it('reserves quota before sending, using the sender id and its effective limit', async () => {
    mockResendSendEmail.mockResolvedValue({ id: 'resend-msg' });
    const capped: CrmSender = { ...resendSender, dailyLimit: 25 };

    await sendAsSender('u1', capped, { to: 'a@b.com', subject: 's', html: 'h' });

    expect(mockReserveSend).toHaveBeenCalledWith('u1', 's1', 25);
  });

  it('refuses to send when the sender is at its daily limit, without calling the provider', async () => {
    mockReserveSend.mockRejectedValue(new SenderDailyLimitExceededError('s1', 25));
    const capped: CrmSender = { ...resendSender, dailyLimit: 25 };

    await expect(
      sendAsSender('u1', capped, { to: 'a@b.com', subject: 's', html: 'h' }),
    ).rejects.toBeInstanceOf(SenderDailyLimitExceededError);
    expect(mockResendSendEmail).not.toHaveBeenCalled();
    // The rejection came from reserveSend itself — there's no reservation to release.
    expect(mockReleaseSend).not.toHaveBeenCalled();
  });

  it('does not release the reservation when Resend confirms success', async () => {
    mockResendSendEmail.mockResolvedValue({ id: 'resend-msg' });
    const capped: CrmSender = { ...resendSender, dailyLimit: 25 };

    await sendAsSender('u1', capped, { to: 'a@b.com', subject: 's', html: 'h' });

    expect(mockReserveSend).toHaveBeenCalledWith('u1', 's1', 25);
    expect(mockReleaseSend).not.toHaveBeenCalled();
  });

  // CodeRabbit (post-fix review): a missing Resend message id is ambiguous, not proof the
  // send never went out — Resend may have accepted it before a response failure reached this
  // process. Releasing quota here would let a client-side retry exceed the sender's real
  // daily limit if the original attempt actually sent. Same for any dispatch-time throw from
  // a mailbox provider (timeout, connection drop after the request started, etc.) — none of
  // these prove no dispatch occurred, so the reservation now stays consumed in every case
  // past the pre-flight validation stage (conservative: under- not over-sending).
  it('does NOT release the reservation on an ambiguous Resend outcome (missing message id)', async () => {
    mockResendSendEmail.mockResolvedValue(null); // Resend "failed" signal — but maybe not really
    const capped: CrmSender = { ...resendSender, dailyLimit: 25 };

    await expect(
      sendAsSender('u1', capped, { to: 'a@b.com', subject: 's', html: 'h' }),
    ).rejects.toThrow(SenderSendError);
    expect(mockReleaseSend).not.toHaveBeenCalled();
  });

  it('does NOT release the reservation when a mailbox provider throws after dispatch was attempted', async () => {
    const mockSendEmail = jest.fn().mockRejectedValue(new Error('token revoked'));
    mockGetEmailProvider.mockReturnValue({ sendEmail: mockSendEmail });
    const capped: CrmSender = { ...gmailSender, dailyLimit: 10 };

    await expect(
      sendAsSender('u1', capped, { to: 'a@b.com', subject: 's', html: 'h' }),
    ).rejects.toThrow('token revoked');
    expect(mockReserveSend).toHaveBeenCalledWith('u1', 's2', 10);
    expect(mockReleaseSend).not.toHaveBeenCalled();
  });

  it('applies the same cap reserve/no-release-on-success to a mailbox (Gmail) sender', async () => {
    const mockSendEmail = jest.fn().mockResolvedValue({ messageId: 'gm-1', threadId: '' });
    mockGetEmailProvider.mockReturnValue({ sendEmail: mockSendEmail });
    const capped: CrmSender = { ...gmailSender, dailyLimit: 10 };

    await sendAsSender('u1', capped, { to: 'a@b.com', subject: 's', html: 'h' });

    expect(mockReserveSend).toHaveBeenCalledWith('u1', 's2', 10);
    expect(mockReleaseSend).not.toHaveBeenCalled();
  });

  it('never reserves quota when bootstrapEmailProviders/getEmailProvider fails for a mailbox sender (pre-flight, not dispatch)', async () => {
    mockBootstrapEmailProviders.mockRejectedValue(new Error('provider registry init failed'));
    const capped: CrmSender = { ...gmailSender, dailyLimit: 10 };

    await expect(
      sendAsSender('u1', capped, { to: 'a@b.com', subject: 's', html: 'h' }),
    ).rejects.toThrow('provider registry init failed');
    expect(mockReserveSend).not.toHaveBeenCalled();
  });

  it('never reserves quota for a pre-flight validation failure (bcc on Resend, missing connectedAccountId)', async () => {
    const cappedResend: CrmSender = { ...resendSender, dailyLimit: 25 };
    await expect(
      sendAsSender('u1', cappedResend, { to: 'a@b.com', subject: 's', html: 'h', bcc: 'x@y.com' }),
    ).rejects.toThrow(SenderSendError);

    const cappedBrokenGmail: CrmSender = { ...gmailSender, dailyLimit: 10, connectedAccountId: undefined };
    await expect(
      sendAsSender('u1', cappedBrokenGmail, { to: 'a@b.com', subject: 's', html: 'h' }),
    ).rejects.toThrow(SenderSendError);

    expect(mockReserveSend).not.toHaveBeenCalled();
    expect(mockReleaseSend).not.toHaveBeenCalled();
  });

  it('a warming-up sender is checked against its ramped limit, not its eventual dailyLimit', async () => {
    mockResendSendEmail.mockResolvedValue({ id: 'resend-msg' });
    const warmingUp: CrmSender = { ...resendSender, dailyLimit: 200, warmupStartedAt: new Date().toISOString() };

    await sendAsSender('u1', warmingUp, { to: 'a@b.com', subject: 's', html: 'h' });

    // Day 1 of warmup caps at 10 (see senderUsageTracker.effectiveDailyLimit), not 200.
    expect(mockReserveSend).toHaveBeenCalledWith('u1', 's1', 10);
  });
});
