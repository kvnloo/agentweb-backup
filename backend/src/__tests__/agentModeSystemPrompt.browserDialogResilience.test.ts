import { AGENT_MODE_SYSTEM_PROMPT } from '../docs/agentModeSystemPrompt';

// ENG-1953: reported as "cookie not shared to agent, still had to manually
// upload the list" — but the session that produced the report shows cookie
// restoration succeeded and browser_navigate succeeded twice. The only
// failure was a single browser_handle_dialog call reporting "No dialog
// visible" (a benign race: the dialog had already resolved on its own).
// Emma treated that one transient error as proof the browser tools were
// unavailable and abandoned them for the rest of the task, defaulting to
// asking the user to attach a CSV even though navigation still worked. The
// system prompt never told Emma that a single dialog-handling error is
// recoverable, so it over-reacted. This guidance corrects that.
describe('AgentMode system prompt - browser-tool transient error resilience', () => {
  it('explains "No dialog visible" is a benign, already-resolved race, not a broken browser', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('No dialog visible');
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('the dialog already resolved itself');
  });

  it('forbids treating one failed browser-tool call as proof the browser is unavailable', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain(
      'Do **not** respond to one failed browser-tool call by concluding the browser tools are unavailable'
    );
  });

  it('directs Emma to retry or take a browser_snapshot before giving up on the session', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('browser_snapshot');
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('confirm the actual page state before deciding the session is unusable');
  });

  it('only allows falling back to user-provided data after repeated real failures, not a single dialog error', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain(
      'Only fall back to user-provided data after a real, repeated failure to navigate or interact with the page'
    );
  });
});
