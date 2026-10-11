import { classifyToolErrorClass, KNOWN_TOOL_ERROR_CLASSES } from '../utils/toolErrorClassifier';

/** The subset of CodingAgentResult this classifier reads (kept import-free of the service). */
export interface CodingAgentFailureInput {
  success: boolean;
  message: string;
  notAuthorized?: boolean;
  state?: string;
}

/**
 * ENG-1949 — semantic error class for a failed coding_agent run, emitted on
 * the tool's structured failure result. Production telemetry showed the
 * generic `Error` bucket was mostly runs whose failure message is the
 * sub-agent's own prose summary (build/acceptance failed after edits), plus
 * iteration-limit exhaustion and LLM transport errors — none classifiable by
 * message text. Returns undefined for successful runs.
 */
const CODING_AGENT_ERROR_PREFIX = 'Coding agent encountered an error: ';

export function classifyCodingAgentFailure(result: CodingAgentFailureInput): string | undefined {
  if (result.success) return undefined;
  if (result.notAuthorized) return 'auth';
  if (result.state === 'timed_out' || result.state === 'cancelled') return 'timeout';
  const message = result.message || '';
  if (message.startsWith(CODING_AGENT_ERROR_PREFIX)) {
    const cls = classifyToolErrorClass(new Error(message.slice(CODING_AGENT_ERROR_PREFIX.length)));
    return KNOWN_TOOL_ERROR_CLASSES.has(cls) ? cls : 'upstream_5xx';
  }
  if (message.startsWith('Cannot prepare preview branch:')) {
    // Permanent page-configuration errors: retrying can never succeed.
    if (/has no GitHub repository|invalid GitHub repo URL/i.test(message)) return 'upstream_rejected';
    const cls = classifyToolErrorClass(new Error(message));
    return KNOWN_TOOL_ERROR_CLASSES.has(cls) ? cls : 'upstream_5xx';
  }
  // Iteration-limit exhaustion, failed build/deploy, failed or blocked
  // acceptance: the agent ran but did not produce a verified change.
  return 'invalid_output';
}

