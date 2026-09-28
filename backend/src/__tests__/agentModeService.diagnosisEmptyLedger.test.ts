jest.mock('@slack/web-api', () => ({
  WebClient: jest.fn().mockImplementation(() => ({
    chat: { postMessage: jest.fn() },
    conversations: { info: jest.fn(), list: jest.fn() },
    views: { open: jest.fn() },
  })),
}));

import { AgentModeService, DiagnosisContext } from '../services/agentModeService';

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
 * The inverse of ENG-971. That ticket fixed the diagnosis agent reporting COMPLETED work
 * as lost; this covers the opposite failure — reporting work that never ran as completed.
 *
 * Production, 2026-09-25, session 7adc834c-3afc-4120-abbb-77caf573b80a: an OpenRouter 429
 * killed the turn before a single tool dispatched (`calledFunctions: null`, no dispatch in
 * the backend logs). The user was nonetheless told:
 *
 *   "I have successfully loaded your browser cookies and navigated to the event management
 *    page. The final step to list the guests was interrupted by high demand..."
 *
 * Root cause was an omission, not a bad rule: when the success ledger was empty the
 * "Succeeded operations" line was simply left out of the prompt, so the model saw only the
 * error and the user's request — and narrated the request back as history. The existing
 * output guards cannot catch this: stripUnfoundedEntityCounts removes unproven QUANTITIES
 * (the fabricated sentence has none), and reconcileFalseFailureReport /
 * reconcileFalseDataWriteFailure / reconcileFalseArtifactFailure only ever flip a false
 * FAILURE into an acknowledged success, never the reverse.
 *
 * So the prompt must state the absence rather than imply it by silence.
 */
describe('generateDiagnosticMessage — empty success ledger must be stated, not omitted', () => {
  let svc: AgentModeService;
  let callLLM: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;
  let consoleWarnSpy: jest.SpyInstance;

  beforeEach(() => {
    svc = new AgentModeService();
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();
    callLLM = jest
      .spyOn(svc as any, 'callLLM')
      .mockResolvedValue({ choices: [{ message: { content: 'diagnosed' } }] });
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    jest.restoreAllMocks();
  });

  /** The production shape of session 7adc834c at the moment the 429 ended the turn. */
  const PROD_CONTEXT: DiagnosisContext = {
    errorType: 'rate_limit',
    errorMessage: "I'm currently experiencing high demand. Please wait a moment and try again.",
    userMessage:
      'Load my browser cookies, open https://luma.com/event/manage/evt-HjqqW76FE1c9Jx5/guests '
      + 'and list the guests who registered in the last 3 days.',
    workPlanSummary: null,
    succeededFunctions: {},
    failedFunctions: null,
    importTotalsSummary: null,
  };

  const userPromptFor = async (context: DiagnosisContext): Promise<string> => {
    await svc.generateDiagnosticMessage(context);
    expect(callLLM).toHaveBeenCalledTimes(1);
    const messages = callLLM.mock.calls[0][1] as Array<{ role: string; content: string }>;
    const user = messages.find((m) => m.role === 'user');
    expect(user).toBeDefined();
    return user!.content;
  };

  const systemPromptFor = async (context: DiagnosisContext): Promise<string> => {
    await svc.generateDiagnosticMessage(context);
    const messages = callLLM.mock.calls[0][1] as Array<{ role: string; content: string }>;
    const system = messages.find((m) => m.role === 'system');
    expect(system).toBeDefined();
    return system!.content;
  };

  it('states NONE explicitly when the ledger is empty, rather than omitting the line', async () => {
    const prompt = await userPromptFor(PROD_CONTEXT);
    expect(prompt).toContain('Succeeded operations: NONE');
    expect(prompt).toMatch(/failed before anything ran/i);
  });

  it('treats a null ledger the same as an empty one', async () => {
    const prompt = await userPromptFor({ ...PROD_CONTEXT, succeededFunctions: null as any });
    expect(prompt).toContain('Succeeded operations: NONE');
  });

  it('tells the model never to infer completed steps from the user request', async () => {
    const system = await systemPromptFor(PROD_CONTEXT);
    expect(system).toMatch(/absent or says NONE/i);
    expect(system).toMatch(/never infer the steps from the user's request/i);
  });

  it('still reports real successes when the ledger is non-empty (ENG-971 unregressed)', async () => {
    const prompt = await userPromptFor({
      ...PROD_CONTEXT,
      succeededFunctions: { publish_landing_page_changes: 1 },
    });
    expect(prompt).toContain('publish_landing_page_changes');
    expect(prompt).not.toContain('Succeeded operations: NONE');
  });
});
