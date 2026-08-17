/**
 * ENG-1312 criterion 3: "Deterministic replay fixtures with hard thresholds
 * (chars/tokens, not judge score): the four Ed sessions + Phoenix `822c1ed4`
 * + mvarma `eecb6d31` are checked into the eval set (Okareo or
 * characterization) with the thresholds from ENG-1309/1310/1311; a regression
 * above threshold fails CI for agentMode PRs."
 *
 * Scope note (see the ENG-1312 Linear comment + the ENG-1314 child issue this
 * PR links): all five session IDs named in this issue's own acceptance
 * criteria are real production AW-ChatSessions rows (verified read-only), so
 * the fixtures ARE buildable — but only by copying real, named customers'
 * (Ed/xCures, Phoenix/Vince) verbatim conversation content into permanently
 * committed, CI-gating git history. That is a data-exposure decision, not a
 * code decision, and ENG-1314 asks Harsha to pick where that content lives.
 *
 * So this harness is real and fully wired — the mechanism that "a regression
 * above threshold fails CI" is proven below with synthetic content standing
 * in for each named session. Swapping REPLAY_FIXTURES' placeholder `turns`
 * for the real transcript (sourced per ENG-1314's decision) is the only
 * remaining step; no harness code changes.
 *
 * Only 3 of the 5 named sessions have an explicit numeric char/word threshold
 * in the human-written text (ENG-1309's own acceptance criteria). The other
 * two (822c1ed4, 9481f94e) are about unnecessaryPermissionRequest and
 * pushback respectively, for which ENG-1309/1310/1311 give no char/token
 * number — so they are registered (proving CI coverage of every named
 * session) with `pending: true` rather than a fabricated threshold.
 */
import {
  REPLAY_FIXTURES,
  checkReplayFixture,
  checkAllReplayFixtures,
  type JudgeReplayFixture,
} from '../loops/eval/agentModeReplayFixtures';

describe('agentModeReplayFixtures (ENG-1312 criterion 3)', () => {
  // FAIL tests -------------------------------------------------------------

  it('registers every session ID named in ENG-1312/ENG-1309\'s own acceptance criteria', () => {
    const ids = REPLAY_FIXTURES.map((f) => f.id);
    expect(ids).toEqual(
      expect.arrayContaining(['51674765', '822c1ed4', '68c9a8fb', '9481f94e', 'eecb6d31']),
    );
  });

  it('every fixture with a numeric threshold cites its source issue in a comment-visible field', () => {
    const thresholded = REPLAY_FIXTURES.filter((f) => !f.pending);
    expect(thresholded.length).toBeGreaterThanOrEqual(3);
    for (const f of thresholded) {
      expect(f.thresholdSource).toMatch(/ENG-1309/);
    }
  });

  it('every fixture is explicitly marked isPlaceholder until ENG-1314 resolves (never silently treated as real evidence)', () => {
    for (const f of REPLAY_FIXTURES) {
      expect(f.isPlaceholder).toBe(true);
    }
  });

  it('checkReplayFixture fails a fixture whose reply exceeds its maxChars threshold', () => {
    const fixture: JudgeReplayFixture = {
      id: 'test-over',
      label: 'test',
      thresholdSource: 'ENG-1309 test',
      isPlaceholder: true,
      pending: false,
      turns: [{ role: 'assistant', content: 'x'.repeat(700) }],
      assertion: { maxChars: 600 },
    };
    const result = checkReplayFixture(fixture);
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/700.*600|exceeds/i);
  });

  it('checkReplayFixture fails a fixture whose reply exceeds its maxWords threshold', () => {
    const fixture: JudgeReplayFixture = {
      id: 'test-words',
      label: 'test',
      thresholdSource: 'ENG-1309 test',
      isPlaceholder: true,
      pending: false,
      turns: [{ role: 'assistant', content: Array.from({ length: 200 }, () => 'word').join(' ') }],
      assertion: { maxWords: 150 },
    };
    const result = checkReplayFixture(fixture);
    expect(result.pass).toBe(false);
  });

  it('a pending fixture (no numeric threshold given) never fails CI — it is registered, not gated', () => {
    const fixture: JudgeReplayFixture = {
      id: 'test-pending',
      label: 'test',
      thresholdSource: 'none specified in ENG-1309/1310/1311',
      isPlaceholder: true,
      pending: true,
      turns: [{ role: 'assistant', content: 'x'.repeat(999999) }],
      assertion: {},
    };
    const result = checkReplayFixture(fixture);
    expect(result.pass).toBe(true);
    expect(result.reason).toMatch(/pending/i);
  });

  // SUCCESS tests ------------------------------------------------------------

  it('checkReplayFixture passes a fixture whose reply is within its maxChars threshold', () => {
    const fixture: JudgeReplayFixture = {
      id: 'test-under',
      label: 'test',
      thresholdSource: 'ENG-1309 test',
      isPlaceholder: true,
      pending: false,
      turns: [{ role: 'assistant', content: 'x'.repeat(500) }],
      assertion: { maxChars: 600 },
    };
    expect(checkReplayFixture(fixture).pass).toBe(true);
  });

  it('the registered 51674765 fixture uses the ENG-1309 ~6,000 char threshold', () => {
    const f = REPLAY_FIXTURES.find((x) => x.id === '51674765')!;
    expect(f.assertion.maxChars).toBe(6000);
  });

  it('the registered 68c9a8fb fixture uses the ENG-1309 600 char threshold', () => {
    const f = REPLAY_FIXTURES.find((x) => x.id === '68c9a8fb')!;
    expect(f.assertion.maxChars).toBe(600);
  });

  it('the registered eecb6d31 fixture uses the ENG-1309 150 word threshold', () => {
    const f = REPLAY_FIXTURES.find((x) => x.id === 'eecb6d31')!;
    expect(f.assertion.maxWords).toBe(150);
  });

  it('checkAllReplayFixtures: today\'s placeholder content for every thresholded fixture passes (proves the harness is wired to something reasonable while real content is pending)', () => {
    const results = checkAllReplayFixtures();
    const failures = results.filter((r) => !r.pass);
    expect(failures).toEqual([]);
  });

  it('checkAllReplayFixtures: a synthetic regression above threshold is caught (the actual CI-gating mechanism criterion 3 requires)', () => {
    const regressed: JudgeReplayFixture[] = REPLAY_FIXTURES.map((f) =>
      f.id === '51674765'
        ? { ...f, turns: [{ role: 'assistant', content: 'x'.repeat(10524) }] } // today's real over-length count from ENG-1309
        : f,
    );
    const results = checkAllReplayFixtures(regressed);
    const failed = results.find((r) => r.id === '51674765')!;
    expect(failed.pass).toBe(false);
  });
});
