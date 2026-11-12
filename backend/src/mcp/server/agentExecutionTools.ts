/**
 * ENG-2948 (ENG-2847.9) — single source of truth for main-MCP tools that
 * execute, resume, or delegate to the Emma agent.
 *
 * Purpose: an external deterministic caller (Yugo acting on customer accounts
 * via AW keys) must be able to build an allowlist that excludes every tool
 * capable of starting or resuming an agent run. The `emma_` prefix is NOT a
 * reliable signal — e.g. `emma_get_brand_profile` is deterministic — so the
 * classification is an explicit list.
 *
 * Additive only: nothing in the server enforces this list yet. Enforcement on
 * keys is a scope/security-posture decision tracked under ENG-2910.
 */

export const AGENT_EXECUTION_TOOLS: readonly string[] = Object.freeze([
  // Delegation entry point: creates the session agent runs attach to.
  'emma_create_session',
  // Execute or resume the agent.
  'emma_send_message',
  'emma_answer_question_deck',
  'emma_launch_work_plan',
  'emma_answer_work_plan_input',
  'execute_task',
  'test_scheduled_chat',
  'emma_run_marketing_task',
  // Executes the agent when an immediate run is requested; classified
  // conservatively as execution for allowlist purposes.
  'submit_scheduled_chat_variables',
]);

const AGENT_EXECUTION_TOOL_SET: ReadonlySet<string> = new Set(AGENT_EXECUTION_TOOLS);

/** True when the tool can execute, resume, or delegate to the Emma agent. */
export function isAgentExecutionTool(name: string): boolean {
  return AGENT_EXECUTION_TOOL_SET.has(name);
}

/** Returns the input tool names minus every agent-execution tool, order preserved. */
export function filterDeterministicTools(names: readonly string[]): string[] {
  return names.filter((name) => !isAgentExecutionTool(name));
}
