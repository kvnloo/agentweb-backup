import { AGENT_MODE_SYSTEM_PROMPT } from '../docs/agentModeSystemPrompt';
import { MIN_PROMPTS } from '../services/skillHardening/applyHardening';

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

  // CodeRabbit (PR #2445): the "ONLY for three things" rule, read alone, would
  // conflict with MIN_PROMPTS.googleCalendar ("CONFIRM before any
  // create/update/delete" — unconditional) and MIN_PROMPTS.meetingIntelligence
  // ("show the draft and get explicit approval" before task/calendar writes) —
  // a reversible calendar write matches none of the three named exceptions,
  // so the composed prompt (base + installed-skill context, see
  // agentModeService.ts's `installedSkillContextMsg`) would hand the model two
  // contradictory rules for the same action. Fix: state explicit precedence
  // (a floor, not a ceiling) rather than rewording the skill-specific prompts,
  // so calendar/meeting-intelligence behavior is unchanged.
  describe('composed-prompt path: does not contradict stricter skill-specific confirmation rules', () => {
    it('states the confirmation-scope rule is a floor a skill can raise, not a ceiling', () => {
      expect(AGENT_MODE_SYSTEM_PROMPT).toContain('This is a FLOOR, not a ceiling');
      expect(AGENT_MODE_SYSTEM_PROMPT).toContain(
        "this rule never lowers another skill's explicit confirmation requirement"
      );
    });

    it('leaves MIN_PROMPTS.googleCalendar\'s unconditional confirm-before-write rule in place', () => {
      expect(MIN_PROMPTS.googleCalendar).toContain(
        'CONFIRM before any create/update/delete'
      );
    });

    it('leaves MIN_PROMPTS.meetingIntelligence\'s confirm-before-write rule in place', () => {
      expect(MIN_PROMPTS.meetingIntelligence).toContain(
        'Before any action that writes or sends'
      );
    });

    it('composing base prompt + a stricter installed skill yields both rules, with the floor rule readable as deferring to the skill', () => {
      // Mirrors how agentModeService.ts's installedSkillContextMsg concatenates
      // an installed skill's systemPrompt alongside the base system prompt.
      const composed = `${AGENT_MODE_SYSTEM_PROMPT}\n\nInstalled Skills:\ngoogleCalendar- Google Calendar: ${MIN_PROMPTS.googleCalendar}`;
      expect(composed).toContain('Explicit confirmation is required ONLY for three things');
      expect(composed).toContain('This is a FLOOR, not a ceiling');
      expect(composed).toContain('CONFIRM before any create/update/delete');
    });
  });
});
