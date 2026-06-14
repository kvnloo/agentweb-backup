/**
 * `executeAgentStep` — the ONE-ITERATION contract of the AgentMode core loop.
 *
 * This is the seam the monolith is being strangled onto. The target shape (from
 * Claude Code / the OpenAI agent loop) is a single legible step:
 *
 *     model call → parse tool calls → dispatch via gateway → append results →
 *     decide termination
 *
 * For THIS proof slice the skeleton documents the contract and exposes the typed
 * boundary; it intentionally delegates the heavy lifting (LLM call, policy eval,
 * arg validation/repair, gateway dispatch, message trimming) back into the
 * monolith's existing helpers. The point is to establish the seam + the typed
 * StepInput/StepResult boundary — NOT to yank all ~660 loop lines at once. Each
 * subsequent seam PR moves one responsibility behind this boundary, proven
 * behavior-preserving by the characterization harness.
 *
 * The first responsibility actually living behind a pure core module is the
 * termination decision (see ./termination.ts), which the monolith loop now calls.
 */

import { decideTermination, type TerminationInput } from './termination';
import type { StepResult } from './types';

/**
 * Compute the termination decision for a model turn that returned NO tool calls.
 * Thin re-export so the monolith imports the seam from `core/` rather than the
 * leaf module directly — keeps the migration boundary in one place.
 */
export function computeTermination(input: TerminationInput) {
  return decideTermination(input);
}

/**
 * Skeleton for the future single-step executor. Once the seams below are migrated
 * this becomes the body of the core loop's iteration. It is NOT wired into the
 * monolith in this proof slice (the monolith still owns the loop); it documents
 * the contract the extractions converge toward.
 *
 * Planned seams (strangler order):
 *   1. termination decision           — DONE (./termination.ts) ✅
 *   2. tool-call parse/normalization  — extract `JSON.parse(arguments)` + shaping
 *   3. tool dispatch boundary         — `executePreparedTools` behind ToolRegistry
 *   4. anti-loop detection            — pure policy (consecutive + sliding window)
 *   5. message trimming               — wire existing `trimToolMessagesForContext`
 *   6. model backup selection         — already inside `callLLM`
 */
export async function executeAgentStep(): Promise<StepResult> {
  // Deliberately unimplemented in the proof slice. The monolith's loop body is the
  // current implementation; this signature reserves the seam. Throwing here makes
  // accidental early use loud rather than silently wrong.
  throw new Error(
    'executeAgentStep is a migration seam skeleton — not yet wired. ' +
      'The monolith loop owns iteration execution until later seams are extracted.',
  );
}
