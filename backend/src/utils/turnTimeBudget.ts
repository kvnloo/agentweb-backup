/**
 * turnTimeBudget — the wall-clock analogue of the agent loop's step budget (ENG-907).
 *
 * The tool loop already self-regulates against `maxIterations`: it injects escalating
 * "wrap up soon" nudges and, at the ceiling, exits with whatever it has. It had no
 * equivalent for TIME, so a broad research turn that stayed well under 40 steps could
 * still burn the whole 10-minute `withGenerationTimeout` cap issuing discovery calls.
 * When the cap fires the controller force-rejects the run and returns a bare 504 — the
 * turn's text output is thrown away and the user sees "please try again" after real
 * spend (ENG-907: 34 messages, $3.22, zero deliverables).
 *
 * These pure helpers give the loop the same ladder for wall-clock time:
 *   normal          — plenty of budget left, behave exactly as before
 *   wrap_up         — past `wrapUpFraction` of the budget: stop starting new discovery
 *   final_synthesis — less than the synthesis reserve left: take the tools away and
 *                     make the model deliver what it already has, labelled partial
 *
 * Pure and dependency-free so it can be unit-tested without loading the agent-mode
 * monolith (same shape as `waitSecondsBudget`).
 */

export type TurnTimeBudgetPhase = 'normal' | 'wrap_up' | 'final_synthesis';

export interface TurnTimeBudgetInput {
  /** Epoch ms when this turn's tool loop started. */
  startedAtMs: number;
  /** Absolute epoch ms at which the whole-turn hard cap fires. Non-finite disables the budget. */
  hardCapMs?: number;
  /** Current epoch ms (injectable for tests). Defaults to Date.now(). */
  nowMs?: number;
  /** Fraction of the budget after which new discovery should stop. Default 0.7. */
  wrapUpFraction?: number;
  /** Base ms to hold back for the final synthesis turn. Default 90_000. */
  synthesisReserveMs?: number;
  /**
   * Longest single LLM call observed this run. The synthesis turn is itself an LLM
   * call, so on a slow model the fixed reserve can be too small — grow it to 1.25x
   * the slowest call seen (never past half the budget, or a single pathological call
   * would push the turn into synthesis before any work happened).
   */
  longestLlmCallMs?: number;
}

export interface TurnTimeBudgetState {
  phase: TurnTimeBudgetPhase;
  /** ms consumed by this turn so far (never negative). */
  elapsedMs: number;
  /** ms left before the hard cap (never negative). */
  remainingMs: number;
  /** ms held back for the final synthesis turn. */
  reserveMs: number;
}

const DEFAULT_WRAP_UP_FRACTION = 0.7;
const DEFAULT_SYNTHESIS_RESERVE_MS = 90_000;
const SYNTHESIS_RESERVE_SLOWEST_CALL_MULTIPLIER = 1.25;

function positiveOr(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function evaluateTurnTimeBudget(input: TurnTimeBudgetInput): TurnTimeBudgetState {
  const now = Number.isFinite(input.nowMs as number) ? (input.nowMs as number) : Date.now();
  const hardCap = Number(input.hardCapMs);
  const totalMs = hardCap - input.startedAtMs;

  // No usable budget (unset/NaN cap, or a cap at/behind the start) → stay out of the way.
  if (!Number.isFinite(hardCap) || !(totalMs > 0)) {
    return { phase: 'normal', elapsedMs: Math.max(0, now - input.startedAtMs), remainingMs: 0, reserveMs: 0 };
  }

  const elapsedMs = Math.max(0, now - input.startedAtMs);
  const remainingMs = Math.max(0, hardCap - now);

  const baseReserve = positiveOr(input.synthesisReserveMs, DEFAULT_SYNTHESIS_RESERVE_MS);
  const slowestCallReserve = positiveOr(input.longestLlmCallMs, 0) * SYNTHESIS_RESERVE_SLOWEST_CALL_MULTIPLIER;
  const reserveMs = Math.min(Math.max(baseReserve, slowestCallReserve), totalMs / 2);

  if (remainingMs <= reserveMs) {
    return { phase: 'final_synthesis', elapsedMs, remainingMs, reserveMs };
  }

  const wrapUpFraction = positiveOr(input.wrapUpFraction, DEFAULT_WRAP_UP_FRACTION);
  if (elapsedMs >= totalMs * wrapUpFraction) {
    return { phase: 'wrap_up', elapsedMs, remainingMs, reserveMs };
  }

  return { phase: 'normal', elapsedMs, remainingMs, reserveMs };
}

/**
 * The message injected into the conversation at each phase. Mirrors the wording style
 * of the existing step-budget nudges so the model treats them the same way.
 */
export function buildTurnTimeBudgetNudge(
  state: TurnTimeBudgetState,
  kind: 'wrap_up' | 'final_synthesis',
): string {
  const remainingSeconds = Math.max(0, Math.round(state.remainingMs / 1000));
  if (kind === 'wrap_up') {
    return (
      `[SYSTEM] Time budget: about ${remainingSeconds}s of wall-clock time remain for this turn. ` +
      `Stop starting new research, searches, browsing or pagination. Complete any pending writes ` +
      `now, then write your answer with the results you already have. If the request had several ` +
      `parts, deliver the parts you completed and say plainly which parts are still missing.`
    );
  }
  return (
    `[SYSTEM WARNING] The time limit for this turn is about to be reached (~${remainingSeconds}s left) ` +
    `and tools are now disabled. Do not call any more tools. Write your final answer NOW using ` +
    `everything you already gathered so far, even if it is incomplete: lead with a short "Partial ` +
    `results" note stating which parts are done and which are missing, then give the actual content ` +
    `you have (lists, findings, links), and finish by telling the user they can reply "continue" to ` +
    `pick up the rest. Never reply with only an apology or a request to try again — partial output is ` +
    `far more useful than none.`
  );
}

/**
 * Fallback shown when the forced synthesis turn still produces no text (e.g. the model
 * returns an empty completion). Keeps the turn honest: it says the time limit was hit
 * and that the transcript above holds the work that was done.
 */
export const TURN_TIME_BUDGET_FALLBACK_CONTENT =
  "I hit the time limit for this request before I could finish everything. The research I completed " +
  'so far is in the steps above — reply "continue" and I\'ll pick up from there instead of starting over.';
