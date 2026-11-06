// ENG-2160 deterministic close: on an empty success ledger, getDiagnosticErrorMessage must NOT
// call the LLM diagnosis agent — it returns a fixed, honest, error-type-aware message. This makes
// empty-ledger fabrication structurally impossible (no model in the loop for that case).

jest.mock('aws-sdk', () => ({
  config: { update: jest.fn() },
  DynamoDB: { DocumentClient: jest.fn(() => ({})) },
  S3: jest.fn(() => ({})),
}));

const mockGetChatSession = jest.fn();
jest.mock('../services/chatbotService', () => ({
  chatbotDb: { getChatSession: mockGetChatSession },
  filterMessagesForClient: (m: any[]) => m,
}));

const mockGenerateDiagnosticMessage = jest.fn();
jest.mock('../services/agentModeService', () => ({
  agentModeService: { generateDiagnosticMessage: mockGenerateDiagnosticMessage },
  AgentModeService: class {},
  normalizeWorkPlanTitleForMatch: (x: string) => x,
  ADMIN_SKILL_TOOL_NAMES: [],
}));
jest.mock('../services/db', () => ({ scheduleDb: {}, userDb: {}, taskDb: {}, scheduleTemplateDb: {} }));
jest.mock('../services/emailService', () => ({ emailService: {} }));
jest.mock('../services/settingsService', () => ({ settingsService: {} }));
jest.mock('../services/workPlanService', () => ({ workPlanService: {} }));
jest.mock('../services/generateMarketingResponseWorkerService', () => ({ generateMarketingResponseWorkerService: {} }));
jest.mock('../utils/sseProgress', () => ({
  emitProgress: jest.fn(), registerProgressCallback: jest.fn(), getLatestProgress: jest.fn(),
  progressStore: {}, requestCancel: jest.fn(), clearCancel: jest.fn(),
}));
jest.mock('../services/skillService', () => ({ skillService: {} }));
jest.mock('../services/subscriptionService', () => ({ getAllowedSkills: jest.fn() }));
jest.mock('../services/tokenUsageService', () => ({ checkTokenUsage: jest.fn() }));
jest.mock('../services/voiceService', () => ({ transcribeSpeech: jest.fn() }));
jest.mock('../utils/s3Utils', () => ({ uploadFileToS3: jest.fn(), uploadScreenshotToS3: jest.fn() }));
jest.mock('../utils/agentModeAlerts', () => ({ sendAgentModeOncallAlert: jest.fn() }));
jest.mock('../docs/agentModeSystemPrompt', () => ({ ABOUT_AGENTWEB_TEAM: '' }));
jest.mock('../middleware/auth', () => ({ getUserFromToken: jest.fn() }));

import { getDiagnosticErrorMessage, deterministicEmptyLedgerMessage } from '../controllers/agentModeController';

describe('ENG-2160 deterministic empty-ledger close', () => {
  beforeEach(() => { jest.clearAllMocks(); jest.spyOn(console, 'error').mockImplementation(); });
  afterEach(() => jest.restoreAllMocks());

  it('empty ledger + 429: returns fixed rate-limit message and does NOT call the LLM diagnosis', async () => {
    mockGetChatSession.mockResolvedValue({ userId: 'u1', calledFunctions: {}, messages: [], failedFunctions: null });
    const err: any = new Error('high demand'); err.status = 429;
    const res = await getDiagnosticErrorMessage(err, 'sid', 'pull the guest list', null, undefined);
    expect(mockGenerateDiagnosticMessage).not.toHaveBeenCalled();
    expect(res.message).toMatch(/nothing was done yet|temporary capacity/i);
    expect(res.message).not.toMatch(/successfully/i);
  });

  it('non-empty ledger: DOES call the LLM diagnosis (short-circuit not taken)', async () => {
    mockGetChatSession.mockResolvedValue({ userId: 'u1', calledFunctions: { search_leads: 1 }, messages: [], failedFunctions: null });
    mockGenerateDiagnosticMessage.mockResolvedValue('contextual diagnosis');
    const err: any = new Error('Generation timed out');
    const res = await getDiagnosticErrorMessage(err, 'sid', 'do a thing', null, undefined);
    expect(mockGenerateDiagnosticMessage).toHaveBeenCalledTimes(1);
    expect(res.message).toBe('contextual diagnosis');
  });

  it('deterministicEmptyLedgerMessage is honest and error-type-aware', () => {
    const rl: any = new Error('high demand'); rl.status = 429;
    expect(deterministicEmptyLedgerMessage(rl)).toMatch(/capacity|try again/i);
    expect(deterministicEmptyLedgerMessage(new Error('whatever'))).toMatch(/nothing was done yet/i);
    // never claims success
    for (const e of [rl, new Error('x')]) expect(deterministicEmptyLedgerMessage(e)).not.toMatch(/successfully/i);
  });
});
