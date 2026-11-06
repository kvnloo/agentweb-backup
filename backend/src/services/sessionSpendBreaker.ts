/**
 * ENG-2820 (child of ENG-2812): pure per-session turn/spend circuit-breaker evaluator.
 *
 * DARK — not wired into any live path. Cap values, user-facing copy, and agent-loop
 * wiring belong to the parent issue. This module only decides.
 *
 * Re-trip semantics: a user confirmation at turn T acknowledges every cap multiple up to
 * and including the one T reached, so the breaker stays quiet until the next multiple
 * (k = floor(T / maxTurns) + 1) is crossed — `turns >= maxTurns * k` or
 * `spendUsd >= maxSpendUsd * k`.
 */

export interface SessionSpendCaps {
  maxTurns: number;
  maxSpendUsd: number;
}

export interface SessionSpendBreakerInput {
  turns: number;
  spendUsd: number;
  caps: SessionSpendCaps;
  isScheduled: boolean;
  confirmedUpToTurn?: number;
}

export type SessionSpendBreakerAction = 'continue' | 'pause_for_confirmation' | 'pause_and_notify';

export interface SessionSpendBreakerDecision {
  action: SessionSpendBreakerAction;
  reason: 'under_caps' | 'turn_cap' | 'spend_cap' | 'turn_and_spend_cap';
  turns: number;
  spendUsd: number;
}

function isPositiveCap(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

export function evaluateSessionSpendBreaker(input: SessionSpendBreakerInput): SessionSpendBreakerDecision {
  const { turns, spendUsd, caps, isScheduled, confirmedUpToTurn } = input;

  let multiple = 1;
  if (confirmedUpToTurn !== undefined && confirmedUpToTurn >= 0 && isPositiveCap(caps.maxTurns)) {
    multiple = Math.floor(confirmedUpToTurn / caps.maxTurns) + 1;
  }

  const turnTripped = isPositiveCap(caps.maxTurns) && turns >= caps.maxTurns * multiple;
  const spendTripped = isPositiveCap(caps.maxSpendUsd) && spendUsd >= caps.maxSpendUsd * multiple;

  if (!turnTripped && !spendTripped) {
    return { action: 'continue', reason: 'under_caps', turns, spendUsd };
  }

  const reason = turnTripped && spendTripped ? 'turn_and_spend_cap' : turnTripped ? 'turn_cap' : 'spend_cap';
  return {
    action: isScheduled ? 'pause_and_notify' : 'pause_for_confirmation',
    reason,
    turns,
    spendUsd,
  };
}
