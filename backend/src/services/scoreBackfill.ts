import { ChatSession } from "./chatbotService";
import {
  scoreSessionIfNeeded,
  scoreSessionWithJudgeIfNeeded,
  ScoringJudge,
} from "./sessionScoringService";

// ENG-291: get_chat_history with sync=true used to score every session in the
// window SEQUENTIALLY (one awaited LLM call per session, plus one per judge),
// followed by a second sequential loop re-fetching each session from DynamoDB.
// On a busy 24h window this blew past the 5-minute tool timeout, so the Daily
// Satisfaction Score Report aborted with zero output.
//
// backfillSessionScores replaces that with a bounded-concurrency worker pool
// under a wall-clock budget:
//   - Concurrency cap (default 6) scores sessions in parallel instead of one at
//     a time — the dominant cost is the per-session LLM scoring call.
//   - Wall-clock budget (default 4 min, safely under the 5-min tool timeout):
//     once exhausted, no new session is dispatched, so the endpoint always
//     returns before the tool aborts. Sessions not reached this run keep their
//     cached scores in the response and are scored on a later run (each score
//     persists, so already-scored sessions are cheaply skipped next time — the
//     backlog drains across the daily runs). No fire-and-forget background work,
//     which would be unsafe on Elastic Beanstalk (the process can be recycled).
//   - Scores are applied IN-MEMORY onto the passed session objects, so the
//     caller no longer needs a second re-fetch loop.

const DEFAULT_CONCURRENCY = 6;
const DEFAULT_BUDGET_MS = 4 * 60 * 1000; // 4 min < 5-min tool timeout

function envInt(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

export interface BackfillScoresOptions {
  /** Max sessions scored in parallel. Default env CHAT_HISTORY_SCORE_CONCURRENCY or 6. */
  concurrency?: number;
  /** Wall-clock budget in ms; once elapsed, remaining sessions are left for a later run. */
  budgetMs?: number;
  /** Injectable clock for deterministic tests. Defaults to Date.now. */
  now?: () => number;
  /** Test seam / override for the per-session satisfaction scorer. */
  scoreSession?: (session: ChatSession) => Promise<ChatSession["satisfactionScore"] | null>;
  /** Test seam / override for the per-judge scorer. */
  scoreWithJudge?: (
    session: ChatSession,
    judge: ScoringJudge
  ) => Promise<NonNullable<ChatSession["judgeScores"]>[string] | null>;
  /** Called when a session's scoring throws, so the caller can log without halting the batch. */
  onError?: (session: ChatSession, error: unknown) => void;
}

export interface BackfillScoresResult {
  /** Sessions dispatched (attempted) this run — includes ones whose scorer threw. */
  scored: number;
  /** Sessions never reached because the wall-clock budget was exhausted first. */
  skipped: number;
  /** True when the budget was exhausted before every session was dispatched. */
  timedOut: boolean;
}

/**
 * Score the given sessions (default + all judges) with bounded concurrency under a
 * wall-clock budget, applying results onto the session objects in place.
 */
export async function backfillSessionScores(
  sessions: ChatSession[],
  judges: ScoringJudge[],
  options: BackfillScoresOptions = {}
): Promise<BackfillScoresResult> {
  const total = sessions.length;
  if (total === 0) {
    return { scored: 0, skipped: 0, timedOut: false };
  }

  const concurrency = Math.max(
    1,
    options.concurrency ?? envInt("CHAT_HISTORY_SCORE_CONCURRENCY", DEFAULT_CONCURRENCY)
  );
  const budgetMs = options.budgetMs ?? envInt("CHAT_HISTORY_SYNC_SCORE_BUDGET_MS", DEFAULT_BUDGET_MS);
  const now = options.now ?? Date.now;
  const scoreSession = options.scoreSession ?? scoreSessionIfNeeded;
  const scoreWithJudge = options.scoreWithJudge ?? scoreSessionWithJudgeIfNeeded;

  const start = now();
  let next = 0;
  let scored = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      // Stop before claiming more work once the budget is spent, so the endpoint
      // returns ahead of the tool timeout.
      if (now() - start >= budgetMs) return;
      const index = next++;
      if (index >= total) return;

      const session = sessions[index];
      try {
        const satisfaction = await scoreSession(session);
        if (satisfaction) session.satisfactionScore = satisfaction;
        for (const judge of judges) {
          const judgeScore = await scoreWithJudge(session, judge);
          if (judgeScore) {
            (session.judgeScores ??= {})[judge.id] = judgeScore;
          }
        }
      } catch (error) {
        options.onError?.(session, error);
      }
      scored++;
    }
  };

  const workerCount = Math.min(concurrency, total);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  const skipped = total - scored;
  return { scored, skipped, timedOut: skipped > 0 };
}
