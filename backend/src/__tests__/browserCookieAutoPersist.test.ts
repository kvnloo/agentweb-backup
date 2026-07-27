/**
 * ENG-475: deterministic auto-persistence of the browser session.
 *
 * The reported Luma-style failure is that a login only persists if the model
 * remembers to call save_browser_cookies. These helpers make load-at-start /
 * save-after-each-state-change automatic, and — because they run on a long-lived
 * singleton for every user — must be recursion-safe, memory-bounded, and
 * non-destructive (never overwrite a good saved session with one we failed to
 * restore). Persisting after every state-changing tool (rather than on a timer)
 * also guarantees the post-login cookie jar is captured, instead of being
 * swallowed by a debounce window that an earlier unauthenticated save started
 * (Greptile, PR #2163).
 */
import {
  isBrowserAutomationTool,
  shouldPersistAfterBrowserTool,
  createAutoPersistState,
  autoLoadCookiesOnce,
  autoSaveCookies,
} from '../emma/browserCookieAutoPersist';

describe('isBrowserAutomationTool', () => {
  it('matches Playwright browser automation tools (prefixed and bare)', () => {
    expect(isBrowserAutomationTool('playwright_browser_navigate')).toBe(true);
    expect(isBrowserAutomationTool('playwright_browser_run_code')).toBe(true);
    expect(isBrowserAutomationTool('browser_click')).toBe(true);
  });

  it('does NOT match the cookie tools themselves (would recurse) or unrelated tools', () => {
    expect(isBrowserAutomationTool('save_browser_cookies')).toBe(false);
    expect(isBrowserAutomationTool('load_browser_cookies')).toBe(false);
    expect(isBrowserAutomationTool('clear_browser_cookies')).toBe(false);
    expect(isBrowserAutomationTool('install_skills')).toBe(false);
    expect(isBrowserAutomationTool('report_product_issues')).toBe(false);
    expect(isBrowserAutomationTool('')).toBe(false);
    expect(isBrowserAutomationTool(undefined as any)).toBe(false);
  });
});

describe('shouldPersistAfterBrowserTool', () => {
  it('persists after state-changing browser tools (incl. unknown ones by default)', () => {
    expect(shouldPersistAfterBrowserTool('playwright_browser_navigate')).toBe(true);
    expect(shouldPersistAfterBrowserTool('playwright_browser_click')).toBe(true);
    expect(shouldPersistAfterBrowserTool('playwright_browser_type')).toBe(true);
    expect(shouldPersistAfterBrowserTool('playwright_browser_wait_for')).toBe(true);
    expect(shouldPersistAfterBrowserTool('playwright_browser_run_code')).toBe(true);
    expect(shouldPersistAfterBrowserTool('playwright_browser_some_new_action')).toBe(true);
  });

  it('skips pure-read browser tools (no cookie change → no needless round-trip)', () => {
    expect(shouldPersistAfterBrowserTool('playwright_browser_snapshot')).toBe(false);
    expect(shouldPersistAfterBrowserTool('playwright_browser_take_screenshot')).toBe(false);
    expect(shouldPersistAfterBrowserTool('playwright_browser_console_messages')).toBe(false);
    expect(shouldPersistAfterBrowserTool('playwright_browser_network_requests')).toBe(false);
  });

  it('is false for non-browser tools', () => {
    expect(shouldPersistAfterBrowserTool('save_browser_cookies')).toBe(false);
    expect(shouldPersistAfterBrowserTool('install_skills')).toBe(false);
  });
});

describe('autoLoadCookiesOnce', () => {
  it('loads exactly once per session, then skips on later calls', async () => {
    const state = createAutoPersistState();
    const runTool = jest.fn().mockResolvedValue({ success: true });
    const deps = { runTool };

    expect(await autoLoadCookiesOnce(state, 'sess-1', deps)).toBe(true);
    expect(await autoLoadCookiesOnce(state, 'sess-1', deps)).toBe(false);
    expect(await autoLoadCookiesOnce(state, 'sess-1', deps)).toBe(false);

    expect(runTool).toHaveBeenCalledTimes(1);
    expect(runTool).toHaveBeenCalledWith('load_browser_cookies', {});
  });

  it('skips (no throw) when there is no sessionId', async () => {
    const state = createAutoPersistState();
    const runTool = jest.fn().mockResolvedValue({ success: true });
    expect(await autoLoadCookiesOnce(state, '', { runTool })).toBe(false);
    expect(runTool).not.toHaveBeenCalled();
  });

  it('swallows runTool errors, marks the session attempted (no retry-loop), and clears busy', async () => {
    const state = createAutoPersistState();
    const runTool = jest.fn().mockRejectedValue(new Error('no page yet'));
    const deps = { runTool };

    await expect(autoLoadCookiesOnce(state, 'sess-1', deps)).resolves.toBe(false);
    expect(state.busySessions.has('sess-1')).toBe(false); // not left wedged
    expect(await autoLoadCookiesOnce(state, 'sess-1', deps)).toBe(false); // not retried
    expect(runTool).toHaveBeenCalledTimes(1);
  });

  it('does not re-enter while a cookie op is already in flight (recursion guard)', async () => {
    const state = createAutoPersistState();
    let reentrantResult: boolean | undefined;
    const runTool = jest.fn().mockImplementation(async () => {
      // A nested browser tool (browser_run_code) would call back in here.
      reentrantResult = await autoSaveCookies(state, 'sess-1', { runTool });
      return { success: true };
    });
    await autoLoadCookiesOnce(state, 'sess-1', { runTool });
    expect(reentrantResult).toBe(false); // nested save was suppressed
    expect(runTool).toHaveBeenCalledTimes(1); // only the load ran
  });

  it('prunes oldest sessions first so tracking is memory-bounded', async () => {
    const state = createAutoPersistState(2); // cap of 2
    const runTool = jest.fn().mockResolvedValue({ success: true });
    const deps = { runTool };

    await autoLoadCookiesOnce(state, 'a', deps);
    await autoLoadCookiesOnce(state, 'b', deps);
    await autoLoadCookiesOnce(state, 'c', deps); // evicts oldest ('a')

    expect(state.sessions.size).toBe(2);
    expect(state.sessions.has('a')).toBe(false);
    expect(state.sessions.has('b')).toBe(true);
    expect(state.sessions.has('c')).toBe(true);
  });
});

describe('autoSaveCookies', () => {
  // A session is only save-eligible once its one-time auto-load has run.
  const withLoadedSession = async (state: ReturnType<typeof createAutoPersistState>, sessionId: string) => {
    await autoLoadCookiesOnce(state, sessionId, { runTool: jest.fn().mockResolvedValue({ success: true }) });
  };

  it('saves on every eligible call — no time window can swallow a post-login save', async () => {
    const state = createAutoPersistState();
    await withLoadedSession(state, 'sess-1');

    const runTool = jest.fn().mockResolvedValue({ success: true });
    const deps = { runTool };

    // Simulates: navigate (unauth) → save; then login click → save right after.
    expect(await autoSaveCookies(state, 'sess-1', deps)).toBe(true);
    expect(await autoSaveCookies(state, 'sess-1', deps)).toBe(true);

    expect(runTool).toHaveBeenCalledTimes(2);
    expect(runTool).toHaveBeenCalledWith('save_browser_cookies', {});
  });

  it('skips (no throw) when there is no sessionId', async () => {
    const state = createAutoPersistState();
    const runTool = jest.fn();
    expect(await autoSaveCookies(state, '', { runTool })).toBe(false);
    expect(runTool).not.toHaveBeenCalled();
  });

  it('does not save a session whose auto-load never ran (no blind overwrite)', async () => {
    const state = createAutoPersistState();
    const runTool = jest.fn().mockResolvedValue({ success: true });
    expect(await autoSaveCookies(state, 'never-loaded', { runTool })).toBe(false);
    expect(runTool).not.toHaveBeenCalled();
  });

  it('SAFETY: never overwrites a saved session when auto-load errored (no clobber)', async () => {
    const state = createAutoPersistState();
    // auto-load throws (e.g. browser had no page) → session flagged loadErrored
    await autoLoadCookiesOnce(state, 'sess-1', { runTool: jest.fn().mockRejectedValue(new Error('no page')) });

    const save = jest.fn().mockResolvedValue({ success: true });
    expect(await autoSaveCookies(state, 'sess-1', { runTool: save })).toBe(false);
    expect(save).not.toHaveBeenCalled(); // the previously-saved session is left intact
  });

  it('swallows runTool errors and clears the busy flag', async () => {
    const state = createAutoPersistState();
    await withLoadedSession(state, 'sess-1');
    const runTool = jest.fn().mockRejectedValue(new Error('save failed'));
    await expect(autoSaveCookies(state, 'sess-1', { runTool })).resolves.toBe(false);
    expect(state.busySessions.has('sess-1')).toBe(false);
  });
});
