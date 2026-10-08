/**
 * ENG-1553 — L2 Diagnose: the pure half.
 *
 * For a flagged symptom (leads at zero, CTR falling, CPM rising), discriminates between
 * look-alike causes before any recommendation is emitted. Kept free of the DynamoDB/HTTP clients
 * for the same reason `leadVolumeMonitor.ts`/`adsThresholds.ts` are — the gate logic below is
 * what's worth unit-testing exhaustively, and it should not need AWS or a live API to run.
 * Evidence composition (talking to `monitor_lead_volume`, `assess_client_health`,
 * `check_account_tracking_health`) lives in `l2DiagnoseService.ts`.
 *
 * ─── Why each cause is `ruled_out` | `supported` | `unchecked`, not a 2-state model ─────────
 *
 * A first draft used only `ruled_out` / `insufficient_evidence`, requiring EVERY other cause be
 * `ruled_out` before `determined` could fire. That breaks on a real case: `budget_exhausted` (one
 * of "leads at zero"'s five look-alikes) has NO evidence source anywhere in this codebase today —
 * confirmed directly, not assumed. Under the 2-state gate, that means `leads_at_zero` could NEVER
 * reach `determined`, even with rock-solid direct evidence for a different cause (verified live on
 * a real account: a pixel confirmed broken via `check_account_tracking_health`'s structured
 * alert). Discarding a confident, well-evidenced finding because of an UNRELATED cause we
 * structurally never had a way to check fails the card's own bar exactly as badly as overclaiming
 * would — it isn't honest incompleteness, it's information loss.
 *
 * The fix: `unchecked` is excluded from the "must be ruled out" requirement, but always disclosed
 * in the output — the diagnosis says "supported: X; ruled out: Y, Z; not checkable in this
 * version: W" rather than either hiding W or letting W block every finding forever. Nothing is
 * assumed about an `unchecked` cause; it just isn't required to be `ruled_out` for the ONE cause
 * that IS `supported` to be trusted.
 *
 * ─── Why "could not determine" is not engineered around further than this ───────────────────
 *
 * The card's own AC is uncompromising: *"'Could not determine' is a valid and REQUIRED output.
 * A confidently wrong diagnosis costs more than an honestly incomplete one."* For CTR-falling and
 * CPM-rising specifically, EVERY listed look-alike cause has zero evidence source anywhere in this
 * codebase today (confirmed directly) — so those symptoms will legitimately return
 * `could_not_determine` on essentially every call in this version, and that is correct, not a bug
 * to route around. The generic gate below handles this uniformly: a symptom whose causes are all
 * `unchecked` produces zero `supported` causes, which is `could_not_determine` by the same rule
 * that handles every other ambiguous case — no special-casing needed per symptom.
 */

export type Symptom = 'leads_at_zero' | 'ctr_falling' | 'cpm_rising';

export type CauseVerdict = 'ruled_out' | 'supported' | 'unchecked';

export interface CauseEvaluation {
  cause: string;
  verdict: CauseVerdict;
  /** Required for ruled_out and supported (the evidence that produced the verdict). Required for
   * unchecked too — states WHY there is no evidence source, so a reader never has to guess
   * whether a cause was forgotten versus genuinely uncheckable in this version. */
  evidence: string;
}

export type DiagnosisOutcome = 'determined' | 'could_not_determine';

export interface Diagnosis {
  symptom: Symptom;
  outcome: DiagnosisOutcome;
  /** Set only when outcome === 'determined'. */
  concludedCause: string | null;
  causes: CauseEvaluation[];
  /** Reason the diagnosis is could_not_determine — null when determined. Always present
   * otherwise, mirroring `leadVolumeMonitor.ts`'s CampaignVolumeReport.reason convention. */
  reason: string | null;
}

/**
 * The look-alike causes per symptom, verbatim from ENG-1553's own table. Exported so a caller
 * (and a test) can assert every symptom's evidence-composition step actually evaluates every
 * cause the card names — a cause silently missing from evaluation is indistinguishable from one
 * that was checked and passed, which is exactly the failure class this whole module exists to
 * prevent.
 */
export const CAUSES_BY_SYMPTOM: Readonly<Record<Symptom, readonly string[]>> = {
  leads_at_zero: ['pixel_capi_broken', 'landing_page_unreachable', 'budget_exhausted', 'genuine_demand_drop', 'normal_variance'],
  ctr_falling: ['creative_fatigue', 'audience_saturation', 'auction_competition', 'seasonality'],
  cpm_rising: ['creative_fatigue', 'competitor_entry', 'audience_shrink', 'delivery_optimisation_shift'],
};

/**
 * Applies the discrimination gate to a fully-evaluated set of causes for one symptom.
 *
 * Pure: takes the already-computed per-cause verdicts (evidence composition is the caller's job,
 * in `l2DiagnoseService.ts`) and decides determined vs could_not_determine. This is the one
 * function this module exists to get right, and it is unit-testable with no AWS/HTTP dependency.
 */
export function diagnose(symptom: Symptom, causes: CauseEvaluation[]): Diagnosis {
  const expectedCauses = CAUSES_BY_SYMPTOM[symptom];
  const evaluatedCauseNames = new Set(causes.map(c => c.cause));
  const missing = expectedCauses.filter(c => !evaluatedCauseNames.has(c));
  if (missing.length > 0) {
    throw new Error(
      `l2Diagnose: diagnose() called for '${symptom}' without evaluating every listed cause — missing: ${missing.join(', ')}. ` +
        `A cause silently absent from evaluation is indistinguishable from one that was checked and ruled out.`,
    );
  }

  const supported = causes.filter(c => c.verdict === 'supported');
  const uncheckedNames = causes.filter(c => c.verdict === 'unchecked').map(c => c.cause);

  // With exactly three possible verdicts (ruled_out / supported / unchecked), "every OTHER cause
  // is ruled_out or unchecked" is automatically true whenever exactly one cause is supported —
  // there is no fourth verdict a cause could hold instead. So the full gate condition reduces to
  // this single check; no separate "were the others properly ruled out" verification is needed
  // or possible to fail differently.
  if (supported.length === 1) {
    return {
      symptom,
      outcome: 'determined',
      concludedCause: supported[0].cause,
      causes,
      reason: null,
    };
  }

  if (supported.length === 0) {
    const reason = uncheckedNames.length === expectedCauses.length
      ? `no evidence source exists for any of this symptom's look-alike causes in this version — every cause is unchecked`
      : `no cause has supporting evidence; ${uncheckedNames.length} of ${expectedCauses.length} causes have no evidence source (${uncheckedNames.join(', ')})`;
    return { symptom, outcome: 'could_not_determine', concludedCause: null, causes, reason };
  }

  // supported.length > 1 — two or more candidate explanations both have direct evidence, and
  // neither can be trusted over the other.
  const supportedNames = supported.map(c => c.cause);
  return {
    symptom,
    outcome: 'could_not_determine',
    concludedCause: null,
    causes,
    reason: `more than one cause has supporting evidence and cannot be distinguished: ${supportedNames.join(', ')}`,
  };
}
