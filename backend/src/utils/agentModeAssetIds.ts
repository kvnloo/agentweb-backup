/**
 * Synthetic asset ids for agent-mode (Emma chat) images — ENG-1957.
 *
 * Images produced inside a chat are not task executions: they live as tool-call
 * results in `AW-ChatMessages`, projected into `AW-ChatSessions.assetCache`. The
 * Images page still has to present them next to real task images, so
 * `getExecutionsWithAssets` (routes/tasks.ts) mints a task/execution id pair for
 * each session:
 *
 *   taskId      = `agent-mode-<sessionId>`
 *   executionId = `<sessionId>-images`
 *
 * Endpoints that accept those ids must resolve them back to a session before
 * doing anything, because no `AW-Tasks` / `AW-TaskExecutions` row exists.
 */

const AGENT_MODE_TASK_PREFIX = 'agent-mode-';
const AGENT_MODE_IMAGE_SUFFIX = '-images';

/**
 * Resolve an `agent-mode-<sessionId>` / `<sessionId>-images` pair to its session
 * id, or null when the pair is not an agent-mode image pair.
 *
 * Both ids must name the *same* session. That check is the session-path
 * equivalent of the task path's `execution.taskId !== taskId`: without it a
 * caller authorized for one session could aim the write at another.
 *
 * Affixes are stripped positionally, not with `String.replace`, so a session id
 * that itself contains `-images` is not mangled (the favorite/archive/feedback
 * endpoints still use `replace` — ENG-1961 territory, untouched here).
 */
export function parseAgentModeImageIds(
  taskId: string | undefined,
  executionId: string | undefined,
): string | null {
  if (!taskId?.startsWith(AGENT_MODE_TASK_PREFIX)) return null;
  if (!executionId?.endsWith(AGENT_MODE_IMAGE_SUFFIX)) return null;

  const sessionIdFromTask = taskId.slice(AGENT_MODE_TASK_PREFIX.length);
  const sessionIdFromExecution = executionId.slice(0, -AGENT_MODE_IMAGE_SUFFIX.length);

  if (!sessionIdFromTask || sessionIdFromTask !== sessionIdFromExecution) return null;

  return sessionIdFromTask;
}
