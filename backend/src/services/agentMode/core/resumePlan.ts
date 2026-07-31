/**
 * PURE resume-planning logic for abandoned scheduled runs (ENG-657).
 *
 * Root cause (prod-verified): an EB immutable deploy terminates the instance a
 * scheduled run is executing on (~1 min OS shutdown grace, well under the app's
 * 10-min drain). The ENG-324 reconciler then requeues the schedule — but requeue
 * starts a BRAND-NEW session and re-runs the whole task from scratch, so the
 * user's Steps 2/3 only ever land if a later full re-run happens to dodge another
 * deploy. Both reported sessions died right after their last tool result, with the
 * transcript already durably persisted up to that point.
 *
 * Resume (v1) instead CONTINUES the same session from its last persisted step —
 * but only when doing so is provably safe: the transcript must end on a settled,
 * balanced boundary that the agent loop can legally take one more turn from,
 * WITHOUT re-executing any side-effecting tool that already ran. Anything
 * ambiguous (a run killed mid-tool-execution, so a tool_use has no persisted
 * result) is declared NOT resumable and the caller falls back to the existing
 * restart-from-scratch requeue — conservative by design, since re-driving a
 * half-applied `enrich_leads_execute`/`send_email` is the one thing we must not do.
 *
 * This module is PURE: it inspects the persisted message array and returns a
 * decision. It performs no IO and mutates nothing.
 */

/** Minimal shape of a persisted chat message this planner needs to reason about. */
export interface ResumeMessage {
  role: 'system' | 'user' | 'assistant' | 'tool' | string;
  content?: unknown;
  /** OpenAI-shape tool calls on an assistant turn (each carries an `id`). */
  tool_calls?: Array<{ id?: string; function?: { name?: string } }>;
  /** tool-result linkage back to the assistant tool_call it answers. */
  tool_call_id?: string;
  metadata?: {
    /** ENG-324 reconciler "job incomplete" placeholder. */
    jobIncomplete?: boolean;
    /** ENG-473 surfaceFailedRun "please retry" placeholder. */
    isRunFailureNotice?: boolean;
    /** some persisters mirror tool calls under metadata rather than top-level. */
    toolCalls?: Array<{ id?: string; function?: { name?: string } }>;
    [k: string]: unknown;
  };
}

export type ResumeReason =
  | 'resumable_tool_boundary' // ends on a balanced tool result — model continues
  | 'resumable_user_prompt' // ends on an unanswered injected prompt
  | 'no_progress' // no real assistant/tool turn yet (turnless crash → existing path)
  | 'dangling_tool_call' // an assistant tool_use has no persisted result (mid-side-effect)
  | 'already_settled'; // ends on a final assistant text turn — nothing to continue

export interface ResumePlan {
  /** true only when the run can be safely continued from `resumeHistory`. */
  resumable: boolean;
  reason: ResumeReason;
  /**
   * The message history to re-seed the loop with when `resumable` — the persisted
   * transcript minus any trailing reconciler/failure placeholders. Undefined when
   * not resumable (the caller restarts from scratch instead).
   */
  resumeHistory?: ResumeMessage[];
}

/** A harness-written crash/abandon placeholder, not a genuine assistant turn. */
export function isRunFailurePlaceholder(m: ResumeMessage): boolean {
  return m?.metadata?.jobIncomplete === true || m?.metadata?.isRunFailureNotice === true;
}

/** Tool calls emitted by an assistant turn (top-level or mirrored under metadata). */
function toolCallsOf(m: ResumeMessage): Array<{ id?: string; function?: { name?: string } }> {
  if (Array.isArray(m.tool_calls) && m.tool_calls.length) return m.tool_calls;
  if (Array.isArray(m.metadata?.toolCalls) && m.metadata!.toolCalls!.length) return m.metadata!.toolCalls!;
  return [];
}

function hasText(m: ResumeMessage): boolean {
  const c = m.content;
  if (typeof c === 'string') return c.trim().length > 0;
  if (Array.isArray(c)) return c.some((b: any) => (typeof b?.text === 'string' ? b.text.trim().length > 0 : false));
  if (c && typeof c === 'object') return typeof (c as any).text === 'string' && (c as any).text.trim().length > 0;
  return false;
}

/**
 * Decide whether an abandoned scheduled run can be safely resumed from its
 * persisted transcript, and if so with what history.
 *
 * The last assistant `tool_calls` turn must be BALANCED — every tool_use id has a
 * matching persisted tool result — otherwise the run died mid-tool-execution and
 * re-driving it could double-apply a side effect, so we refuse to resume.
 */
export function planScheduledRunResume(messages: ResumeMessage[] = []): ResumePlan {
  // 1. Drop trailing harness placeholders — they are not real turns and must not
  //    be fed back to the model (they'd read as an assistant giving up).
  let history = messages.slice();
  while (history.length && isRunFailurePlaceholder(history[history.length - 1])) {
    history = history.slice(0, -1);
  }

  const nonSystem = history.filter((m) => m.role !== 'system');

  // 2. No genuine assistant/tool progress → not a resume case (a turnless crash;
  //    the existing turnless-failure path already handles it).
  const madeProgress = nonSystem.some(
    (m) => (m.role === 'assistant' && (hasText(m) || toolCallsOf(m).length > 0)) || m.role === 'tool'
  );
  if (!madeProgress) return { resumable: false, reason: 'no_progress' };

  // 3. Every assistant tool_use must have a matching persisted tool result.
  //    A dangling tool_use means the instance died mid-tool-execution — the tool
  //    may or may not have applied its side effect, so resuming is unsafe.
  const answeredToolCallIds = new Set(
    nonSystem.filter((m) => m.role === 'tool' && m.tool_call_id).map((m) => m.tool_call_id as string)
  );
  for (const m of nonSystem) {
    if (m.role !== 'assistant') continue;
    for (const tc of toolCallsOf(m)) {
      if (tc.id && !answeredToolCallIds.has(tc.id)) {
        return { resumable: false, reason: 'dangling_tool_call' };
      }
    }
  }

  // 4. Classify the settled boundary the loop would continue from.
  const last = nonSystem[nonSystem.length - 1];
  if (last.role === 'tool') {
    return { resumable: true, reason: 'resumable_tool_boundary', resumeHistory: history };
  }
  if (last.role === 'user') {
    return { resumable: true, reason: 'resumable_user_prompt', resumeHistory: history };
  }
  // Last real message is an assistant turn with no pending tool calls — the run
  // already produced a final response, so there is nothing to continue.
  return { resumable: false, reason: 'already_settled' };
}
