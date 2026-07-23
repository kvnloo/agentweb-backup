/**
 * ENG-475: deterministic auto-persistence of the browser session.
 *
 * The reported Luma failure is that a login only persists if the model remembers
 * to call save_browser_cookies. Luma (and similar sites) let the automation
 * browser through INTERMITTENTLY; the reliable half of the fix is to make sure
 * that whenever a browser session IS established, its cookies are auto-loaded at
 * the start and auto-saved as the user progresses — without depending on the
 * model. These helpers own that orchestration (guards, debounce, recursion
 * safety) so it can be unit-tested away from the 470KB agentModeService.
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

  it('swallows runTool errors, still marks the session loaded, and clears the busy flag', async () => {
    const state = createAutoPersistState();
    const runTool = jest.fn().mockRejectedValue(new Error('no page yet'));
    const deps = { runTool, now: () => 1 };

    await expect(autoLoadCookiesOnce(state, 'sess-1', deps)).resolves.toBe(false);
    expect(state.busySessions.has('sess-1')).toBe(false); // not left wedged
    // marked loaded so we don't retry-loop a failing load every tool call
    expect(await autoLoadCookiesOnce(state, 'sess-1', deps)).toBe(false);
    expect(runTool).toHaveBeenCalledTimes(1);
  });

  it('does not re-enter while a cookie op is already in flight (recursion guard)', async () => {
    const state = createAutoPersistState();
    // While load runs, a nested browser tool (browser_run_code) would call back in.
    let reentrantResult: boolean | undefined;
    const runTool = jest.fn().mockImplementation(async () => {
      reentrantResult = await autoSaveCookiesDebounced(state, 'sess-1', { runTool, now: () => 99999 });
      return { success: true };
    });
    await autoLoadCookiesOnce(state, 'sess-1', { runTool, now: () => 1 });
    expect(reentrantResult).toBe(false); // nested save was suppressed
    expect(runTool).toHaveBeenCalledTimes(1); // only the load ran
  });
});

describe('autoSaveCookiesDebounced', () => {
  it('saves on first eligible call, then debounces subsequent calls within the window', async () => {
    const state = createAutoPersistState();
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

  it('swallows runTool errors and clears the busy flag', async () => {
    const state = createAutoPersistState();
    const runTool = jest.fn().mockRejectedValue(new Error('save failed'));
    await expect(autoSaveCookiesDebounced(state, 'sess-1', { runTool, now: () => 1 })).resolves.toBe(false);
    expect(state.busySessions.has('sess-1')).toBe(false);
  });
});
