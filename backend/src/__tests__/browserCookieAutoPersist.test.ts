/**
 * ENG-475: deterministic auto-persistence of the browser session.
 *
 * The reported Luma-style failure is that a login only persists if the model
 * remembers to call save_browser_cookies. These helpers make load-at-start /
 * save-as-you-go automatic, and — because they run on a long-lived singleton for
 * every user — must be recursion-safe, memory-bounded, and non-destructive (never
 * overwrite a good saved session with one we failed to restore).
 */
import {
  isBrowserAutomationTool,
  createAutoPersistState,
  autoLoadCookiesOnce,
  autoSaveCookiesDebounced,
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

describe('autoLoadCookiesOnce', () => {
  it('loads exactly once per session, then skips on later calls', async () => {
    const state = createAutoPersistState();
    const runTool = jest.fn().mockResolvedValue({ success: true });
    const deps = { runTool, now: () => 1000 };

    expect(await autoLoadCookiesOnce(state, 'sess-1', deps)).toBe(true);
    expect(await autoLoadCookiesOnce(state, 'sess-1', deps)).toBe(false);
    expect(await autoLoadCookiesOnce(state, 'sess-1', deps)).toBe(false);

    expect(runTool).toHaveBeenCalledTimes(1);
    expect(runTool).toHaveBeenCalledWith('load_browser_cookies', {});
  });

  it('skips (no throw) when there is no sessionId', async () => {
    const state = createAutoPersistState();
    const runTool = jest.fn().mockResolvedValue({ success: true });
    expect(await autoLoadCookiesOnce(state, '', { runTool, now: () => 1 })).toBe(false);
    expect(runTool).not.toHaveBeenCalled();
  });

  it('swallows runTool errors, marks the session attempted (no retry-loop), and clears busy', async () => {
    const state = createAutoPersistState();
    const runTool = jest.fn().mockRejectedValue(new Error('no page yet'));
    const deps = { runTool, now: () => 1 };

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
      reentrantResult = await autoSaveCookiesDebounced(state, 'sess-1', { runTool, now: () => 99999 });
      return { success: true };
    });
    await autoLoadCookiesOnce(state, 'sess-1', { runTool, now: () => 1 });
    expect(reentrantResult).toBe(false); // nested save was suppressed
    expect(runTool).toHaveBeenCalledTimes(1); // only the load ran
  });

  it('prunes oldest sessions first so tracking is memory-bounded', async () => {
    const state = createAutoPersistState(2); // cap of 2
    const runTool = jest.fn().mockResolvedValue({ success: true });
    const deps = { runTool, now: () => 1 };

    await autoLoadCookiesOnce(state, 'a', deps);
    await autoLoadCookiesOnce(state, 'b', deps);
    await autoLoadCookiesOnce(state, 'c', deps); // evicts oldest ('a')

    expect(state.sessions.size).toBe(2);
    expect(state.sessions.has('a')).toBe(false);
    expect(state.sessions.has('b')).toBe(true);
    expect(state.sessions.has('c')).toBe(true);
  });
});

describe('autoSaveCookiesDebounced', () => {
  // A session is only save-eligible once its one-time auto-load has run.
  const withLoadedSession = async (state: ReturnType<typeof createAutoPersistState>, sessionId: string) => {
    await autoLoadCookiesOnce(state, sessionId, { runTool: jest.fn().mockResolvedValue({ success: true }), now: () => 0 });
  };

  it('saves on first eligible call, then debounces subsequent calls within the window', async () => {
    const state = createAutoPersistState();
    await withLoadedSession(state, 'sess-1');

    const runTool = jest.fn().mockResolvedValue({ success: true });
    let t = 100000;
    const deps = { runTool, now: () => t, saveDebounceMs: 15000 };

    expect(await autoSaveCookiesDebounced(state, 'sess-1', deps)).toBe(true);
    t += 5000;
    expect(await autoSaveCookiesDebounced(state, 'sess-1', deps)).toBe(false); // within 15s
    t += 11000; // now >15s since last save
    expect(await autoSaveCookiesDebounced(state, 'sess-1', deps)).toBe(true);

    expect(runTool).toHaveBeenCalledTimes(2);
    expect(runTool).toHaveBeenCalledWith('save_browser_cookies', {});
  });

  it('skips (no throw) when there is no sessionId', async () => {
    const state = createAutoPersistState();
    const runTool = jest.fn();
    expect(await autoSaveCookiesDebounced(state, '', { runTool, now: () => 1 })).toBe(false);
    expect(runTool).not.toHaveBeenCalled();
  });

  it('does not save a session whose auto-load never ran (no blind overwrite)', async () => {
    const state = createAutoPersistState();
    const runTool = jest.fn().mockResolvedValue({ success: true });
    expect(await autoSaveCookiesDebounced(state, 'never-loaded', { runTool, now: () => 99999 })).toBe(false);
    expect(runTool).not.toHaveBeenCalled();
  });

  it('SAFETY: never overwrites a saved session when auto-load errored (no clobber)', async () => {
    const state = createAutoPersistState();
    // auto-load throws (e.g. browser had no page) → session flagged loadErrored
    await autoLoadCookiesOnce(state, 'sess-1', { runTool: jest.fn().mockRejectedValue(new Error('no page')), now: () => 0 });

    const save = jest.fn().mockResolvedValue({ success: true });
    expect(await autoSaveCookiesDebounced(state, 'sess-1', { runTool: save, now: () => 99999 })).toBe(false);
    expect(save).not.toHaveBeenCalled(); // the previously-saved session is left intact
  });

  it('swallows runTool errors and clears the busy flag', async () => {
    const state = createAutoPersistState();
    await withLoadedSession(state, 'sess-1');
    const runTool = jest.fn().mockRejectedValue(new Error('save failed'));
    await expect(autoSaveCookiesDebounced(state, 'sess-1', { runTool, now: () => 99999 })).resolves.toBe(false);
    expect(state.busySessions.has('sess-1')).toBe(false);
  });
});
