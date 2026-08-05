const mockGetRankAICredentials = jest.fn();

jest.mock('../../utils/secretsManager', () => ({
  getRankAICredentials: (...args: any[]) => mockGetRankAICredentials(...args),
}));

import '../../emma/siteSigninTools';
import { emmaToolRegistry } from '../../emma/registry';

const tool = emmaToolRegistry.getTool('open_site_signin');
if (!tool) throw new Error('open_site_signin tool not registered');

const BYPASS_KEY = 'super-secret-bypass-key-123';

const CREDENTIALS = {
  captchaBypassKey: BYPASS_KEY,
  signinUrl: 'https://rankai.ai/signin',
  reportAccountEmail: 'founders@agentweb.pro',
  dashboardId: 'cmidp0w230001xlm9a93t8mot',
};

function buildContext(navigateAvailable = true) {
  const executeTool = jest.fn().mockResolvedValue({
    raw: { content: [{ type: 'text', text: '### Result\n"navigated"' }] },
  });
  return {
    userId: 'user-123',
    sessionId: 'session-abc',
    llmModel: 'test-model',
    service: {
      toolRegistry: {
        getAllTools: () => (navigateAvailable ? [{ name: 'playwright_browser_navigate' }] : []),
      },
      executeTool,
    },
  };
}

/**
 * A context that can also probe the current page — `currentUrl` is what
 * page.url() returns, or an Error to simulate a failed/hung probe.
 */
function buildContextWithPageProbe(currentUrl: string | Error) {
  const executeTool = jest.fn().mockImplementation((_model: string, toolName: string) => {
    if (toolName === 'playwright_browser_run_code') {
      if (currentUrl instanceof Error) return Promise.reject(currentUrl);
      return Promise.resolve({
        raw: { content: [{ type: 'text', text: `### Result\n${JSON.stringify(currentUrl)}` }] },
      });
    }
    return Promise.resolve({ raw: { content: [{ type: 'text', text: '### Result\n"navigated"' }] } });
  });
  return {
    userId: 'user-123',
    sessionId: 'session-abc',
    llmModel: 'test-model',
    service: {
      toolRegistry: {
        getAllTools: () => [
          { name: 'playwright_browser_navigate' },
          { name: 'playwright_browser_run_code' },
        ],
      },
      executeTool,
    },
  };
}

/** Did the context actually navigate the browser? */
function navigatedTo(context: any): string | null {
  const call = context.service.executeTool.mock.calls.find(
    (c: any[]) => c[1] === 'playwright_browser_navigate'
  );
  return call ? call[2].url : null;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetRankAICredentials.mockResolvedValue({ ...CREDENTIALS });
});

describe('open_site_signin — failure paths', () => {
  it('requires an authenticated user', async () => {
    await expect(tool.execute({ site: 'rankai' }, {} as any)).rejects.toThrow('Authentication required');
  });

  it('rejects an unknown site and lists the supported ones', async () => {
    const result = await tool.execute({ site: 'luma' }, buildContext());

    expect(result.success).toBe(false);
    expect(result.error).toContain('luma');
    expect(result.error).toContain('rankai');
    expect(mockGetRankAICredentials).not.toHaveBeenCalled();
  });

  it('fails loudly, naming the missing secret field, when the secret is incomplete', async () => {
    mockGetRankAICredentials.mockResolvedValue({ signinUrl: 'https://rankai.ai/signin' });
    const context = buildContext();

    const result = await tool.execute({ site: 'rankai' }, context);

    expect(result.success).toBe(false);
    expect(result.error).toContain('captchaBypassKey');
    expect(result.error).toContain('AgentWeb/RankAI');
    expect(context.service.executeTool).not.toHaveBeenCalled();
  });

  it('reports the failure instead of navigating when the secret cannot be read', async () => {
    mockGetRankAICredentials.mockRejectedValue(new Error('Failed to fetch secret: prod/AgentWeb/RankAI'));
    const context = buildContext();

    const result = await tool.execute({ site: 'rankai' }, context);

    expect(result.success).toBe(false);
    expect(result.error).toContain('prod/AgentWeb/RankAI');
    expect(context.service.executeTool).not.toHaveBeenCalled();
  });

  it('errors when no browser session is active', async () => {
    const result = await tool.execute({ site: 'rankai' }, buildContext(false));

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/browser/i);
  });
});

// The tool is a foundation tool, so it is offered in EVERY session — including
// one driving the browser somewhere else entirely. Navigating that browser away
// mid-task would be visibly wrong, so the tool only acts when the browser is
// already on the site (the real dead-session case) or has nothing open.
describe('open_site_signin — will not hijack a browser working elsewhere', () => {
  it('refuses, without navigating, when the browser is on an unrelated site', async () => {
    const context = buildContextWithPageProbe('https://app.hubspot.com/contacts/123');

    const result = await tool.execute({ site: 'rankai' }, context);

    expect(result.success).toBe(false);
    expect(result.reason).toBe('browser_on_other_site');
    expect(result.error).toContain('app.hubspot.com');
    expect(result.error).toContain('rankai.ai');
    expect(navigatedTo(context)).toBeNull();
  });

  it('proceeds when the browser is already on the site (the dead-session case)', async () => {
    const context = buildContextWithPageProbe('https://rankai.ai/signin?returnUrl=%2Fdashboard');

    const result = await tool.execute({ site: 'rankai' }, context);

    expect(result.success).toBe(true);
    expect(navigatedTo(context)).toContain('rankai.ai/signin');
  });

  it('proceeds on a subdomain of the site', async () => {
    const context = buildContextWithPageProbe('https://app.rankai.ai/dashboard/abc/analytics');

    const result = await tool.execute({ site: 'rankai' }, context);

    expect(result.success).toBe(true);
  });

  it('proceeds when no page is open — there is nothing to disrupt', async () => {
    const context = buildContextWithPageProbe('about:blank');

    const result = await tool.execute({ site: 'rankai' }, context);

    expect(result.success).toBe(true);
  });

  it('proceeds when the probe fails, so a flaky probe cannot block the login', async () => {
    const context = buildContextWithPageProbe(new Error('page closed'));

    const result = await tool.execute({ site: 'rankai' }, context);

    expect(result.success).toBe(true);
    expect(navigatedTo(context)).toContain('rankai.ai/signin');
  });

  it('does not mistake a lookalike host for the site', async () => {
    const context = buildContextWithPageProbe('https://rankai.ai.evil.example.com/signin');

    const result = await tool.execute({ site: 'rankai' }, context);

    expect(result.success).toBe(false);
    expect(result.reason).toBe('browser_on_other_site');
  });
});

describe('open_site_signin — success path', () => {
  it('navigates to the signin URL with the bypass key applied', async () => {
    const context = buildContext();

    const result = await tool.execute({ site: 'rankai' }, context);

    expect(result.success).toBe(true);
    const [, toolName, args] = context.service.executeTool.mock.calls[0];
    expect(toolName).toBe('playwright_browser_navigate');
    expect(args.url).toBe(`https://rankai.ai/signin?captchaKey=${BYPASS_KEY}`);
  });

  it('never returns the bypass key to the caller', async () => {
    const result = await tool.execute({ site: 'rankai' }, buildContext());

    expect(JSON.stringify(result)).not.toContain(BYPASS_KEY);
    expect(result.signin_url).toBe('https://rankai.ai/signin?captchaKey=[redacted]');
  });

  it('hands back the login email and the code-retrieval next step', async () => {
    const result = await tool.execute({ site: 'rankai' }, buildContext());

    expect(result.login_email).toBe('founders@agentweb.pro');
    expect(result.next_steps).toContain('read_verification_code');
    expect(result.next_steps).toContain('Send Verification Code');
  });

  it('does not tell the agent to solve a CAPTCHA — the whole point of the bypass', async () => {
    const result = await tool.execute({ site: 'rankai' }, buildContext());

    expect(JSON.stringify(result)).not.toContain('solve_captcha');
  });

  it('logs a warning so a dead persisted session is visible in the run logs', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    await tool.execute({ site: 'rankai' }, buildContext());

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('rankai.ai'));
    warn.mockRestore();
  });
});
