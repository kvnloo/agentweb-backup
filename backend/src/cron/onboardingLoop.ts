/**
 * Onboarding Loop — daily cron at 7am PT (15:00 UTC).
 *
 * Required env vars:
 *   ONBOARDING_LOOP_ENABLED             — must be 'true' to run
 *   ONBOARDING_LOOP_APPROVER_SLACK_USER_ID — Harsha's Slack user ID
 *   ONBOARDING_LOOP_ALLOWLIST           — comma-separated step names (empty = all)
 *   SLACK_BOT_TOKEN                     — Slack bot token for DMs
 *
 * LLM: anthropic.claude-sonnet-4-6 via LLMService (Bedrock inference profile).
 */

import AWS from 'aws-sdk';
import { WebClient } from '@slack/web-api';
import { readConfig, writeConfig, invalidateConfigCache } from '../services/onboardingLoopConfig';
import { LLMService } from '../utils/llmService';
import { LLMServiceInterface, StepStats, sensorScan, diagnoseUnderperforming, generateMutations, validateBusinessRules, critiqueMutations } from '../services/onboardingLoopAgents';
import { postDailySlackDM, postHeartbeatSlackDM, HeartbeatMetrics } from '../services/onboardingLoopApproval';
import { userDb } from '../services/db';

const TABLE_PREFIX = process.env.NODE_ENV === 'development' ? 'Dev-' : '';
const RUNS_TABLE = `${TABLE_PREFIX}AW-OnboardingLoopRuns`;

// ~6 LLM calls per cycle (generate + critique per underperforming step).
// At ~$0.015/call (1000 in + 500 out on sonnet-4-6) the floor is ~$0.09 per step pair.
// max_tokens_per_cycle_usd * 1000 compared against estimated call count.
const ESTIMATED_USD_PER_LLM_CALL = 0.015;
const MAX_LLM_CALLS_PER_CYCLE = 6;

function buildDynamoDB(): AWS.DynamoDB.DocumentClient {
  return new AWS.DynamoDB.DocumentClient({
    region: process.env.AWS_REGION || 'us-west-2',
    ...(process.env.AWS_ACCESS_KEY_ID
      ? {
          credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
          },
        }
      : {}),
  });
}

async function logRun(
  docClient: AWS.DynamoDB.DocumentClient,
  runId: string,
  status: 'completed' | 'skipped' | 'error',
  details: Record<string, unknown>,
): Promise<void> {
  try {
    await docClient
      .put({
        TableName: RUNS_TABLE,
        Item: {
          runId,
          ts: new Date().toISOString(),
          status,
          ...details,
        },
      })
      .promise();
  } catch (err) {
    // Non-fatal — don't let logging failures abort the run
    console.error('[OnboardingLoop] Failed to log run to DynamoDB:', err);
  }
}

/**
 * Adapter so LLMService (which uses generateJsonRobust) satisfies
 * LLMServiceInterface (which uses callLLM).
 */
function wrapLLMService(svc: LLMService): LLMServiceInterface {
  return {
    async callLLM(system: string, user: string, _format: 'json' | 'text'): Promise<string> {
      const result = await svc.generateJsonRobust<unknown>(system, user);
      return typeof result === 'string' ? result : JSON.stringify(result);
    },
  };
}

export async function runOnboardingLoop(): Promise<void> {
  if (process.env.ONBOARDING_LOOP_ENABLED !== 'true') {
    console.log('[OnboardingLoop] Disabled — set ONBOARDING_LOOP_ENABLED=true to enable');
    return;
  }

  const runId = `loop-${Date.now()}`;
  const docClient = buildDynamoDB();

  console.log(`[OnboardingLoop] Starting run ${runId}`);

  try {
    const { config, versionId } = await readConfig();

    if (config.paused) {
      console.log('[OnboardingLoop] Config is paused — skipping cycle');
      await logRun(docClient, runId, 'skipped', { reason: 'paused', versionId });
      return;
    }

    // Cost cap check: estimate based on number of steps that could mutate
    const stepCount = Object.keys(config.steps).length;
    const estimatedCalls = Math.min(MAX_LLM_CALLS_PER_CYCLE, stepCount * 2); // generate + critique per step
    const estimatedUsd = estimatedCalls * ESTIMATED_USD_PER_LLM_CALL;
    const budgetUsd = config.thresholds.max_tokens_per_cycle_usd ?? 5;

    if (estimatedUsd > budgetUsd) {
      console.log(
        `[OnboardingLoop] Estimated cost $${estimatedUsd.toFixed(3)} exceeds budget $${budgetUsd} — skipping`,
      );
      await logRun(docClient, runId, 'skipped', {
        reason: 'cost_cap',
        estimatedUsd,
        budgetUsd,
        versionId,
      });
      return;
    }

    // Fetch real users (no bot-like emails)
    const users = await userDb.getAllUsers(true);
    console.log(`[OnboardingLoop] Fetched ${users.length} users`);

    const stats: StepStats[] = await sensorScan(users, config);
    console.log(`[OnboardingLoop] sensorScan: ${stats.length} step-variant data points`);

    const allowlist = (process.env.ONBOARDING_LOOP_ALLOWLIST ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    // Steps to improve. Tier 1: a challenger measurably losing to control.
    // Tier 2 (no challenger yet — the usual case): bootstrap one for the
    // weakest-converting allowlisted step so the loop proposes a concrete
    // improvement idea every day instead of only ever reporting "nothing to do."
    const underperformingSteps = diagnoseUnderperforming(stats, config, {
      maxSteps: 1,
      allowlist,
    });
    console.log(`[OnboardingLoop] Steps to improve: ${underperformingSteps.join(', ') || 'none'}`);

    // Build LLM service once — fail fast if config/creds are wrong
    const llmRaw = new LLMService('anthropic.claude-sonnet-4-6', 0.3);
    const llm = wrapLLMService(llmRaw);

    const proposedMutations: {
      step: string;
      variants: { variant: import('../services/onboardingLoopConfig').Variant; score: number; feedback: string }[];
    }[] = [];

    for (const step of underperformingSteps) {
      const stepCfg = config.steps[step];
      if (!stepCfg?.active_variants?.length) continue;

      // Generate
      const rawMutations = await generateMutations(step, stepCfg.active_variants, stats, llm);
      console.log(`[OnboardingLoop] Generated ${rawMutations.length} mutations for step "${step}"`);

      // Validate
      const { valid, rejected } = validateBusinessRules(rawMutations, step, allowlist);
      if (rejected.length > 0) {
        console.log(
          `[OnboardingLoop] Rejected ${rejected.length} mutations for step "${step}":`,
          rejected.map((r) => r.reason),
        );
      }

      // Critique
      const critiqued = await critiqueMutations(valid, step, llm);
      console.log(
        `[OnboardingLoop] ${critiqued.length} mutations passed critique for step "${step}"`,
      );

      if (critiqued.length > 0) {
        proposedMutations.push({ step, variants: critiqued });
      }
    }

    if (proposedMutations.length === 0) {
      console.log('[OnboardingLoop] No mutations needed today — all steps healthy or no proposals passed critique');

      // Even with nothing to ship, send a heartbeat so the approver sees the
      // loop is alive + the funnel state. Silence-by-design masked a real bug
      // for 2 days; the heartbeat removes that ambiguity.
      const slackUserId = process.env.ONBOARDING_LOOP_APPROVER_SLACK_USER_ID;
      if (slackUserId && process.env.SLACK_BOT_TOKEN) {
        try {
          const metrics = computeHeartbeatMetrics(users, config);
          const slackClient = new WebClient(process.env.SLACK_BOT_TOKEN);
          const dm = await postHeartbeatSlackDM(metrics, slackUserId, slackClient);
          console.log(`[OnboardingLoop] Heartbeat DM posted — channel=${dm.channel} ts=${dm.ts}`);
        } catch (err) {
          // Non-fatal — log and continue. The runs-table log is the source of
          // truth for "did the cron fire."
          console.warn('[OnboardingLoop] Heartbeat DM failed (non-fatal):', err);
        }
      }

      await logRun(docClient, runId, 'completed', {
        reason: 'no_mutations',
        underperformingSteps,
        versionId,
      });
      return;
    }

    // -----------------------------------------------------------------------
    // Stage proposed variants in config with pending=true.
    // The variant route skips pending variants until the watchdog activates
    // them after ✅ approval or 6pm PT auto-ship.
    // -----------------------------------------------------------------------
    const pendingTs = new Date().toISOString();
    const updatedConfig = JSON.parse(JSON.stringify(config)) as typeof config;
    let latestVersionId = versionId;

    let slackChannel = '';
    let slackTs = '';

    // Post Slack DM first so we have the channel+ts to stamp on each variant.
    const slackUserId = process.env.ONBOARDING_LOOP_APPROVER_SLACK_USER_ID;
    if (slackUserId && process.env.SLACK_BOT_TOKEN) {
      try {
        const slackClient = new WebClient(process.env.SLACK_BOT_TOKEN);
        const dm = await postDailySlackDM(proposedMutations, stats, slackUserId, slackClient);
        slackChannel = dm.channel;
        slackTs = dm.ts;
        console.log(`[OnboardingLoop] Slack DM posted — channel=${slackChannel} ts=${slackTs}`);
      } catch (err) {
        console.warn('[OnboardingLoop] Slack DM failed (non-fatal):', err);
      }
    } else {
      console.warn('[OnboardingLoop] Slack env vars missing — staging proposals without DM notification');
    }

    for (const { step, variants } of proposedMutations) {
      if (!updatedConfig.steps[step]) {
        updatedConfig.steps[step] = { active_variants: [] };
      }
      const stepCfg = updatedConfig.steps[step];

      // Enforce max_active_arms_per_step — don't stage if already at cap.
      const activeCount = stepCfg.active_variants.filter((v) => !v.pending).length;
      const pendingCount = stepCfg.active_variants.filter((v) => v.pending).length;
      const availableSlots = Math.max(0, config.thresholds.max_active_arms_per_step - activeCount - pendingCount);

      const toStage = variants.slice(0, availableSlots);
      for (const { variant } of toStage) {
        stepCfg.active_variants.push({
          ...variant,
          pending: true,
          pendingApprovalTs: pendingTs,
          ...(slackChannel ? { pendingSlackChannel: slackChannel, pendingSlackTs: slackTs } : {}),
        });
      }
      console.log(`[OnboardingLoop] Staged ${toStage.length} pending variants for step "${step}"`);
    }

    // Write updated config to S3.
    try {
      latestVersionId = await writeConfig(updatedConfig, latestVersionId);
      invalidateConfigCache();
      console.log(`[OnboardingLoop] Config written — new versionId=${latestVersionId}`);
    } catch (err) {
      console.error('[OnboardingLoop] Config write failed:', err);
      // Don't abort — log and continue. Variants weren't staged but DM was sent.
    }

    await logRun(docClient, runId, 'completed', {
      proposedSteps: proposedMutations.map((m) => m.step),
      mutationCount: proposedMutations.reduce((sum, m) => sum + m.variants.length, 0),
      ...(slackChannel ? { slackChannel, slackTs } : {}),
      versionId: latestVersionId,
    });
  } catch (error) {
    console.error('[OnboardingLoop] CRITICAL ERROR:', error);
    await logRun(docClient, runId, 'error', {
      error: error instanceof Error ? error.message : String(error),
    });
    // Don't rethrow — cron errors should not crash the server
  }
}


// ---------------------------------------------------------------------------
// computeHeartbeatMetrics
// ---------------------------------------------------------------------------

/**
 * Compute the metrics surfaced in the daily heartbeat DM. Pure function over
 * the same users + config the loop already has in hand, so this adds no extra
 * I/O on the cron path.
 *
 * "Self-active" uses lastActiveAt (per db.ts:68, only ticks on non-delegated
 * sessions). Delegated admin activity on a customer account does NOT count —
 * this is what makes the metric trustworthy when we pilot accounts.
 *
 * Exported so tests can hit it directly with synthetic user fixtures.
 */
export interface HeartbeatUser {
  userId?: string;
  createdAt?: string;
  onboardingStage?: string;
  onboardingEvents?: unknown;
  lastLoginTime?: string;
  lastActiveAt?: string;
}

export function computeHeartbeatMetrics(
  users: ReadonlyArray<HeartbeatUser>,
  config: { steps: Record<string, { active_variants?: unknown[] }> },
  now: Date = new Date(),
): HeartbeatMetrics {
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  const nowMs = now.getTime();
  const todayStr = now.toISOString().slice(0, 10);

  const stepNames = Object.keys(config.steps);
  const variantCount = stepNames.reduce(
    (sum, s) => sum + (config.steps[s]?.active_variants?.length || 0),
    0,
  );
  const reason =
    variantCount <= stepNames.length
      ? `Only control copy is live across ${stepNames.length} step(s). The loop drafts a challenger for the weakest step daily — today's draft didn't clear quality review, so nothing new shipped.`
      : 'All non-control variants are within healthy bounds vs control.';

  const inWindow = (iso: unknown, windowMs: number): boolean => {
    if (typeof iso !== 'string') return false;
    const t = Date.parse(iso);
    return Number.isFinite(t) && t >= nowMs - windowMs && t <= nowMs;
  };

  const stageDistribution: Record<string, number> = {};
  let pilotEligible = 0;
  let pilotOnly = 0;
  let last24Signups = 0;
  let last7dSignups = 0;
  let last24Completions = 0;
  let last7dCompletions = 0;
  const selfActive24 = new Set<string>();
  const selfActive7d = new Set<string>();
  const selfActive30d = new Set<string>();

  for (const u of users) {
    const stage = u.onboardingStage || '(unset)';
    stageDistribution[stage] = (stageDistribution[stage] || 0) + 1;

    if (inWindow(u.createdAt, ONE_DAY_MS)) last24Signups++;
    if (inWindow(u.createdAt, 7 * ONE_DAY_MS)) last7dSignups++;

    const events = Array.isArray(u.onboardingEvents) ? u.onboardingEvents : [];
    for (const e of events as Array<{ event?: string; ts?: string }>) {
      if (e?.event !== 'onboarding_completed') continue;
      if (inWindow(e.ts, ONE_DAY_MS)) last24Completions++;
      if (inWindow(e.ts, 7 * ONE_DAY_MS)) last7dCompletions++;
    }

    if (u.userId) {
      if (inWindow(u.lastActiveAt, ONE_DAY_MS)) selfActive24.add(u.userId);
      if (inWindow(u.lastActiveAt, 7 * ONE_DAY_MS)) selfActive7d.add(u.userId);
      if (inWindow(u.lastActiveAt, 30 * ONE_DAY_MS)) selfActive30d.add(u.userId);
    }

    // Pilot ratio: of users who logged in recently (30d), how many never
    // performed an action under their own (non-delegated) session?
    if (inWindow(u.lastLoginTime, 30 * ONE_DAY_MS)) {
      pilotEligible++;
      if (!inWindow(u.lastActiveAt, 30 * ONE_DAY_MS)) pilotOnly++;
    }
  }

  return {
    todayStr,
    reason,
    totalUsers: users.length,
    stageDistribution,
    signups: { last24h: last24Signups, last7d: last7dSignups },
    completions: { last24h: last24Completions, last7d: last7dCompletions },
    selfActive: { last24h: selfActive24.size, last7d: selfActive7d.size, last30d: selfActive30d.size },
    pilotRatio: pilotEligible > 0 ? pilotOnly / pilotEligible : null,
  };
}
