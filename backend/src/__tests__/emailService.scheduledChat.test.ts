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

  it('includes function call details in HTML email when provided', async () => {
    const resultWithFunctionDetails = {
      ...baseResult,
      functionCallDetails: {
        'get_marketing_tips': { actual: 2, required: 2 },
        'analyze_competitors': { actual: 1, required: 1 }
      }
    };

    const spy = jest.spyOn(emailService, 'sendEmail').mockResolvedValue();

    await emailService.sendScheduledChatResultEmail(
      'test@example.com',
      'My Schedule',
      resultWithFunctionDetails,
      'schedule-123'
    );

    expect(spy).toHaveBeenCalledTimes(1);
    
    // Check that HTML contains function call details section
    const [, , , htmlContent] = spy.mock.calls[0];
    expect(htmlContent).toContain('Function Call Details');
    expect(htmlContent).toContain('get_marketing_tips');
    expect(htmlContent).toContain('2/2 calls');
    expect(htmlContent).toContain('analyze_competitors');
    expect(htmlContent).toContain('1/1 calls');
    expect(htmlContent).toContain('✅'); // Success indicator
  });

  it('includes function call details in text email when provided', async () => {
    const resultWithFunctionDetails = {
      ...baseResult,
      functionCallDetails: {
        'get_marketing_tips': { actual: 1, required: 2 },
        'analyze_competitors': { actual: 0, required: 1 }
      }
    };

    const spy = jest.spyOn(emailService, 'sendEmail').mockResolvedValue();

    await emailService.sendScheduledChatResultEmail(
      'test@example.com',
      'My Schedule',
      resultWithFunctionDetails,
      'schedule-123'
    );

    expect(spy).toHaveBeenCalledTimes(1);
    
    // Check that text content contains function call details
    const [, , textContent] = spy.mock.calls[0];
    expect(textContent).toContain('Function Call Details:');
    expect(textContent).toContain('- get_marketing_tips: 1/2 calls ❌');
    expect(textContent).toContain('- analyze_competitors: 0/1 calls ❌');
  });

  it('does not include function call details section when not provided', async () => {
    const spy = jest.spyOn(emailService, 'sendEmail').mockResolvedValue();

    await emailService.sendScheduledChatResultEmail(
      'test@example.com',
      'My Schedule',
      baseResult,
      'schedule-123'
    );

    expect(spy).toHaveBeenCalledTimes(1);
    
    // Check that HTML does not contain function call details section
    const [, , , htmlContent] = spy.mock.calls[0];
    expect(htmlContent).not.toContain('Function Call Details');
    expect(htmlContent).not.toContain('🔧');
  });

  it('shows correct success/failure indicators for function calls', async () => {
    const resultWithMixedFunctionDetails = {
      ...baseResult,
      functionCallDetails: {
        'get_marketing_tips': { actual: 3, required: 2 }, // Success
        'analyze_competitors': { actual: 0, required: 1 }  // Failure
      }
    };

    const spy = jest.spyOn(emailService, 'sendEmail').mockResolvedValue();

    await emailService.sendScheduledChatResultEmail(
      'test@example.com',
      'My Schedule',
      resultWithMixedFunctionDetails,
      'schedule-123'
    );

    expect(spy).toHaveBeenCalledTimes(1);
    
    // Check HTML content for correct indicators
    const [, , , htmlContent] = spy.mock.calls[0];
    expect(htmlContent).toContain('get_marketing_tips');
    expect(htmlContent).toContain('3/2 calls');
    expect(htmlContent).toContain('✅'); // Success for get_marketing_tips
    
    expect(htmlContent).toContain('analyze_competitors');
    expect(htmlContent).toContain('0/1 calls');
    expect(htmlContent).toContain('❌'); // Failure for analyze_competitors
  });
});


