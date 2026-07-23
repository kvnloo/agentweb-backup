/**
 * ENG-475: deterministic auto-persistence of the browser-automation session.
 *
 * Sites like Luma sit behind an intermittent Cloudflare bot-check, so a login
 * only succeeds some of the time. When it DOES succeed, the session must be
 * captured so future (and scheduled) runs skip the gate via load_browser_cookies.
 * Relying on the model to call save_browser_cookies is fragile — in the reported
 * session it never did. These helpers make load-at-start / save-as-you-go
 * automatic around the existing save/load_browser_cookies tools.
 *
 * Design constraints:
 *  - Best-effort: never throw into the tool path; a failed cookie op must not
 *    break the browser tool the user actually asked for.
 *  - Recursion-safe: the cookie tools themselves drive `browser_run_code`, which
 *    re-enters the executor. A per-session "busy" flag suppresses that reentry.
 *  - Debounced: save at most once per window so we don't add a run_code
 *    round-trip to every single browser tool call.
 */

export interface AutoPersistState {
  /** Sessions we've already attempted a one-time auto-load for. */
  loadedSessions: Set<string>;
  /** Sessions with a cookie op in flight — suppresses recursive reentry. */
  busySessions: Set<string>;
  /** Last successful/attempted save time per session, for debouncing. */
  lastSaveAt: Map<string, number>;
}

export interface AutoPersistDeps {
  /** Runs a registered cookie tool by name (bound to the service's tool registry). */
  runTool: (name: string, args: any) => Promise<any>;
  /** Injectable clock (epoch ms) for deterministic debounce testing. */
  now: () => number;
  /** Save debounce window; defaults to 15s. */
  saveDebounceMs?: number;
}

const DEFAULT_SAVE_DEBOUNCE_MS = 15_000;

export function createAutoPersistState(): AutoPersistState {
  return {
    loadedSessions: new Set<string>(),
    busySessions: new Set<string>(),
    lastSaveAt: new Map<string, number>(),
  };
}

/**
 * True for the Playwright browser-automation tools we want to bracket with
 * cookie persistence. Excludes the cookie tools themselves (they drive
 * browser_run_code internally and would otherwise recurse).
 */
export function isBrowserAutomationTool(toolName: string): boolean {
  if (!toolName) return false;
  if (toolName.includes('cookies')) return false;
  return /(^|_)browser_/.test(toolName);
}

/**
 * Restore any previously-saved session ONCE per session, before the first
 * browser tool runs (so injected cookies apply to the first navigation).
 * Returns true iff a load was attempted this call.
 */
export async function autoLoadCookiesOnce(
  state: AutoPersistState,
  sessionId: string,
  deps: AutoPersistDeps,
): Promise<boolean> {
  if (!sessionId) return false;
  if (state.loadedSessions.has(sessionId)) return false;
  if (state.busySessions.has(sessionId)) return false;

  // Mark loaded up-front so a failing load doesn't retry-loop on every tool call.
  state.loadedSessions.add(sessionId);
  state.busySessions.add(sessionId);
  try {
    await deps.runTool('load_browser_cookies', {});
    return true;
  } catch {
    return false;
  } finally {
    state.busySessions.delete(sessionId);
  }
}

/**
 * Persist the current browser cookies, at most once per debounce window, after a
 * successful browser tool. Best-effort and recursion-safe. Returns true iff a
 * save was attempted this call.
 */
export async function autoSaveCookiesDebounced(
  state: AutoPersistState,
  sessionId: string,
  deps: AutoPersistDeps,
): Promise<boolean> {
  if (!sessionId) return false;
  if (state.busySessions.has(sessionId)) return false;

  const debounce = deps.saveDebounceMs ?? DEFAULT_SAVE_DEBOUNCE_MS;
  const now = deps.now();
  const last = state.lastSaveAt.get(sessionId) ?? 0;
  if (now - last < debounce) return false;

  state.busySessions.add(sessionId);
  state.lastSaveAt.set(sessionId, now);
  try {
    await deps.runTool('save_browser_cookies', {});
    return true;
  } catch {
    return false;
  } finally {
    state.busySessions.delete(sessionId);
  }
}
