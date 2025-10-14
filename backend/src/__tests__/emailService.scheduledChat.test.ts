import { emailService } from '../services/emailService';

// Mock chatbotService used inside sendScheduledChatResultEmail to avoid side effects
jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    updateSessionInteractiveShareMetadata: jest.fn().mockResolvedValue(undefined),
  },
}));

describe('emailService.sendScheduledChatResultEmail', () => {
  const baseResult = {
    passed: true,
    actualResponse: 'Hello world',
    keywordMatches: [],
    keywordMisses: [],
    functionCallMatches: [],
    functionCallMisses: [],
    executionTime: 1234,
    sessionId: 'session-abc',
    attempt: 1,
    createdAt: new Date().toISOString(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('sends ONE email with all recipients when multiple emails provided', async () => {
    const recipients = ['a@example.com', 'b@example.com', 'c@example.com'];
    const spy = jest.spyOn(emailService, 'sendEmail').mockResolvedValue();

    await emailService.sendScheduledChatResultEmail(
      recipients,
      'My Schedule',
      baseResult,
      'schedule-123'
    );

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      recipients,
      expect.stringContaining('Scheduled Chat:'),
      expect.any(String),
      expect.stringContaining('<html>')
    );
  });

  it('normalizes single recipient to array and sends ONE email', async () => {
    const recipient = 'solo@example.com';
    const spy = jest.spyOn(emailService, 'sendEmail').mockResolvedValue();

    await emailService.sendScheduledChatResultEmail(
      recipient,
      'My Schedule',
      baseResult,
      'schedule-123'
    );

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      [recipient],
      expect.stringContaining('Scheduled Chat:'),
      expect.any(String),
      expect.stringContaining('<html>')
    );
  });
});


