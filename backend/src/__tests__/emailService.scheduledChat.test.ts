import { emailService } from '../services/emailService';
import { chatbotDb } from '../services/chatbotService';
import { userDb } from '../services/db';

// Mock chatbotService used inside sendScheduledChatResultEmail to avoid side effects.
// getChatSession is read by the recipient-authorization guard (ENG-500); default it
// to undefined so the guard classifies the report as non-sensitive (no-op) unless a
// test overrides it.
jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    updateSessionInteractiveShareMetadata: jest.fn().mockResolvedValue(undefined),
    getChatSession: jest.fn().mockResolvedValue(undefined),
    // best-effort-counter fallback: the guard cross-checks tool-call messages
    // when calledFunctions looks clean. Default to none (non-sensitive).
    getMessagesFromMessagesTable: jest.fn().mockResolvedValue([]),
    createOrReuseInteractiveShare: jest.fn().mockResolvedValue('https://app/share'),
  },
}));

// The guard resolves per-recipient admin status + the owner via userDb.
jest.mock('../services/db', () => ({
  userDb: { getUserByEmail: jest.fn(), getUserById: jest.fn() },
}));

// Shared result fixture for the guard tests (module scope so it is visible
// regardless of which describe block the guard tests live in).
const GUARD_BASE_RESULT = {
  passed: true,
  actualResponse: 'Hello world',
  keywordMatches: [] as string[],
  keywordMisses: [] as string[],
  functionCallMatches: [] as string[],
  functionCallMisses: [] as string[],
  executionTime: 1234,
  sessionId: 'session-abc',
  attempt: 1,
  createdAt: new Date().toISOString(),
};

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

  // Greptile P1/security ("Notification HTML remains unescaped"): scheduleName
  // and question were interpolated into the email HTML raw. A schedule name or
  // a model-generated question containing HTML/script markup would render
  // unescaped in the recipient's inbox — altering layout, injecting misleading
  // links, or hiding the real question and CTA.
  it('escapes HTML in scheduleName and question so markup cannot alter the email or inject links', async () => {
    const spy = jest.spyOn(emailService, 'sendEmail').mockResolvedValue();

    await emailService.sendScheduledChatPausedForInputEmail(
      'owner@example.com',
      '<script>alert(1)</script>Evil Schedule',
      'schedule-xyz',
      '<a href="https://evil.example">Click here</a> instead of choosing',
      'session-abc-123',
    );

    const [, , , htmlContent] = spy.mock.calls[0];
    expect(htmlContent).not.toContain('<script>');
    expect(htmlContent).not.toContain('<a href="https://evil.example">');
    expect(htmlContent).toContain('&lt;script&gt;');
    expect(htmlContent).toContain('&lt;a href=');
  });

  // ── Recipient-authorization guard (ENG-500), end-to-end through the real send ──
  it('withholds non-admin recipients for a cross-account (sensitive) report and adds a notice', async () => {
    (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({
      sessionId: 'session-abc',
      userId: 'owner-id',
      calledFunctions: { list_all_clients: 1, get_chat_history: 1 },
    });
    (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'owner-id', email: 'owner@example.com', isAdmin: true });
    (userDb.getUserByEmail as jest.Mock).mockImplementation(async (email: string) =>
      email === 'admin@example.com' || email === 'owner@example.com' ? { email, isAdmin: true } : { email, isAdmin: false }
    );
    const spy = jest.spyOn(emailService, 'sendEmail').mockResolvedValue();

    await emailService.sendScheduledChatResultEmail(
      ['admin@example.com', 'nonadmin@example.com'],
      'Daily User Activity Report',
      GUARD_BASE_RESULT,
      'schedule-123'
    );

    expect(spy).toHaveBeenCalledTimes(1);
    const [recipients, , textContent, htmlContent] = spy.mock.calls[0];
    // non-admin withheld; admin kept; owner added (custodian + gets the notice)
    expect(recipients).toContain('admin@example.com');
    expect(recipients).toContain('owner@example.com');
    expect(recipients).not.toContain('nonadmin@example.com');
    // the withholding notice is injected into the delivered body
    expect(htmlContent).toContain('withheld');
    expect(htmlContent).toContain('nonadmin@example.com');
    expect(textContent).toContain('withheld');
  });

  it('HTML-escapes withheld addresses in the notice so a crafted recipient cannot inject markup', async () => {
    (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({
      sessionId: 'session-abc',
      userId: 'owner-id',
      calledFunctions: { list_all_clients: 1 },
    });
    (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'owner-id', email: 'owner@example.com', isAdmin: true });
    (userDb.getUserByEmail as jest.Mock).mockImplementation(async (email: string) =>
      email === 'owner@example.com' ? { email, isAdmin: true } : { email, isAdmin: false }
    );
    const spy = jest.spyOn(emailService, 'sendEmail').mockResolvedValue();

    await emailService.sendScheduledChatResultEmail(
      ['<img src=x onerror=alert(1)>@evil.com'],
      'Daily User Activity Report',
      GUARD_BASE_RESULT,
      'schedule-123'
    );

    const [, , , htmlContent] = spy.mock.calls[0];
    expect(htmlContent).not.toContain('<img src=x onerror=alert(1)>');
    expect(htmlContent).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('still restricts when the counter is clean but the tool-call MESSAGES show a cross-account tool (swallowed-counter fail-open closed)', async () => {
    // calledFunctions missed list_all_clients (its counter write was swallowed),
    // but the authoritative tool-call message records prove it ran.
    (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({
      sessionId: 'session-abc',
      userId: 'owner-id',
      calledFunctions: { search_tool_response: 1 }, // no cross-account tool recorded
    });
    (chatbotDb.getMessagesFromMessagesTable as jest.Mock).mockResolvedValue([
      { role: 'assistant', tool_calls: [{ type: 'function', function: { name: 'list_all_clients', arguments: '{}' } }] },
      { role: 'tool', name: 'list_all_clients', content: '...' },
    ]);
    (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'owner-id', email: 'owner@example.com', isAdmin: true });
    (userDb.getUserByEmail as jest.Mock).mockImplementation(async (email: string) =>
      email === 'owner@example.com' ? { email, isAdmin: true } : { email, isAdmin: false }
    );
    const spy = jest.spyOn(emailService, 'sendEmail').mockResolvedValue();

    await emailService.sendScheduledChatResultEmail(
      ['nonadmin@example.com'],
      'Daily User Activity Report',
      GUARD_BASE_RESULT,
      'schedule-123'
    );

    expect(spy).toHaveBeenCalledTimes(1);
    const [recipients] = spy.mock.calls[0];
    // non-admin withheld, fell back to owner-only
    expect(recipients).toEqual(['owner@example.com']);
    expect(recipients).not.toContain('nonadmin@example.com');
  });

  it('leaves recipients unchanged and does no lookups for an ordinary (non-sensitive) report', async () => {
    (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({
      sessionId: 'session-abc',
      userId: 'owner-id',
      calledFunctions: { install_skills: 1 },
    });
    // counter clean AND no cross-account tool in the messages → genuinely non-sensitive
    (chatbotDb.getMessagesFromMessagesTable as jest.Mock).mockResolvedValue([
      { role: 'assistant', tool_calls: [{ function: { name: 'install_skills' } }] },
    ]);
    const spy = jest.spyOn(emailService, 'sendEmail').mockResolvedValue();

    await emailService.sendScheduledChatResultEmail(
      ['a@example.com', 'b@example.com'],
      'Weekly Digest',
      GUARD_BASE_RESULT,
      'schedule-123'
    );

    expect(spy).toHaveBeenCalledTimes(1);
    const [recipients] = spy.mock.calls[0];
    expect(recipients).toEqual(['a@example.com', 'b@example.com']);
    expect(userDb.getUserByEmail).not.toHaveBeenCalled();
  });
});


