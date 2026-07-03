/**
 * End-to-end landing-page EDIT smoke test (ENG-46).
 *
 * This is the CI analogue of the post-deploy landing-page-edit smoke test that
 * regressed: a request pinned the retired model id `gpt-5.1`, `generateMarketingResponse`
 * threw an opaque "Invalid model" deep inside `callLLM`, and the edit tool never ran
 * — surfacing to the user as "I encountered an error…". The judges scored it 1/5 and
 * mislabeled it a tool-path failure; the real cause was the model id.
 *
 * Unlike `agentModeService.modelValidation.test.ts` (which unit-tests the resolver and
 * halts before generation), this drives the REAL `generateMarketingResponse` loop
 * end-to-end and PINS the observable behavior that closes the incident:
 *
 *   1. A request with the retired `gpt-5.1` id must NOT surface "Invalid model" /
 *      an opaque error — it completes.
 *   2. `callLLM` must only ever receive a served (allow-listed) model — never `gpt-5.1`.
 *      The stub below faithfully re-throws the production "Invalid model" error if an
 *      unlisted id reaches it, so REMOVING the up-front resolution fails this test.
 *   3. The `coding_agent` edit tool must actually be dispatched and succeed — proving
 *      the tool path runs, not just that the model resolved.
 *
 * Mocking style matches the characterization harness: the runtime spies replace
 * `callLLM` (scripted transcript) and `executeTool` (mock leaf result); the rest of
 * the loop — policy eval, arg validation, gateway dispatch, termination — runs FOR REAL.
 */

import { AgentModeService } from '../../services/agentModeService';
import {
  buildLLMResponse,
  installStandardMockDeps,
  snapshotResult,
  type ScriptedTurn,
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

// The scripted edit conversation: iteration 1 delegates the landing-page edit to
// coding_agent; iteration 2 relays the staging/preview result back to the user.
const EDIT_TRANSCRIPT: ScriptedTurn[] = [
  {
    tool_calls: [
      {
        id: 'call-edit-1',
        name: 'coding_agent',
        arguments: JSON.stringify({
          page_id: 'lp-smoke-123',
          task_description: "Change the hero headline to 'Welcome to Acme'",
        }),
      },
    ],
  },
  {
    content:
      'Done — your headline edit is on the staging preview branch (not live yet). Review it and ask me to publish when ready.',
  },
];

const CODING_AGENT_RESULT = JSON.stringify({
  success: true,
  previewUrl: 'https://preview.example.com/lp-smoke-123',
  branch: 'draft/agentweb-preview',
});

/**
 * Run the REAL generateMarketingResponse for the edit transcript against `requestedModel`.
 * `callLLM` is stubbed to (a) faithfully reproduce the production allow-list guard so a
 * regression that lets an invalid id through fails loudly, and (b) return the scripted turns.
 */
async function runEditSmoke(service: AgentModeService, requestedModel: string) {
  const servedModels = new Set(Object.keys((service as any).llmModels));

  let turnIndex = 0;
  const callLLMSpy = jest
    .spyOn(service as any, 'callLLM')
    .mockImplementation(async (...args: any[]) => {
      const model = args[0] as string;
      const normalized = service.normalizeModelId(model);
      if (!normalized || !servedModels.has(normalized)) {
        // The exact failure the incident hit — if the up-front resolution is ever
        // removed, `gpt-5.1` reaches here and this throws, failing the assertions below.
        throw new Error(
          `Invalid model '${model}'. Available models: ${[...servedModels].join(', ')}`,
        );
      }
      const turn = EDIT_TRANSCRIPT[turnIndex] ?? { content: '[end-of-script]' };
      turnIndex += 1;
      return buildLLMResponse(turn);
    });

  // Mock only the leaf tool execution; the real policy/dispatch still runs.
  jest.spyOn(service as any, 'executeTool').mockImplementation(async (...args: any[]) => {
    const toolName: string = args[1];
    if (toolName === 'coding_agent') return CODING_AGENT_RESULT;
    return JSON.stringify({ success: true, data: `mock:${toolName}` });
  });

  jest.spyOn(service as any, 'generateSuggestedReplies').mockResolvedValue([]);

  const result = await service.generateMarketingResponse(
    'Edit my landing page: change the hero headline to "Welcome to Acme".',
    [],
    'test-user',
    requestedModel,
    'landing-page-edit-smoke-session',
  );

  return { result, snapshot: snapshotResult(result, callLLMSpy.mock.calls.length), callLLMSpy, servedModels };
}

describe('AgentMode landing-page edit smoke (ENG-46)', () => {
  let service: AgentModeService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AgentModeService();
    installStandardMockDeps();
  });

  it('completes an edit requested with the retired gpt-5.1 id and actually runs coding_agent', async () => {
    const { snapshot, callLLMSpy, servedModels } = await runEditSmoke(service, 'gpt-5.1');

    // 1. The edit tool actually ran and succeeded (tool path works).
    const codingAgentCalls = snapshot.toolCallSequence.filter((t) => t.name === 'coding_agent');
    expect(codingAgentCalls).toHaveLength(1);
    expect(codingAgentCalls[0].outcome).toBe('success');

    // 2. The final content is the assistant's real reply — NOT an opaque error.
    expect(snapshot.content).toContain('staging preview');
    expect(snapshot.content).not.toMatch(/encountered an error|unknown error|invalid model/i);

    // 3. callLLM only ever saw a served model — the retired id never reached it,
    //    and the first turn ran on the configured default fallback.
    expect(callLLMSpy).toHaveBeenCalled();
    for (const call of callLLMSpy.mock.calls) {
      expect(call[0]).not.toBe('gpt-5.1');
      expect(servedModels.has(service.normalizeModelId(call[0] as string))).toBe(true);
    }
    expect(callLLMSpy.mock.calls[0][0]).toBe(service.default_model);
  });

  it('runs the identical edit path when a valid model is requested (no fallback needed)', async () => {
    const { snapshot, callLLMSpy } = await runEditSmoke(service, 'gpt-5.5');

    const codingAgentCalls = snapshot.toolCallSequence.filter((t) => t.name === 'coding_agent');
    expect(codingAgentCalls).toHaveLength(1);
    expect(codingAgentCalls[0].outcome).toBe('success');
    expect(snapshot.content).toContain('staging preview');
    // A valid id is honored as-is — no substitution.
    expect(callLLMSpy.mock.calls[0][0]).toBe('gpt-5.5');
  });
});
