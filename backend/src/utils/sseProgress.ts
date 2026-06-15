/**
 * Server-Sent Events (SSE) utility for Agent Mode progress updates
 * Uses a simple in-memory store to track progress by sessionId
 */

// Progress type definition
type ProgressUpdate = { iteration: number; status: string; toolCalls?: any[]; pendingTools?: string[]; suggestions?: string[] };
type ProgressCallback = (progress: ProgressUpdate) => void;

// Store progress updates by sessionId
export const progressStore = new Map<string, ProgressUpdate>();

// Store active SSE connections by sessionId
const activeConnections = new Map<string, Set<ProgressCallback>>();

/**
 * Register a progress callback for a session
 */
export function registerProgressCallback(
  sessionId: string,
  callback: ProgressCallback
): () => void {
  if (!activeConnections.has(sessionId)) {
    activeConnections.set(sessionId, new Set());
  }
  activeConnections.get(sessionId)!.add(callback);

  // Return cleanup function
  return () => {
    const callbacks = activeConnections.get(sessionId);
    if (callbacks) {
      callbacks.delete(callback);
      if (callbacks.size === 0) {
        activeConnections.delete(sessionId);
      }
    }
  };
}

/**
 * Emit progress update for a session
 */
export function emitProgress(sessionId: string, progress: ProgressUpdate) {
  // Store the latest progress
  progressStore.set(sessionId, progress);

  // Notify all active connections
  const callbacks = activeConnections.get(sessionId);
  if (callbacks && callbacks.size > 0) {
    callbacks.forEach(callback => {
      try {
        callback(progress);
      } catch (error) {
        console.error('Error in progress callback:', error);
      }
    });
  }
}

/**
 * Get the latest progress for a session
 */
export function getLatestProgress(sessionId: string): ProgressUpdate | undefined {
  return progressStore.get(sessionId);
}

/**
 * Clean up progress data for a session
 */
export function cleanupProgress(sessionId: string) {
  activeConnections.delete(sessionId);
  progressStore.delete(sessionId);
}

/**
 * Terminal-state cleanup for a session's progress.
 *
 * Emits a final `complete` status to any live SSE listener (so the frontend
 * stops showing "Thinking…") and then removes the stored progress entry so it
 * cannot leak. Active SSE connections are intentionally left registered — a
 * reconnecting client must still receive the `complete` signal.
 *
 * This is the single definition of "a run reached a terminal state" used by
 * every terminal path (normal completion, cancel, and worker crash/exit). It
 * MUST be called on worker death so a generation that dies mid-iteration does
 * not orphan a stale progress entry forever (the SSE-zombie-progress bug).
 */
export function clearTerminalProgress(sessionId: string) {
  // Only emit `complete` if a live progress entry exists, so we don't resurrect
  // an entry for a session that was already cleaned up.
  if (progressStore.has(sessionId)) {
    emitProgress(sessionId, { iteration: 0, status: 'complete' });
  }
  progressStore.delete(sessionId);
}

// Cancel store - tracks sessions whose generation should be stopped
const cancelledSessions = new Set<string>();

export function requestCancel(sessionId: string) {
  cancelledSessions.add(sessionId);
}

export function isCancelled(sessionId: string): boolean {
  return cancelledSessions.has(sessionId);
}

export function clearCancel(sessionId: string) {
  cancelledSessions.delete(sessionId);
}
