import { AGENT_MODE_SYSTEM_PROMPT } from '../docs/agentModeSystemPrompt';

// ENG-431: in Slack-triggered sessions, a message that @mentions someone other
// than Emma must not be answered as if Emma were that person. Emma offers once to
// draft a reply for human review instead. Agent-drafted contract (ENG-431 comment
// 2026-10-07); verifying live model behavior is eval work, this pins the prompt.
describe('AgentMode system prompt - third-party Slack @mention guard (ENG-431)', () => {
  it('has a dedicated Third-Party Mention Guard section', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('### Third-Party Mention Guard');
  });

  it('forbids answering as if Emma were the mentioned person (AC1)', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain(
      'do not answer as if you were the mentioned person'
    );
  });

  it('offers a single one-line draft offer, never an auto-send (AC2)', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('offer once, in one line, to draft a reply');
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('Never send it on your own');
  });

  it('skips the offer when Emma is the addressee or a draft was already requested (AC3)', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain(
      'Skip the offer when you are the only person mentioned'
    );
  });

  it('keeps the existing Drafting Direction Guard intact (AC4)', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('### Drafting Direction Guard');
  });
});
