import { AGENT_MODE_SYSTEM_PROMPT } from '../docs/agentModeSystemPrompt';
import { AgentModeService } from '../services/agentModeService';

// ENG-795: the weekly RankAI SEO/GEO report produced zero output every run. The
// persisted rankai.ai session had died, the signin page is walled by an
// invisible reCAPTCHA that 2captcha returns ERROR_CAPTCHA_UNSOLVABLE for, and
// the prompt told Emma that an unattended run "cannot relay a one-time code" —
// so every path out was closed and the run correctly, but permanently, gave up.
// Two tools now open that path (a credentialed signin and an inbox code reader);
// these assertions cover the two ways they could still be unreachable in prod:
// not being offered to the model, and the prompt still teaching the old dead end.
describe('AgentMode email-code login recovery (ENG-795)', () => {
  describe('tool availability', () => {
    it('offers read_verification_code as a foundation tool', () => {
      expect(AgentModeService.DEFAULT_FOUNDATION_TOOLS).toContain('read_verification_code');
    });

    it('offers open_site_signin as a foundation tool', () => {
      // Skill tool lists live in DynamoDB, so a tool that is only "browser
      // automation"-shaped would be invisible to every existing session.
      expect(AgentModeService.DEFAULT_FOUNDATION_TOOLS).toContain('open_site_signin');
    });
  });

  describe('prompt guidance', () => {
    it('tells Emma to read the one-time code from the connected mailbox', () => {
      expect(AGENT_MODE_SYSTEM_PROMPT).toContain('read_verification_code');
      expect(AGENT_MODE_SYSTEM_PROMPT).toContain('Settings > Connected Accounts');
    });

    it('no longer claims a scheduled run cannot relay a one-time code', () => {
      expect(AGENT_MODE_SYSTEM_PROMPT).not.toContain('cannot relay a one-time code');
    });

    it('states the code tool ignores emails from before the login attempt', () => {
      expect(AGENT_MODE_SYSTEM_PROMPT).toContain('never hand you the previous run');
    });

    it('forbids inventing a code or continuing as if signed in', () => {
      expect(AGENT_MODE_SYSTEM_PROMPT).toContain('never invent a code');
    });

    it('routes credentialed sites to open_site_signin instead of solve_captcha', () => {
      expect(AGENT_MODE_SYSTEM_PROMPT).toContain('open_site_signin');
      expect(AGENT_MODE_SYSTEM_PROMPT).toContain('not solvable by the solver');
    });

    it('keeps the credential out of anything Emma can echo', () => {
      expect(AGENT_MODE_SYSTEM_PROMPT).toContain('never shown to you');
    });

    it('explains the refusal that protects a browser working elsewhere', () => {
      expect(AGENT_MODE_SYSTEM_PROMPT).toContain('browser_on_other_site');
      expect(AGENT_MODE_SYSTEM_PROMPT).toContain('never pull the browser away from other work');
    });
  });
});
