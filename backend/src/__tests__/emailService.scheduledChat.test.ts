import { emailService } from '../services/emailService';
import { chatbotDb } from '../services/chatbotService';
import { scheduleDb, userDb } from '../services/db';
import { __resetAgentModeAlertDedupeForTests } from '../utils/agentModeAlerts';

// Mock chatbotService used inside sendScheduledChatResultEmail to avoid side effects.
// getChatSession is read by the recipient-authorization guard (ENG-500); default it
// to undefined so the guard classifies the report as non-sensitive (no-op) unless a
// test overrides it.
jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    updateSessionInteractiveShareMetadata: jest.fn().mockResolvedValue(undefined),
    // Default to a PRESENT session with a clean tool record so the guard can
    // positively verify the report is ordinary (fail-closed default treats an
    // absent session as sensitive). Individual tests override for sensitive cases.
    getChatSession: jest.fn().mockResolvedValue({ sessionId: 'session-abc', userId: 'owner-id', calledFunctions: {} }),
    getMessagesFromMessagesTable: jest.fn().mockResolvedValue([]),
    createOrReuseInteractiveShare: jest.fn().mockResolvedValue('https://app/share'),
  },
}));

// The guard resolves per-recipient admin status + the owner via userDb.
jest.mock('../services/db', () => ({
  userDb: { getUserByEmail: jest.fn(), getUserById: jest.fn() },
  scheduleDb: { getScheduleById: jest.fn(), appendDeliveryLogEntry: jest.fn().mockResolvedValue(undefined) },
}));

// The withheld-report oncall alert is deduped per schedule for 24h (ENG-1552), and
// several tests below reuse 'schedule-123' — start every test with a clean window.
beforeEach(() => __resetAgentModeAlertDedupeForTests());

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

  // CodeRabbit (PR #2383, pre-existing gap surfaced by this PR's own edits to
  // the surrounding lines): scheduleName was interpolated raw into the HTML
  // body/header — a schedule name containing markup renders unescaped in the
  // recipient's email client. sendScheduleSourcingBlockTransitionEmail (added
  // in the same PR) already escapes it; this brings the sibling function in
  // line with that pattern.
  it('HTML-escapes the schedule name so markup cannot alter the email or inject links', async () => {
    const spy = jest.spyOn(emailService, 'sendEmail').mockResolvedValue();

    await emailService.sendScheduledChatResultEmail(
      'test@example.com',
      '<script>alert(1)</script>Evil Schedule',
      baseResult,
      'schedule-123'
    );

    const [, , , htmlContent] = spy.mock.calls[0];
    expect(htmlContent).not.toContain('<script>alert(1)</script>');
    expect(htmlContent).toContain('&lt;script&gt;');
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

  // ENG-668: a pay-as-you-go account is past its plan pool by design, so "N% of your monthly allowance"
  // is not what stopped it (and can read far above 100%). The email names the PAYG reason instead.
  it.each([
    [{ reason: 'payg_cap_reached' }, "You've reached your extra usage limit", 'Raise your extra usage limit or upgrade your plan'],
    [{ reason: 'payg_suspended', paygSuspendedReason: 'payment_failed' }, 'Extra usage is on hold', 'Pay the open invoice to resume extra usage.'],
    [{ reason: 'payg_suspended', paygSuspendedReason: 'dispute' }, 'Extra usage is on hold', 'Please contact us to resume extra usage.'],
    [{ reason: 'payg_inactive', paygInactiveReason: 'no_payment_method' }, 'Extra usage needs a payment method', 'Add a payment method to keep working with extra usage.'],
    [{ reason: 'payg_inactive', paygInactiveReason: 'subscription_inactive' }, 'Extra usage needs an active subscription', 'Reactivate your subscription to keep working with extra usage.'],
  ] as const)('names the PAYG reason (%j), its own action, and no plan percentage', async (paygBlock, headline, action) => {
    const spy = jest.spyOn(emailService, 'sendEmail').mockResolvedValue();

    await emailService.sendScheduledChatTokenLimitEmail('user@example.com', 'My Schedule', 'schedule-123', {
      used: 0,
      allowance: null,
      effectiveAllowance: null,
      percentUsed: 0,
      costUsed: 180,
      costAllowance: 100,
      costPercentUsed: 180,
      costEnforced: true,
      month: '2026-10',
      paygBlock,
    });

    const [, subject, textContent, htmlContent] = spy.mock.calls[0];
    expect(subject).toContain(headline);
    expect(htmlContent).toContain(headline);
    expect(textContent).toMatch(/extra usage/i);
    expect(textContent).not.toMatch(/pay[- ]as[- ]you[- ]go|payg/i);
    for (const body of [textContent, htmlContent]) {
      expect(body).toContain(action);
      expect(body).toContain('cannot execute because AI usage is paused');
      expect(body).not.toContain('monthly usage limit');
      expect(body).not.toContain('wait for your allowance to reset');
      expect(body).not.toContain('180%');
      expect(body).not.toContain('of your monthly allowance used');
      expect(body).not.toContain('$');
      expect(body).toContain('resets on November 1, 2026');
    }
  });

  it('renders a percentage-only message when the token cap is the cause — never the raw token count (ENG-1566)', async () => {
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
    expect(subject).toContain('Monthly Usage Limit Reached');
    expect(htmlContent).toContain('Monthly Usage Limit Reached');
    expect(htmlContent).toContain('105% of your monthly allowance used');
    expect(textContent).toContain('105% of your monthly allowance used');
    // ENG-1566: neither the raw token count nor the "cost"/"token" dimension name
    // may reach the customer — only a percentage of "monthly usage".
    expect(htmlContent).not.toContain('1,050,000');
    expect(htmlContent).not.toContain('spent this month');
    expect(htmlContent).not.toContain('tokens used');
    expect(htmlContent).not.toContain('$');
  });

  it('names the reset DATE, not "the start of each billing period" (ENG-1344)', async () => {
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
        month: '2026-09',
      }
    );

    const [, , textContent, htmlContent] = spy.mock.calls[0];
    for (const body of [textContent, htmlContent]) {
      expect(body).toContain('resets on October 1, 2026');
      // The vague sentence the escalating customer could not decode.
      expect(body).not.toContain('resets at the start of each billing period');
    }
    // ENG-1566 still holds: a date is not a dollar figure.
    expect(htmlContent).not.toContain('$');
  });

  it('renders a percentage-only message when the cost cap is the cause — never the raw dollar spend (ENG-1566)', async () => {
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
    expect(subject).toContain('Monthly Usage Limit Reached');
    expect(htmlContent).toContain('Monthly Usage Limit Reached');
    expect(htmlContent).toContain('106% of your monthly allowance used');
    expect(textContent).toContain('106% of your monthly allowance used');
    // ENG-1566: neither the raw dollar spend/allowance nor the "cost"/"token"
    // dimension name may reach the customer — only a percentage of "monthly usage".
    expect(htmlContent).not.toContain('$');
    expect(textContent).not.toContain('$');
    expect(htmlContent).not.toContain('spent this month');
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

  it('does NOT silently drop: notifies the owner when a sensitive report has no authorized recipients', async () => {
    (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({
      sessionId: 'session-abc',
      userId: 'owner-id',
      calledFunctions: { list_all_clients: 1 },
    });
    // owner is NOT an admin and neither is the configured recipient → nobody authorized
    (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'owner-id', email: 'owner@example.com', isAdmin: false });
    (userDb.getUserByEmail as jest.Mock).mockResolvedValue({ isAdmin: false });
    const spy = jest.spyOn(emailService, 'sendEmail').mockResolvedValue();
    const oncallSpy = jest.spyOn(emailService, 'sendOncallAlert').mockResolvedValue(undefined);

    await emailService.sendScheduledChatResultEmail(
      ['nonadmin@example.com'],
      'Daily User Activity Report',
      GUARD_BASE_RESULT,
      'schedule-123'
    );

    // durable escalation fired (report not lost silently)
    expect(oncallSpy).toHaveBeenCalledTimes(1);
    // exactly one send: the delivery-blocked STATUS notice to the owner (not the report)
    expect(spy).toHaveBeenCalledTimes(1);
    const [recipients, subject, , htmlContent] = spy.mock.calls[0];
    expect(recipients).toEqual(['owner@example.com']);
    expect(subject).toContain('not delivered');
    expect(htmlContent).not.toContain('<html>'); // the report body is NOT included
  });

  it('fails closed (restricts) when the session cannot be found — cannot verify ordinary', async () => {
    (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(undefined); // missing session
    (userDb.getUserById as jest.Mock).mockResolvedValue(undefined); // owner unknown
    (userDb.getUserByEmail as jest.Mock).mockResolvedValue({ isAdmin: false });
    const spy = jest.spyOn(emailService, 'sendEmail').mockResolvedValue();
    const oncallSpy = jest.spyOn(emailService, 'sendOncallAlert').mockResolvedValue(undefined);

    await emailService.sendScheduledChatResultEmail(
      ['nonadmin@example.com'],
      'Some Report',
      GUARD_BASE_RESULT,
      'schedule-123'
    );

    // unverifiable → treated sensitive → non-admin withheld → nobody authorized →
    // no report broadcast, durable oncall escalation instead
    expect(oncallSpy).toHaveBeenCalledTimes(1);
    const reportSends = spy.mock.calls.filter(c => Array.isArray(c[0]) && c[0].includes('nonadmin@example.com'));
    expect(reportSends).toHaveLength(0);
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

  // ENG-2785: a customer (non-admin) owner's Meta Ads report only reads their own
  // account, so it must reach their recipients instead of being withheld.
  it('ENG-2785: delivers a non-admin owner Meta Ads report to configured recipients', async () => {
    (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({
      sessionId: 'session-abc',
      userId: 'owner-id',
      calledFunctions: { list_meta_ads_campaigns: 1, get_meta_ads_metrics: 1, call_meta_ads_insights_api: 1 },
    });
    (chatbotDb.getMessagesFromMessagesTable as jest.Mock).mockResolvedValue([
      { role: 'tool', name: 'get_meta_ads_metrics', content: '...' },
    ]);
    (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'owner-id', email: 'sary@customer.com', isAdmin: false });
    (userDb.getUserByEmail as jest.Mock).mockResolvedValue({ isAdmin: false });
    const spy = jest.spyOn(emailService, 'sendEmail').mockResolvedValue();

    await emailService.sendScheduledChatResultEmail(['sary@customer.com'], 'Social Monitor', GUARD_BASE_RESULT, 'schedule-123');

    expect(spy).toHaveBeenCalledTimes(1);
    const [recipients, , textContent] = spy.mock.calls[0];
    expect(recipients).toEqual(['sary@customer.com']);
    expect(textContent).not.toContain('withheld');
  });

  it('ENG-2785 negative: an ADMIN owner Meta Ads report is still restricted to admins', async () => {
    (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({
      sessionId: 'session-abc',
      userId: 'owner-id',
      calledFunctions: { get_meta_ads_metrics: 1 },
    });
    (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'owner-id', email: 'owner@example.com', isAdmin: true });
    (userDb.getUserByEmail as jest.Mock).mockImplementation(async (email: string) =>
      email === 'owner@example.com' ? { email, isAdmin: true } : { email, isAdmin: false }
    );
    const spy = jest.spyOn(emailService, 'sendEmail').mockResolvedValue();

    await emailService.sendScheduledChatResultEmail(['client@customer.com'], 'Meta Report', GUARD_BASE_RESULT, 'schedule-123');

    const [recipients] = spy.mock.calls[0];
    expect(recipients).not.toContain('client@customer.com');
    expect(recipients).toContain('owner@example.com');
  });
});



describe('emailService.sendScheduledRunFailedEmail (ENG-826 #1)', () => {
  beforeEach(() => jest.clearAllMocks());

  const opts = {
    failedAttempts: 4,
    failureClass: 'system' as const,
  };

  it('sends ONE email to all recipients with a keeps-failing subject', async () => {
    const spy = jest.spyOn(emailService, 'sendEmail').mockResolvedValue();

    await emailService.sendScheduledRunFailedEmail(
      ['ops@example.com', 'lead@example.com'],
      'LinkedIn Post Factory',
      'sched-1',
      opts,
    );

    expect(spy).toHaveBeenCalledTimes(1);
    const [recipients, subject, text, html] = spy.mock.calls[0];
    expect(recipients).toEqual(['ops@example.com', 'lead@example.com']);
    expect(subject).toContain('LinkedIn Post Factory');
    expect(subject.toLowerCase()).toContain('failing');
    // Carries class-specific guidance for the exhausted state (system class here),
    // NOT the per-run "will be retried automatically" copy (which would contradict).
    expect(text.toLowerCase()).toContain('system error');
    expect(text).not.toContain('will be retried automatically');
    expect(html).toContain('4 times in a row');
  });

  it('normalizes a single recipient string to a one-element list', async () => {
    const spy = jest.spyOn(emailService, 'sendEmail').mockResolvedValue();
    await emailService.sendScheduledRunFailedEmail('solo@example.com', 'Daily Digest', 'sched-2', opts);
    expect(spy.mock.calls[0][0]).toEqual(['solo@example.com']);
  });

  it('HTML-escapes the schedule name to prevent injection into the email body', async () => {
    const spy = jest.spyOn(emailService, 'sendEmail').mockResolvedValue();
    await emailService.sendScheduledRunFailedEmail(
      ['x@example.com'],
      'Evil <img src=x onerror=alert(1)> Schedule',
      'sched-4',
      opts,
    );
    const html = spy.mock.calls[0][3];
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');
  });

  it('never throws when the transport fails (best-effort)', async () => {
    jest.spyOn(emailService, 'sendEmail').mockRejectedValue(new Error('SMTP down'));
    await expect(
      emailService.sendScheduledRunFailedEmail(['x@example.com'], 'S', 'sched-5', opts),
    ).resolves.toBeUndefined();
  });
});

// ── ENG-1552: zero-content runs (the xCures / ENG-1504 class) ────────────────
describe('emailService.sendScheduledChatResultEmail — empty report (ENG-1552)', () => {
  // ENG-1552 behavior is customer-visible only with enforcement on (shadow mode otherwise).
  beforeAll(() => { process.env.SCHEDULED_REPORT_DELIVERY_ENFORCEMENT = 'true'; });
  afterAll(() => { delete process.env.SCHEDULED_REPORT_DELIVERY_ENFORCEMENT; });
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each([['empty', ''], ['whitespace-only', '  \n\t ']])(
    'never sends a %s report — to recipients or anyone else; records withheld/empty_content',
    async (_label, body) => {
      const spy = jest.spyOn(emailService, 'sendEmail').mockResolvedValue();

      await emailService.sendScheduledChatResultEmail(
        ['a@example.com', 'b@example.com'],
        'xCures monthly',
        { ...GUARD_BASE_RESULT, passed: false, actualResponse: body, runId: 'run-9' },
        'schedule-123'
      );

      // Nothing goes to the customer during the review period (2026-09-18) — not the
      // empty report, and not a new "not delivered" notice either.
      expect(spy).not.toHaveBeenCalled();
      expect(scheduleDb.appendDeliveryLogEntry).toHaveBeenCalledWith(
        'schedule-123',
        expect.objectContaining({ runId: 'run-9', state: 'withheld', reason: 'empty_content', withheldRecipients: ['a@example.com', 'b@example.com'] }),
        undefined,
      );
      // No share link is minted for a report that does not exist.
      expect(chatbotDb.createOrReuseInteractiveShare).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['sent', [['delivered', undefined]]],
    ['suppressed', [['delivery_attempted', 'suppressed_nonprod']]],
    ['failed', [['delivery_attempted', 'provider_error']]],
  ])('a %s send records exactly the delivery states it earned', async (outcome, expected) => {
    (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({ sessionId: 'session-abc', userId: 'owner-id', calledFunctions: {} });
    (chatbotDb.getMessagesFromMessagesTable as jest.Mock).mockResolvedValue([]);
    jest.spyOn(emailService, 'sendEmail').mockResolvedValue(outcome as any);

    await emailService.sendScheduledChatResultEmail(['a@example.com'], 'Weekly', { ...GUARD_BASE_RESULT, runId: 'run-5' }, 'schedule-123');

    const states = (scheduleDb.appendDeliveryLogEntry as jest.Mock).mock.calls.map((c) => [c[1].state, c[1].reason]);
    expect(states).toEqual(expected);
    expect((scheduleDb.appendDeliveryLogEntry as jest.Mock).mock.calls.every((c) => c[1].runId === 'run-5')).toBe(true);
  });

  it('records withheld/no_authorized_recipients when the send-time guard leaves nobody', async () => {
    (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({ sessionId: 'session-abc', userId: 'owner-id', calledFunctions: { list_all_clients: 1 } });
    (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'owner-id', email: 'owner@example.com', isAdmin: false });
    (userDb.getUserByEmail as jest.Mock).mockResolvedValue({ isAdmin: false });
    jest.spyOn(emailService, 'sendEmail').mockResolvedValue();
    jest.spyOn(emailService, 'sendOncallAlert').mockResolvedValue(undefined);

    await emailService.sendScheduledChatResultEmail(['nonadmin@example.com'], 'Report', { ...GUARD_BASE_RESULT, runId: 'run-7' }, 'schedule-123');

    expect(scheduleDb.appendDeliveryLogEntry).toHaveBeenCalledWith(
      'schedule-123',
      expect.objectContaining({ runId: 'run-7', state: 'withheld', reason: 'no_authorized_recipients', missingPermission: 'isAdmin' }),
      undefined,
    );
  });
});

describe('ENG-1552 shadow mode — empty report is sent exactly as before (enforcement unset)', () => {
  beforeEach(() => { jest.clearAllMocks(); delete process.env.SCHEDULED_REPORT_DELIVERY_ENFORCEMENT; });

  it('still emails the recipients, and records the send internally', async () => {
    (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({ sessionId: 'session-abc', userId: 'owner-id', calledFunctions: {} });
    (chatbotDb.getMessagesFromMessagesTable as jest.Mock).mockResolvedValue([]);
    const spy = jest.spyOn(emailService, 'sendEmail').mockResolvedValue('sent' as any);

    await emailService.sendScheduledChatResultEmail(['a@example.com'], 'xCures monthly', { ...GUARD_BASE_RESULT, actualResponse: '', runId: 'run-e' }, 'schedule-123');

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toEqual(['a@example.com']);
    const states = (scheduleDb.appendDeliveryLogEntry as jest.Mock).mock.calls.map((c) => c[1].state);
    expect(states).toEqual(['delivered']);
  });
});

describe('ENG-1552 manual resend is never recorded as a delivery', () => {
  beforeEach(() => { jest.clearAllMocks(); process.env.SCHEDULED_REPORT_DELIVERY_ENFORCEMENT = 'true'; });
  afterEach(() => { delete process.env.SCHEDULED_REPORT_DELIVERY_ENFORCEMENT; });

  it.each([['a report with content', 'Report body'], ['an empty report', '']])('%s: records nothing', async (_l, body) => {
    (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({ sessionId: 'session-abc', userId: 'owner-id', calledFunctions: {} });
    (chatbotDb.getMessagesFromMessagesTable as jest.Mock).mockResolvedValue([]);
    jest.spyOn(emailService, 'sendEmail').mockResolvedValue('sent' as any);

    await emailService.sendScheduledChatResultEmail(['me@example.com'], 'Weekly', { ...GUARD_BASE_RESULT, actualResponse: body, runId: 'run-5' }, 'schedule-123', undefined, { recordDelivery: false });

    expect(scheduleDb.appendDeliveryLogEntry).not.toHaveBeenCalled();
  });
});

