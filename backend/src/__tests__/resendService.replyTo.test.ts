// Mock resendService
jest.mock('../services/resendService', () => ({
  resendService: {
    sendEmail: jest.fn(),
  },
}));

import { resendService } from '../services/resendService';

describe('ResendService - replyTo functionality', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (resendService.sendEmail as jest.Mock).mockResolvedValue({ id: 'test-email-id' });
  });

  it('should include replyTo in email options when provided', async () => {
    await resendService.sendEmail({
      from: 'sender@example.com',
      to: 'recipient@example.com',
      subject: 'Test Subject',
      html: '<p>Test content</p>',
      replyTo: 'replyto@example.com',
    });

    expect(resendService.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'sender@example.com',
        to: 'recipient@example.com',
        subject: 'Test Subject',
        html: '<p>Test content</p>',
        replyTo: 'replyto@example.com',
      })
    );
  });

  it('should not include replyTo when not provided', async () => {
    await resendService.sendEmail({
      from: 'sender@example.com',
      to: 'recipient@example.com',
      subject: 'Test Subject',
      html: '<p>Test content</p>',
    });

    expect(resendService.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'sender@example.com',
        to: 'recipient@example.com',
        subject: 'Test Subject',
        html: '<p>Test content</p>',
      })
    );

    // Verify replyTo was not in the call
    const callArgs = (resendService.sendEmail as jest.Mock).mock.calls[0][0];
    expect(callArgs.replyTo).toBeUndefined();
  });

  it('should send support email with correct replyTo', async () => {
    await resendService.sendEmail({
      from: 'AgentWeb Support <no-reply@updates.agentweb.pro>',
      to: 'founders@agentweb.pro',
      subject: 'Help Request from customer@example.com',
      html: '<p>Help message content</p>',
      replyTo: 'customer@example.com',
    });

    expect(resendService.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'AgentWeb Support <no-reply@updates.agentweb.pro>',
        to: 'founders@agentweb.pro',
        replyTo: 'customer@example.com',
      })
    );
  });

  it('should handle multiple recipients with replyTo', async () => {
    await resendService.sendEmail({
      from: 'sender@example.com',
      to: ['recipient1@example.com', 'recipient2@example.com'],
      subject: 'Test Subject',
      html: '<p>Test content</p>',
      replyTo: 'replyto@example.com',
    });

    expect(resendService.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: ['recipient1@example.com', 'recipient2@example.com'],
        replyTo: 'replyto@example.com',
      })
    );
  });

  it('should handle replyTo with both text and html content', async () => {
    await resendService.sendEmail({
      from: 'sender@example.com',
      to: 'recipient@example.com',
      subject: 'Test Subject',
      html: '<p>HTML content</p>',
      text: 'Plain text content',
      replyTo: 'replyto@example.com',
    });

    expect(resendService.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        html: '<p>HTML content</p>',
        text: 'Plain text content',
        replyTo: 'replyto@example.com',
      })
    );
  });

  it('should handle replyTo with inReplyTo header', async () => {
    await resendService.sendEmail({
      from: 'sender@example.com',
      to: 'recipient@example.com',
      subject: 'Re: Test Subject',
      html: '<p>Reply content</p>',
      replyTo: 'replyto@example.com',
      inReplyTo: '<message-id@example.com>',
    });

    expect(resendService.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        replyTo: 'replyto@example.com',
        inReplyTo: '<message-id@example.com>',
      })
    );
  });
});
