/**
 * ENG-2888 (slice of ENG-2836): pure classifier for how a finished agent-mode
 * run ended, plus a *proposed* credit treatment.
 *
 * DARK: nothing imports this from the billing path. It performs no DynamoDB,
 * Stripe or usage-ledger writes. The default config reproduces today's
 * behaviour (charge_full for every class); wiring and the real credit policy
 * are ENG-2836.3 (Requires: Me, money gate).
 */

export type RunCreditClass =
  | 'completed'
  | 'truncated_iteration_limit'
  | 'failed_before_effect'
  | 'failed_after_partial_effect';

export type CreditTreatment = 'charge_full' | 'charge_consumed_only' | 'waive';

export interface RunToolEffect {
  /** Tool name, e.g. an LP write tool. */
  tool: string;
  /** True when the tool mutated external state (LP write, publish, send, ...). */
  mutating: boolean;
  /** True when the call succeeded; failed mutating calls are not effects. */
  succeeded: boolean;
}

export interface FinishedRunInput {
  /** Terminal reason as recorded by the run (ENG-2854 sets 'iteration_limit'). */
  terminationReason?: 'iteration_limit' | 'completed' | 'error' | 'cancelled' | string;
  /** Whether the run ended in an error. */
  failed?: boolean;
  /** Recorded tool effects in call order. */
  effects?: readonly RunToolEffect[];
}

export type CreditPolicyConfig = Record<RunCreditClass, CreditTreatment>;

/** Today's behaviour: every run is charged in full. */
export const DEFAULT_CREDIT_POLICY: Readonly<CreditPolicyConfig> = Object.freeze({
  completed: 'charge_full',
  truncated_iteration_limit: 'charge_full',
  failed_before_effect: 'charge_full',
  failed_after_partial_effect: 'charge_full',
});

export function hasPartialEffect(effects: readonly RunToolEffect[] | undefined): boolean {
  return (effects ?? []).some((e) => e.mutating && e.succeeded);
}

/**
 * Classify a finished run.
 * - iteration-limit exit with successful mutating effects is a partial apply
 *   (the ENG-2836 half-applied LP edit) => failed_after_partial_effect.
 * - iteration-limit exit with no effects => truncated_iteration_limit.
 * - failed/cancelled run => failed_before_effect / failed_after_partial_effect.
 * - otherwise completed.
 */
export function classifyFinishedRun(run: FinishedRunInput): RunCreditClass {
  const partial = hasPartialEffect(run.effects);
  if (run.terminationReason === 'iteration_limit') {
    return partial ? 'failed_after_partial_effect' : 'truncated_iteration_limit';
  }
  const failed = run.failed === true || run.terminationReason === 'error' || run.terminationReason === 'cancelled';
  if (failed) return partial ? 'failed_after_partial_effect' : 'failed_before_effect';
  return 'completed';
}

export interface CreditProposal {
  runClass: RunCreditClass;
  treatment: CreditTreatment;
}

export function proposeRunCredit(
  run: FinishedRunInput,
  config: CreditPolicyConfig = DEFAULT_CREDIT_POLICY,
): CreditProposal {
  const runClass = classifyFinishedRun(run);
  return { runClass, treatment: config[runClass] ?? 'charge_full' };
}
