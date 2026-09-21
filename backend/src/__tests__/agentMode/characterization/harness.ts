/**
 * Characterization harness for the AgentMode agentic-core strangler migration.
 *
 * Purpose: PIN the OBSERVABLE behavior of the REAL `generateMarketingResponse`
 * loop so that every future seam extraction can be proven behavior-preserving.
 *
 * This is the single highest-leverage artifact of the migration: it is reused
 * by every seam PR. The contract it captures is:
 *   1. The exact tool-call sequence (name + arguments + success/error + order)
 *   2. The final `content` string
 *   3. The shape of `responseMessages` (roles + tool names, in order)
 *
 * It does this WITHOUT touching the network: `callLLM` is replaced by a scripted
 * transcript, and tool execution (`executeTool`, which `executePreparedAgentTool`
 * delegates to) is replaced by keyed mock results. The rest of the loop — policy
 * evaluation, arg validation/repair, the gateway dispatch, message appending,
 * termination decisions, anti-loop detection — runs FOR REAL.
 *
 * Mocking style matches the existing ~134 agentMode test files (jest.spyOn on the
 * service instance for `callLLM` / `executeTool`; jest.mock for db/skills/etc).
 * The per-test `jest.mock(...)` calls must live in the test file (they are hoisted);
 * this harness wires the runtime spies + builders + snapshotting.
 */

import { AgentModeService } from '../../../services/agentModeService';

/** One scripted LLM turn. Mirrors the subset of the OpenAI/Claude response the loop reads. */
export interface ScriptedTurn {
  /** assistant text content for this turn (string form; '' for tool-only or empty turns) */
  content?: string;
  /** tool calls the model emits this turn; omit/empty for a terminal text turn */
  tool_calls?: Array<{
    id: string;
    name: string;
    /** JSON string of arguments, exactly as the model would emit (the loop JSON.parses this) */
    arguments: string;
  }>;
  /** finish_reason: 'stop' | 'tool_calls' | 'length' | 'content_filter' (default inferred) */
  finish_reason?: string;
  /** stop_reason passthrough (Claude) */
  stop_reason?: string;
}

/** A mock result for a tool, keyed by tool name (optionally by call id for fine control). */
export interface ScriptedToolResult {
  /** if set, the tool "fails": executeTool throws this error */
  error?: string;
  /** otherwise the tool returns this (object or string, as the real tool would) */
  result?: any;
}

export interface HarnessScenario {
  /** ordered LLM turns; one per loop iteration that reaches callLLM */
  transcript: ScriptedTurn[];
  /** mock results keyed by `${toolName}` or `${toolName}#${callId}` for precise control */
  toolResults?: Record<string, ScriptedToolResult>;
  /** the user message that starts the run */
  message?: string;
  /** prior session history */
  sessionHistory?: any[];
}

/** The OBSERVABLE snapshot the harness pins. Anything not here is internal and may change. */
export interface BehaviorSnapshot {
  /** the final assistant content returned to the user */
  content: string;
  /** the exact tool-call sequence the loop produced, in order */
  toolCallSequence: Array<{
    name: string;
    arguments: any;
    outcome: 'success' | 'error';
  }>;
  /** number of LLM turns actually consumed (proves termination decisions unchanged) */
  llmTurnsConsumed: number;
  /** shape of responseMessages: role + (tool) name, in order */
  responseMessageShape: Array<{ role: string; name?: string }>;
  /** whether the run reported cancellation */
  cancelled: boolean;
}

/** Build a scripted LLM response object in the shape `generateMarketingResponse` consumes. */
export function buildLLMResponse(turn: ScriptedTurn): any {
  const hasTools = Array.isArray(turn.tool_calls) && turn.tool_calls.length > 0;
  const finish_reason = turn.finish_reason ?? (hasTools ? 'tool_calls' : 'stop');
  const message: any = {
    role: 'assistant',
    content: turn.content ?? '',
    tool_calls: hasTools
      ? turn.tool_calls!.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments },
        }))
      : null,
  };
  return {
    choices: [{ message, finish_reason, stop_reason: turn.stop_reason }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

/**
 * Wire the runtime spies for a scenario onto a fresh AgentModeService instance and
 * run the REAL `generateMarketingResponse`. Returns the observable BehaviorSnapshot.
 *
 * IMPORTANT: the caller's test file MUST declare the standard agentMode jest.mock
 * block (openai / settingsService / db / chatbotService / secretsManager /
 * skillService / subscriptionService) — those are module-hoisted and cannot be set
 * from here. Use `installStandardMockDeps()` in beforeEach to fill the runtime stubs.
 */
export async function runScenario(
  service: AgentModeService,
  scenario: HarnessScenario,
): Promise<BehaviorSnapshot> {
  return (await runScenarioWithResult(service, scenario)).snapshot;
}

/**
 * As `runScenario`, but also hands back the RAW `generateMarketingResponse` result.
 *
 * `BehaviorSnapshot` deliberately reduces `responseMessages` to roles and tool names
 * and drops their content, so it cannot answer "what text was actually persisted into
 * the transcript?" — which is exactly the claim the ENG-1054 residue guard makes. Use
 * this when an assertion needs the persisted message bodies; use `runScenario` (the
 * pinned contract) for everything else.
 */
export async function runScenarioWithResult(
  service: AgentModeService,
  scenario: HarnessScenario,
): Promise<{ snapshot: BehaviorSnapshot; result: any }> {
  const callLLMSpy = jest.spyOn(service as any, 'callLLM');
  for (const turn of scenario.transcript) {
    callLLMSpy.mockResolvedValueOnce(buildLLMResponse(turn));
  }
  // Safety net: if the loop calls beyond the scripted transcript, return a terminal turn
  callLLMSpy.mockResolvedValue(buildLLMResponse({ content: '[end-of-script]' }));

  // Intercept tool execution at `executeTool` — the real `executePreparedAgentTool`
  // (and thus policy eval + the gateway) still runs; only the leaf execution is mocked.
  jest.spyOn(service as any, 'executeTool').mockImplementation(async (...args: any[]) => {
    const toolName: string = args[1];
    const keyed = scenario.toolResults?.[toolName];
    if (keyed?.error) {
      throw new Error(keyed.error);
    }
    if (keyed && 'result' in keyed) {
      return keyed.result;
    }
    return JSON.stringify({ success: true, data: `mock:${toolName}` });
  });

  // Suppress suggested-reply generation (it makes an extra LLM call and is not part
  // of the migration contract).
  jest.spyOn(service as any, 'generateSuggestedReplies').mockResolvedValue([]);

  const result = await service.generateMarketingResponse(
    scenario.message ?? 'Do the task.',
    (scenario.sessionHistory ?? []) as any,
    'test-user',
    service.default_model,
    'test-session',
  );

  return { snapshot: snapshotResult(result, callLLMSpy.mock.calls.length), result };
}

/** Reduce a generateMarketingResponse result to its observable snapshot. */
export function snapshotResult(result: any, llmTurnsConsumed: number): BehaviorSnapshot {
  const toolCallSequence = (result.toolCalls ?? []).map((tc: any) => ({
    name: tc.name,
    arguments: tc.arguments,
    outcome: tc.error ? ('error' as const) : ('success' as const),
  }));
  const responseMessageShape = (result.responseMessages ?? []).map((m: any) => ({
    role: m.role,
    ...(m.name ? { name: m.name } : {}),
  }));
  return {
    content: result.content,
    toolCallSequence,
    llmTurnsConsumed,
    responseMessageShape,
    cancelled: Boolean(result.cancelled),
  };
}

/**
 * Fill the runtime mock stubs that the standard jest.mock block leaves empty.
 * Call from beforeEach AFTER `jest.clearAllMocks()`. Matches the canonical
 * `mockDeps()` helper duplicated across the existing agentMode tests.
 */
export function installStandardMockDeps(session?: any): void {
  const mockChatbotService = require('../../../services/chatbotService');
  mockChatbotService.chatbotDb = {
    getChatSession: jest.fn().mockResolvedValue(
      session ?? { sessionId: 'test-session', messages: [], associatedSkills: null },
    ),
    addMessagesToSession: jest.fn().mockResolvedValue(undefined),
    incrementFailedFunctions: jest.fn().mockResolvedValue(undefined),
    incrementCalledFunctions: jest.fn().mockResolvedValue(undefined),
  };

  const mockSettingsService = require('../../../services/settingsService');
  mockSettingsService.settingsService = {
    getSetting: jest.fn().mockResolvedValue(null),
  };

  const mockDb = require('../../../services/db');
  mockDb.userDb = {
    getUserById: jest.fn().mockResolvedValue({ userId: 'test-user', isAdmin: false }),
  };
  mockDb.accountMemoryDb = {
    getRecentMemories: jest.fn().mockResolvedValue([]),
    getUserMemories: jest.fn().mockResolvedValue([]),
    setMemoryEmbedding: jest.fn().mockResolvedValue(undefined),
  };
  mockDb.orgMemoryDb = { getOrgMemories: jest.fn().mockResolvedValue([]) };
  mockDb.orgDb = { getUserOrg: jest.fn().mockResolvedValue(null) };
}
