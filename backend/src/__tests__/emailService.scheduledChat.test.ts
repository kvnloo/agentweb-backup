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

describe('emailService.sendScheduledChatTokenLimitEmail', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders a token-based message and subject when the token cap is the cause', async () => {
    const spy = jest.spyOn(emailService, 'sendEmail').mockResolvedValue();

    await emailService.sendScheduledChatTokenLimitEmail(
      'user@example.com',
      'My Schedule',
      'schedule-123',
      {
        used: 1050000,
        allowance: 1000000,
        effectiveAllowance: 1000000,
        percentUsed: 105,
        costUsed: 0,
        costAllowance: null,
        costPercentUsed: 0,
      }
    );

    expect(spy).toHaveBeenCalledTimes(1);
    const [, subject, textContent, htmlContent] = spy.mock.calls[0];
    expect(subject).toContain('Monthly Token Limit Reached');
    expect(htmlContent).toContain('Monthly Token Limit Reached');
    expect(htmlContent).toContain('1,050,000 / 1,000,000 tokens used this month');
    expect(textContent).toContain('1,050,000 / 1,000,000 tokens used this month');
    expect(htmlContent).not.toContain('spent this month');
  });

  it('renders a cost-based message when the cost cap is the cause and token allowance is unlimited', async () => {
    const spy = jest.spyOn(emailService, 'sendEmail').mockResolvedValue();

    await emailService.sendScheduledChatTokenLimitEmail(
      'user@example.com',
      'My Schedule',
      'schedule-123',
      {
        used: 5000000,
        allowance: null,
        effectiveAllowance: null,
        percentUsed: 0,
        costUsed: 42.5,
        costAllowance: 40,
        costPercentUsed: 106,
      }
    );

    expect(spy).toHaveBeenCalledTimes(1);
    const [, subject, textContent, htmlContent] = spy.mock.calls[0];
    expect(subject).toContain('Monthly Cost Limit Reached');
    expect(htmlContent).toContain('Monthly Cost Limit Reached');
    expect(htmlContent).toContain('$42.50 / $40.00 spent this month');
    expect(textContent).toContain('$42.50 / $40.00 spent this month');
    // Must not misleadingly show "N/A tokens" when tokens are unlimited
    expect(htmlContent).not.toContain('N/A tokens');
  });
});

describe('emailService.sendScheduledChatPausedForInputEmail (ENG-396)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('deep-links to the session via the PATH form the portal actually reads (not ?sessionId=)', async () => {
    const spy = jest.spyOn(emailService, 'sendEmail').mockResolvedValue();

    await emailService.sendScheduledChatPausedForInputEmail(
      'owner@example.com',
      'RankAI Meta Ads',
      'schedule-xyz',
      'Which Meta campaign objective? It cannot be changed after launch.',
      'session-abc-123'
    );

    expect(spy).toHaveBeenCalledTimes(1);
    const [, subject, textContent, htmlContent] = spy.mock.calls[0];
    expect(subject).toContain('Emma needs your input');
    // The portal (AgentMode.tsx) reads sessionId from the route param, so the
    // link MUST be /agent-mode/<sessionId>. The old ?sessionId= query form opened
    // a blank chat — the "Open chat to decide" button dead-ended.
    expect(htmlContent).toContain('/agent-mode/session-abc-123');
    expect(textContent).toContain('/agent-mode/session-abc-123');
    expect(htmlContent).not.toContain('?sessionId=');
    // The question the user must answer is shown.
    expect(htmlContent).toContain('Which Meta campaign objective?');
  });

  it('falls back to the bare /agent-mode link when no sessionId is available', async () => {
    const spy = jest.spyOn(emailService, 'sendEmail').mockResolvedValue();

    await emailService.sendScheduledChatPausedForInputEmail(
      'owner@example.com',
      'RankAI Meta Ads',
      'schedule-xyz',
      'Which objective?'
    );

    expect(spy).toHaveBeenCalledTimes(1);
    const [, , , htmlContent] = spy.mock.calls[0];
    expect(htmlContent).toContain('/agent-mode');
    expect(htmlContent).not.toContain('/agent-mode/');
    expect(htmlContent).not.toContain('?sessionId=');
  });
});


