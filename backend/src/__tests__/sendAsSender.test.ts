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

import { sendAsSender, SenderSendError } from '../services/sendAsSender';
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
