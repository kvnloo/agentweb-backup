import { AGENT_MODE_SYSTEM_PROMPT } from '../docs/agentModeSystemPrompt';

// ENG-1311 (fix for ENG-1307). Human-drafted behavioral contract:
//
//   Phoenix kickoff, 08-14 (Fathom 783353558 @54:00): "number one is asking for
//   permission to like run a test"; Harsha told Vince to "just ignore what Emma
//   said". Session 822c1ed4 (work-plan step "run a test") should proceed without
//   a permission prompt.
//
// AC2: explicit confirmation is requested for spend changes, publish/send, and
// irreversible data actions ONLY -- never for read-only tests, drafts, research,
// or analysis.
//
// A live-transcript replay proving the MODEL's behavior (session 822c1ed4 for the
// "proceeds without asking" side, a Meta budget change for the "still asks" side)
// is Okareo eval work tracked under ENG-1312. This suite proves the enforceable
// unit-test surface: the prompt states the confirmation-only-for-money/publish/
// send/irreversible rule explicitly, and the pre-existing spend/publish
// confirmation instances (Slack send, Meta/Google Ads writes) are undisturbed.
describe('AgentMode system prompt - confirmation scoped to money/publish/send/irreversible (ENG-1311)', () => {
  it('states confirmation is required ONLY for spend, publish/send, and irreversible actions', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain(
      'Explicit confirmation is required ONLY for three things: spend changes'
    );
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('publish/send actions');
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('irreversible data actions');
  });

  it('explicitly excludes tests, reads, drafts, research, and analysis from the confirmation gate', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain(
      'running a test, reading data, producing a draft, research, analysis'
    );
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain(
      'do not ask "should I run this?" or "should I proceed?" for a reversible, non-spending, non-publishing step'
    );
  });

  it('leaves the existing Slack-send confirmation gate (a publish/send action) in place', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain(
      'ask for explicit approval BEFORE calling `slack_send_message`'
    );
  });

  it('leaves the existing Google Ads spend-confirmation gate in place', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain(
      'ALWAYS get user confirmation before any write action (create, pause, resume campaigns) — this spends real money.'
    );
  });

  it('the new confirmation-scope rule lives inside "When to Ask Questions"', () => {
    const sectionStart = AGENT_MODE_SYSTEM_PROMPT.indexOf('## When to Ask Questions');
    const sectionEnd = AGENT_MODE_SYSTEM_PROMPT.indexOf('## Skill Descriptions');
    expect(sectionStart).toBeGreaterThan(-1);
    expect(sectionEnd).toBeGreaterThan(sectionStart);
    const section = AGENT_MODE_SYSTEM_PROMPT.slice(sectionStart, sectionEnd);
    expect(section).toContain('Explicit confirmation is required ONLY for three things');
  });
});
