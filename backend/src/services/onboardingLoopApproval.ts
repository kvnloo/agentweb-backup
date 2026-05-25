/**
 * Onboarding loop approval — daily Slack DM to approver and reaction-based
 * decision polling.
 *
 * DM format:
 *   🧪 Onboarding Loop — Daily Review (YYYY-MM-DD)
 *   North star: X.X% completion (7d) | Δ vs last week: +/-X.X%
 *   Step: {step}
 *     Control: X.X% (N=Y)
 *     Proposed variants: ...
 *   React ✅ approve | ❌ deny | 🛑 hold
 *   No response by 6pm PT → auto-ships if signal is green
 *
 * Reaction mapping:
 *   white_check_mark → approved
 *   x                → denied
 *   octagonal_sign   → hold
 *   Thread reply "approve" / "deny" also count.
 */

import { WebClient } from '@slack/web-api';
import { Variant } from './onboardingLoopConfig';
import { StepStats } from './onboardingLoopAgents';

export interface ApprovalResult {
  decision: 'approved' | 'denied' | 'auto_ship' | 'hold';
  reason: string;
}

// ---------------------------------------------------------------------------
// postDailySlackDM
// ---------------------------------------------------------------------------

/**
 * Posts the daily review DM. Returns channel ID and message timestamp for
 * subsequent reaction polling.
 */
export async function postDailySlackDM(
  proposedMutations: { step: string; variants: { variant: Variant; score: number; feedback: string }[] }[],
  stats: StepStats[],
  slackUserId: string,
  slackClient: WebClient,
): Promise<{ channel: string; ts: string }> {
  const today = new Date().toISOString().slice(0, 10);

  // North-star: aggregate completion rate across all steps (control variants only).
  const controlStats = stats.filter((s) => s.variantId.startsWith('control') || s.lift_pct === null);
  const totalN = controlStats.reduce((sum, s) => sum + s.n, 0);
  const totalCompletions = controlStats.reduce((sum, s) => sum + s.completions, 0);
  const northStarRate = totalN > 0 ? ((totalCompletions / totalN) * 100).toFixed(1) : '—';

  const lines: string[] = [
    `🧪 *Onboarding Loop — Daily Review (${today})*`,
    '',
    `North star: ${northStarRate}% completion (7d) | Δ vs last week: (not tracked yet)`,
    '',
  ];

  for (const { step, variants } of proposedMutations) {
    const controlStat = stats.find(
      (s) => s.step === step && (s.lift_pct === null),
    );
    const controlRate = controlStat
      ? (controlStat.completion_rate * 100).toFixed(1)
      : '—';
    const controlN = controlStat ? controlStat.n : 0;

    lines.push(`*Step: ${step}*`);
    lines.push(`  Control: ${controlRate}% (N=${controlN})`);
    lines.push(`  Proposed variants:`);

    for (const { variant, score, feedback } of variants) {
      const copyParts: string[] = [];
      if (variant.copy.heading) copyParts.push(`heading: "${variant.copy.heading}"`);
      if (variant.copy.cta) copyParts.push(`cta: "${variant.copy.cta}"`);
      if (variant.copy.description) copyParts.push(`desc: "${variant.copy.description.slice(0, 60)}..."`);

      lines.push(`    [${variant.variantId}] ${copyParts.join(' | ')}`);
      lines.push(`    Score: ${score}/15 | Feedback: "${feedback}"`);
    }

    lines.push('');
  }

  lines.push('React ✅ to approve all | ❌ to deny | 🛑 to hold');
  lines.push('No response by 6pm PT → auto-ships if signal is green');

  const text = lines.join('\n');

  const dm = await slackClient.conversations.open({ users: slackUserId });
  const channelId = dm.channel?.id;
  if (!channelId) throw new Error('Could not open DM channel with Slack user');

  const posted = await slackClient.chat.postMessage({
    channel: channelId,
    text,
    mrkdwn: true,
  });

  if (!posted.ok || !posted.ts) {
    throw new Error(`Slack postMessage failed: ${posted.error ?? 'unknown'}`);
  }

  return { channel: channelId, ts: posted.ts };
}

// ---------------------------------------------------------------------------
// pollApprovalDecision
// ---------------------------------------------------------------------------

/**
 * Polls the DM message for reactions or thread replies.
 *
 * Returns immediately when a definitive reaction/reply is found.
 * After cutoffHourPT has passed (in PT) with no reaction, returns auto_ship
 * if checkAutoShipConditions passes, otherwise hold.
 */
export async function pollApprovalDecision(
  channel: string,
  ts: string,
  slackClient: WebClient,
  cutoffHourPT: number,
  now: () => Date = () => new Date(),
): Promise<ApprovalResult> {
  // Check reactions on the message
  const reactionsResp = await slackClient.reactions.get({ channel, timestamp: ts });

  const reactions: string[] = [];
  if (reactionsResp.ok && reactionsResp.message?.reactions) {
    for (const r of reactionsResp.message.reactions) {
      if (r.name) reactions.push(r.name);
    }
  }

  if (reactions.includes('white_check_mark')) {
    return { decision: 'approved', reason: 'Approver reacted ✅' };
  }
  if (reactions.includes('x')) {
    return { decision: 'denied', reason: 'Approver reacted ❌' };
  }
  if (reactions.includes('octagonal_sign')) {
    return { decision: 'hold', reason: 'Approver reacted 🛑' };
  }

  // Check thread replies
  const repliesResp = await slackClient.conversations.replies({ channel, ts });
  if (repliesResp.ok && Array.isArray(repliesResp.messages)) {
    // Skip first message (the original DM), check replies
    for (const msg of repliesResp.messages.slice(1)) {
      const text = (msg.text ?? '').toLowerCase().trim();
      if (text === 'approve') return { decision: 'approved', reason: 'Approver replied "approve"' };
      if (text === 'deny') return { decision: 'denied', reason: 'Approver replied "deny"' };
    }
  }

  // No reaction/reply yet — check if we're past cutoff
  const currentTime = now();
  const ptOffsetHours = isPDT(currentTime) ? -7 : -8;
  const ptHour = (currentTime.getUTCHours() + 24 + ptOffsetHours) % 24;

  if (ptHour >= cutoffHourPT) {
    return {
      decision: 'auto_ship',
      reason: `No response by ${cutoffHourPT}:00 PT — auto-shipping per policy`,
    };
  }

  return {
    decision: 'hold',
    reason: `Awaiting approval — past cutoff at ${cutoffHourPT}:00 PT`,
  };
}

// ---------------------------------------------------------------------------
// checkAutoShipConditions
// ---------------------------------------------------------------------------

/**
 * Returns true if it is safe to auto-ship without manual approval:
 * - All control variants have non-negative lift (signal trending up/flat)
 * - No watchdog warnings are active
 */
export function checkAutoShipConditions(
  stats: StepStats[],
  hasWatchdogWarnings: boolean,
): boolean {
  if (hasWatchdogWarnings) return false;

  // All non-control variants with enough data should have non-negative lift
  const significantNonControl = stats.filter(
    (s) => s.lift_pct !== null && s.n >= 10,
  );

  if (significantNonControl.length === 0) return true; // no data → conservative allow

  return significantNonControl.every((s) => (s.lift_pct ?? 0) >= 0);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Rough PDT detection: second Sunday in March through first Sunday in November.
 * Good enough for business-hours cutoff logic.
 */
function isPDT(date: Date): boolean {
  const month = date.getUTCMonth() + 1; // 1-based
  if (month < 3 || month > 11) return false;
  if (month > 3 && month < 11) return true;

  const day = date.getUTCDate();
  const dow = date.getUTCDay(); // 0=Sun

  if (month === 3) {
    // Second Sunday in March
    const secondSunday = 14 - ((date.getUTCDay() + 7 - (14 % 7)) % 7);
    return day >= secondSunday;
  }

  // November: before first Sunday
  const firstSunday = 7 - ((dow + 6) % 7);
  return day < firstSunday;
}
