import { settingsService } from './settingsService';
import type { ApprovalDecisionApprover } from './approvalInboxService';

/**
 * ENG-1644 Phase C: approver -> Slack identity/channel resolution for the
 * durable decision inbox. Deliberately a NEW, standalone module rather than
 * refactoring humanEvalService.ts's internals to share code with it — that
 * file is a live, already-shipped production system (creative/lead-enrichment
 * review) with zero functional need to change for this ticket, and touching
 * its tested internals as a side effect of an unrelated feature is a real
 * regression risk for no real benefit.
 *
 * What IS shared, deliberately: for 'matt' and 'fangfang', this reuses
 * humanEvalService's EXISTING settings/env keys for their Slack user id —
 * the same real person's Slack ID shouldn't need configuring twice in two
 * places, and if it ever changes, one update covers both systems. 'harsha'
 * is new (humanEvalService's HumanEvalReviewer type never included him), so
 * gets his own keys.
 */

const REVIEWER_SLACK_ID_SETTING: Record<ApprovalDecisionApprover, string> = {
  matt: 'human_eval_reviewer_matt_slack_user_id',
  fangfang: 'human_eval_reviewer_fangfang_slack_user_id',
  harsha: 'approval_inbox_reviewer_harsha_slack_user_id',
};

const REVIEWER_SLACK_ID_ENV: Record<ApprovalDecisionApprover, string> = {
  matt: 'HUMAN_EVAL_MATT_SLACK_USER_ID',
  fangfang: 'HUMAN_EVAL_FANGFANG_SLACK_USER_ID',
  harsha: 'APPROVAL_INBOX_HARSHA_SLACK_USER_ID',
};

/** Per-approver channel — a genuinely new capability, not a generalization of
 *  humanEvalService's getEvalChannel (which stays exactly as-is: one shared
 *  channel, unrelated purpose). Falls back to a shared default channel
 *  setting so a not-yet-configured approver doesn't hard-fail. */
const APPROVER_CHANNEL_SETTING_PREFIX = 'approval_inbox_channel_';
const APPROVER_CHANNEL_DEFAULT_SETTING = 'approval_inbox_channel_default';
const APPROVER_CHANNEL_DEFAULT_ENV = 'APPROVAL_INBOX_DEFAULT_SLACK_CHANNEL';

export class ApproverDirectoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApproverDirectoryError';
  }
}

/** Same fail-safe shape as humanEvalService's getReviewerSlackUserId — a
 *  transient settings-lookup failure must never throw out of a caller that's
 *  already committed to persisting/posting; missing/undefined is handled by
 *  every caller (falls back to a plain-text mention). */
export async function getApproverSlackUserId(approver: ApprovalDecisionApprover): Promise<string | undefined> {
  try {
    const setting = await settingsService.getSetting(REVIEWER_SLACK_ID_SETTING[approver]);
    return (setting?.settingValue || process.env[REVIEWER_SLACK_ID_ENV[approver]])?.trim() || undefined;
  } catch (err: any) {
    console.warn(`[approver-directory] failed to resolve ${approver}'s Slack user id, continuing without it:`, err?.message || err);
    return undefined;
  }
}

/** Unlike getApproverSlackUserId, a missing channel IS a hard error — posting
 *  to an unconfigured channel isn't a degradable no-op the way a missing
 *  @-mention is (mirrors humanEvalService's getEvalChannel: a channel is
 *  required infrastructure, a Slack user id is a nice-to-have enrichment). */
export async function getApproverChannel(approver: ApprovalDecisionApprover): Promise<string> {
  const perApprover = await settingsService.getSetting(`${APPROVER_CHANNEL_SETTING_PREFIX}${approver}`);
  const fallback = await settingsService.getSetting(APPROVER_CHANNEL_DEFAULT_SETTING);
  const channel = perApprover?.settingValue
    || fallback?.settingValue
    || process.env[APPROVER_CHANNEL_DEFAULT_ENV];

  if (!channel?.trim()) {
    throw new ApproverDirectoryError(`No Slack channel configured for approver '${approver}' (and no default configured)`);
  }
  return channel.trim();
}

/** Optional configured fallback approver(s) who may act on ANY decision, so
 *  one absent named approver can't permanently stall it. Comma-separated
 *  Slack user ids, same DB-setting-with-env-fallback convention as
 *  everything else in this file. Empty/unconfigured is the safe default —
 *  no fallback means only the assigned approver can act, which is correct
 *  until someone explicitly opts in. */
export async function getFallbackApproverSlackUserIds(): Promise<string[]> {
  const setting = await settingsService.getSetting('approval_inbox_fallback_slack_user_ids');
  const raw = setting?.settingValue || process.env.APPROVAL_INBOX_FALLBACK_SLACK_USER_IDS || '';
  return raw.split(',').map((id) => id.trim()).filter(Boolean);
}
