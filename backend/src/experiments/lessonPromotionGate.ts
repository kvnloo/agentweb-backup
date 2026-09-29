export interface LessonCandidate {
  evidenceCount: number;
  distinctSessions: number;
  humanReviewed: boolean;
  conflictingEvidence: number;
}

export interface LessonPromotionDecision {
  promote: boolean;
  reasons: string[];
}

export interface LessonPromotionThresholds {
  minEvidence: number;
  minDistinctSessions: number;
  maxConflicts: number;
}

export const DEFAULT_LESSON_THRESHOLDS: LessonPromotionThresholds = {
  minEvidence: 3,
  minDistinctSessions: 2,
  maxConflicts: 0,
};

export function evaluateLessonPromotion(
  candidate: LessonCandidate,
  thresholds: LessonPromotionThresholds = DEFAULT_LESSON_THRESHOLDS,
): LessonPromotionDecision {
  const reasons: string[] = [];
  if (!candidate.humanReviewed) reasons.push('human_review_required');
  if (candidate.evidenceCount < thresholds.minEvidence) reasons.push('insufficient_evidence');
  if (candidate.distinctSessions < thresholds.minDistinctSessions) reasons.push('insufficient_session_diversity');
  if (candidate.conflictingEvidence > thresholds.maxConflicts) reasons.push('conflicting_evidence');

  return {
    promote: reasons.length === 0,
    reasons,
  };
}
