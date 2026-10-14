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

  // ENG-1953 follow-up: the original guidance only offered CSV once a
  // bot-protection gate wouldn't clear, even though Session Cookies manual
  // import exists specifically for sites Emma can't log into automatically —
  // it just was never mentioned as an option on a domain's FIRST such failure
  // (only after a later re-check of an already-imported cookie died, covered
  // by the "Manually-imported sessions" guidance below). A first-time Luma-style
  // Cloudflare block should offer this path too, not just CSV.
  it('offers Session Cookies manual import, with a direct link, as an option alongside CSV when a bot-protection gate will not clear', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain(
      'manually import a session cookie for this domain, which skips this gate entirely on the next run'
    );
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('/settings/browser-sessions');
  });

  // ENG-1953 follow-up: a second review round flagged that offering this option
  // as a bare backward-reference ("exactly like the re-import flow above") risks
  // the model compressing it down to just "log in" under load — the same failure
  // mode the sibling bullet above exists to prevent. Both steps must be spelled
  // out here too, not just pointed at.
  it('spells out both re-import steps here too, rather than only pointing back at the guidance above', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain(
      "log into the site in their own browser to get a fresh authenticated session, AND (b) copy that session's cookie into **Settings > Session Cookies** themselves"
    );
  });
});

// ENG-494 follow-up: a manually-imported Session Cookies cookie can die
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

  // ENG-1953 follow-up: a manually-imported Session Cookies cookie only exists
  // because credentialed auto-login already failed for that domain. Without this
  // guidance, Emma reported a dead session and then offered "save your Login
  // Credentials" as an equally-weighted fix — a path that was already known not
  // to work for that domain, wasting a turn before the user got useful direction.
  it('does not offer saving Login Credentials as an equally-weighted fix after reporting a manually-imported session failed', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain(
      "Don't offer \"save your Login Credentials\" as the recommended fix in the same breath as this report"
    );
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain(
      'A domain usually ends up as a manually-imported Session Cookies cookie because credentialed auto-login already didn\'t work for it'
    );
  });

  // ENG-1953 follow-up: the reported bug was literally this misunderstanding —
  // the user read "log into Luma" as the complete fix and expected the session
  // to reach Emma on its own. Emma's own instructions must make the second,
  // actually-load-bearing step (copying the cookie into Settings) impossible to
  // miss, with a direct link so there's no ambiguity about where that happens.
  it('requires both re-import steps to be stated together, with a direct link to the Session Cookies settings page', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('logging into the site is not enough on its own');
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain(
      'copy that session\'s cookie into **Settings > Session Cookies** themselves'
    );
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('/settings/browser-sessions');
  });
});

// ENG-2338: a user was told to import a cookie but not how; the agent also gave
// up on a gate it never re-checked after its final wait.
describe('ENG-2338 bot-gate handoff', () => {
  it('requires a final snapshot after the last wait before declaring the gate stuck', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('Never declare the gate stuck from a wait you did not re-check');
  });

  it('gives the cookie-header how-to inline instead of leaving the user to ask', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('Do not make the user ask how');
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('DevTools → Network');
  });
});

// ENG-2338: Luma's API is the reliable path; the browser is the fallback.
describe('ENG-2338 Luma API-first guidance', () => {
  it('tells the agent to try the Luma API tools before a browser, and never to take a key in chat', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('luma_get_guests');
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('before opening a browser');
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('Never ask the user to paste an API key into the chat');
  });
});

// ENG-2338: the Luma key is NOT in Connected Accounts (OAuth only); Emma must send users to the card.
describe('ENG-2338 Luma key placement', () => {
  it('tells the agent the key goes on Login Credentials, with a direct link, never Connected Accounts', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('saved on the "Luma API key" card in Settings > Login Credentials');
    // The exact markdown link renders clickable in chat (checked in the preview); a bare path does not.
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('[Settings → Login Credentials](/settings/login-credentials)');
    expect(AGENT_MODE_SYSTEM_PROMPT).not.toMatch(/Connected Accounts[^\n]{0,40}Luma|Luma[^\n]{0,40}Connected Accounts/);
  });
});
