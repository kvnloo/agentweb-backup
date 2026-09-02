import { AGENT_MODE_SYSTEM_PROMPT } from '../docs/agentModeSystemPrompt';

// ENG-828: a landing-page generation/fix session (b397bf89) hit V0_CALL_TIMEOUT
// mid-work-plan and stopped, leaving the "Fix Deviations & Confirm Final Page"
// step stranded pending with no resume path — even though the underlying v0
// job (v0ChatId) stays reusable and a retry does NOT re-charge or restart it.
//
// Root cause: the system prompt's Anti-Loop Rule ("NEVER call the same tool
// with identical arguments more than once") has no exception for a transient/
// infrastructure failure (timeout, 5xx, network blip) — only for an explicit
// user regeneration request. So the model correctly explained the timeout
// but never retried, even though retrying was safe and often would have
// resumed the same in-flight job. Fix: teach the model this class of failure
// is retryable once, automatically, before surfacing it to the user.
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
