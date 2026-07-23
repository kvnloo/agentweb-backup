/**
 * ENG-475: deterministic auto-persistence of the browser-automation session.
 *
 * Sites with an intermittent bot-check let the automation browser log in only
 * some of the time. When it DOES succeed, the session must be captured so future
 * (and scheduled) runs skip the gate via load_browser_cookies. Relying on the
 * model to call save_browser_cookies is fragile — in the reported session it
 * never did. These helpers make load-at-start / save-after-each-action automatic
 * around the existing save/load_browser_cookies tools.
 *
 * Safety properties (this runs on a long-lived singleton, for every user):
 *  - Best-effort: never throws into the tool path; a cookie op must not break the
 *    browser tool the user actually asked for.
 *  - Recursion-safe: the cookie tools drive browser_run_code, which re-enters the
 *    executor. A per-session "busy" flag suppresses that reentry (and also
 *    coalesces a concurrent batch of browser tools into a single save).
 *  - No lossy time-window: we save after every state-CHANGING browser tool rather
 *    than on a timer. A timer/debounce could let the first (unauthenticated) save
 *    start a window that swallows the immediately-following authenticated save,
 *    losing the login when the task ends (Greptile, PR #2163). Saving right after
 *    each state change guarantees the post-login cookie jar is captured. Pure-read
 *    tools (snapshot/screenshot/etc.) are skipped so reads don't add round-trips.
 *  - Non-destructive: if restoring a prior session ERRORED, we do NOT auto-save —
 *    otherwise we could overwrite a user's good saved login with a session that no
 *    longer contains it.
 *  - Bounded: per-session bookkeeping is capped and prunes oldest-first, so the
 *    singleton's memory cannot grow without limit.
 */

export interface SessionCookieInfo {
  /** True if the one-time auto-load threw — auto-save is then disabled (no clobber). */
  loadErrored: boolean;
}

export interface AutoPersistState {
  /** Per-session bookkeeping. Insertion-ordered; pruned oldest-first at the cap. */
  sessions: Map<string, SessionCookieInfo>;
  /** Sessions with a cookie op in flight — suppresses recursive reentry. Transient. */
  busySessions: Set<string>;
  /** Max tracked sessions before oldest-first pruning. */
  maxSessions: number;
}

export interface AutoPersistDeps {
  /** Runs a registered cookie tool by name (bound to the service's tool registry). */
  runTool: (name: string, args: any) => Promise<any>;
}

const DEFAULT_MAX_SESSIONS = 1_000;

// Substrings of the pure-read Playwright browser tools. These never change the
// cookie/auth state, so persisting after them would only add a needless
// run_code round-trip. Everything else (navigate/click/type/wait/run_code/…),
// including unknown future tools, is treated as potentially state-changing.
const READ_ONLY_BROWSER_TOOL_MARKERS = [
  'snapshot',
  'take_screenshot',
  'console_messages',
  'network_request', // covers network_request(s)
];

export function createAutoPersistState(maxSessions: number = DEFAULT_MAX_SESSIONS): AutoPersistState {
  return {
    sessions: new Map<string, SessionCookieInfo>(),
    busySessions: new Set<string>(),
    maxSessions,
  };
}

/**
 * True for the Playwright browser-automation tools we bracket with cookie
 * persistence. Excludes the cookie tools themselves (they drive browser_run_code
 * internally and would otherwise recurse).
 */
export function isBrowserAutomationTool(toolName: string): boolean {
  if (!toolName) return false;
  if (toolName.includes('cookies')) return false;
  return /(^|_)browser_/.test(toolName);
}

/**
 * Whether to persist cookies AFTER a given browser tool: yes for state-changing
 * tools, no for pure reads (so reads don't add round-trips). Unknown tools default
 * to yes, so a new state-changing tool is never silently missed.
 */
export function shouldPersistAfterBrowserTool(toolName: string): boolean {
  if (!isBrowserAutomationTool(toolName)) return false;
  return !READ_ONLY_BROWSER_TOOL_MARKERS.some((marker) => toolName.includes(marker));
}

/** Register a session, pruning the oldest entry first if we're at the cap. */
function registerSession(state: AutoPersistState, sessionId: string): SessionCookieInfo {
  if (state.sessions.size >= state.maxSessions) {
    const oldest = state.sessions.keys().next().value;
    if (oldest !== undefined) state.sessions.delete(oldest);
  }
  const info: SessionCookieInfo = { loadErrored: false };
  state.sessions.set(sessionId, info);
  return info;
}

/**
 * Restore any previously-saved session ONCE per session, before the first browser
 * tool runs (so injected cookies apply to the first navigation). Returns true iff
 * a load was attempted this call. If the load throws, the session is flagged so
 * auto-save stays disabled for it (never clobber a session we failed to restore).
 */
export async function autoLoadCookiesOnce(
  state: AutoPersistState,
  sessionId: string,
  deps: AutoPersistDeps,
): Promise<boolean> {
  if (!sessionId) return false;
  if (state.sessions.has(sessionId)) return false; // already attempted once
  if (state.busySessions.has(sessionId)) return false;

  const info = registerSession(state, sessionId);
  state.busySessions.add(sessionId);
  try {
    await deps.runTool('load_browser_cookies', {});
    return true;
  } catch {
    info.loadErrored = true;
    return false;
  } finally {
    state.busySessions.delete(sessionId);
  }
}

/**
 * Persist the current browser cookies after a successful state-changing browser
 * tool. Best-effort and recursion-safe (the busy flag also coalesces a concurrent
 * batch of browser tools into a single save). Skips entirely unless the session's
 * one-time auto-load ran without error, so a save can only add to / refresh a
 * restored session, never replace a good one we failed to load. Returns true iff a
 * save was attempted this call.
 */
export async function autoSaveCookies(
  state: AutoPersistState,
  sessionId: string,
  deps: AutoPersistDeps,
): Promise<boolean> {
  if (!sessionId) return false;
  if (state.busySessions.has(sessionId)) return false;

  const info = state.sessions.get(sessionId);
  if (!info) return false;            // auto-load never ran → don't save blind
  if (info.loadErrored) return false; // safety: don't overwrite a session we couldn't restore

  state.busySessions.add(sessionId);
  try {
    await deps.runTool('save_browser_cookies', {});
    return true;
  } catch {
    return false;
  } finally {
    state.busySessions.delete(sessionId);
  }
}
