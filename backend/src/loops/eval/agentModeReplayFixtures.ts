/**
 * ENG-1312 criterion 3 — deterministic replay fixtures with hard char/word
 * thresholds (NOT judge score) for the named real customer sessions.
 *
 * Pure and IO-free by design (no chatbotDb/DynamoDB dependency): this module
 * only defines fixtures and evaluates them against a transcript already in
 * memory. That keeps it trivially unit-testable and, more importantly, keeps
 * the DECISION of where real transcript content lives (see the scope note
 * below) fully separable from the mechanism that checks it.
 *
 * ============================================================================
 * SCOPE NOTE — why `turns` below is synthetic, not the real transcript
 * ============================================================================
 * Every session ID named in ENG-1312's own acceptance criteria was verified
 * (read-only) to be a real, existing production AW-ChatSessions row:
 *   51674765, 822c1ed4, 68c9a8fb, 9481f94e, eecb6d31
 * ("the four Ed sessions" per criterion 3's own wording — only three of those
 * five are attributed to Ed elsewhere in this issue and ENG-1309, and
 * eecb6d31 is attributed to "mvarma" in ENG-1312 but to Ed's own words in
 * ENG-1309; that inconsistency is in the human-drafted text and is not this
 * module's place to resolve — all five are registered below regardless).
 *
 * Building the REAL replay fixture means copying those real customers'
 * (Ed/xCures, Phoenix/Vince) verbatim conversation content into this
 * permanently-committed, CI-gating file — readable by every future clone and
 * by Argusoft's external contractors, forever. That is a data-exposure
 * decision, not a code decision (autonomous-execution-and-merge.md's
 * database/data-plane gate: "a change that can... expose... existing stored
 * data"), tracked on ENG-1314 (blocks ENG-1312) with three concrete options.
 *
 * Until ENG-1314 resolves, `turns` holds synthetic placeholder content sized
 * to demonstrate the mechanism (pass on today's placeholder, fail on an
 * over-threshold regression — see agentModeReplayFixtures.test.ts) and
 * `isPlaceholder: true` is set on every fixture so nothing downstream can
 * mistake a placeholder pass for real evidence. Swapping in real content is a
 * data change to this file only — the checker functions never change.
 *
 * Only 3 of the 5 sessions have an explicit NUMERIC threshold in the
 * human-written text (ENG-1309's own acceptance criteria — see
 * thresholdSource on each). The other two (822c1ed4: unnecessaryPermissionRequest,
 * 9481f94e: pushback/outputQuality) are judge-dimension assertions, not
 * char/token ones, and ENG-1309/1310/1311 give no number for them — they are
 * registered with `pending: true` (proves CI awareness of every named
 * session) rather than gated on a fabricated threshold.
 */

export interface ReplayFixtureAssertion {
  maxChars?: number;
  maxWords?: number;
}

export interface JudgeReplayFixture {
  /** The (possibly abbreviated) session ID as named in the Linear issue text. */
  id: string;
  label: string;
  /** Where the numeric threshold came from, or why there isn't one yet. */
  thresholdSource: string;
  /** Always true until ENG-1314 resolves and real content replaces `turns`. */
  isPlaceholder: boolean;
  /** True when no numeric char/word threshold exists in the human-written
   * text yet — registered for CI-coverage visibility, never gates a build. */
  pending: boolean;
  turns: Array<{ role: 'user' | 'assistant'; content: string }>;
  assertion: ReplayFixtureAssertion;
}

function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed === '' ? 0 : trimmed.split(/\s+/).length;
}

/** The assistant-authored content of a fixture, concatenated — what the
 * ENG-1309 char/word thresholds are actually measured against. */
function assistantContent(fixture: JudgeReplayFixture): string {
  return fixture.turns
    .filter((t) => t.role === 'assistant')
    .map((t) => t.content)
    .join('\n');
}

export interface ReplayFixtureResult {
  id: string;
  pass: boolean;
  reason: string;
}

/** Evaluate one fixture against its own threshold. Pure, deterministic — no
 * judge score, no LLM call, exactly what criterion 3 asks for. */
export function checkReplayFixture(fixture: JudgeReplayFixture): ReplayFixtureResult {
  if (fixture.pending) {
    return {
      id: fixture.id,
      pass: true,
      reason: `pending — no numeric char/word threshold given in ENG-1309/1310/1311 for ${fixture.id} yet (${fixture.thresholdSource})`,
    };
  }

  if (fixture.assertion.maxChars === undefined && fixture.assertion.maxWords === undefined) {
    // A non-pending fixture with no numeric threshold is a misconfiguration —
    // it would otherwise pass unconditionally forever, silently turning off
    // the exact CI gate criterion 3 asks for (CodeRabbit, PR #2443). Register
    // it with `pending: true` instead if there is genuinely no threshold yet.
    return {
      id: fixture.id,
      pass: false,
      reason: `${fixture.id}: misconfigured — pending is false but neither maxChars nor maxWords is set (${fixture.thresholdSource})`,
    };
  }

  const content = assistantContent(fixture);

  if (fixture.assertion.maxChars !== undefined && content.length > fixture.assertion.maxChars) {
    return {
      id: fixture.id,
      pass: false,
      reason: `${fixture.id}: reply is ${content.length} chars, exceeds the ${fixture.assertion.maxChars}-char threshold (${fixture.thresholdSource})`,
    };
  }

  const words = wordCount(content);
  if (fixture.assertion.maxWords !== undefined && words > fixture.assertion.maxWords) {
    return {
      id: fixture.id,
      pass: false,
      reason: `${fixture.id}: reply is ${words} words, exceeds the ${fixture.assertion.maxWords}-word threshold (${fixture.thresholdSource})`,
    };
  }

  return { id: fixture.id, pass: true, reason: `${fixture.id}: within threshold (${fixture.thresholdSource})` };
}

/** Evaluate every fixture (or a caller-supplied set, e.g. a mutated copy in a
 * test) against its own threshold. This is the function an agentMode PR's CI
 * run calls — a regression above threshold shows up as a failing result. */
export function checkAllReplayFixtures(
  fixtures: readonly JudgeReplayFixture[] = REPLAY_FIXTURES,
): ReplayFixtureResult[] {
  return fixtures.map(checkReplayFixture);
}

/**
 * The registered fixture set. Real content pending ENG-1314 — see the module
 * doc comment above. Synthetic `turns` are sized so today's placeholder
 * passes its own threshold (proving the harness doesn't false-alarm on
 * itself) while remaining well under the real, human-reported "today" length
 * quoted in ENG-1309, so a real regression stays visible once swapped in.
 */
export const REPLAY_FIXTURES: JudgeReplayFixture[] = [
  {
    id: '51674765',
    label: '"2 pages → 20 pages" — Ed (xCures), 08-14, "Condense this down to maximum of 2 pages… Leave your opinions out."',
    thresholdSource: 'ENG-1309 criterion 2: ≤ ~6,000 chars (today 10,524)',
    isPlaceholder: true,
    pending: false,
    turns: [
      { role: 'user', content: 'Condense this down to maximum of 2 pages. Leave your opinions out. Leave all of the rhetoric out.' },
      { role: 'assistant', content: '[PLACEHOLDER — real content pending ENG-1314] ' + 'x'.repeat(400) },
    ],
    assertion: { maxChars: 6000 },
  },
  {
    id: '68c9a8fb',
    label: 'Ed (xCures) yes/no turns [15]/[25] — "Are you sure they\'re US members?" / audience-usage correction',
    thresholdSource: 'ENG-1309 criterion 1: total reply ≤ 600 chars (today 2,982 / 3,285)',
    isPlaceholder: true,
    pending: false,
    turns: [
      { role: 'user', content: "Are you sure they're US members?" },
      { role: 'assistant', content: '[PLACEHOLDER — real content pending ENG-1314] Yes — ' + 'x'.repeat(200) },
    ],
    assertion: { maxChars: 600 },
  },
  {
    id: 'eecb6d31',
    label: '"Yes or no: are page_view and scroll marked as Key Events?" (attributed to mvarma in ENG-1312, to Ed in ENG-1309 — see scope note)',
    thresholdSource: 'ENG-1309 criterion 3: ≤ 150 words (today "I don\'t know" in 1,326 chars)',
    isPlaceholder: true,
    pending: false,
    turns: [
      { role: 'user', content: 'Yes or no: are page_view and scroll marked as Key Events?' },
      { role: 'assistant', content: '[PLACEHOLDER — real content pending ENG-1314] Yes — ' + Array.from({ length: 30 }, () => 'word').join(' ') },
    ],
    assertion: { maxWords: 150 },
  },
  {
    id: '822c1ed4',
    label: 'Phoenix kickoff (Vince), 08-14, 48K completion tokens — "I didn\'t ask for a lecture… asking for permission to run a test"',
    thresholdSource: 'no numeric char/token threshold given in ENG-1309/1310/1311 — this session gates on unnecessaryPermissionRequest (ENG-1311 criterion 2), a judge-dimension assertion, not a deterministic char/token one',
    isPlaceholder: true,
    pending: true,
    turns: [
      { role: 'user', content: '[PLACEHOLDER — real content pending ENG-1314] run the test' },
      { role: 'assistant', content: '[PLACEHOLDER — real content pending ENG-1314] should I go ahead and run this test?' },
    ],
    assertion: {},
  },
  {
    id: '9481f94e',
    label: 'Ed (xCures) [52] "Stop the July campaign Now" — pushback-not-rewarded case',
    thresholdSource: 'no numeric char/token threshold given in ENG-1309/1310/1311 — this session gates on outputQuality ≤ 3 for pushback (ENG-1312 criterion 2), a judge-score assertion, not a deterministic char/token one',
    isPlaceholder: true,
    pending: true,
    turns: [
      { role: 'user', content: 'Stop the July campaign Now' },
      { role: 'assistant', content: '[PLACEHOLDER — real content pending ENG-1314] I don\'t think we should stop it because...' },
    ],
    assertion: {},
  },
];
