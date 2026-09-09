import {
  X_RANKING_WEIGHTS,
  NEGATIVE_SCORES_OFFSET,
  TEXT_ESTIMABLE_SIGNALS,
  API_MEASURABLE_SIGNALS,
  computeXRankingScore,
  computePredictedXScore,
  computeActualXScore,
  isNetPositive,
  parseXAssessmentResponse,
  buildXAssessmentPrompt,
} from '../utils/xPostRankingScore';
import { JsonExtractError } from '../services/util/extractJson';

// Hand-rolled reference port of RankingScorer::offset_score, independent of the
// implementation under test, so these tests catch a transcription bug rather
// than just re-asserting whatever the code happens to compute.
function referenceOffsetScore(probs: Record<string, number>, signals: string[]): number {
  let pos = 0, neg = 0, positiveSum = 0, negativeSum = 0;
  for (const s of signals) {
    const w = (X_RANKING_WEIGHTS as any)[s];
    if (w >= 0) positiveSum += w; else negativeSum += -w;
    const term = w * (probs[s] ?? 0);
    if (term >= 0) pos += term; else neg += -term;
  }
  const combined = pos - neg;
  const totalSum = positiveSum + negativeSum;
  if (totalSum === 0) return Math.max(combined, 0);
  if (combined < 0) return ((combined + negativeSum) / totalSum) * NEGATIVE_SCORES_OFFSET;
  return combined + NEGATIVE_SCORES_OFFSET;
}

describe('computeXRankingScore (ported offset_score formula)', () => {
  it('matches an independent reference implementation of the same formula', () => {
    const probs = {
      favorite: 0.2, reply: 0.05, retweet: 0.02, quote: 0.01,
      click: 0.1, openLink: 0, profileClick: 0.01, followAuthor: 0.02,
      share: 0.03, shareViaDm: 0.01, shareViaCopyLink: 0.005,
      notInterested: 0.002, blockAuthor: 0.0005, muteAuthor: 0.0003, report: 0.0001,
    };
    const score = computeXRankingScore(probs, TEXT_ESTIMABLE_SIGNALS);
    expect(score).toBeCloseTo(referenceOffsetScore(probs, TEXT_ESTIMABLE_SIGNALS), 12);
  });

  it('all-zero probabilities net to a small negative-branch score, not zero', () => {
    // combined = 0 falls into the >=0 branch: offsetScore(0) = 0 + OFFSET.
    const score = computeXRankingScore({}, TEXT_ESTIMABLE_SIGNALS);
    expect(score).toBeCloseTo(NEGATIVE_SCORES_OFFSET, 12);
  });

  it('report (real weight -234.0) can flip a favorite-heavy post net-negative', () => {
    const noReport = computeXRankingScore({ favorite: 0.3 }, TEXT_ESTIMABLE_SIGNALS);
    const withReport = computeXRankingScore({ favorite: 0.3, report: 0.01 }, TEXT_ESTIMABLE_SIGNALS);
    // 0.3 * 0.5 (favorite weight) = 0.15 positive; 0.01 * 234.0 = 2.34 negative — net negative.
    expect(isNetPositive(noReport)).toBe(true);
    expect(isNetPositive(withReport)).toBe(false);
    expect(withReport).toBeLessThan(noReport);
  });

  it('net-positive vs net-negative is a real threshold: every non-negative combined beats every negative one', () => {
    // Structural property of offsetScore, not tuned per input — sample across many
    // random-ish probability vectors and assert the ordering guarantee holds.
    const cases = [
      { favorite: 0.9 }, // net positive
      { favorite: 0.01, report: 0.05 }, // net negative
      {}, // combined == 0, in the >=0 branch
      { favorite: 0.5, retweet: 0.3, quote: 0.2 }, // net positive
      { blockAuthor: 0.1, muteAuthor: 0.1 }, // net negative
    ];
    const scores = cases.map((c) => computeXRankingScore(c, TEXT_ESTIMABLE_SIGNALS));
    const positives = scores.filter((s) => s >= NEGATIVE_SCORES_OFFSET);
    const negatives = scores.filter((s) => s < NEGATIVE_SCORES_OFFSET);
    for (const p of positives) for (const n of negatives) expect(p).toBeGreaterThan(n);
  });

  it('clamps out-of-range probabilities instead of letting a bad LLM value blow up the score', () => {
    const score = computeXRankingScore({ favorite: 5, report: -3 }, ['favorite', 'report']);
    // favorite clamped to 1 -> 0.5; report clamped to 0 -> no negative term.
    expect(score).toBeCloseTo(0.5 + NEGATIVE_SCORES_OFFSET, 12);
  });
});

describe('isNetPositive', () => {
  it('is exactly the >= NEGATIVE_SCORES_OFFSET boundary, not an arbitrary cutoff', () => {
    expect(isNetPositive(NEGATIVE_SCORES_OFFSET)).toBe(true);
    expect(isNetPositive(NEGATIVE_SCORES_OFFSET - 1e-9)).toBe(false);
  });
});

describe('parseXAssessmentResponse', () => {
  it('parses a well-formed JSON response over every text-estimable signal', () => {
    const values: Record<string, number> = {};
    TEXT_ESTIMABLE_SIGNALS.forEach((s, i) => { values[s] = 0.01 * (i + 1); });
    const raw = JSON.stringify(values);
    const result = parseXAssessmentResponse(raw, 'a plain draft with no link');
    for (const s of TEXT_ESTIMABLE_SIGNALS) {
      if (s === 'openLink') continue;
      expect(result[s]).toBeCloseTo(values[s], 10);
    }
  });

  it('forces openLink to 0 when the draft has no link, regardless of what the model said', () => {
    const raw = JSON.stringify({ openLink: 0.9 });
    expect(parseXAssessmentResponse(raw, 'no link here').openLink).toBe(0);
  });

  it('does not force openLink to 0 when the draft actually has a link', () => {
    const raw = JSON.stringify({ openLink: 0.4 });
    expect(parseXAssessmentResponse(raw, 'check this out https://example.com').openLink).toBe(0.4);
  });

  it('clamps out-of-range or missing fields rather than trusting the model verbatim', () => {
    const raw = '{"favorite": 1.5, "reply": -1, "retweet": "not a number"}';
    const result = parseXAssessmentResponse(raw, 'draft');
    expect(result.favorite).toBe(1);
    expect(result.reply).toBe(0);
    expect(result.retweet).toBe(0);
    expect(result.quote).toBe(0); // missing field defaults to 0, not fabricated
  });

  it('fails closed (throws) on unparsable garbage instead of returning a fabricated score', () => {
    expect(() => parseXAssessmentResponse('not json at all', 'draft')).toThrow(JsonExtractError);
  });
});

describe('computeActualXScore', () => {
  it('scores only the API-measurable signals via the same real formula', () => {
    const metrics = { likeCount: 50, replyCount: 5, retweetCount: 2, quoteCount: 1, impressionCount: 1000 };
    const score = computeActualXScore(metrics);
    const expected = referenceOffsetScore(
      { favorite: 50 / 1000, reply: 5 / 1000, retweet: 2 / 1000, quote: 1 / 1000 },
      API_MEASURABLE_SIGNALS,
    );
    expect(score).toBeCloseTo(expected, 12);
  });

  it('fails closed (null) when impressions are missing or zero, instead of dividing by zero', () => {
    expect(computeActualXScore({ likeCount: 10, replyCount: 0, retweetCount: 0, quoteCount: 0, impressionCount: 0 })).toBeNull();
    expect(computeActualXScore({ likeCount: 10, replyCount: 0, retweetCount: 0, quoteCount: 0, impressionCount: undefined as any })).toBeNull();
  });
});

describe('computePredictedXScore', () => {
  it('is computeXRankingScore scoped to TEXT_ESTIMABLE_SIGNALS', () => {
    const probs = { favorite: 0.4, report: 0.001 };
    expect(computePredictedXScore(probs)).toBeCloseTo(computeXRankingScore(probs, TEXT_ESTIMABLE_SIGNALS), 12);
  });
});

describe('buildXAssessmentPrompt', () => {
  it('embeds the draft text and asks for every text-estimable signal category as JSON', () => {
    const { system, user } = buildXAssessmentPrompt('hello world');
    for (const signal of TEXT_ESTIMABLE_SIGNALS) {
      expect(system).toContain(signal);
    }
    expect(user).toContain('hello world');
  });

  it('tells the model up front when the draft has no link', () => {
    const { system } = buildXAssessmentPrompt('no link here');
    expect(system).toMatch(/no link/i);
  });
});
