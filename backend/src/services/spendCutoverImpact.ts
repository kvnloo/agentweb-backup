/**
 * The blast-radius model for the ENG-1250 §9 enforcement cutover.
 *
 * Enforcement today compares an account's LLM-only spend against its cap. The
 * cutover swaps the numerator for all-vendor spend. The only question worth
 * answering before flipping it: **who pauses the moment it moves, and who is
 * about to.** This is that classification, and it is one of Harsha's named
 * pre-cutover checklist items ("the cutover-impact model is reviewed").
 *
 * Pure over already-resolved inputs: the caller fetches usage and resolves each
 * account's cap (including credits/grants) exactly as the projection does, then
 * hands the numbers here. Nothing IO, nothing that can move enforcement.
 *
 * The lesson this model exists to encode, learned the hard way: the headline
 * "vendor spend is 2721% of LLM spend" is NOT the cutover risk. The cutover
 * compares spend against the CAP, so a huge ratio on a tiny base is harmless,
 * and the real exposure is small caps (Free tier) where ordinary vendor spend
 * is a large fraction of the cap. Every field here is against the cap, never a
 * spend-vs-spend ratio.
 */

export interface CutoverAccountInput {
  billingUserId: string;
  tier: string;
  llmMicroUsd: number;
  vendorMicroUsd: number;
  /** Effective cap incl. credits/grants, or null for an uncapped tier. */
  capMicroUsd: number | null;
}

export interface CutoverAccountImpact extends CutoverAccountInput {
  /** Over cap on today's LLM-only basis. */
  pausedNow: boolean;
  /** Over cap on the post-cutover all-vendor basis. */
  pausedAfter: boolean;
  /** The account the cutover newly pauses — !pausedNow && pausedAfter. */
  newlyPaused: boolean;
  percentNow: number | null;
  percentAfter: number | null;
}

export interface CutoverImpactSummary {
  assessed: number;
  capped: number;
  uncapped: number;
  alreadyPaused: number;
  newlyPaused: number;
  /** Crossed from under half its cap to at-or-past half, without pausing. */
  pushedPast50: number;
  /** Every account, richest fields first by post-cutover cap fraction. */
  accounts: CutoverAccountImpact[];
}

function classifyAccount(input: CutoverAccountInput): CutoverAccountImpact {
  const after = input.llmMicroUsd + input.vendorMicroUsd;
  const cap = input.capMicroUsd;
  const capped = cap != null;

  // An uncapped tier cannot pause on spend, and has no cap to be a percentage
  // of — null, not 0, so it is never miscounted as "at 0% of cap."
  const pausedNow = capped && input.llmMicroUsd >= cap!;
  const pausedAfter = capped && after >= cap!;

  return {
    ...input,
    pausedNow,
    pausedAfter,
    newlyPaused: !pausedNow && pausedAfter,
    percentNow: capped && cap! > 0 ? (input.llmMicroUsd / cap!) * 100 : capped ? 0 : null,
    percentAfter: capped && cap! > 0 ? (after / cap!) * 100 : capped ? 0 : null,
  };
}

export function classifyCutoverImpact(inputs: readonly CutoverAccountInput[]): CutoverImpactSummary {
  const accounts = inputs
    .map(classifyAccount)
    .sort((a, b) => (b.percentAfter ?? -1) - (a.percentAfter ?? -1));

  const capped = accounts.filter((a) => a.capMicroUsd != null);

  return {
    assessed: accounts.length,
    capped: capped.length,
    uncapped: accounts.length - capped.length,
    alreadyPaused: capped.filter((a) => a.pausedNow).length,
    newlyPaused: capped.filter((a) => a.newlyPaused).length,
    // Only among accounts that did NOT pause — the population that pauses next,
    // days rather than instantly, and worth watching after a cutover.
    pushedPast50: capped.filter(
      (a) => !a.pausedAfter && (a.percentAfter ?? 0) >= 50 && (a.percentNow ?? 0) < 50,
    ).length,
    accounts,
  };
}
