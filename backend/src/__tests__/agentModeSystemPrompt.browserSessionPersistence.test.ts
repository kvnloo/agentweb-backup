import { AGENT_MODE_SYSTEM_PROMPT } from '../docs/agentModeSystemPrompt';

// ENG-475: Luma login via browser automation failed persistently, and Emma's
// suggested workarounds made it worse. Emma recommended "Option A" — the user
// logs into Luma on their own personal browser and the agent reuses that
// session. That is impossible: the Playwright automation browser runs with
// `--isolated` (its own cookie jar, no `--user-data-dir`), so it never inherits
// the user's personal-browser login. The always-on system prompt never told
// Emma this, and never told it that the ONLY cross-run persistence path is the
// save_browser_cookies / load_browser_cookies store — so Emma improvised bad
// guidance. This prompt guidance corrects both.
describe('AgentMode system prompt - browser session persistence & isolation guidance', () => {
  it('states the automation browser is isolated with its own cookie jar', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('own cookie jar');
  });

  it('explicitly forbids recommending personal-browser login reuse (the failed "Option A")', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain(
      "logging in on their own browser"
    );
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('does NOT share cookies or logins with the user');
  });

  it('directs Emma to persist sessions via save_browser_cookies after login and load_browser_cookies at start', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('save_browser_cookies');
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('load_browser_cookies');
  });

  it('explains a "No saved cookies" result means no successful login was ever persisted, not a personal-browser problem', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('No saved cookies');
  });

  it('handles persistent "Verifying Your Browser" bot-protection at the login gate honestly, without recommending personal-browser reuse', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('Verifying Your Browser');
  });

  it('treats the "Verifying Your Browser" challenge as intermittent and forbids resubmitting while it verifies', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('intermittent, not an absolute block');
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('Do NOT resubmit while it is verifying');
  });

  it('drives the proven interactive one-time-email-code login and persists it with save_browser_cookies', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('one-time email code');
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('paste it here');
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain(
      'Immediately after the login succeeds, call `save_browser_cookies`'
    );
  });

  it('falls back to user-provided data + report_product_issues only when the gate will not clear, and flags that scheduled runs cannot relay a code', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('paste or attach');
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('report_product_issues');
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('unattended/scheduled run cannot relay a one-time code');
  });
});

// ENG-494 follow-up: a manually-imported Browser Sessions cookie can die
// server-side at any time, independent of the synthetic expiry estimate shown
// in Settings. Without this guidance, load_browser_cookies reporting "success"
// (a cookie was injected) would be mistaken for "still authenticated" — Emma
// would proceed as if logged in, land back on a signin page, and the failure
// would recur silently on every future run with no signal to the user.
describe('AgentMode system prompt - manually-imported session failure reporting (mark_browser_session_failed)', () => {
  it('warns that load_browser_cookies success does not guarantee the site still honors the session', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('does NOT guarantee the site still honors it');
  });

  it('directs Emma to verify authentication (not just cookie injection) before proceeding', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('check that you\'re actually authenticated');
  });

  it('directs Emma to call mark_browser_session_failed immediately upon finding a dead manually-imported session', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('mark_browser_session_failed(domain)');
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('immediately');
  });

  it('clarifies this is a report, not a fix, and scopes it to manually-imported domains only (not the automatic __all__ jar)', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('This is a report, not a fix');
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('only for domains the user explicitly imported');
  });
});
