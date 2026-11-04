jest.mock('@slack/web-api', () => ({
  WebClient: jest.fn().mockImplementation(() => ({
    chat: { postMessage: jest.fn() },
    conversations: { info: jest.fn(), list: jest.fn() },
    views: { open: jest.fn() },
  })),
}));

import { AgentModeService } from '../services/agentModeService';

jest.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('../utils/s3Utils', () => ({
  uploadFileToS3: jest.fn(),
  getS3ObjectAsString: jest.fn(),
}));

jest.mock('../utils/secretsManager', () => ({
  getSecret: jest.fn(),
}));
/**
 * ENG-2807: playwright_browser_run_code failed 26% of the time with locator
 * timeouts; the model re-ran the same selector. formatToolError must steer it
 * to snapshot the page and change selector instead.
 */
describe('formatToolError — browser_run_code locator timeout (ENG-2807)', () => {
  let svc: AgentModeService;
  let spy: jest.SpyInstance;
  beforeEach(() => {
    svc = new AgentModeService();
    spy = jest.spyOn(console, 'error').mockImplementation();
  });
  afterEach(() => spy.mockRestore());
  const format = (tool: string, msg: string): string => (svc as any).formatToolError(tool, msg);
  const PROD_MSG =
    "### Error\nTimeoutError: page.fill: Timeout 30000ms exceeded.\nCall log:\n  - waiting for locator('input#username')\n";

  it.each(['playwright_browser_run_code', 'browser_run_code'])('%s: gives selector-not-found guidance', (tool) => {
    const out = format(tool, PROD_MSG);
    expect(out).toContain(PROD_MSG);
    expect(out).toContain("locator('input#username')");
    expect(out).toMatch(/browser_snapshot/);
    expect(out).toMatch(/Do NOT re-run the same code with the same selector/);
  });

  it('leaves the ReferenceError hint unchanged', () => {
    const out = format('playwright_browser_run_code', 'ReferenceError: foo is not defined');
    expect(out).toMatch(/only has `page` in scope/);
    expect(out).not.toMatch(/browser_snapshot/);
  });

  it('does not apply to other tools or non-locator timeouts', () => {
    expect(format('playwright_browser_click', PROD_MSG)).not.toMatch(/Do NOT re-run the same code/);
    expect(format('playwright_browser_run_code', 'TimeoutError: page.goto: Timeout 30000ms exceeded.')).not.toMatch(
      /Do NOT re-run the same code/,
    );
  });
});
