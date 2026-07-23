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
});
