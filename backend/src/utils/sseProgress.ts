/**
 * Server-Sent Events (SSE) utility for Agent Mode progress updates
 * Uses a simple in-memory store to track progress by sessionId
 */

// Action intent types — used by the frontend to navigate/highlight UI elements
export type ActionIntent = {
  type: 'navigate';
  route: string;
  label: string;
} | {
  type: 'highlight';
  elementId: string;
  label: string;
};

// Progress type definition
type ProgressUpdate = {
  iteration: number;
  status: string;
  toolCalls?: any[];
  pendingTools?: string[];
  actions?: ActionIntent[];
};
type ProgressCallback = (progress: ProgressUpdate) => void;

// Mapping of tool names to navigation routes
const TOOL_NAVIGATION_MAP: Record<string, { route: string; label: string }> = {
  update_brand_guidelines: { route: '/brand-guidelines', label: 'View Brand Guidelines' },
  update_market_strategy: { route: '/gtm-tracker', label: 'View GTM Tracker' },
  manage_crm_leads: { route: '/crm', label: 'View CRM' },
  create_email_template: { route: '/email-templates', label: 'View Email Templates' },
  create_landing_page: { route: '/landing-pages', label: 'View Landing Pages' },
};

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
 * Emit an action intent (navigate or highlight) for a session.
 * This is a convenience wrapper that creates a progress update with a single action.
 */
export function emitActionIntent(
  sessionId: string,
  iteration: number,
  type: 'navigate' | 'highlight',
  target: string,
  label: string
) {
  const action: ActionIntent = type === 'navigate'
    ? { type: 'navigate', route: target, label }
    : { type: 'highlight', elementId: target, label };

  emitProgress(sessionId, {
    iteration,
    status: 'action_intent',
    actions: [action]
  });
}

/**
 * Given a list of tool names that were just executed, return navigation
 * action intents for any tools that have a known page mapping.
 * Deduplicates by route.
 */
export function getActionIntentsForTools(toolNames: string[]): ActionIntent[] {
  const seenRoutes = new Set<string>();
  const actions: ActionIntent[] = [];

  for (const toolName of toolNames) {
    const mapping = TOOL_NAVIGATION_MAP[toolName];
    if (mapping && !seenRoutes.has(mapping.route)) {
      seenRoutes.add(mapping.route);
      actions.push({
        type: 'navigate',
        route: mapping.route,
        label: mapping.label
      });
    }
  }

  return actions;
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
