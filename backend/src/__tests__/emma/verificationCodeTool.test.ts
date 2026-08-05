const mockGetAccountByPlatform = jest.fn();
const mockListEmails = jest.fn();
const mockSearchEmails = jest.fn();
const mockGetEmails = jest.fn();
const mockResolveEmailAccount = jest.fn();

jest.mock('../../services/connectedAccountsDb', () => ({
  getAccountByPlatform: (...args: any[]) => mockGetAccountByPlatform(...args),
}));

jest.mock('../../services/emailProviderService', () => ({
  bootstrapEmailProviders: jest.fn().mockResolvedValue(undefined),
  getEmailProvider: () => ({
    listEmails: (...args: any[]) => mockListEmails(...args),
    searchEmails: (...args: any[]) => mockSearchEmails(...args),
    getEmails: (...args: any[]) => mockGetEmails(...args),
  }),
  resolveEmailAccount: (...args: any[]) => mockResolveEmailAccount(...args),
  EmailProviderError: class EmailProviderError extends Error {},
}));

import { resolveWaitSeconds, partitionByArrival, senderDomain } from '../../emma/verificationCodeTool';
import { emmaToolRegistry } from '../../emma/registry';

const tool = emmaToolRegistry.getTool('read_verification_code');
if (!tool) throw new Error('read_verification_code tool not registered');

const context = { userId: 'user-123', sessionId: 'session-abc', llmModel: 'test-model', service: {} };

const GMAIL_ACCOUNT = { platform: 'gmail', account_id: 'founders@agentweb.pro', account_name: 'founders@agentweb.pro' };

/** A message summary as the email providers return it. */
function summary(over: Partial<{ id: string; subject: string; from: string; date: string }> = {}) {
  return {
    id: over.id ?? 'msg-1',
    threadId: 't-1',
    subject: over.subject ?? 'Your RankAI Login Code',
    from: over.from ?? 'founders@agentweb.pro',
    // Default fixture: arrived AFTER the tool was invoked, which is the only
    // thing a default call accepts (a pre-call message cannot be told apart
    // from the previous attempt's code).
    date: over.date ?? new Date(Date.now() + 5_000).toISOString(),
    snippet: '',
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetAccountByPlatform.mockImplementation(async (_userId: string, platform: string) =>
    platform === 'gmail' ? GMAIL_ACCOUNT : null
  );
  mockListEmails.mockResolvedValue([]);
  mockSearchEmails.mockResolvedValue([]);
  mockGetEmails.mockResolvedValue([]);
});

// A whole agent-mode turn is capped at AGENT_MODE_GENERATION_TIMEOUT_MS (600s).
// A single tool that can hold hundreds of seconds of that budget is how a turn
// gets killed with completed work still unsaved (ENG-510). Codes arrive in
// seconds, so the ceiling is deliberately well under the turn cap.
describe('read_verification_code — wait window', () => {
  it('defaults to 90 seconds when unspecified', () => {
    expect(resolveWaitSeconds(undefined)).toBe(90);
    expect(resolveWaitSeconds(null)).toBe(90);
    expect(resolveWaitSeconds('not a number')).toBe(90);
  });

  it('caps an over-long request well short of the whole-turn timeout', () => {
    expect(resolveWaitSeconds(300)).toBe(180);
    expect(resolveWaitSeconds(6000)).toBe(180);
  });

  it('allows a single check and never a negative wait', () => {
    expect(resolveWaitSeconds(0)).toBe(0);
    expect(resolveWaitSeconds(-30)).toBe(0);
  });

  it('passes a reasonable request through unchanged', () => {
    expect(resolveWaitSeconds(45)).toBe(45);
  });
});

// Greptile P1: the grace window that absorbs clock skew also admitted the
// PREVIOUS login's code when it happened to arrive shortly before this attempt —
// the exact failure this tool exists to prevent. A message that predates the
// call is now held back while there is still time for a genuinely new one.
describe('read_verification_code — arrival partitioning', () => {
  const invokedAt = Date.parse('2026-08-05T12:00:00.000Z');
  const window = { invokedAt, since: invokedAt - 60_000 };
  const at = (offsetMs: number) => ({ id: `m${offsetMs}`, date: new Date(invokedAt + offsetMs).toISOString() });

  it('treats a message that arrived after the call as unambiguously ours', () => {
    const result = partitionByArrival([at(5_000)], window);
    expect(result.arrivedAfterCall.map((e) => e.id)).toEqual(['m5000']);
    expect(result.withinGrace).toHaveLength(0);
    expect(result.stale).toHaveLength(0);
  });

  it('holds a pre-call message in the grace bucket rather than treating it as ours', () => {
    const result = partitionByArrival([at(-30_000)], window);
    expect(result.arrivedAfterCall).toHaveLength(0);
    expect(result.withinGrace.map((e) => e.id)).toEqual(['m-30000']);
  });

  it('treats anything older than the window as stale', () => {
    const result = partitionByArrival([at(-90_000)], window);
    expect(result.withinGrace).toHaveLength(0);
    expect(result.stale.map((e) => e.id)).toEqual(['m-90000']);
  });

  it('orders each bucket newest first', () => {
    const result = partitionByArrival([at(1_000), at(9_000), at(5_000)], window);
    expect(result.arrivedAfterCall.map((e) => e.id)).toEqual(['m9000', 'm5000', 'm1000']);
  });

  it('treats an unparseable date as stale rather than as a fresh code', () => {
    const result = partitionByArrival([{ id: 'bad', date: 'not a date' }], window);
    expect(result.stale.map((e) => e.id)).toEqual(['bad']);
  });
});

describe('senderDomain', () => {
  it('reads the domain out of a display-name address', () => {
    expect(senderDomain('RankAI <no-reply@rankai.ai>')).toBe('rankai.ai');
  });

  it('reads a bare address and lowercases it', () => {
    expect(senderDomain('Founders@AgentWeb.pro')).toBe('agentweb.pro');
  });

  it('returns null when there is no parseable address', () => {
    expect(senderDomain('RankAI Support')).toBeNull();
    expect(senderDomain(undefined)).toBeNull();
  });
});

describe('read_verification_code — failure paths', () => {
  it('requires an authenticated user', async () => {
    await expect(tool.execute({}, {} as any)).rejects.toThrow('Authentication required');
  });

  it('fails loudly when the user has no connected mailbox', async () => {
    mockGetAccountByPlatform.mockResolvedValue(null);

    const result = await tool.execute({ wait_seconds: 0 }, context);

    expect(result.success).toBe(false);
    expect(result.reason).toBe('no_email_account');
    expect(result.message).toMatch(/Connected Accounts/i);
    expect(result.code).toBeUndefined();
  });

  it('reports no_matching_email when nothing matches the filters', async () => {
    mockListEmails.mockResolvedValue([summary({ subject: 'Weekly newsletter' })]);

    const result = await tool.execute(
      { subject_contains: 'Login Code', wait_seconds: 0 },
      context
    );

    expect(result.success).toBe(false);
    expect(result.reason).toBe('no_matching_email');
    expect(mockGetEmails).not.toHaveBeenCalled();
  });

  it('never returns a code from a message older than the freshness window', async () => {
    const stale = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    mockListEmails.mockResolvedValue([summary({ date: stale })]);
    mockGetEmails.mockResolvedValue([{ id: 'msg-1', body: 'Your code is 366990' }]);

    const result = await tool.execute({ subject_contains: 'Login Code', wait_seconds: 0 }, context);

    expect(result.success).toBe(false);
    expect(result.reason).toBe('only_stale_matches');
    expect(result.code).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('366990');
  });

  it('honours an explicit since that excludes an otherwise-recent message', async () => {
    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    mockListEmails.mockResolvedValue([summary({ date: twoMinutesAgo })]);
    mockGetEmails.mockResolvedValue([{ id: 'msg-1', body: 'Your code is 366990' }]);

    const result = await tool.execute(
      { subject_contains: 'Login Code', since: new Date().toISOString(), wait_seconds: 0 },
      context
    );

    expect(result.success).toBe(false);
    expect(result.reason).toBe('only_stale_matches');
  });

  // Greptile P1 follow-up: the grace window may not silently promote a pre-call
  // message to "fresh" — it cannot be distinguished from the previous attempt's
  // code, and typing the wrong one is less recoverable than saying "none yet".
  it('will not return a code from an email that arrived before the call', async () => {
    const thirtySecondsAgo = new Date(Date.now() - 30 * 1000).toISOString();
    mockListEmails.mockResolvedValue([summary({ date: thirtySecondsAgo })]);
    mockGetEmails.mockResolvedValue([{ id: 'msg-1', body: 'Your code is 366990' }]);

    const result = await tool.execute({ subject_contains: 'Login Code', wait_seconds: 0 }, context);

    expect(result.success).toBe(false);
    expect(result.reason).toBe('code_predates_call');
    expect(result.message).toMatch(/re-trigger/i);
    expect(JSON.stringify(result)).not.toContain('366990');
  });

  it('does return a pre-call code when the caller anchored the window with since', async () => {
    const thirtySecondsAgo = new Date(Date.now() - 30 * 1000).toISOString();
    mockListEmails.mockResolvedValue([summary({ date: thirtySecondsAgo })]);
    mockGetEmails.mockResolvedValue([{ id: 'msg-1', body: 'Your code is 366990' }]);

    const result = await tool.execute(
      {
        subject_contains: 'Login Code',
        since: new Date(Date.now() - 60 * 1000).toISOString(),
        wait_seconds: 0,
      },
      context
    );

    expect(result.success).toBe(true);
    expect(result.code).toBe('366990');
  });

  it('reports code_not_found when a fresh matching email has no extractable code', async () => {
    mockListEmails.mockResolvedValue([summary()]);
    mockGetEmails.mockResolvedValue([{ id: 'msg-1', body: 'Someone tried to sign in. No action needed.' }]);

    const result = await tool.execute({ subject_contains: 'Login Code', wait_seconds: 0 }, context);

    expect(result.success).toBe(false);
    expect(result.reason).toBe('code_not_found');
  });

  it('surfaces a provider error instead of pretending no code arrived', async () => {
    mockListEmails.mockRejectedValue(new Error('Gmail token revoked'));

    const result = await tool.execute({ wait_seconds: 0 }, context);

    expect(result.success).toBe(false);
    expect(result.reason).toBe('mailbox_error');
    expect(result.message).toContain('Gmail token revoked');
  });
});

describe('read_verification_code — success paths', () => {
  it('returns the code from the freshest matching message', async () => {
    mockListEmails.mockResolvedValue([summary({ subject: 'Your RankAI Login Code' })]);
    mockGetEmails.mockResolvedValue([
      { id: 'msg-1', subject: 'Your RankAI Login Code', from: 'founders@agentweb.pro', body: '<p>Your code is 366990</p>' },
    ]);

    const result = await tool.execute(
      { subject_contains: 'RankAI Login Code', wait_seconds: 0 },
      context
    );

    expect(result.success).toBe(true);
    expect(result.code).toBe('366990');
    expect(result.subject).toBe('Your RankAI Login Code');
    expect(result.account).toEqual({ platform: 'gmail', account_id: 'founders@agentweb.pro' });
  });

  it('filters by sender as well as subject', async () => {
    mockListEmails.mockResolvedValue([
      summary({ id: 'other', from: 'noreply@elsewhere.com' }),
      summary({ id: 'wanted', from: 'RankAI <founders@agentweb.pro>' }),
    ]);
    mockGetEmails.mockResolvedValue([{ id: 'wanted', body: 'Your code is 512377' }]);

    const result = await tool.execute(
      { from_contains: 'founders@agentweb.pro', wait_seconds: 0 },
      context
    );

    expect(result.success).toBe(true);
    expect(result.code).toBe('512377');
    expect(mockGetEmails).toHaveBeenCalledWith('user-123', 'founders@agentweb.pro', ['wanted']);
  });

  // A Gmail filter that archives the code email, or a busy inbox, hides the
  // message from the INBOX scan entirely. Gmail search sees it either way.
  it('finds a code the inbox scan cannot see, via Gmail search', async () => {
    mockListEmails.mockResolvedValue([]);
    mockSearchEmails.mockResolvedValue([summary({ id: 'archived', from: 'RankAI <no-reply@rankai.ai>' })]);
    mockGetEmails.mockResolvedValue([{ id: 'archived', body: 'Your code is 366990' }]);

    const result = await tool.execute(
      { subject_contains: 'RankAI Login Code', from_contains: 'rankai.ai', wait_seconds: 0 },
      context
    );

    expect(result.success).toBe(true);
    expect(result.code).toBe('366990');

    const query = mockSearchEmails.mock.calls[0][2];
    expect(query).toContain('newer_than:');
    expect(query).toContain('subject:"RankAI Login Code"');
    expect(query).toContain('from:rankai.ai');
  });

  it('still applies the local filters to search hits, so a loose query cannot widen the match', async () => {
    mockSearchEmails.mockResolvedValue([summary({ id: 'wrong-sender', from: 'noreply@elsewhere.com' })]);
    mockListEmails.mockResolvedValue([]);
    mockGetEmails.mockResolvedValue([{ id: 'wrong-sender', body: 'Your code is 366990' }]);

    const result = await tool.execute(
      { from_contains: 'rankai.ai', wait_seconds: 0 },
      context
    );

    expect(result.success).toBe(false);
    expect(result.reason).toBe('no_matching_email');
    expect(mockGetEmails).not.toHaveBeenCalled();
  });

  it('strips quotes from filter text so they cannot break the search query', async () => {
    mockSearchEmails.mockResolvedValue([]);
    mockListEmails.mockResolvedValue([]);

    await tool.execute({ subject_contains: 'a "quoted" \\ code', wait_seconds: 0 }, context);

    const query = mockSearchEmails.mock.calls[0][2];
    expect(query).toBe('newer_than:1d subject:"a quoted  code"');
  });

  it('falls back to the inbox scan when the search itself fails', async () => {
    mockSearchEmails.mockRejectedValue(new Error('search unavailable'));
    mockListEmails.mockResolvedValue([summary()]);
    mockGetEmails.mockResolvedValue([{ id: 'msg-1', body: 'Your code is 366990' }]);

    const result = await tool.execute({ subject_contains: 'Login Code', wait_seconds: 0 }, context);

    expect(result.success).toBe(true);
    expect(result.code).toBe('366990');
  });

  it('reads a message returned by both sources only once', async () => {
    mockSearchEmails.mockResolvedValue([summary()]);
    mockListEmails.mockResolvedValue([summary()]);
    mockGetEmails.mockResolvedValue([{ id: 'msg-1', body: 'Your code is 366990' }]);

    const result = await tool.execute({ wait_seconds: 0 }, context);

    expect(result.success).toBe(true);
    expect(mockGetEmails).toHaveBeenCalledWith('user-123', 'founders@agentweb.pro', ['msg-1']);
  });

  it('does not issue a Gmail-syntax search against a non-Gmail mailbox', async () => {
    mockResolveEmailAccount.mockResolvedValue({
      platform: 'outlook',
      provider: { listEmails: mockListEmails, searchEmails: mockSearchEmails, getEmails: mockGetEmails },
    });
    mockListEmails.mockResolvedValue([summary()]);
    mockGetEmails.mockResolvedValue([{ id: 'msg-1', body: 'Your code is 998877' }]);

    const result = await tool.execute(
      { account_id: 'work-outlook', subject_contains: 'Login Code', wait_seconds: 0 },
      context
    );

    expect(result.success).toBe(true);
    expect(mockSearchEmails).not.toHaveBeenCalled();
  });

  it('honours an explicit search_query instead of building one', async () => {
    mockSearchEmails.mockResolvedValue([summary()]);
    mockListEmails.mockResolvedValue([]);
    mockGetEmails.mockResolvedValue([{ id: 'msg-1', body: 'Your code is 366990' }]);

    const result = await tool.execute(
      { search_query: 'from:rankai.ai newer_than:2d', wait_seconds: 0 },
      context
    );

    expect(result.success).toBe(true);
    expect(mockSearchEmails).toHaveBeenCalledWith(
      'user-123',
      'founders@agentweb.pro',
      'from:rankai.ai newer_than:2d',
      expect.any(Number)
    );
  });

  it('returns the magic link alongside the code when the link is on the sender\'s domain', async () => {
    mockListEmails.mockResolvedValue([summary({ from: 'RankAI <no-reply@rankai.ai>' })]);
    mockGetEmails.mockResolvedValue([
      { id: 'msg-1', from: 'RankAI <no-reply@rankai.ai>', body: 'Code 366990 or <a href="https://rankai.ai/api/auth/callback?token=xyz">sign in</a>' },
    ]);

    const result = await tool.execute({ return_link: true, wait_seconds: 0 }, context);

    expect(result.success).toBe(true);
    expect(result.magic_link).toBe('https://rankai.ai/api/auth/callback?token=xyz');
  });

  // Greptile P1 (security): anyone can email you a message matching the filters.
  // A link in it must not be handed back as "the login link" just because it
  // carries a token= or /auth marker.
  it('does not hand back a login link pointing somewhere other than the sender', async () => {
    mockListEmails.mockResolvedValue([summary({ from: 'RankAI <no-reply@rankai.ai>' })]);
    mockGetEmails.mockResolvedValue([
      { id: 'msg-1', from: 'RankAI <no-reply@rankai.ai>', body: 'Code 366990 <a href="https://evil.example.com/auth?token=xyz">sign in</a>' },
    ]);

    const result = await tool.execute({ return_link: true, wait_seconds: 0 }, context);

    expect(result.success).toBe(true);
    expect(result.code).toBe('366990');
    expect(result.magic_link).toBeUndefined();
    expect(result.link_omitted).toMatch(/rankai\.ai/);
  });

  it('accepts a caller-supplied link_host for senders that mail from a different domain', async () => {
    mockListEmails.mockResolvedValue([summary({ from: 'Luma <no-reply@luma-mail.com>' })]);
    mockGetEmails.mockResolvedValue([
      { id: 'msg-1', from: 'Luma <no-reply@luma-mail.com>', body: '<a href="https://lu.ma/verify?token=xyz">sign in</a>' },
    ]);

    const result = await tool.execute(
      { return_link: true, link_host: 'lu.ma', wait_seconds: 0 },
      context
    );

    expect(result.success).toBe(true);
    expect(result.magic_link).toBe('https://lu.ma/verify?token=xyz');
  });

  it('uses the explicitly supplied account instead of auto-resolving', async () => {
    mockResolveEmailAccount.mockResolvedValue({
      platform: 'outlook',
      provider: { listEmails: mockListEmails, searchEmails: mockSearchEmails, getEmails: mockGetEmails },
    });
    mockListEmails.mockResolvedValue([summary()]);
    mockGetEmails.mockResolvedValue([{ id: 'msg-1', body: 'Your code is 998877' }]);

    const result = await tool.execute({ account_id: 'work-outlook', wait_seconds: 0 }, context);

    expect(result.success).toBe(true);
    expect(result.code).toBe('998877');
    expect(mockResolveEmailAccount).toHaveBeenCalledWith('user-123', 'work-outlook');
    expect(mockGetAccountByPlatform).not.toHaveBeenCalled();
  });
});
