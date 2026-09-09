import {
  X_RANKING_SIGNAL_WEIGHTS,
  computeWeightedXScore,
  computeActualXScore,
  parseXAssessmentResponse,
  buildXAssessmentPrompt,
  scoreTier,
} from '../utils/xPostRankingScore';
import { JsonExtractError } from '../services/util/extractJson';

describe('computeWeightedXScore', () => {
  it('matches a hand-computed weighted sum', () => {
    const score = computeWeightedXScore({
      favorite: 0.2, reply: 0.05, retweet: 0.02, quote: 0.01, share: 0.03, report: 0.001,
    });
    const expected =
      0.5 * 0.2 + 5.0 * 0.05 + 1.0 * 0.02 + 5.0 * 0.01 + 2.0 * 0.03 + -234.0 * 0.001;
    expect(score).toBeCloseTo(expected, 10);
  });

  it('clamps out-of-range probabilities instead of letting them blow up the score', () => {
    const score = computeWeightedXScore({
      favorite: 5, reply: -3, retweet: 0, quote: 0, share: 0, report: 0,
    });
    // favorite clamped to 1, reply clamped to 0
    expect(score).toBeCloseTo(X_RANKING_SIGNAL_WEIGHTS.favorite, 10);
  });

  it('a real report probability dominates the score, matching the real -234 weight', () => {
    const withReport = computeWeightedXScore({ favorite: 0.5, reply: 0, retweet: 0, quote: 0, share: 0, report: 0.05 });
    const withoutReport = computeWeightedXScore({ favorite: 0.5, reply: 0, retweet: 0, quote: 0, share: 0, report: 0 });
    expect(withReport).toBeLessThan(withoutReport - 10);
  });
});

describe('scoreTier', () => {
  it('buckets low/medium/high at the documented thresholds', () => {
    expect(scoreTier(0)).toBe('low');
    expect(scoreTier(0.14)).toBe('low');
    expect(scoreTier(0.15)).toBe('medium');
    expect(scoreTier(0.49)).toBe('medium');
    expect(scoreTier(0.5)).toBe('high');
  });
});

describe('parseXAssessmentResponse', () => {
  it('parses a well-formed JSON response', () => {
    const raw = '{"favorite": 0.3, "reply": 0.1, "retweet": 0.05, "quote": 0.02, "share": 0.01, "report": 0}';
    expect(parseXAssessmentResponse(raw)).toEqual({
      favorite: 0.3, reply: 0.1, retweet: 0.05, quote: 0.02, share: 0.01, report: 0,
    });
  });

  it('recovers JSON wrapped in prose/fences (same defense as dedupService)', () => {
    const raw = 'Sure, here you go:\n```json\n{"favorite": 0.4, "reply": 0.2, "retweet": 0.1, "quote": 0.05, "share": 0.05, "report": 0.001}\n```';
    expect(parseXAssessmentResponse(raw).favorite).toBe(0.4);
  });

  it('clamps out-of-range or missing fields rather than trusting the model verbatim', () => {
    const raw = '{"favorite": 1.5, "reply": -1, "retweet": "not a number"}';
    const result = parseXAssessmentResponse(raw);
    expect(result.favorite).toBe(1);
    expect(result.reply).toBe(0);
    expect(result.retweet).toBe(0);
    expect(result.quote).toBe(0); // missing field defaults to 0, not fabricated
  });

  it('fails closed (throws) on unparsable garbage instead of returning a fabricated score', () => {
    expect(() => parseXAssessmentResponse('not json at all')).toThrow(JsonExtractError);
  });
});

describe('computeActualXScore', () => {
  it('computes an engagement-rate-weighted score from real public_metrics counts', () => {
    const score = computeActualXScore({
      likeCount: 50, replyCount: 5, retweetCount: 2, quoteCount: 1, impressionCount: 1000,
    });
    const expected =
      X_RANKING_SIGNAL_WEIGHTS.favorite * (50 / 1000) +
      X_RANKING_SIGNAL_WEIGHTS.reply * (5 / 1000) +
      X_RANKING_SIGNAL_WEIGHTS.retweet * (2 / 1000) +
      X_RANKING_SIGNAL_WEIGHTS.quote * (1 / 1000);
    expect(score).toBeCloseTo(expected, 10);
  });

  it('fails closed (null) when impressions are missing or zero, instead of dividing by zero', () => {
    expect(computeActualXScore({ likeCount: 10, replyCount: 0, retweetCount: 0, quoteCount: 0, impressionCount: 0 })).toBeNull();
    expect(computeActualXScore({ likeCount: 10, replyCount: 0, retweetCount: 0, quoteCount: 0, impressionCount: undefined as any })).toBeNull();
  });
});

describe('buildXAssessmentPrompt', () => {
  it('embeds the draft text and asks for every weighted signal category as JSON', () => {
    const { system, user } = buildXAssessmentPrompt('hello world');
    for (const signal of Object.keys(X_RANKING_SIGNAL_WEIGHTS)) {
      expect(system).toContain(signal);
    }
    expect(user).toContain('hello world');
  });
});
