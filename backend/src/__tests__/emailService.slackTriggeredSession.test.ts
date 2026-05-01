import { emailService } from '../services/emailService';

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    createOrReuseInteractiveShare: jest.fn().mockResolvedValue('https://share.example.com/session-123'),
  },
}));

const baseParams = {
  sessionId: 'session-123',
  userEmail: 'client@example.com',
  channelName: 'general',
  originalMessage: 'Hello, I have a question.',
  emmaResponse: 'Hi! Happy to help.',
  receivedAt: new Date('2026-05-01T10:00:00Z').toISOString(),
};

describe('emailService.sendSlackTriggeredSessionEmail', () => {
  let spy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    spy = jest.spyOn(emailService, 'sendEmail').mockResolvedValue();
  });

  // FAIL tests

  it('sends email even when senderDisplayName is missing (undefined)', async () => {
    await emailService.sendSlackTriggeredSessionEmail('founders@agentweb.pro', {
      ...baseParams,
      senderDisplayName: undefined,
    });

    expect(spy).toHaveBeenCalledTimes(1);
    const [, , textBody, htmlBody] = spy.mock.calls[0];
    expect(htmlBody).toContain('Original Message from Unknown');
    expect(textBody).toContain('Original Message from Unknown:');
  });

  it('does not include senderDisplayName in subject when missing — falls back to userEmail', async () => {
    await emailService.sendSlackTriggeredSessionEmail('founders@agentweb.pro', {
      ...baseParams,
      senderDisplayName: undefined,
    });

    const [, subject] = spy.mock.calls[0];
    expect(subject).toContain('client@example.com');
    expect(subject).not.toContain('undefined');
  });

  it('escapes HTML special chars in senderDisplayName', async () => {
    await emailService.sendSlackTriggeredSessionEmail('founders@agentweb.pro', {
      ...baseParams,
      senderDisplayName: '<script>alert("xss")</script>',
    });

    const [, , , htmlBody] = spy.mock.calls[0];
    expect(htmlBody).not.toContain('<script>');
    expect(htmlBody).toContain('&lt;script&gt;');
  });

  // SUCCESS tests

  it('includes senderDisplayName in the HTML section title', async () => {
    await emailService.sendSlackTriggeredSessionEmail('founders@agentweb.pro', {
      ...baseParams,
      senderDisplayName: 'John Smith',
    });

    expect(spy).toHaveBeenCalledTimes(1);
    const [, , , htmlBody] = spy.mock.calls[0];
    expect(htmlBody).toContain('Original Message from John Smith');
  });

  it('includes senderDisplayName in the plain text section header', async () => {
    await emailService.sendSlackTriggeredSessionEmail('founders@agentweb.pro', {
      ...baseParams,
      senderDisplayName: 'John Smith',
    });

    const [, , textBody] = spy.mock.calls[0];
    expect(textBody).toContain('Original Message from John Smith:');
  });

  it('includes senderDisplayName in the email subject line', async () => {
    await emailService.sendSlackTriggeredSessionEmail('founders@agentweb.pro', {
      ...baseParams,
      senderDisplayName: 'John Smith',
    });

    const [, subject] = spy.mock.calls[0];
    expect(subject).toContain('John Smith');
    expect(subject).toContain('#general');
  });

  it('still includes client account, channel, and messages in HTML', async () => {
    await emailService.sendSlackTriggeredSessionEmail('founders@agentweb.pro', {
      ...baseParams,
      senderDisplayName: 'John Smith',
    });

    const [, , , htmlBody] = spy.mock.calls[0];
    expect(htmlBody).toContain('client@example.com');
    expect(htmlBody).toContain('#general');
    expect(htmlBody).toContain('Hello, I have a question.');
    expect(htmlBody).toContain('Hi! Happy to help.');
    // No separate "Sent By" tile
    expect(htmlBody).not.toContain('<div class="label">Sent By</div>');
  });
});
