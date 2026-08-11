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
 * ENG-971 (real root cause). The false-failure sentence in the production session
 * was NOT the model's closing narrative — it was written by THIS diagnosis agent,
 * from the controller's catch block, after the turn hit the 600s generation
 * timeout three minutes AFTER the landing-page publish had already landed and
 * been verified live.
 *
 * The diagnosis agent was handed a failure-only view of the run (errorMessage +
 * failedFunctions) and asked to "be specific about what was accomplished (if
 * anything)". With no record of what SUCCEEDED it answered by asserting the work
 * was lost: "The system timed out while attempting to update the shared
 * /api/capture route, so your changes were not saved. Please try your request
 * again."
 *
 * So the diagnosis prompt must carry the run's SUCCESS ledger and an explicit rule
 * that a timeout ends a run without undoing work that already completed.
 */
describe('generateDiagnosticMessage — success ledger and no-lost-work rule (ENG-971)', () => {
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

  /** The production shape of session 7b4895fd at the moment the turn timed out. */
  const PROD_CONTEXT: DiagnosisContext = {
    errorType: 'unknown',
    errorMessage:
      'Generation timed out after 600000ms for session 7b4895fd-4d6f-4c0e-9ba1-32f212be4139. ' +
      'The lock has been released; the orphaned generation may still complete in the background.',
    userMessage: 'Go ahead. Fix the shared /api/capture route. Harsha approved.',
    workPlanSummary: null,
    succeededFunctions: {
      publish_landing_page_changes: 1,
      generate_landing_page: 1,
      get_deployment_status: 2,
      save_memory: 1,
    },
    failedFunctions: {
      playwright_browser_run_code: 1,
      generate_landing_page: 2,
      coding_agent: 1,
      get_file_contents: 1,
      save_memory: 1,
    },
  };

  const promptFor = async (context: DiagnosisContext): Promise<{ system: string; user: string }> => {
    await svc.generateDiagnosticMessage(context);
    expect(callLLM).toHaveBeenCalled();
    const messages = callLLM.mock.calls[0][1] as Array<{ role: string; content: string }>;
    return {
      system: messages.find((m) => m.role === 'system')!.content,
      user: messages.find((m) => m.role === 'user')!.content,
    };
  };

  it('sends the operations that SUCCEEDED, not only the ones that failed', async () => {
    const { user } = await promptFor(PROD_CONTEXT);

    expect(user).toContain('publish_landing_page_changes');
    expect(user).toContain('generate_landing_page');
    // The failure list is still reported — this adds a view, it does not remove one.
    expect(user).toContain('Failed operations');
    expect(user).toMatch(/succeeded/i);
  });

  it('forbids claiming completed work was lost or must be re-run', async () => {
    const { system } = await promptFor(PROD_CONTEXT);

    expect(system).toMatch(/not\s+saved|lost/i);
    expect(system).toMatch(/timeout|timed out/i);
    // The rule that the production message violated: a timeout ends the run, it
    // does not roll back what already completed.
    expect(system).toMatch(/succeeded/i);
  });

  it('omits the success section entirely when nothing succeeded', async () => {
    const { user } = await promptFor({ ...PROD_CONTEXT, succeededFunctions: {} });

    expect(user).not.toMatch(/Succeeded operations/i);
    // A run where nothing worked must still report its failures.
    expect(user).toContain('Failed operations');
  });

  it('tolerates a context with no success ledger at all (older callers)', async () => {
    const { succeededFunctions, ...withoutLedger } = PROD_CONTEXT;
    const out = await svc.generateDiagnosticMessage(withoutLedger as DiagnosisContext);

    expect(out).toBe('diagnosed');
    const { user } = { user: (callLLM.mock.calls[0][1] as any[]).find((m) => m.role === 'user').content };
    expect(user).not.toMatch(/Succeeded operations/i);
  });
});
