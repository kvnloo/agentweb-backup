/**
 * Shadow-judge online sampler (ENG-2128, ENG-2189, ENG-2138, ENG-2146).
 *
 * Once a day: draw a seeded uniform random sample of the previous UTC day's sessions, and for
 * every custom judge configured with `shadow: true` in AW-Settings scoring-judges, score each
 * sampled session through `scoreSessionWithJudgeIfNeeded` (the same function the admin
 * judge-score route uses). That function's own `isInShadowSample` check further restricts
 * scoring to the judge's own configured `sampleRate`, so this cron's sample size and the
 * judge's sampleRate compose rather than duplicate each other.
 *
 * Deliberately NOT `backfillSessionScores` (scoreBackfill.ts): that helper also runs the
 * general default scorer (`scoreSession`) on every session, reviving the paused "Daily
 * Satisfaction Score Report" population pattern as a side effect of wanting shadow-judge data.
 * This cron calls only `scoreSessionWithJudgeIfNeeded`, and only for judges with `shadow: true`
 * — a non-shadow custom judge (Fangfang/Matt) bills the session's own user as customer spend
 * (see `judgeUsage` in sessionScoringService.ts), which this cron must never trigger.
 *
 * Why this exists: ENG-2146's shadow judge (outcome-judge-b-shadow) has been configured in prod
 * since 2026-09-28 but nothing has ever run it on live traffic — the daily report task that
 * used to call `GET /api/admin/chat-sessions?sync=true` has been paused since 2026-08-18. This
 * is the narrow, dedicated trigger, built instead of resuming that unrelated, broader task.
 *
 * Inert by default. A live run refuses unless SHADOW_JUDGE_SAMPLER_ENABLED=true; enabling it in
 * production is an OPS decision (real LLM spend, even though it is system-billed, not
 * customer-billed). No grader this writes is validated, so it raises no alert.
 */

import { settingsService } from "../services/settingsService";
import { chatbotDb, type ChatSession } from "../services/chatbotService";
import { scoreSessionWithJudgeIfNeeded, type ScoringJudge } from "../services/sessionScoringService";
import { listSessionsUpdatedBetween } from "../loops/eval/agentGraderLoader";
import { sampleUniform, sampleSeed, utcDayWindow, shiftDate } from "../loops/eval/evalV2Sampler";
import { productionGraderTables, queryOnlyReader } from "./evalV2SamplerCron";

export const SHADOW_JUDGE_SAMPLER_FLAG = "SHADOW_JUDGE_SAMPLER_ENABLED";
export const SHADOW_JUDGE_SAMPLE_SIZE_ENV = "SHADOW_JUDGE_SAMPLE_SIZE";
export const DEFAULT_SHADOW_JUDGE_SAMPLE_SIZE = 50;
const MAX_SHADOW_JUDGE_SAMPLE_SIZE = 200;

export function isShadowJudgeSamplerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[SHADOW_JUDGE_SAMPLER_FLAG] === "true";
}

/** SHADOW_JUDGE_SAMPLE_SIZE, clamped to [1, 200]; unset, blank or not a number means the default. */
export function resolveShadowJudgeSampleSize(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_SHADOW_JUDGE_SAMPLE_SIZE;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_SHADOW_JUDGE_SAMPLE_SIZE;
  return Math.max(1, Math.min(MAX_SHADOW_JUDGE_SAMPLE_SIZE, Math.floor(n)));
}

export interface ShadowJudgeSamplerResult {
  status: "refused" | "ran";
  reason?: string;
  sampleDate?: string;
  frameSize?: number;
  sampled?: number;
  shadowJudgeCount?: number;
  scored?: number;
  errors?: number;
  /** Sessions whose scoring failed on the first pass and were attempted once more. */
  retried?: number;
  /** Of `retried`, those that scored on the retry (counted in `scored`, not in `errors`). */
  recovered?: number;
}

export interface ShadowJudgeSamplerOptions {
  enabled: boolean;
  dryRun: boolean;
  sampleSize: number;
  /** Override for tests; defaults to "yesterday" in UTC. */
  sampleDate?: string;
}

/** Loads scoring-judges from AW-Settings and keeps only judges configured with shadow: true. */
async function loadShadowJudges(): Promise<ScoringJudge[]> {
  const setting = await settingsService.getSetting("scoring-judges");
  if (!setting?.settingValue) return [];
  let judges: ScoringJudge[];
  try {
    judges = JSON.parse(setting.settingValue);
  } catch {
    return [];
  }
  return judges.filter((judge) => judge.shadow === true);
}

export async function runShadowJudgeSample(
  opts: ShadowJudgeSamplerOptions
): Promise<ShadowJudgeSamplerResult> {
  if (!opts.dryRun && !opts.enabled) return { status: "refused", reason: "flag_off" };

  const today = new Date().toISOString().slice(0, 10);
  const sampleDate = opts.sampleDate ?? shiftDate(today, -1);
  if (sampleDate >= today) return { status: "refused", reason: "day_not_over", sampleDate };

  const shadowJudges = await loadShadowJudges();
  if (shadowJudges.length === 0) {
    return { status: "ran", sampleDate, frameSize: 0, sampled: 0, shadowJudgeCount: 0, scored: 0, errors: 0 };
  }

  const window = utcDayWindow(sampleDate);
  const frame = await listSessionsUpdatedBetween(queryOnlyReader(), productionGraderTables().sessions, window);
  const sampleSize = Math.max(1, Math.min(MAX_SHADOW_JUDGE_SAMPLE_SIZE, Math.floor(opts.sampleSize)));
  // sampleSeed depends only on the date, not the caller, so this draws the same session set as
  // the ENG-2144 deterministic sampler for the same day — one shared daily sampling frame
  // across eval surfaces, not an accidental collision.
  const seed = sampleSeed(sampleDate);
  const picked = sampleUniform(frame, sampleSize, seed, (item) => String(item.sessionId));

  let scored = 0;
  let errors = 0;
  // ENG-2138: a failed session is never re-sampled (tomorrow draws a different date), so a
  // transient judge failure would permanently skew stored scores toward short, clean
  // transcripts. Failures are held back here and retried once, after the main loop.
  const failed: Array<{ session: ChatSession; judge: ScoringJudge; error: unknown }> = [];
  for (const item of picked) {
    let session: ChatSession | null;
    try {
      session = await chatbotDb.getChatSession(String(item.sessionId));
    } catch (error) {
      errors++;
      console.error(`[ShadowJudgeSampler] failed to load session ${item.sessionId}:`, error);
      continue;
    }
    if (!session) continue;

    for (const judge of shadowJudges) {
      if (opts.dryRun) continue;
      try {
        const result = await scoreSessionWithJudgeIfNeeded(session, judge);
        if (result) scored++;
      } catch (error) {
        failed.push({ session, judge, error });
      }
    }
  }

  // One retry pass, sequential. Safe: scoreSessionWithJudgeIfNeeded writes the score only after
  // the model call succeeds and skips a session already scored by this judge, so only sessions
  // that never persisted a score are re-attempted. A null on retry is not a recovery.
  let recovered = 0;
  for (const { session, judge, error: firstError } of failed) {
    let error = firstError;
    try {
      const result = await scoreSessionWithJudgeIfNeeded(session, judge);
      if (result) {
        scored++;
        recovered++;
        continue;
      }
    } catch (retryError) {
      error = retryError;
    }
    errors++;
    console.error(`[ShadowJudgeSampler] judge ${judge.id} failed on session ${session.sessionId}:`, error);
  }

  return {
    status: "ran",
    sampleDate,
    frameSize: frame.length,
    sampled: picked.length,
    shadowJudgeCount: shadowJudges.length,
    scored,
    errors,
    retried: failed.length,
    recovered,
  };
}

export async function runShadowJudgeSamplerCron(): Promise<void> {
  try {
    const result = await runShadowJudgeSample({
      enabled: isShadowJudgeSamplerEnabled(),
      dryRun: false,
      sampleSize: resolveShadowJudgeSampleSize(process.env[SHADOW_JUDGE_SAMPLE_SIZE_ENV]),
    });
    console.log("[ShadowJudgeSampler]", JSON.stringify(result));
  } catch (err) {
    console.error("[ShadowJudgeSampler] failed (swallowed):", err);
  }
}
