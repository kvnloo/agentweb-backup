/**
 * Finalize-guard ledger mapping — the monolith's toolCalls → FinalizeLedgerEntry
 * map in agentModeService.generateMarketingResponse (edge fix d23bd0d7).
 *
 * The dispatch ledger (core/toolDispatch.ts) has two never-EXECUTED entry shapes:
 *   - a suppressed same-turn duplicate: { duplicateOf: <original id> }, no
 *     result, no error (appendSuppressedDuplicate)
 *   - a budget-deferred media call: { result: { deferred: true, reason:
 *     'media_generation_time_budget' } } (the deferred branch)
 *
 * The monolith must map BOTH to status 'deferred' so finalizeGuard's
 * claimBackedByLedger (which requires status === 'success') never accepts them
 * as backing for a completed-action claim. Pre-fix, a duplicateOf entry (no
 * error, no result) fell through to 'success' and falsely backed the claim
 * when the ORIGINAL call had failed — this test pins that exact scenario
 * through the REAL loop: the model emits two identical send_email calls in one
 * turn, the executed original FAILS, the second is suppressed as a duplicate,
 * and the model then claims the email was sent. The guard must find the claim
 * UNBACKED and run the corrective turn.
 */

import { AgentModeService } from '../../services/agentModeService';
import {
  runScenario,
  installStandardMockDeps,
  type BehaviorSnapshot,
} from './characterization/harness';

// Standard agentMode mock block (module-hoisted — must live in the test file).
jest.mock('openai');
jest.mock('../../services/settingsService');
jest.mock('../../services/db');
jest.mock('../../services/chatbotService');
jest.mock('../../utils/secretsManager');
jest.mock('../../services/skillService', () => ({
  skillService: {
    getPublishedSkills: jest.fn().mockResolvedValue([]),
    getSkillsByIds: jest.fn().mockResolvedValue([]),
  },
}));
jest.mock('../../services/subscriptionService', () => ({
  getAllowedSkills: jest.fn().mockResolvedValue(['*']),
  resolveSkillsToToolNames: jest.fn().mockResolvedValue(['*']),
  filterFunctionCalls: jest.fn().mockImplementation((tools: any) => tools),
}));

const EMAIL_ARGS = '{"to":"client@example.com","subject":"Weekly report"}';
const UNTRUE_CLAIM = "Done! I've sent the email to the client with the report attached.";
const JUDGE_VERDICT = '[{"claimClass":"email_sent"}]';
const CORRECTED =
  'I was not able to send the email — the send_email call failed in this session. Ask me to retry and I will attempt it again.';

describe('AgentMode finalize guard — monolith ledger mapping (suppressed duplicates never back a claim)', () => {
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

  it('a duplicateOf ledger entry maps to deferred (non-backing) — failed original + suppressed duplicate still triggers the corrective turn', async () => {
    const snapshot = await runScenario(service, {
      message: 'Send the weekly report email to the client.',
      transcript: [
        {
          // ONE assistant turn, two IDENTICAL send_email calls: e1 executes (and
          // fails), e2 is collapsed by the same-turn dedupe into a suppressed
          // duplicate ledger entry ({ duplicateOf: 'e1' }, no result, no error).
          tool_calls: [
            { id: 'e1', name: 'send_email', arguments: EMAIL_ARGS },
            { id: 'e2', name: 'send_email', arguments: EMAIL_ARGS },
          ],
        },
        { content: UNTRUE_CLAIM }, // main loop final turn — claims the email went out
        { content: JUDGE_VERDICT }, // judge call extracts [email_sent]
        { content: CORRECTED }, // corrective turn restates the true outcome
      ],
      toolResults: {
        send_email: { error: 'SMTP 550: mailbox rejected the message' },
      },
    });

    const expected: BehaviorSnapshot = {
      // The corrective turn fired — so the suppressed duplicate (which the
      // harness snapshot reduces to outcome 'success' because it carries no
      // error) was mapped to a NON-backing 'deferred' ledger status. Pre-fix it
      // mapped to 'success', falsely backed the email_sent claim, and the
      // untrue text was delivered unchanged in 3 turns.
      content: CORRECTED,
      toolCallSequence: [
        { name: 'send_email', arguments: { to: 'client@example.com', subject: 'Weekly report' }, outcome: 'error' },
        // the suppressed duplicate: no error on the ledger entry, so the
        // snapshot reduction reports 'success' — exactly why the monolith's
        // mapping must key on duplicateOf, not on error-absence alone
        { name: 'send_email', arguments: { to: 'client@example.com', subject: 'Weekly report' }, outcome: 'success' },
      ],
      llmTurnsConsumed: 4, // tools + untrue claim + judge + corrective
      responseMessageShape: [
        { role: 'assistant' },
        { role: 'tool', name: 'send_email' }, // e1 — executed, failed
        { role: 'tool', name: 'send_email' }, // e2 — suppressed-duplicate note
        { role: 'assistant' },
      ],
      cancelled: false,
    };
    expect(snapshot).toEqual(expected);
  });
});
