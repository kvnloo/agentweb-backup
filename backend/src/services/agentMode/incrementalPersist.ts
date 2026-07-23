/**
 * Incremental (checkpoint) persistence of agent-mode response messages.
 *
 * ENG-473: a regular/interactive run buffers ALL of its assistant/tool output in
 * the forked worker's memory and persists it in ONE batch only after the run
 * finishes (agentModeController.generateSessionResponse). If the owning process
 * is hard-killed mid-run (OOM/SIGKILL, or force-exit past the shutdown drain) the
 * whole batch is lost and the session is a silent `[system, user]` dead chat.
 *
 * The fix is to persist each fully-settled turn as it completes, so a hard kill
 * leaves a VISIBLE partial transcript instead of nothing. These helpers are the
 * pure core of that mechanism: selecting the not-yet-persisted settled tail and
 * stripping oversized image data before it is written.
 */

/**
 * Strip base64 image data URIs from tool-result message content before persisting.
 *
 * Mirrors the end-batch stripping in agentModeController so that a message written
 * incrementally is byte-identical to the same message written by the final batch
 * (a ~300KB data URI would otherwise blow the DynamoDB 400KB item limit). Pure —
 * returns a new array and never mutates the input or its messages.
 */
export function stripImageDataForPersistence(messages: any[]): any[] {
  return (messages || []).map((msg: any) => {
    if (msg && msg.role === 'tool' && Array.isArray(msg.content)) {
      const strippedContent =
        msg.content
          .filter((item: any) => item.type !== 'image_url')
          .map((item: any) => item.text ?? item)
          .join('\n') || '[screenshot captured]';
      return { ...msg, content: strippedContent };
    }
    return msg;
  });
}

/**
 * Given the full working `messages` array, the boundary index where response
 * messages begin (`initialMessageCount` — everything before it is system/context
 * that the controller already persisted or never persists), and how many response
 * messages have already been checkpointed, compute the next batch of settled
 * response messages to persist.
 *
 * "Response messages" = everything after the boundary that is NOT a user message —
 * identical to the controller's final-batch selection
 * (`messages.slice(initialMessageCount).filter(m => m.role !== 'user')`), so the
 * incremental and final persistence never disagree on the set or its order. The
 * caller only invokes this at a point where the CURRENT in-flight turn has not yet
 * been appended (the top of each loop iteration), so every returned message is
 * final and safe to persist.
 *
 * The returned `toPersist` is image-stripped. `newPersistedCount` is the cursor to
 * pass back next time. Idempotent: with no new settled messages it returns an
 * empty batch and the unchanged cursor. Defensive against a cursor that already
 * meets/exceeds the tail (never returns a short/duplicated slice).
 */
export function computeCheckpointBatch(
  messages: any[],
  initialMessageCount: number,
  alreadyPersistedCount: number
): { toPersist: any[]; newPersistedCount: number } {
  const responseMessages = (messages || [])
    .slice(initialMessageCount)
    .filter((m: any) => m && m.role !== 'user');
  if (responseMessages.length <= alreadyPersistedCount) {
    return { toPersist: [], newPersistedCount: alreadyPersistedCount };
  }
  const fresh = responseMessages.slice(alreadyPersistedCount);
  return {
    toPersist: stripImageDataForPersistence(fresh),
    newPersistedCount: responseMessages.length,
  };
}
