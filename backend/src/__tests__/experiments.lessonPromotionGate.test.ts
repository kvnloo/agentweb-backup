import { evaluateLessonPromotion } from '../experiments/lessonPromotionGate';

describe('A6 lesson promotion experiment', () => {
  it('blocks one-shot self-reinforcement', () => {
    expect(evaluateLessonPromotion({
      evidenceCount: 1,
      distinctSessions: 1,
      humanReviewed: false,
      conflictingEvidence: 0,
    })).toMatchObject({
      promote: false,
    });
  });

  it('blocks reviewed lessons with conflicting evidence', () => {
    const result = evaluateLessonPromotion({
      evidenceCount: 8,
      distinctSessions: 4,
      humanReviewed: true,
      conflictingEvidence: 1,
    });

    expect(result.promote).toBe(false);
    expect(result.reasons).toContain('conflicting_evidence');
  });

  it('promotes only after evidence, diversity, and review gates all pass', () => {
    expect(evaluateLessonPromotion({
      evidenceCount: 4,
      distinctSessions: 3,
      humanReviewed: true,
      conflictingEvidence: 0,
    })).toEqual({
      promote: true,
      reasons: [],
    });
  });
});
