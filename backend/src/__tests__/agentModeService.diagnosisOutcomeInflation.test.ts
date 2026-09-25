jest.mock('@slack/web-api', () => ({
  WebClient: jest.fn().mockImplementation(() => ({
    chat: { postMessage: jest.fn() },
    conversations: { info: jest.fn(), list: jest.fn() },
    views: { open: jest.fn() },
  })),
}));

import { AgentModeService, DiagnosisContext } from '../services/agentModeService';

jest.mock('@google/generative-ai', () => ({ GoogleGenerativeAI: jest.fn().mockImplementation(() => ({})) }));
jest.mock('../utils/s3Utils', () => ({ uploadFileToS3: jest.fn(), getS3ObjectAsString: jest.fn() }));
jest.mock('../utils/secretsManager', () => ({ getSecret: jest.fn() }));

/**
 * ENG-2161 — the non-empty-ledger half of the fabrication problem, NOT covered by
 * the empty-ledger fix (ENG-2160).
 *
 * Prod 2026-09-25, session 707d50fb-…: search_tool_response ran (and succeeded) but
 * returned nothing useful. With that on the succeeded ledger, the diagnosis agent
 * wrote "I have successfully analyzed the guest data using the search tool. Please
 * retry the browser evaluation step" — it upgraded "a tool RAN" into "I achieved the
 * goal", and told the USER to retry an internal step. The agent never sees tool
 * RESULTS, so it cannot know anything was analyzed/found.
 *
 * The prompt must forbid claiming tool outputs/outcomes and forbid delegating
 * internal steps back to the user.
 */
describe('generateDiagnosticMessage — succeeded tool ≠ achieved goal (ENG-2161)', () => {
  let svc: AgentModeService;
  let callLLM: jest.SpyInstance;

  beforeEach(() => {
    svc = new AgentModeService();
    jest.spyOn(console, 'error').mockImplementation();
    jest.spyOn(console, 'warn').mockImplementation();
    callLLM = jest.spyOn(svc as any, 'callLLM')
      .mockResolvedValue({ choices: [{ message: { content: 'diagnosed' } }] });
  });
  afterEach(() => jest.restoreAllMocks());

  const CTX: DiagnosisContext = {
    errorType: 'unknown',
    errorMessage: 'Generation timed out.',
    userMessage: 'Pull the guest list and analyze it.',
    workPlanSummary: null,
    // Non-empty ledger: tools ran, but the task did not complete.
    succeededFunctions: { search_tool_response: 8, load_browser_cookies: 1, playwright_browser_navigate: 1 },
    failedFunctions: null,
    importTotalsSummary: null,
  };

  const systemPrompt = async (): Promise<string> => {
    await svc.generateDiagnosticMessage(CTX);
    const msgs = callLLM.mock.calls[0][1] as Array<{ role: string; content: string }>;
    return msgs.find((m) => m.role === 'system')!.content;
  };

  it('states that a succeeded tool is not an achieved goal', async () => {
    expect(await systemPrompt()).toMatch(/RAN.*is NOT the same as|not the same as its goal being achieved/i);
  });

  it('forbids claiming what a tool found/analyzed/produced', async () => {
    expect(await systemPrompt()).toMatch(/never claim what any tool FOUND/i);
  });

  it('forbids telling the user to run or retry an internal step', async () => {
    expect(await systemPrompt()).toMatch(/never tell the user to run or retry an internal step/i);
  });

  it('still lists the succeeded tools for a non-empty ledger (unregressed)', async () => {
    await svc.generateDiagnosticMessage(CTX);
    const msgs = callLLM.mock.calls[0][1] as Array<{ role: string; content: string }>;
    const user = msgs.find((m) => m.role === 'user')!.content;
    expect(user).toContain('search_tool_response');
    expect(user).not.toContain('Succeeded operations: NONE');
  });
});
