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
 * ENG-971: a trailing validation error on save_memory — a NON-CRITICAL
 * bookkeeping call — was fed back to the model with the generic
 * "Next: Adjust the plan or ask the user for missing info" guidance. The model
 * generalized it into "the system timed out and your changes were not saved",
 * after a landing-page publish that had already landed in production.
 *
 * formatToolError must classify bookkeeping failures by criticality: scope the
 * failure to the note itself and explicitly forbid reporting it as a session /
 * system timeout or as lost work.
 */
describe('formatToolError — bookkeeping tool failures are non-critical (ENG-971)', () => {
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

  const BOOKKEEPING_TOOLS = ['save_memory', 'save_org_memory', 'delete_memory', 'delete_org_memory'];

  it.each(BOOKKEEPING_TOOLS)(
    '%s: forbids reporting the failure as a session timeout or as lost work',
    (tool) => {
      const out = format(tool, `${tool} arguments failed schema validation: "content" is required`);
      expect(out).toContain(tool);
      expect(out).toContain('arguments failed schema validation');
      // The criticality verdict the model needs.
      expect(out).toMatch(/bookkeeping/i);
      expect(out).toMatch(/did not undo|does not undo|scoped/i);
      expect(out).toMatch(/do NOT tell the user/i);
      expect(out).toMatch(/timed out/i);
      expect(out).toMatch(/report the true outcome/i);
    },
  );

  it('keeps the failure visible rather than hiding it', () => {
    const out = format('save_memory', 'Missing required argument: memory_content');
    expect(out).toContain('⚠️ Tool Error: save_memory');
    expect(out).toContain('Missing required argument: memory_content');
  });

  // FAIL cases: primary-work tools keep their existing guidance.
  it('does not apply the bookkeeping verdict to a publish/deploy failure', () => {
    const out = format('publish_landing_page_changes', 'Upstream returned 502');
    expect(out).not.toMatch(/bookkeeping/i);
    expect(out).toContain('Next: Adjust the plan or ask the user for missing info.');
  });

  it('does not apply the bookkeeping verdict to a research-lookup timeout', () => {
    const out = format('you_search_web', 'The request timed out');
    expect(out).not.toMatch(/bookkeeping/i);
    expect(out).toContain('⚠️ Research/Lookup Timeout');
  });

  it('does not apply the bookkeeping verdict to a knowledge-base file write', () => {
    const out = format('update_knowledge_base_file', 'S3 upload failed');
    expect(out).not.toMatch(/bookkeeping/i);
  });
});
