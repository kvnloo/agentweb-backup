import { resendService } from '../services/resendService';

// Mock Resend SDK
const mockSend = jest.fn();
jest.mock('resend', () => {
  return {
    Resend: jest.fn().mockImplementation(() => ({
      emails: {
        send: mockSend,
      },
    })),
  };
});

// Mock AWS Secrets Manager
jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn().mockImplementation(() => ({})),
  GetSecretValueCommand: jest.fn(),
}));

describe('ResendService - replyTo functionality', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSend.mockResolvedValue({ data: { id: 'test-email-id' }, error: null });
  });

  it('should include replyTo in email options when provided', async () => {
    await resendService.sendEmail({
      from: 'sender@example.com',
      to: 'recipient@example.com',
      subject: 'Test Subject',
      html: '<p>Test content</p>',
      replyTo: 'replyto@example.com',
    });

    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'sender@example.com',
        to: ['recipient@example.com'],
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

    const callArgs = mockSend.mock.calls[0][0];
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

    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'AgentWeb Support <no-reply@updates.agentweb.pro>',
        to: ['founders@agentweb.pro'],
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

    expect(mockSend).toHaveBeenCalledWith(
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

    expect(mockSend).toHaveBeenCalledWith(
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

    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        replyTo: 'replyto@example.com',
        headers: {
          'In-Reply-To': '<message-id@example.com>',
        },
      })
    );
  });
});
