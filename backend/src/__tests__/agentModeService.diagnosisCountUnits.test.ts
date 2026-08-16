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
 * ENG-1173 / ENG-1133. The ENG-971 fix gave the diagnosis agent the run's success
 * ledger, which was right — but it is a histogram of tool-call COUNTS, handed over as
 * bare JSON under the label "Succeeded operations" with no unit anywhere in the prompt.
 *
 * Production session 39eb5663 carried `{"add_leads_to_list": 3}` (three batches of
 * 25 = 75 leads written) and the model reported "successfully added the 3 leads".
 * Reading `3` as a lead count is the only reasonable reading of what it was sent.
 *
 * The prompt-level fix SHIPPED WITH ENG-1133, which reached the same diagnosis from
 * the import side and labelled both ledgers (succeeded AND failed — this file pins
 * both). These tests are therefore a regression pin on wording that already landed,
 * not a claim to it. ENG-1173's own contribution is the deterministic backstop in
 * falseFailureReport: a prompt rule is guidance, not a guarantee, and the model is
 * still free to ignore it.
 */
describe('generateDiagnosticMessage — run counts are labelled, not entity counts (ENG-1133)', () => {
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

  /** The production shape of session 39eb5663 at the moment the turn timed out. */
  const PROD_CONTEXT: DiagnosisContext = {
    errorType: 'unknown',
    errorMessage:
      'Generation timed out after 600000ms for session 39eb5663-126a-4ee4-bc0a-7543232b1aed.',
    userMessage: 'Import this CSV of 97 approved attendees into a new CRM list.',
    workPlanSummary: null,
    succeededFunctions: {
      install_skills: 1,
      perform_data_analysis: 2,
      read_file_content: 1,
      add_leads_to_list: 3,
      get_lead_lists: 1,
      read_tool_response: 6,
    },
    failedFunctions: null,
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

  it('states in the user prompt that the numbers are run counts', async () => {
    const { user } = await promptFor(PROD_CONTEXT);

    expect(user).toMatch(/number of times it RAN/i);
    expect(user).toMatch(/NOT a count of records/i);
    // The ledger itself is still sent — this adds the unit, it does not remove data.
    expect(user).toContain('add_leads_to_list');
  });

  it('labels the FAILED ledger with the same unit', async () => {
    const { user } = await promptFor({
      ...PROD_CONTEXT,
      failedFunctions: { add_leads_to_list: 2 },
    });

    expect(user).toMatch(/Failed operations[^\n]*number of times it FAILED/i);
    expect(user).toMatch(/Failed operations[^\n]*NOT a count of records/i);
  });

  it('forbids restating those counts as a quantity of records', async () => {
    const { system } = await promptFor(PROD_CONTEXT);

    expect(system).toMatch(/never restate a run count as a quantity/i);
    expect(system).toMatch(/leads|records|rows/i);
    // Names the exact production misreading so the rule cannot be softened blindly.
    expect(system).toMatch(/add_leads_to_list["']?:\s*3/);
  });

  it('still carries the ENG-971 no-lost-work rules', async () => {
    const { system } = await promptFor(PROD_CONTEXT);

    expect(system).toMatch(/not\s+saved|lost/i);
    expect(system).toMatch(/succeeded/i);
  });

  it('omits the success section (and its unit note) when nothing succeeded', async () => {
    const { user } = await promptFor({ ...PROD_CONTEXT, succeededFunctions: {} });

    expect(user).not.toMatch(/Succeeded operations/i);
    expect(user).not.toMatch(/number of times it RAN/i);
  });
});
