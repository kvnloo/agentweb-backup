jest.mock('../../utils/secretsManager', () => ({
  get2CaptchaApiKey: jest.fn().mockResolvedValue('test-2captcha-key')
}));

import '../../emma/solveRecaptchaTool';
import { emmaToolRegistry } from '../../emma/registry';

const tool = emmaToolRegistry.getTool('solve_captcha');
if (!tool) throw new Error('solve_captcha tool not registered');

const mockContext = {
  userId: 'user-123',
  sessionId: 'session-abc',
  llmModel: 'test-model',
  service: {}
};

/** Builds a mock context whose service can run the playwright_browser_run_code tool. */
function buildRunCodeContext(probeResponse: { dataKey: string | null; iframeKey: string | null }) {
  const executeTool = jest.fn().mockImplementation((_model: string, _toolName: string, args: { code: string }) => {
    // The site-key probe code references "iframeKey"; injection code does not.
    if (args.code.includes('iframeKey')) {
      return Promise.resolve({
        raw: { content: [{ type: 'text', text: `### Result\n${JSON.stringify(JSON.stringify(probeResponse))}` }] }
      });
    }
    return Promise.resolve({
      raw: { content: [{ type: 'text', text: `### Ran Playwright code\n\`\`\`js\n// inject\n\`\`\`` }] }
    });
  });

  return {
    userId: 'user-123',
    sessionId: 'session-abc',
    llmModel: 'test-model',
    service: {
      toolRegistry: { getAllTools: () => [{ name: 'playwright_browser_run_code' }] },
      executeTool
    }
  };
}

function mockTwoCaptchaFetch() {
  return jest.fn().mockImplementation((url: string) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/in.php')) {
      return Promise.resolve({ json: () => Promise.resolve({ status: 1, request: 'task-123' }) });
    }
    return Promise.resolve({ json: () => Promise.resolve({ status: 1, request: 'solved-token-abc' }) });
  });
}

describe('solve_captcha validation', () => {
  it('returns error when all required args are missing', async () => {
    const result = await tool.execute({}, mockContext);
    expect(result.success).toBe(false);
    expect(result.error).toContain('captcha_type');
    expect(result.error).toContain('site_key');
    expect(result.error).toContain('page_url');
    expect(result.error).toContain('browser_evaluate');
  });

  it('returns error when args is null/undefined', async () => {
    const result = await tool.execute(null, mockContext);
    expect(result.success).toBe(false);
    expect(result.error).toContain('captcha_type');
  });

  it('returns error when captcha_type is missing', async () => {
    const result = await tool.execute({ site_key: 'abc', page_url: 'https://example.com' }, mockContext);
    expect(result.success).toBe(false);
    expect(result.error).toContain('captcha_type');
    expect(result.error).not.toContain('site_key');
    expect(result.error).not.toContain('page_url');
  });

  it('returns error when site_key is missing', async () => {
    const result = await tool.execute({ captcha_type: 'recaptcha_v2', page_url: 'https://example.com' }, mockContext);
    expect(result.success).toBe(false);
    expect(result.error).toContain('site_key');
  });

  it('returns error when page_url is missing', async () => {
    const result = await tool.execute({ captcha_type: 'recaptcha_v2', site_key: 'abc123' }, mockContext);
    expect(result.success).toBe(false);
    expect(result.error).toContain('page_url');
  });

  it('includes browser_evaluate JS snippet in error for discoverability', async () => {
    const result = await tool.execute({}, mockContext);
    expect(result.error).toContain('data-sitekey');
    expect(result.error).toContain('browser_evaluate');
  });

  it('throws when userId is missing (even with all args)', async () => {
    await expect(
      tool.execute({ captcha_type: 'recaptcha_v2', site_key: 'key', page_url: 'https://example.com' }, { ...mockContext, userId: undefined })
    ).rejects.toThrow('Authentication required');
  });

  it('rejects unknown captcha_type (passes validation, hits switch default)', async () => {
    await expect(
      tool.execute({ captcha_type: 'image_captcha', site_key: 'key', page_url: 'https://example.com' }, mockContext)
    ).rejects.toThrow(/Unknown captcha_type/);
  });
});

describe('solve_captcha live site-key verification', () => {
  jest.setTimeout(20000); // real 15s 2captcha initial-wait for recaptcha_v2 runs unmocked
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  it('falls back to the caller-provided site_key when the live page cannot be probed for any key (no dataKey/iframeKey found)', async () => {
    const fetchMock = mockTwoCaptchaFetch();
    global.fetch = fetchMock as any;
    const ctx = buildRunCodeContext({ dataKey: null, iframeKey: null });

    const result = await tool.execute(
      { captcha_type: 'recaptcha_v2', site_key: 'STALE_PROMPT_KEY', page_url: 'https://rankai.ai/signin', invisible: true },
      ctx
    );

    expect(result.success).toBe(true);
    const submitCall = fetchMock.mock.calls.find(([url]: [string]) => url.includes('/in.php'));
    expect(submitCall).toBeDefined();
    const submittedUrl = new URL(submitCall![0]);
    expect(submittedUrl.searchParams.get('googlekey')).toBe('STALE_PROMPT_KEY');
  });

  it('overrides a stale/mismatched caller-provided site_key with the live key found on the page (data-sitekey)', async () => {
    const fetchMock = mockTwoCaptchaFetch();
    global.fetch = fetchMock as any;
    const ctx = buildRunCodeContext({ dataKey: 'LIVE_KEY_FROM_DOM', iframeKey: null });

    const result = await tool.execute(
      { captcha_type: 'recaptcha_v2', site_key: 'STALE_PROMPT_KEY', page_url: 'https://rankai.ai/signin', invisible: true },
      ctx
    );

    expect(result.success).toBe(true);
    const submitCall = fetchMock.mock.calls.find(([url]: [string]) => url.includes('/in.php'));
    const submittedUrl = new URL(submitCall![0]);
    expect(submittedUrl.searchParams.get('googlekey')).toBe('LIVE_KEY_FROM_DOM');
  });

  it('overrides a stale/mismatched caller-provided site_key with the live key extracted from the reCAPTCHA iframe src when no data-sitekey attribute exists', async () => {
    // This is the specific gap from ENG-494: invisible reCAPTCHA rendered without a static
    // [data-sitekey] attribute — the only place to find the real key is the iframe src.
    const fetchMock = mockTwoCaptchaFetch();
    global.fetch = fetchMock as any;
    const ctx = buildRunCodeContext({ dataKey: null, iframeKey: 'LIVE_KEY_FROM_IFRAME' });

    const result = await tool.execute(
      { captcha_type: 'recaptcha_v2', site_key: 'STALE_PROMPT_KEY', page_url: 'https://rankai.ai/signin', invisible: true },
      ctx
    );

    expect(result.success).toBe(true);
    const submitCall = fetchMock.mock.calls.find(([url]: [string]) => url.includes('/in.php'));
    const submittedUrl = new URL(submitCall![0]);
    expect(submittedUrl.searchParams.get('googlekey')).toBe('LIVE_KEY_FROM_IFRAME');
  });

  it('uses the caller-provided site_key as-is when it already matches the live key (no spurious override)', async () => {
    const fetchMock = mockTwoCaptchaFetch();
    global.fetch = fetchMock as any;
    const ctx = buildRunCodeContext({ dataKey: 'MATCHING_KEY', iframeKey: null });

    await tool.execute(
      { captcha_type: 'recaptcha_v2', site_key: 'MATCHING_KEY', page_url: 'https://rankai.ai/signin', invisible: true },
      ctx
    );

    const submitCall = fetchMock.mock.calls.find(([url]: [string]) => url.includes('/in.php'));
    const submittedUrl = new URL(submitCall![0]);
    expect(submittedUrl.searchParams.get('googlekey')).toBe('MATCHING_KEY');
  });

  it('falls back to the caller-provided site_key if the live probe itself throws/errors', async () => {
    const fetchMock = mockTwoCaptchaFetch();
    global.fetch = fetchMock as any;
    const executeTool = jest.fn().mockImplementation((_model: string, _toolName: string, args: { code: string }) => {
      if (args.code.includes('iframeKey')) {
        return Promise.reject(new Error('no active page'));
      }
      return Promise.resolve({ raw: { content: [{ type: 'text', text: '### Ran Playwright code\n```js\n// inject\n```' }] } });
    });
    const ctx = {
      userId: 'user-123',
      sessionId: 'session-abc',
      llmModel: 'test-model',
      service: { toolRegistry: { getAllTools: () => [{ name: 'playwright_browser_run_code' }] }, executeTool }
    };

    const result = await tool.execute(
      { captcha_type: 'recaptcha_v2', site_key: 'FALLBACK_KEY', page_url: 'https://rankai.ai/signin', invisible: true },
      ctx
    );

    expect(result.success).toBe(true);
    const submitCall = fetchMock.mock.calls.find(([url]: [string]) => url.includes('/in.php'));
    const submittedUrl = new URL(submitCall![0]);
    expect(submittedUrl.searchParams.get('googlekey')).toBe('FALLBACK_KEY');
  });
});
