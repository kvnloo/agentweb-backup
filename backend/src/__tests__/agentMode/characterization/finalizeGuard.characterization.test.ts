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
const JUDGE_VERDICT = '[{"claimClass":"email_sent","statement":"sent the email"}]';
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

  it('SHADOW mode: judge runs (for telemetry) but the corrective turn never does (ENG-2150 fix) — the delivered message is the ORIGINAL untrue claim', async () => {
    delete process.env.AGENT_FINALIZE_GUARD;
    process.env.AGENT_FINALIZE_GUARD_SHADOW = 'true';

    const snapshot = await runScenario(service, {
      message: 'Send the report email to the client.',
      transcript: [
        { content: UNTRUE_CLAIM },     // main loop final turn (no tools ran)
        { content: JUDGE_VERDICT },    // judge call still runs — shadow mode still detects
        // No CORRECTED turn: detectOnly means the corrective port is never called, so
        // there is no third transcript entry to consume. A stray unconsumed CORRECTED
        // entry would be a bug in the harness, not the guard, so it is left out here.
      ],
    });

    const expected: BehaviorSnapshot = {
      content: UNTRUE_CLAIM, // NOT corrected — shadow mode never rewrites what the user sees
      toolCallSequence: [],
      // One fewer LLM turn than enforce mode: shadow reports the mismatch (detected_mismatch)
      // straight from the judge call, and never pays for a corrective turn whose text would
      // only be discarded (ENG-2150: the guard shadow was billing a real correction to the
      // customer's own session and making them wait for it, purely to throw the text away).
      llmTurnsConsumed: 2,
      responseMessageShape: [{ role: 'assistant' }],
      cancelled: false,
    };
    expect(snapshot).toEqual(expected);

    delete process.env.AGENT_FINALIZE_GUARD_SHADOW;
  });

  it('enforce mode wins when both AGENT_FINALIZE_GUARD and AGENT_FINALIZE_GUARD_SHADOW are set', async () => {
    process.env.AGENT_FINALIZE_GUARD = 'true';
    process.env.AGENT_FINALIZE_GUARD_SHADOW = 'true';

    const snapshot = await runScenario(service, {
      message: 'Send the report email to the client.',
      transcript: [
        { content: UNTRUE_CLAIM },
        { content: JUDGE_VERDICT },
        { content: CORRECTED },
      ],
    });

    expect(snapshot.content).toBe(CORRECTED);

    delete process.env.AGENT_FINALIZE_GUARD_SHADOW;
  });
});
