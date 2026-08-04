import { AGENT_MODE_SYSTEM_PROMPT } from '../docs/agentModeSystemPrompt';

// ENG-829: In an analytics session Emma asserted conclusions about a live property's
// tracking configuration (GA4 key events, UTM tagging, form fields) from inference and
// stale memory, and only reached for browser/analytics tools after the user escalated
// with "STOP GUESSING!". The verified/unverified split arrived as a post-escalation
// recovery artifact instead of being present from the first response.
describe('Agent Mode system prompt — analytics verify-before-assert discipline', () => {
  it('has a dedicated analytics/tracking verification section', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('## Analytics & Tracking Claims (CRITICAL)');
  });

  it('requires reading live configuration before stating a conclusion about it', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain(
      'Never state a conclusion about how a live site or analytics property is configured'
    );
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('Verify first, then answer — never answer, then verify');
  });

  it('names the configuration surfaces that must be read rather than inferred', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('key events');
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('UTM');
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('form fields');
  });

  it('forbids treating a tool payload field name as evidence of configuration', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain(
      'A field NAME in a tool payload is not evidence of configuration'
    );
  });

  it('requires re-verifying analytics facts carried in from memory or a prior session', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('re-verify it in THIS session before you act on it or repeat it');
  });

  it('requires verified/unverified labelling from the first response, not after pushback', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('from your FIRST response');
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('not as a correction after the user pushes back');
  });

  it('requires saying so plainly when no tool can verify a claim', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain(
      'say plainly that you cannot verify it and do not characterise it in either direction'
    );
  });
});
