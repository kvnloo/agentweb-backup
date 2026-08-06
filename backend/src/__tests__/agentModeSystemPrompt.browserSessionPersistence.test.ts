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

  // ENG-795 superseded the second half of this rule: an unattended run CAN now
  // complete a one-time-code login, by reading the code out of the connected
  // mailbox (read_verification_code). The fallback itself is unchanged — it is
  // just no longer the only option a scheduled run has.
  it('falls back to user-provided data + report_product_issues only when the gate will not clear, and points unattended runs at the email-code path', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('paste or attach');
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('report_product_issues');
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain(
      'you can still complete a one-time-code login without the user'
    );
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

  it('directs Emma to call mark_browser_session_failed when genuinely blocked by a login gate, with a concrete (not vague) trigger condition', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('mark_browser_session_failed(domain)');
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('not just a page that happens to mention "sign in" somewhere');
  });

  it('clarifies this is a report, not a fix, and scopes it to manually-imported domains only (not the automatic __all__ jar)', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('This is a report, not a fix');
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('only for domains the user explicitly imported');
  });

  // Risk-reduction pass: the first version of this guidance was worded generically
  // enough that an LLM could plausibly read it as "always double-check auth after
  // load_browser_cookies, on every task" — adding overhead to flows that never had
  // this problem. Tightened to make explicit this is one thing to *notice*, not an
  // extra step to always perform, and to bias hard against false positives (an
  // incorrect "please reimport" banner on a session that's actually fine is a worse
  // outcome than an occasional missed report).
  it('makes explicit this does not add a mandatory verification step to unrelated login flows', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('it is one extra thing to notice, not an extra step to perform');
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('should never add a dedicated verification pass to a task that isn\'t already hitting a login-shaped wall');
  });

  it('biases against false positives — an incorrect failure report is treated as worse than an occasional missed one', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('Be conservative before calling it');
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('worse outcome than an occasional missed report');
  });
});
