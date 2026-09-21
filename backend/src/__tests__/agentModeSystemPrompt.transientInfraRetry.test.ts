import { AGENT_MODE_SYSTEM_PROMPT } from '../docs/agentModeSystemPrompt';

// ENG-828: a landing-page work-plan session (b397bf89) stalled mid-flight and
// left the "Fix Deviations & Confirm Final Page" step stranded `pending` with
// no resume path. The raw DynamoDB record (workPlan.steps + failedFunctions)
// shows the step that actually failed there called `coding_agent` (a 10-min
// internal timeout, `state: 'timed_out'`, `retryable: true`) — not a v0-backed
// tool; the session's own satisfaction-score reasoning is what named
// "V0_CALL_TIMEOUT", and isn't itself raw evidence of which tool failed. That
// distinction matters here because coding_agent, unlike v0-backed tools,
// does NOT resume an in-flight job on retry — see the "does NOT resume"
// carve-out below.
//
// Root cause (confirmed generally, independent of which single tool tripped
// it in that session): the system prompt's Anti-Loop Rule ("NEVER call the
// same tool with identical arguments more than once") had no exception for a
// transient/infrastructure failure (timeout, 5xx, network blip) — only for an
// explicit user regeneration request. v0Service itself never auto-retries a
// timeout (every withRetry call site passes `retryOnTimeout: false`), so any
// V0_CALL_TIMEOUT/V0_GENERATION_TIMEOUT reaches the model on the first
// attempt — and the model correctly explained the failure but never retried,
// even when retrying was safe (v0-backed tools resume the same in-flight
// chat rather than restarting). Fix: teach the model this class of failure is
// retryable once, automatically, before surfacing it to the user — while
// warning it that coding_agent specifically restarts from scratch on retry.
describe('Agent Mode system prompt — retrying a transient infrastructure failure', () => {
  it('carves out a transient-failure exception distinct from user-requested regeneration', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('Retrying a Transient Failure');
  });

  it('names the V0 timeout codes so the model recognizes this failure class', () => {
    const idx = AGENT_MODE_SYSTEM_PROMPT.indexOf('## Retrying a Transient Failure');
    expect(idx).toBeGreaterThanOrEqual(0);
    const endIdx = AGENT_MODE_SYSTEM_PROMPT.indexOf('## Scheduled Chats', idx);
    const section = AGENT_MODE_SYSTEM_PROMPT.slice(idx, endIdx);
    expect(section).toContain('V0_CALL_TIMEOUT');
    expect(section).toContain('V0_GENERATION_TIMEOUT');
  });

  it('instructs one automatic retry of the same tool before reporting failure', () => {
    const idx = AGENT_MODE_SYSTEM_PROMPT.indexOf('## Retrying a Transient Failure');
    const endIdx = AGENT_MODE_SYSTEM_PROMPT.indexOf('## Scheduled Chats', idx);
    const section = AGENT_MODE_SYSTEM_PROMPT.slice(idx, endIdx);
    expect(section.toLowerCase()).toMatch(/retry the same tool call once/);
    expect(section).toContain('generate_landing_page');
  });

  it('tells the model to leave a work-plan step pending (not report defeat) on a transient failure', () => {
    const idx = AGENT_MODE_SYSTEM_PROMPT.indexOf('## Retrying a Transient Failure');
    const endIdx = AGENT_MODE_SYSTEM_PROMPT.indexOf('## Scheduled Chats', idx);
    const section = AGENT_MODE_SYSTEM_PROMPT.slice(idx, endIdx);
    expect(section).toContain('pending');
  });

  it('warns that coding_agent does not resume on retry, unlike the v0-backed tools', () => {
    const idx = AGENT_MODE_SYSTEM_PROMPT.indexOf('## Retrying a Transient Failure');
    const endIdx = AGENT_MODE_SYSTEM_PROMPT.indexOf('## Scheduled Chats', idx);
    const section = AGENT_MODE_SYSTEM_PROMPT.slice(idx, endIdx);
    expect(section).toContain('coding_agent` does NOT resume');
  });

  it('the Anti-Loop Rule itself references the transient-failure exception', () => {
    const idx = AGENT_MODE_SYSTEM_PROMPT.indexOf('## Anti-Loop Rule (CRITICAL)');
    expect(idx).toBeGreaterThanOrEqual(0);
    const endIdx = AGENT_MODE_SYSTEM_PROMPT.indexOf('## Retrying a Transient Failure', idx);
    const section = AGENT_MODE_SYSTEM_PROMPT.slice(idx, endIdx);
    expect(section).toContain('Retrying a Transient Failure');
  });
});
