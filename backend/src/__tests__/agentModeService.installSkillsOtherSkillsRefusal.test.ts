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
 * ENG-1855: install_skills returns `success: false` (never throws) when the
 * __other_skills__ bundle is refused — the gate in front of
 * publish_landing_page_changes, among other unassociated tools. That refusal
 * reaches the model ONLY through formatToolError's generic fallback (verified
 * directly: toolDispatch.ts downgrades the success:false result into a
 * structured failure, then calls formatToolError('install_skills', message)).
 * A real incident showed the model filling that silence with a fabricated
 * "navigate to Landing Pages and click Publish" — a button that does not
 * exist anywhere in the product.
 */
describe('formatToolError — install_skills refusing __other_skills__ (ENG-1855)', () => {
  let svc: AgentModeService;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    svc = new AgentModeService();
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  const format = (tool: string, message: string): string =>
    (svc as any).formatToolError(tool, message);

  const OTHER_SKILLS_MESSAGE =
    'These skills are currently unavailable to install: __other_skills__. The ID is correct and this account is permitted to use it, so retrying the same ID will not help, and this is NOT a billing limitation — do NOT tell the user it is missing from their subscription. Say the capability is unavailable right now and that support can look into it. Do NOT substitute a different tool\'s output for the tool that needed this skill, and do not describe that tool as having run.';

  it('forbids inventing a manual UI workaround when __other_skills__ is refused', () => {
    const out = format('install_skills', OTHER_SKILLS_MESSAGE);
    expect(out).toContain('install_skills');
    expect(out).toMatch(/do NOT invent a manual UI workaround/i);
    expect(out).toMatch(/temporarily unavailable/i);
  });

  it('preserves the original refusal reason', () => {
    const out = format('install_skills', OTHER_SKILLS_MESSAGE);
    expect(out).toContain('__other_skills__');
  });

  // FAIL cases: other install_skills refusals, and other tools, keep existing guidance.
  it('does not apply this override to an unentitled (billing) refusal', () => {
    const out = format(
      'install_skills',
      'The requested skills are not available with your current subscription: seo-audit-skill. Tell the user plainly that this capability is not on their plan.'
    );
    expect(out).not.toMatch(/do NOT invent a manual UI workaround/i);
    expect(out).toContain('Next: Adjust the plan or ask the user for missing info.');
  });

  it('does not apply this override to a different tool entirely', () => {
    const out = format('publish_landing_page_changes', 'Upstream returned 502');
    expect(out).not.toMatch(/do NOT invent a manual UI workaround/i);
    expect(out).toContain('Next: Adjust the plan or ask the user for missing info.');
  });
});
