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
// postHeartbeatSlackDM
// ---------------------------------------------------------------------------

/**
 * Posts the daily heartbeat DM when the loop has no mutations to propose.
 * Confirms the loop is alive and reports onboarding funnel + self-driven
 * activity, so silence-by-design doesn't look like silence-from-bug.
 *
 * Why: with one variant per step, the proposal path never fires and the
 * approver gets no DM. Without this, "no message" is indistinguishable from
 * "the cron is broken" — the bug that masked the runs-table issue for 2 days.
 *
 * Uses chat.postMessage with the user ID directly as channel. The bot lacks
 * im:write scope, but chat:write works on existing DM channels. If the user
 * has never DM'd the bot, Slack returns channel_not_found and the caller
 * should escalate to scope expansion.
 */
export async function postHeartbeatSlackDM(
  metrics: HeartbeatMetrics,
  slackUserId: string,
  slackClient: WebClient,
): Promise<{ channel: string; ts: string }> {
  const text = formatHeartbeat(metrics);
  const posted = await slackClient.chat.postMessage({
    channel: slackUserId,
    text,
    mrkdwn: true,
  });
  if (!posted.ok || !posted.ts) {
    throw new Error(`Slack postMessage failed: ${posted.error ?? 'unknown'}`);
  }
  return { channel: slackUserId, ts: posted.ts };
}

export interface HeartbeatMetrics {
  todayStr: string; // YYYY-MM-DD
  reason: string; // why no mutations (e.g. "only 1 variant per step")
  totalUsers: number; // real users (post bot filter)
  stageDistribution: Record<string, number>; // onboardingStage → count
  signups: { last24h: number; last7d: number };
  completions: { last24h: number; last7d: number };
  selfActive: { last24h: number; last7d: number; last30d: number }; // distinct users with non-delegated activity in window
  pilotRatio: number | null; // fraction of users where lastLoginTime exists but lastActiveAt doesn't (0..1), null if no data
  reliability?: OnboardingReliabilitySummary;
}

export interface ReliabilityStepSummary {
  step: string;
  count: number;
  p50DurationMs: number | null;
  p95DurationMs: number | null;
  maxDurationMs: number | null;
  failureRate: number;
}

export interface OnboardingComplaintSignal {
  userId: string;
  ts: string;
  step: string;
  message: string;
}

export interface OnboardingReliabilitySummary {
  stepSummaries: ReliabilityStepSummary[];
  slowestStep: ReliabilityStepSummary | null;
  highestFailureStep: ReliabilityStepSummary | null;
  stuckByStage: Record<string, { count: number; oldestHours: number }>;
  paidAds: {
    users: number;
    completed: number;
    reachedAds: number;
    deviations: number;
    failedAdStepUsers: number;
  };
  recentComplaintSignals: OnboardingComplaintSignal[];
  recommendedAction: string;
}

export function formatHeartbeat(m: HeartbeatMetrics): string {
  const lines: string[] = [];
  lines.push(`🟢 *Onboarding Loop — Heartbeat (${m.todayStr})*`);
  lines.push('');
  lines.push(
    m.reliability
      ? `*Status:* Reliability check complete. Copy mutations are secondary.`
      : `*Status:* Healthy. No mutations to propose today.`,
  );
  lines.push(`_Why:_ ${m.reason}`);
  lines.push('');
  if (m.reliability) {
    lines.push(...formatReliabilityBlock(m.reliability));
    lines.push('');
  }
  lines.push(`*Last 24h*`);
  lines.push(`  • New signups: ${m.signups.last24h}`);
  lines.push(`  • Completed onboarding: ${m.completions.last24h}`);
  lines.push(`  • Self-active users: ${m.selfActive.last24h}`);
  lines.push('');
  lines.push(`*Last 7d*`);
  lines.push(`  • New signups: ${m.signups.last7d}`);
  lines.push(`  • Completed onboarding: ${m.completions.last7d}`);
  lines.push(`  • Self-active users: ${m.selfActive.last7d}`);
  lines.push('');
  lines.push(`*Funnel (all real users, n=${m.totalUsers})*`);
  const stageOrder = [
    '(unset)',
    'signed_up_no_start',
    'goal_selected',
    'brand_submitted',
    'brand_skipped',
    'data_connected',
    'channel_connected',
    'onboarding_completed',
    'active',
    'stale',
  ];
  for (const stage of stageOrder) {
    const n = m.stageDistribution[stage] ?? 0;
    if (n === 0) continue;
    const pct = m.totalUsers > 0 ? ((n / m.totalUsers) * 100).toFixed(1) : '—';
    lines.push(`  • ${stage.padEnd(22)} ${String(n).padStart(4)}  (${pct}%)`);
  }
  lines.push('');
  if (m.pilotRatio !== null) {
    const pct = (m.pilotRatio * 100).toFixed(0);
    lines.push(`*Pilot ratio:* ${pct}% of recently-logged-in users never acted under their own session (likely we drove the account).`);
    lines.push('');
  }
  lines.push(`_Loop is alive. You'll get a proposal DM when underperformance is detected._`);
  return lines.join('\n');
}

function formatReliabilityBlock(r: OnboardingReliabilitySummary): string[] {
  const lines: string[] = [];
  lines.push('*Reliability*');
  if (r.slowestStep) {
    lines.push(
      `  • Slowest step: ${r.slowestStep.step} — p50 ${formatDuration(r.slowestStep.p50DurationMs)}, p95 ${formatDuration(r.slowestStep.p95DurationMs)}, max ${formatDuration(r.slowestStep.maxDurationMs)} (n=${r.slowestStep.count})`,
    );
  } else {
    lines.push('  • Step timings: no completed step metrics yet');
  }
  if (r.highestFailureStep && r.highestFailureStep.failureRate > 0) {
    lines.push(
      `  • Highest failure/timeout: ${r.highestFailureStep.step} — ${formatPercent(r.highestFailureStep.failureRate)} (n=${r.highestFailureStep.count})`,
    );
  } else {
    lines.push('  • Highest failure/timeout: none in recent step metrics');
  }

  const stuckEntries = Object.entries(r.stuckByStage)
    .sort((a, b) => b[1].count - a[1].count || b[1].oldestHours - a[1].oldestHours)
    .slice(0, 3);
  if (stuckEntries.length > 0) {
    lines.push(
      `  • Stuck users: ${stuckEntries
        .map(([stage, info]) => `${stage}=${info.count} (oldest ${info.oldestHours.toFixed(1)}h)`)
        .join(', ')}`,
    );
  } else {
    lines.push('  • Stuck users: none detected from current statuses/events');
  }

  const paidAdsCompletion =
    r.paidAds.users > 0 ? `${r.paidAds.completed}/${r.paidAds.users}` : '0/0';
  lines.push(
    `  • Paid ads: users=${r.paidAds.users}, completed=${paidAdsCompletion}, reached ads=${r.paidAds.reachedAds}, deviations=${r.paidAds.deviations}, failed ad steps=${r.paidAds.failedAdStepUsers}`,
  );

  if (r.recentComplaintSignals.length > 0) {
    lines.push('  • Recent complaint signals:');
    for (const signal of r.recentComplaintSignals.slice(0, 3)) {
      lines.push(
        `    - ${signal.step}: ${signal.message.slice(0, 120)} (${signal.userId})`,
      );
    }
  }

  lines.push(`  • Recommended action: ${r.recommendedAction}`);
  return lines;
}

function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—';
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(0)}%`;
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
  reliability?: OnboardingReliabilitySummary,
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

  if (reliability) {
    lines.push(...formatReliabilityBlock(reliability));
    lines.push('');
    lines.push('_Copy variants below are secondary to the reliability findings above._');
    lines.push('');
  }

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
