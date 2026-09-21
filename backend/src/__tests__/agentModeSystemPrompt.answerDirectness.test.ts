import { AGENT_MODE_SYSTEM_PROMPT } from '../docs/agentModeSystemPrompt';

// ENG-1309 (fix for ENG-1306: "Emma ignores explicit length/conciseness
// instructions — 20 pages instead of 2, same prompt correct in Claude").
// Human-drafted behavioral contract (drafted by Fable from Ed Mongiovi's and
// Vince Magaline's own words on real transcripts, confirmed by Harsha
// 2026-08-18 on ENG-1305):
//
//   xCures (Ed, Fathom 784962553): "I've asked her many yes or no questions.
//   She's never answered yes or no... two or three pages of opinions and
//   rhetoric"; a 2-page ask returned 20 pages, then 7; the same prompt in
//   Claude returned 2 pages in 5 minutes.
//
// Replay fixtures named in the Linear AC (68c9a8fb [15]/[25], 51674765 [42],
// eecb6d31) are real transcript turns. Verifying the model's live output
// length against them is deterministic-but-content-blocked eval work already
// built in loops/eval/agentModeReplayFixtures.ts (ENG-1312 criterion 3, real
// content pending the ENG-1314 data-exposure decision — see that module's
// doc comment). What THIS suite characterizes is the enforceable surface a
// unit test actually has: the system prompt states the "yes/no first,
// explicit length honored, terse by default with a compact per-claim tag"
// contract in unambiguous terms an LLM can follow — pinned RED (absent)
// before this PR's prompt change, GREEN (present) after.
describe('AgentMode system prompt — answer directness & length contract (ENG-1309)', () => {
  it('has a dedicated Answer Directness & Length section', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('## Answer Directness & Length (CRITICAL)');
  });

  // Criterion 1: yes/no first, ≤2 sentences of evidence.
  it('requires a Yes/No/Can\'t-verify first line for yes/no-shaped questions, before any caveat', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('Yes/no first');
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain("Can't verify — <one reason>");
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('as the FIRST LINE');
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('at most 2 sentences of evidence');
  });

  // Criterion 2: explicit length is a hard target (±20%), first attempt.
  it('requires honoring an explicit stated length within ~20% on the first attempt', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('An explicit length is a target, not a suggestion');
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('within ~20%');
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('on your FIRST attempt');
  });

  // CodeRabbit (PR #2468): the mandatory "Every message must end with:
  // 👉 Next Step: ..." closing (Content Quality Standard, above) is
  // unconditional elsewhere in the prompt and would make a tight explicit
  // length (e.g. "ten words") structurally impossible to honor unless the
  // length rule explicitly takes precedence over it.
  it('makes an explicit stated length override the mandatory Next Step closing when both cannot fit', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain(
      'That budget covers the ENTIRE visible response, including the mandatory 👉 Next Step closing',
    );
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain(
      'drop the Next Step line for that reply rather than exceed the length the user asked for',
    );
  });

  // Criterion 3: terse by default (~150 words) on factual/config questions,
  // and a compact per-claim tag replacing the old two-separate-lists format.
  it('requires factual/config answers to stay under ~150 words unless depth is requested', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('under ~150 words');
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('unless the user asks for depth');
  });

  it('replaces the two-separate-lists verified/unverified format with a compact per-claim tag', () => {
    // The new instruction (in both the new section and the updated Analytics
    // bullet) is present...
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('never as two separate lists');
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('one compact tag per claim');
    // ...and the old contradictory instruction this replaces is gone. Two
    // simultaneous instructions ("keep two lists" + "never two lists") is
    // exactly the additive-only pattern that regressed twice before
    // (ENG-829, ENG-1187) — this proves it was replaced, not duplicated.
    expect(AGENT_MODE_SYSTEM_PROMPT).not.toContain('Keep the two lists visibly separate');
  });

  it('keeps the ENG-829 first-response verified/unverified labeling requirement intact', () => {
    // Unchanged invariant from ENG-829 — this PR changes the FORMAT (inline
    // tag vs. two lists), never the underlying verify-before-assert rule.
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('from your FIRST response');
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('not as a correction after the user pushes back');
  });

  // Criterion 4 ("measured in characters/tokens, not judge score") has no
  // prompt-text surface — it governs how the fixtures in
  // loops/eval/agentModeReplayFixtures.ts are graded, not what the model is
  // told. Covered by agentModeReplayFixtures.test.ts (ENG-1312, unchanged by
  // this PR).

  it('does not tell the model to pad short answers or default to exhaustive depth', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('not the default shape of a factual or yes/no answer');
  });

  it('the new section appears early, alongside the other response-shaping CRITICAL rules — before "When to Ask Questions"', () => {
    const directnessIdx = AGENT_MODE_SYSTEM_PROMPT.indexOf('## Answer Directness & Length');
    const followIdx = AGENT_MODE_SYSTEM_PROMPT.indexOf('## Follow Explicit Direction');
    const askIdx = AGENT_MODE_SYSTEM_PROMPT.indexOf('## When to Ask Questions');
    expect(directnessIdx).toBeGreaterThan(-1);
    expect(followIdx).toBeGreaterThan(-1);
    expect(askIdx).toBeGreaterThan(-1);
    expect(followIdx).toBeLessThan(directnessIdx);
    expect(directnessIdx).toBeLessThan(askIdx);
  });

  it('the now-redundant generic "keep responses concise" line is removed, not left as a second, weaker, ignored instruction', () => {
    // This exact generic line existed pre-fix and was demonstrably ignored
    // (that's the customer complaint this ticket fixes) — a strong, specific
    // rule superseding a vague, already-proven-ineffective one should REPLACE
    // it, not sit alongside it as a second contradictory-strength signal.
    expect(AGENT_MODE_SYSTEM_PROMPT).not.toContain('Keep responses concise but informative');
  });
});
