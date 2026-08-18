/**
 * ENG-1312 criterion 3: "Deterministic replay fixtures with hard thresholds
 * (chars/tokens, not judge score): the five named real production sessions
 * are checked into the eval set (Okareo or characterization) with the
 * thresholds from ENG-1309/1310/1311; a regression above threshold fails CI
 * for agentMode PRs."
 *
 * Scope note (see the ENG-1312 Linear comment + the ENG-1314 child issue this
 * PR links): all five real session IDs named in this issue's own acceptance
 * criteria are real production AW-ChatSessions rows (verified read-only), so
 * the fixtures ARE buildable — but only by copying that real customer
 * conversation content into permanently committed, CI-gating git history.
 * That is a data-exposure decision, not a code decision, and ENG-1314 asks
 * Harsha to pick where that content lives.
 *
 * So this harness is real and fully wired — the mechanism that "a regression
 * above threshold fails CI" is proven below with synthetic content standing
 * in for each named session. The fixture `id`/`label` below are neutral,
 * synthetic slugs, not the real production session IDs or customer/org names
 * (CodeRabbit, PR #2443) — that redaction doesn't wait on ENG-1314 either,
 * since it only reduces exposure and the checker never reads `label` or the
 * `user` turn. Swapping in the real transcript (sourced per ENG-1314's
 * decision) is the only remaining step; no harness code changes.
 *
 * Only 3 of the 5 named sessions have an explicit numeric char/word threshold
 * in the human-written text (ENG-1309's own acceptance criteria). The other
 * two are about unnecessaryPermissionRequest and pushback respectively, for
 * which ENG-1309/1310/1311 give no char/token number — so they are
 * registered (proving CI coverage of every named session) with
 * `pending: true` rather than a fabricated threshold.
 */
import {
  REPLAY_FIXTURES,
  checkReplayFixture,
  checkAllReplayFixtures,
  type JudgeReplayFixture,
} from '../loops/eval/agentModeReplayFixtures';

describe('agentModeReplayFixtures (ENG-1312 criterion 3)', () => {
  // FAIL tests -------------------------------------------------------------

  it('registers a fixture for every session named in ENG-1312/ENG-1309\'s own acceptance criteria (5 total, neutral synthetic IDs — CodeRabbit, PR #2443)', () => {
    expect(REPLAY_FIXTURES).toHaveLength(5);
    for (const f of REPLAY_FIXTURES) {
      // Neutral slugs only — never a real production session ID (all-digit/hex).
      expect(f.id).not.toMatch(/^[0-9a-f]{8}$/i);
    }
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

  it('checkReplayFixture treats an empty assistant reply as 0 words, not a threshold violation', () => {
    const fixture: JudgeReplayFixture = {
      id: 'test-empty',
      label: 'test',
      thresholdSource: 'ENG-1309 test',
      isPlaceholder: true,
      pending: false,
      turns: [{ role: 'assistant', content: '   ' }],
      assertion: { maxWords: 150, maxChars: 600 },
    };
    expect(checkReplayFixture(fixture).pass).toBe(true);
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

  it('checkReplayFixture fails a non-pending fixture that has neither maxChars nor maxWords set (CodeRabbit, PR #2443) — a misconfigured threshold must not silently pass', () => {
    const fixture: JudgeReplayFixture = {
      id: 'test-ungated',
      label: 'test',
      thresholdSource: 'ENG-1309 test',
      isPlaceholder: true,
      pending: false,
      turns: [{ role: 'assistant', content: 'x'.repeat(999999) }],
      assertion: {},
    };
    const result = checkReplayFixture(fixture);
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/no threshold|misconfigur|maxChars|maxWords/i);
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

  it('the registered length-limit-ignored-1 fixture uses the ENG-1309 ~6,000 char threshold', () => {
    const f = REPLAY_FIXTURES.find((x) => x.id === 'length-limit-ignored-1')!;
    expect(f.assertion.maxChars).toBe(6000);
  });

  it('the registered yesno-terse-1 fixture uses the ENG-1309 600 char threshold', () => {
    const f = REPLAY_FIXTURES.find((x) => x.id === 'yesno-terse-1')!;
    expect(f.assertion.maxChars).toBe(600);
  });

  it('the registered yesno-terse-2 fixture uses the ENG-1309 150 word threshold', () => {
    const f = REPLAY_FIXTURES.find((x) => x.id === 'yesno-terse-2')!;
    expect(f.assertion.maxWords).toBe(150);
  });

  it('checkAllReplayFixtures: today\'s placeholder content for every thresholded fixture passes (proves the harness is wired to something reasonable while real content is pending)', () => {
    const results = checkAllReplayFixtures();
    const failures = results.filter((r) => !r.pass);
    expect(failures).toEqual([]);
  });

  it('checkAllReplayFixtures: a synthetic regression above threshold is caught (the actual CI-gating mechanism criterion 3 requires)', () => {
    const regressed: JudgeReplayFixture[] = REPLAY_FIXTURES.map((f) =>
      f.id === 'length-limit-ignored-1'
        ? { ...f, turns: [{ role: 'assistant', content: 'x'.repeat(10524) }] } // today's real over-length count from ENG-1309
        : f,
    );
    const results = checkAllReplayFixtures(regressed);
    const failed = results.find((r) => r.id === 'length-limit-ignored-1')!;
    expect(failed.pass).toBe(false);
  });
});
