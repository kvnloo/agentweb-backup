import { verifyAcceptanceChecks } from '../services/codingAgentAcceptance';

describe('verifyAcceptanceChecks', () => {
  test('passes an HTTP status check when the expected status matches', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ status: 200 });

    const result = await verifyAcceptanceChecks({
      checks: [{ type: 'http_status', label: 'font asset exists', url: 'https://cdn.example/font.woff2' }],
      fetchImpl: fetchImpl as any,
    });

    expect(result.status).toBe('passed');
    expect(result.checks[0]).toMatchObject({
      label: 'font asset exists',
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
    expect(fetchImpl).toHaveBeenCalledWith('https://preview.example', { method: 'GET' });
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

  test('runs a browser assertion against the preview URL', async () => {
    const executeMcpTool = jest
      .fn()
      .mockResolvedValueOnce({ content: 'navigated' })
      .mockResolvedValueOnce({ result: true });

    const result = await verifyAcceptanceChecks({
      previewUrl: 'https://preview.example',
      executeMcpTool,
      checks: [{
        type: 'browser_eval',
        label: 'headline changed',
        script: 'return document.body.innerText.includes("Launch Faster");',
      }],
    });

    expect(result.status).toBe('passed');
    expect(executeMcpTool).toHaveBeenNthCalledWith(1, 'playwright_browser_navigate', { url: 'https://preview.example' });
    expect(executeMcpTool).toHaveBeenNthCalledWith(2, 'playwright_browser_evaluate', {
      function: expect.stringContaining('Launch Faster'),
    });
  });

  test('blocks browser checks when no Playwright executor is available', async () => {
    const result = await verifyAcceptanceChecks({
      previewUrl: 'https://preview.example',
      checks: [{
        type: 'dom_text',
        label: 'headline visible',
        text: 'Launch Faster',
      }],
    });

    expect(result.status).toBe('blocked');
    expect(result.checks[0].message).toContain('Playwright');
  });
});
