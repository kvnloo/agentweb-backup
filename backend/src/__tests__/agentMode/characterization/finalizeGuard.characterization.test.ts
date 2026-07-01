/**
 * Characterization snapshot for the finalize guard ON-path (AGENT_FINALIZE_GUARD).
 *
 * The guard is an A-or-B migration flag, DEFAULT OFF. The existing
 * characterization suites prove the OFF-path is byte-identical (they run with
 * the flag unset). This file pins the ON-path — the corrective-turn transcript —
 * BEFORE anyone flips the flag, so the flip itself is a pinned, reviewable
 * behavior change rather than an unpinned one:
 *
 *   turn 1  (main loop)   — assistant claims "I've sent the email" with NO tool call
 *   turn 2  (judge call)  — structured claim extraction returns [email_sent]
 *   turn 3  (corrective)  — model restates the true outcome; re-check is clean
 *
 * Final content = the corrected text; message count unchanged (the last
 * assistant message is corrected in place, stamped with finalizeGuard metadata).
 */

import { AgentModeService } from '../../../services/agentModeService';
import {
  runScenario,
  installStandardMockDeps,
  type BehaviorSnapshot,
} from './harness';

// Standard agentMode mock block (module-hoisted — must live in the test file).
jest.mock('openai');
jest.mock('../../../services/settingsService');
jest.mock('../../../services/db');
jest.mock('../../../services/chatbotService');
jest.mock('../../../utils/secretsManager');
jest.mock('../../../services/skillService', () => ({
  skillService: {
    getPublishedSkills: jest.fn().mockResolvedValue([]),
    getSkillsByIds: jest.fn().mockResolvedValue([]),
  },
}));
jest.mock('../../../services/subscriptionService', () => ({
  getAllowedSkills: jest.fn().mockResolvedValue(['*']),
  resolveSkillsToToolNames: jest.fn().mockResolvedValue(['*']),
  filterFunctionCalls: jest.fn().mockImplementation((tools: any) => tools),
}));

const UNTRUE_CLAIM = "Done! I've sent the email to the client with the report attached.";
const JUDGE_VERDICT = '[{"claimClass":"email_sent"}]';
const CORRECTED = 'I was not able to complete the email step — the send_email tool did not run in this session. Ask me to retry and I will send it.';

describe('AgentMode finalize guard — ON-path characterization (flag pinned before flip)', () => {
  let service: AgentModeService;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.AGENT_FINALIZE_GUARD = 'true';
    service = new AgentModeService();
    installStandardMockDeps();
  });

  afterEach(() => {
    delete process.env.AGENT_FINALIZE_GUARD;
  });

  it('corrective-turn transcript — untrue email_sent claim is corrected via one judge + one corrective turn', async () => {
    const snapshot = await runScenario(service, {
      message: 'Send the report email to the client.',
      transcript: [
        { content: UNTRUE_CLAIM },     // main loop final turn (no tools ran)
        { content: JUDGE_VERDICT },    // judge call (claim extraction)
        { content: CORRECTED },        // corrective turn (restates the true outcome)
      ],
    });

    const expected: BehaviorSnapshot = {
      content: CORRECTED,
      toolCallSequence: [],
      llmTurnsConsumed: 3,
      responseMessageShape: [{ role: 'assistant' }],
      cancelled: false,
    };
    expect(snapshot).toEqual(expected);
  });

  it('flag OFF → guard never invoked: same transcript consumes ONE turn and delivers the claim unchanged', async () => {
    delete process.env.AGENT_FINALIZE_GUARD;

    const snapshot = await runScenario(service, {
      message: 'Send the report email to the client.',
      transcript: [
        { content: UNTRUE_CLAIM },
        { content: JUDGE_VERDICT },
        { content: CORRECTED },
      ],
    });

    const expected: BehaviorSnapshot = {
      content: UNTRUE_CLAIM,
      toolCallSequence: [],
      llmTurnsConsumed: 1,
      responseMessageShape: [{ role: 'assistant' }],
      cancelled: false,
    };
    expect(snapshot).toEqual(expected);
  });
});
