import { normalizeBrowserToolValue, verifyAcceptanceChecks } from '../services/codingAgentAcceptance';

describe('verifyAcceptanceChecks', () => {
  test('passes an HTTP status check when the expected status matches', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ status: 200 });

    const result = await verifyAcceptanceChecks({
      checks: [{ type: 'http_status', label: 'preview is live', url: 'https://preview.example' }],
      fetchImpl: fetchImpl as any,
    });

    expect(result.status).toBe('passed');
    expect(result.checks[0]).toMatchObject({
      label: 'preview is live',
      status: 'passed',
      actual: 200,
      expected: 200,
    });
  });

  test('resolves preview URL placeholders for HTTP status checks', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ status: 200 });

    const result = await verifyAcceptanceChecks({
      previewUrl: 'https://preview.example',
      checks: [{ type: 'http_status', label: 'preview is live', url: '{{previewUrl}}' }],
      fetchImpl: fetchImpl as any,
    });

    expect(result.status).toBe('passed');
    expect(fetchImpl).toHaveBeenCalledWith('https://preview.example', expect.objectContaining({ method: 'GET' }));
  });

  test('fails an HTTP status check when an external asset is missing', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ status: 404 });

    const result = await verifyAcceptanceChecks({
      checks: [{ type: 'http_status', label: 'font asset exists', url: 'https://cdn.example/missing.woff2' }],
      fetchImpl: fetchImpl as any,
    });

    expect(result.status).toBe('failed');
    expect(result.summary).toContain('Acceptance failed');
    expect(result.checks[0]).toMatchObject({
      status: 'failed',
      actual: 404,
      expected: 200,
    });
  });

  test('runs a typed text_present check against the preview URL', async () => {
    const executeMcpTool = jest
      .fn()
      .mockResolvedValueOnce({ content: 'navigated' })
      .mockResolvedValueOnce({ result: true });

    const result = await verifyAcceptanceChecks({
      previewUrl: 'https://preview.example',
      executeMcpTool,
      checks: [{
        type: 'text_present',
        label: 'token visible',
        text: 'aw_smoke_abc123',
      }],
    });

    expect(result.status).toBe('passed');
    expect(executeMcpTool).toHaveBeenNthCalledWith(1, 'playwright_browser_navigate', { url: 'https://preview.example' });
    expect(executeMcpTool).toHaveBeenNthCalledWith(2, 'playwright_browser_evaluate', {
      function: expect.stringContaining('aw_smoke_abc123'),
    });
  });

  test('normalizes Playwright markdown result blocks inside the browser adapter', () => {
    const value = normalizeBrowserToolValue({
      content: [
        '### Result',
        'true',
        '### Ran Playwright code',
        '```js',
        "await page.evaluate('async () => true')",
        '```',
      ].join('\n'),
    });

    expect(value).toBe(true);
  });

  test('requests error-level console messages for no_console_errors checks', async () => {
    const executeMcpTool = jest
      .fn()
      .mockResolvedValueOnce({ content: 'navigated' })
      .mockResolvedValueOnce({ result: [] });

    const result = await verifyAcceptanceChecks({
      previewUrl: 'https://preview.example',
      executeMcpTool,
      checks: [{
        type: 'no_console_errors',
        label: 'no console errors',
      }],
    });

    expect(result.status).toBe('passed');
    expect(executeMcpTool).toHaveBeenNthCalledWith(2, 'playwright_browser_console_messages', { level: 'error' });
  });

  test('detects disallowed external hosts with no_external_hosts', async () => {
    const executeMcpTool = jest
      .fn()
      .mockResolvedValueOnce({ content: 'navigated' })
      .mockResolvedValueOnce({ result: ['preview.example', 'fonts.googleapis.com'] });

    const result = await verifyAcceptanceChecks({
      previewUrl: 'https://preview.example',
      executeMcpTool,
      checks: [{
        type: 'no_external_hosts',
        label: 'no external font hosts',
      }],
    });

    expect(result.status).toBe('failed');
    expect(result.checks[0].actual).toEqual(['fonts.googleapis.com']);
  });

  test('blocks browser checks when no Playwright executor is available', async () => {
    const result = await verifyAcceptanceChecks({
      previewUrl: 'https://preview.example',
      checks: [{
        type: 'text_present',
        label: 'headline visible',
        text: 'Launch Faster',
      }],
    });

    expect(result.status).toBe('blocked');
    expect(result.checks[0].message).toContain('Playwright');
  });

  test('blocks checks that exceed the per-check timeout', async () => {
    const executeMcpTool = jest.fn().mockReturnValue(new Promise(() => undefined));

    const result = await verifyAcceptanceChecks({
      previewUrl: 'https://preview.example',
      executeMcpTool,
      checkTimeoutMs: 1,
      checks: [{
        type: 'selector_exists',
        label: 'cta exists',
        selector: '[data-testid="cta"]',
      }],
    });

    expect(result.status).toBe('blocked');
    expect(result.checks[0].message).toContain('timed out');
  });
});
