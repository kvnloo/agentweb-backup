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
