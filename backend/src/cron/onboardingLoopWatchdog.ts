/**
 * Onboarding Loop Watchdog — hourly health check.
 *
 * Per-variant: if lift_pct < -watchdog_rollback_pct_24h AND n >= retire_min_n,
 * retire that variant (remove from active_variants).
 *
 * Aggregate: if 7d completion rate drops > watchdog_pause_pct_7d vs the
 * baseline stored in Variant.stats, set config.paused = true and post a
 * Slack escalation DM to the approver.
 *
 * Required env vars:
 *   ONBOARDING_LOOP_ENABLED             — must be 'true' to run
 *   ONBOARDING_LOOP_APPROVER_SLACK_USER_ID — Slack user for escalation DMs
 *   SLACK_BOT_TOKEN
 */

import { WebClient } from '@slack/web-api';
import {
  readConfig,
  writeConfig,
  invalidateConfigCache,
  OnboardingLoopConfig,
  Variant,
} from '../services/onboardingLoopConfig';
import { pollApprovalDecision, checkAutoShipConditions } from '../services/onboardingLoopApproval';
import { sensorScan, StepStats } from '../services/onboardingLoopAgents';
import { userDb } from '../services/db';

export async function runOnboardingLoopWatchdog(): Promise<void> {
  if (process.env.ONBOARDING_LOOP_ENABLED !== 'true') return;

  console.log('[OnboardingWatchdog] Starting hourly check');

  try {
    const { config, versionId } = await readConfig();

    const users = await userDb.getAllUsers(true);
    const stats: StepStats[] = await sensorScan(users, config);

    const {
      watchdog_rollback_pct_24h,
      watchdog_pause_pct_7d,
      retire_min_n,
    } = config.thresholds;

    let dirty = false;
    const retiredVariants: { step: string; variantId: string; reason: string }[] = [];
    const updatedConfig: OnboardingLoopConfig = JSON.parse(JSON.stringify(config));

    // -----------------------------------------------------------------------
    // Per-variant check: retire if lift < -watchdog_rollback_pct_24h
    // -----------------------------------------------------------------------
    for (const stat of stats) {
      if (
        stat.lift_pct !== null &&
        stat.lift_pct < -Math.abs(watchdog_rollback_pct_24h) &&
        stat.n >= retire_min_n
      ) {
        const stepCfg = updatedConfig.steps[stat.step];
        if (!stepCfg) continue;

        const beforeLen = stepCfg.active_variants.length;
        stepCfg.active_variants = stepCfg.active_variants.filter(
          (v) => v.variantId !== stat.variantId,
        );

        if (stepCfg.active_variants.length < beforeLen) {
          dirty = true;
          retiredVariants.push({
            step: stat.step,
            variantId: stat.variantId,
            reason: `lift_pct=${stat.lift_pct.toFixed(1)}% < -${watchdog_rollback_pct_24h}% threshold`,
          });
          console.log(
            `[OnboardingWatchdog] Retiring variant "${stat.variantId}" on step "${stat.step}": ${retiredVariants[retiredVariants.length - 1].reason}`,
          );
        }
      }
    }

    // -----------------------------------------------------------------------
    // Pending variant activation: poll Slack reactions for staged proposals.
    // If ✅ approved (or 6pm PT auto-ship) → activate variant (clear pending).
    // If ❌ denied or 🛑 hold → remove variant from config.
    // -----------------------------------------------------------------------
    const hasWatchdogWarnings = retiredVariants.length > 0;
    const slackToken = process.env.SLACK_BOT_TOKEN;
    const slackClient = slackToken ? new WebClient(slackToken) : null;

    for (const [stepName, stepCfg] of Object.entries(updatedConfig.steps)) {
      const pendingVariants = stepCfg.active_variants.filter((v) => v.pending);
      if (pendingVariants.length === 0) continue;

      for (const variant of pendingVariants) {
        if (!variant.pendingSlackChannel || !variant.pendingSlackTs || !slackClient) {
          // No Slack DM to poll — auto-activate after 24h staging window.
          const stagedAt = variant.pendingApprovalTs ? new Date(variant.pendingApprovalTs).getTime() : 0;
          if (Date.now() - stagedAt > 24 * 60 * 60 * 1000) {
            if (checkAutoShipConditions(stats, hasWatchdogWarnings)) {
              delete variant.pending;
              delete variant.pendingApprovalTs;
              dirty = true;
              console.log(`[OnboardingWatchdog] Auto-activated pending variant "${variant.variantId}" on step "${stepName}" (no Slack, 24h elapsed)`);
            }
          }
          continue;
        }

        try {
          const decision = await pollApprovalDecision(
            variant.pendingSlackChannel,
            variant.pendingSlackTs,
            slackClient,
            config.approval.auto_ship_cutoff_hour_pt,
          );

          if (decision.decision === 'approved' || decision.decision === 'auto_ship') {
            if (decision.decision === 'auto_ship' && !checkAutoShipConditions(stats, hasWatchdogWarnings)) {
              console.log(`[OnboardingWatchdog] auto_ship blocked by conditions for variant "${variant.variantId}" — holding`);
              continue;
            }
            delete variant.pending;
            delete variant.pendingApprovalTs;
            delete variant.pendingSlackChannel;
            delete variant.pendingSlackTs;
            dirty = true;
            console.log(`[OnboardingWatchdog] Activated variant "${variant.variantId}" on step "${stepName}" (${decision.decision})`);
          } else if (decision.decision === 'denied') {
            stepCfg.active_variants = stepCfg.active_variants.filter((v) => v.variantId !== variant.variantId);
            dirty = true;
            console.log(`[OnboardingWatchdog] Removed denied variant "${variant.variantId}" on step "${stepName}"`);
          }
          // 'hold' → leave pending, check again next hour
        } catch (err) {
          console.warn(`[OnboardingWatchdog] Slack poll failed for variant "${variant.variantId}":`, err);
        }
      }
    }

    // -----------------------------------------------------------------------
    // Aggregate check: pause if 7d completion rate dropped > watchdog_pause_pct_7d
    // -----------------------------------------------------------------------
    let shouldPause = false;
    let pauseReason = '';

    if (!updatedConfig.paused) {
      const controlStats = stats.filter((s) => s.lift_pct === null);
      const totalN = controlStats.reduce((sum, s) => sum + s.n, 0);
      const totalCompletions = controlStats.reduce((sum, s) => sum + s.completions, 0);
      const currentRate = totalN > 0 ? totalCompletions / totalN : 0;

      // Compare against the stored baseline from variant stats (if available)
      const baselineRates = controlStats
        .map((s) => {
          const stepCfg = config.steps[s.step];
          const controlVariant = stepCfg?.active_variants.find(
            (v) => v.variantId === s.variantId,
          );
          return controlVariant?.stats?.lift_pct ?? null;
        })
        .filter((r): r is number => r !== null);

      // Only do aggregate check if we have some historical baseline stored
      if (baselineRates.length > 0) {
        const baselineRate = baselineRates.reduce((a, b) => a + b, 0) / baselineRates.length;

        // Interpret stored lift_pct as approximate historical completion rate
        // (using 0.5 as reference baseline if no better data available)
        const dropPct =
          baselineRate > 0
            ? ((baselineRate - currentRate) / baselineRate) * 100
            : 0;

        if (dropPct > Math.abs(watchdog_pause_pct_7d)) {
          shouldPause = true;
          pauseReason = `7d completion rate dropped ${dropPct.toFixed(1)}% (threshold: ${watchdog_pause_pct_7d}%)`;
        }
      }
    }

    if (shouldPause) {
      updatedConfig.paused = true;
      dirty = true;
      console.warn(`[OnboardingWatchdog] PAUSING loop: ${pauseReason}`);
      await postEscalationDM(pauseReason, retiredVariants);
    }

    // -----------------------------------------------------------------------
    // Write updated config if anything changed
    // -----------------------------------------------------------------------
    if (dirty) {
      const newVersionId = await writeConfig(updatedConfig, versionId);
      invalidateConfigCache();
      console.log(
        `[OnboardingWatchdog] Config updated — new versionId=${newVersionId}, ` +
          `retired=${retiredVariants.length}, paused=${updatedConfig.paused}`,
      );
    } else {
      console.log('[OnboardingWatchdog] No changes needed');
    }
  } catch (error) {
    console.error('[OnboardingWatchdog] ERROR:', error);
    // Don't rethrow — watchdog errors should not crash the server
  }
}

async function postEscalationDM(
  pauseReason: string,
  retiredVariants: { step: string; variantId: string; reason: string }[],
): Promise<void> {
  const slackUserId = process.env.ONBOARDING_LOOP_APPROVER_SLACK_USER_ID;
  const token = process.env.SLACK_BOT_TOKEN;

  if (!slackUserId || !token) {
    console.warn('[OnboardingWatchdog] Cannot post escalation DM — Slack env vars missing');
    return;
  }

  try {
    const slackClient = new WebClient(token);
    const dm = await slackClient.conversations.open({ users: slackUserId });
    const channelId = dm.channel?.id;
    if (!channelId) return;

    const retiredSummary =
      retiredVariants.length > 0
        ? retiredVariants.map((r) => `  • Step "${r.step}" variant "${r.variantId}": ${r.reason}`).join('\n')
        : '  None';

    const text =
      `🛑 *Onboarding Loop — Watchdog PAUSED* (${new Date().toISOString().slice(0, 10)})\n\n` +
      `*Reason:* ${pauseReason}\n\n` +
      `*Retired variants this run:*\n${retiredSummary}\n\n` +
      `The loop is now paused. Set \`config.paused = false\` in S3 to resume.`;

    await slackClient.chat.postMessage({ channel: channelId, text, mrkdwn: true });
    console.log('[OnboardingWatchdog] Escalation DM posted');
  } catch (err) {
    console.error('[OnboardingWatchdog] Failed to post escalation DM:', err);
  }
}
