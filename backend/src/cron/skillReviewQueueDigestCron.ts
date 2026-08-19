/**
 * Skill Review Queue Digest (ENG-932)
 *
 * "Submit for Review" freezes a skill — the owner can't edit, delete, or (until
 * this fix) withdraw it without an admin — and fires no notification at all.
 * ENG-149 correctly killed the old per-submission oncall page as noise, but that
 * left the queue with no reader: a customer clicks one button and nobody on our
 * side finds out. This replaces "nothing" with a low-volume daily digest.
 *
 * Submitting a single skill still pages nobody — this only alerts once a skill
 * has sat in `pending_review` past PENDING_REVIEW_STALE_HOURS, and the oncall
 * alert's own dedupeKey caps it at one message per day regardless of how many
 * skills are stale or how many times this cron fires.
 *
 * Registered in server.ts to run daily.
 */

import { skillService } from '../services/skillService';
import { sendAgentModeOncallAlert } from '../utils/agentModeAlerts';

const TAG = '[skillReviewQueueDigestCron]';

/** A pending_review skill is "stale" once it's sat this long unreviewed. */
export const PENDING_REVIEW_STALE_HOURS = 24;

export interface SkillReviewQueueDigestSummary {
  queueSize: number;
  stale: number;
  alertSent: boolean;
}

/**
 * `now` is injectable for tests; production calls always use Date.now().
 */
export async function runSkillReviewQueueDigest(now: number = Date.now()): Promise<SkillReviewQueueDigestSummary> {
  const summary: SkillReviewQueueDigestSummary = { queueSize: 0, stale: 0, alertSent: false };

  let pending: Awaited<ReturnType<typeof skillService.getSkillsByVisibility>>;
  try {
    pending = await skillService.getSkillsByVisibility('pending_review');
  } catch (error) {
    console.error(`${TAG} Failed to scan pending_review skills:`, error);
    return summary;
  }

  summary.queueSize = pending.length;

  const staleCutoffMs = PENDING_REVIEW_STALE_HOURS * 60 * 60 * 1000;
  const stale = pending.filter((skill) => {
    const updatedAtMs = skill.updatedAt ? Date.parse(skill.updatedAt) : NaN;
    return !Number.isNaN(updatedAtMs) && now - updatedAtMs >= staleCutoffMs;
  });
  summary.stale = stale.length;

  if (stale.length === 0) {
    console.log(`${TAG} Run complete — queueSize=${summary.queueSize} stale=0, no alert`);
    return summary;
  }

  const lines = stale
    .map((skill) => `- "${skill.name}" (${skill.skillId}), owner ${skill.ownerEmail || skill.ownerId || 'unknown'}, waiting since ${skill.updatedAt}`)
    .join('\n');

  try {
    await sendAgentModeOncallAlert({
      subject: `${stale.length} skill${stale.length === 1 ? '' : 's'} stuck in review > ${PENDING_REVIEW_STALE_HOURS}h`,
      message:
        `The platform skill-review queue has ${stale.length} skill(s) waiting longer than ` +
        `${PENDING_REVIEW_STALE_HOURS}h with no owner-side way back except this digest (ENG-932):\n\n${lines}\n\n` +
        `Approve, reject, or manually release each back to private.`,
      dedupeKey: 'skill-review-queue-digest',
      dedupeWindowMs: 24 * 60 * 60 * 1000,
      context: { queueSize: summary.queueSize, stale: summary.stale },
      now,
    });
    summary.alertSent = true;
  } catch (error) {
    console.error(`${TAG} Failed to send digest alert:`, error);
  }

  console.log(`${TAG} Run complete — queueSize=${summary.queueSize} stale=${summary.stale} alertSent=${summary.alertSent}`);
  return summary;
}
