import { AGENT_MODE_SYSTEM_PROMPT } from '../docs/agentModeSystemPrompt';

// ENG-1311 (fix for ENG-1307: "Emma argues with direct user instructions instead
// of complying or pushing back once"). Human-drafted behavioral contract, from
// real customer transcripts:
//
//   xCures (Ed, Fathom 784962553 @05:09): "She argues with me. I'll say, I need
//   this to go this way. And she'll come back and go, no, it shouldn't go that
//   way... if I'm wrong, tell me I'm wrong, but don't just argue with me."
//
//   Telemetry (ENG-1307 comment): "argued/pushed back" judge reasons went 3 -> 16
//   (14 of those scored a 5 -- the judge rewards it); "refused/held for approval"
//   went 17 -> 39.
//
// AC1: on an explicit instruction that is not spend/publish/send/irreversible,
// Emma performs it; any disagreement is at most one sentence appended after the
// action, never a counter-proposal in place of it.
//
// Replay fixtures named in the Linear AC (68c9a8fb [25], 9481f94e [52]) are real
// transcript turns -- verifying the model's live behavior against them is Okareo
// eval work tracked separately (ENG-1312). What this suite proves is the
// enforceable surface available to a unit test: the system prompt actually states
// the "comply first, one line max, after not instead" contract in unambiguous
// terms an LLM can follow.
describe('AgentMode system prompt - follow explicit direction (ENG-1311)', () => {
  it('has a dedicated Follow Explicit Direction section', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('Follow Explicit Direction');
  });

  it('requires performing the instruction first, not substituting a counter-proposal', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('Perform it first');
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain(
      'do not substitute a counter-proposal, a request for permission, or a restatement of your own prior position in place of the action'
    );
  });

  it('caps disagreement at one sentence, appended AFTER complying, never before', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('At most one line of pushback, AFTER complying');
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('Never open with the disagreement, never repeat it');
  });

  it('requires a factual correction to be stated plainly once, not argued at length', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('State a correction plainly, once');
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('do not soften it into a question');
  });

  it('carves out genuine ambiguity and the explicit-confirmation gates as still requiring a question', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('does not override a genuine ambiguity');
  });

  it('appears before "When to Ask Questions" so direction-following and confirmation policy read together', () => {
    const directionIdx = AGENT_MODE_SYSTEM_PROMPT.indexOf('## Follow Explicit Direction');
    const askIdx = AGENT_MODE_SYSTEM_PROMPT.indexOf('## When to Ask Questions');
    expect(directionIdx).toBeGreaterThan(-1);
    expect(askIdx).toBeGreaterThan(-1);
    expect(directionIdx).toBeLessThan(askIdx);
  });
});
