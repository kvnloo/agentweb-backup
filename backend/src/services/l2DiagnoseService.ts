/**
 * ENG-1553 — L2 Diagnose: orchestration half.
 *
 * Composes evidence from three already-built, already-tested sources into the
 * `CauseEvaluation[]` shape `l2Diagnose.ts`'s pure gate consumes, then applies the gate. Calls the
 * underlying service functions directly (in-process), not via HTTP self-call — unlike the MCP
 * tool wrappers (`monitor_lead_volume`, `check_account_tracking_health`), this is backend-internal
 * code, not an LLM-facing tool, so there is no auth-context reason to round-trip through HTTP.
 *
 * Only `leads_at_zero` has real evidence composition today — `budget_exhausted` (one of its five
 * causes) has no evidence source anywhere in this codebase (confirmed directly, see
 * `l2Diagnose.ts`'s doc comment) and stays permanently `unchecked`. `genuine_demand_drop` is in the
 * same position for a different reason: a drought verdict requires a Conversion Tracking Validator
 * pass before it can be trusted (see `evaluateDemandVsVariance`'s doc comment), and CTV is a skill
 * this pure orchestrator cannot invoke — so it can be `ruled_out` here but never `supported`.
 * `ctr_falling`/`cpm_rising`
 * have ZERO evidence source for every one of their listed causes, so `diagnoseCtrFalling`/
 * `diagnoseCpmRising` are not implemented yet — calling `diagnose()` directly with every cause
 * `unchecked` already produces the correct `could_not_determine` result for those symptoms via
 * the same generic gate, so there is nothing symptom-specific to write for them until a real
 * evidence source for at least one of their causes exists.
 */

import { userDb } from './db';
import { getAccountsByUserId } from './connectedAccountsDb';
import { monitorLeadVolume } from './leadVolumeMonitorService';
import { runMetaTrackingMonitor } from '../cron/metaTrackingMonitorCron';
import { BLACKOUT_ALERT_CLASS, OPTIMISATION_ALERT_CLASS, DESTINATION_ALERT_CLASS } from './metaTrackingMonitor';
import { diagnose, type CauseEvaluation, type Diagnosis } from './l2Diagnose';
import type { CampaignVolumeReport } from './leadVolumeMonitor';

export interface DiagnoseLeadsAtZeroResult {
  success: boolean;
  message?: string;
  error?: string;
  client?: { userId: string; email: string; displayName?: string };
  /** One diagnosis per Meta ad account the client has connected — mirrors
   * `leadVolumeMonitorService.ts`'s per-account reports array shape. */
  diagnoses?: Array<Diagnosis & { accountId: string }>;
}

/**
 * Resolves a client and, for each of their connected Meta ad accounts, evaluates all five
 * "leads at zero" look-alike causes and applies the discrimination gate.
 *
 * `callerUserId`/`callerIsAdmin` mirror `monitorLeadVolume`'s own signature exactly — this
 * function is itself admin-only, since it composes `check_account_tracking_health`-equivalent
 * data, which is cross-account.
 */
export async function diagnoseLeadsAtZero(
  callerUserId: string,
  clientNameOrEmail: string,
  callerIsAdmin: boolean | undefined,
): Promise<DiagnoseLeadsAtZeroResult> {
  const isAdmin = callerIsAdmin !== undefined
    ? callerIsAdmin
    : (await userDb.getUserById(callerUserId))?.isAdmin === true;
  if (!isAdmin) {
    return {
      success: false,
      message: 'Access denied. Only admin users can run L2 diagnosis.',
      error: 'Admin access required',
    };
  }

  let client = await userDb.getUserByEmail(clientNameOrEmail);
  if (!client) {
    const allUsers = await userDb.getAllUsers();
    const searchLower = clientNameOrEmail.toLowerCase();
    client = allUsers.find(
      (u: any) =>
        (u.displayName && u.displayName.toLowerCase().includes(searchLower)) ||
        (u.email && u.email.toLowerCase().includes(searchLower)),
    );
  }
  if (!client) {
    return { success: false, message: `Client "${clientNameOrEmail}" not found.`, error: 'Client not found' };
  }

  const connectedAccounts = await getAccountsByUserId(client.userId);
  const metaAdAccounts = connectedAccounts.filter(
    acc => acc.platform === 'meta' && acc.config?.account_type === 'ad_account',
  );
  if (metaAdAccounts.length === 0) {
    return {
      success: true,
      client: { userId: client.userId, email: client.email, displayName: client.displayName },
      diagnoses: [],
      message: 'No connected Meta ad accounts for this client.',
    };
  }

  // One tracking sweep PER AD ACCOUNT, not one for the whole client — `runMetaTrackingMonitor`'s
  // aggregate counters (destinationOk/destinationAlerts/blackouts/...) sum across every account
  // the call covers, so a client-wide call would let one account's destination alert leak into
  // every sibling account's diagnosis. Scoping via `adAccountId` (same as `check_account_tracking_
  // health`'s already-reviewed pattern) makes every counter genuinely single-account.
  const [leadVolumeResult, trackingSummaries] = await Promise.all([
    monitorLeadVolume(callerUserId, clientNameOrEmail, true),
    Promise.all(
      metaAdAccounts.map(acc =>
        runMetaTrackingMonitor({ dryRun: true, userId: client.userId, adAccountId: acc.account_id }),
      ),
    ),
  ]);

  const diagnoses = metaAdAccounts.map((acc, i) => {
    const accountId = acc.account_id;
    const report = leadVolumeResult.reports?.find(r => r.accountId === accountId);
    const trackingSummary = trackingSummaries[i];

    const pixelCapiEvaluation = evaluatePixelCapiBroken(accountId, trackingSummary);
    const causes: CauseEvaluation[] = [
      pixelCapiEvaluation,
      evaluateLandingPageUnreachable(accountId, trackingSummary),
      { cause: 'budget_exhausted', verdict: 'unchecked', evidence: 'no evidence source exists for budget/spend-cap data in this codebase — only realized spend is captured, not the campaign budget cap itself' },
      // Demand-vs-variance is only trustworthy when tracking itself is confirmed healthy — a
      // "leads" count is downstream of the same pixel/CAPI pipeline pixel_capi_broken evaluates.
      // Evaluating it independently while a tracking failure is already SUPPORTED would compare a
      // real signal (pixel confirmed broken) against a signal whose own integrity is in question
      // (lead counts, which the broken pixel could itself be undercounting) — exactly the
      // "two live explanations, can't trust either over the other" case the gate exists to catch,
      // caught by a red-check: a test scenario with both evaluated independently produced
      // could_not_determine on a case that should have been a clean determined:pixel_capi_broken.
      ...(pixelCapiEvaluation.verdict === 'supported'
        ? [
            { cause: 'genuine_demand_drop', verdict: 'unchecked' as const, evidence: 'pixel/CAPI already confirmed broken for this account — lead counts are downstream of the same pipeline and cannot be trusted as independent evidence' },
            { cause: 'normal_variance', verdict: 'unchecked' as const, evidence: 'pixel/CAPI already confirmed broken for this account — lead counts are downstream of the same pipeline and cannot be trusted as independent evidence' },
          ]
        : evaluateDemandVsVariance(report)),
    ];

    return { ...diagnose('leads_at_zero', causes), accountId };
  });

  return {
    success: true,
    client: { userId: client.userId, email: client.email, displayName: client.displayName },
    diagnoses,
  };
}

/** capturedAlerts with either class indicate a real pixel/CAPI event-tracking failure. Sourced
 * from metaTrackingMonitor.ts's own exported constants rather than hand-typed strings — an
 * earlier draft hand-typed 'meta-blackout' (the real class is 'meta-attribution-blackout'),
 * which silently ruled out a full attribution blackout as "no alert found". */
const PIXEL_CAPI_ALERT_CLASSES = new Set([OPTIMISATION_ALERT_CLASS, BLACKOUT_ALERT_CLASS]);

function evaluatePixelCapiBroken(accountId: string, trackingSummary: any): CauseEvaluation {
  const alerts: any[] = trackingSummary?.capturedAlerts ?? [];
  const accountAlerts = alerts.filter(a => a?.context?.['Ad Account'] === accountId);
  const pixelAlert = accountAlerts.find(a => PIXEL_CAPI_ALERT_CLASSES.has(a?.context?.['Alert Class']));
  if (pixelAlert) {
    return { cause: 'pixel_capi_broken', verdict: 'supported', evidence: pixelAlert.message ?? pixelAlert.subject };
  }
  // Zero counters also describe failed or unperformed observations. Only a complete,
  // positively healthy account sweep can exclude a tracking failure.
  if (Number.isInteger(trackingSummary?.healthy) && trackingSummary.healthy > 0
    && trackingSummary.accountsChecked === trackingSummary.healthy
    && ['blackouts', 'tokenErrors', 'fetchErrors', 'unclassifiable', 'idle', 'optimisationAlerts']
      .every(key => trackingSummary[key] === 0)) {
    return {
      cause: 'pixel_capi_broken',
      verdict: 'ruled_out',
      evidence: `tracking sweep found no pixel/CAPI/optimisation-event alert for this account (blackouts: ${trackingSummary.blackouts ?? 0}, tokenErrors: ${trackingSummary.tokenErrors ?? 0})`,
    };
  }
  return { cause: 'pixel_capi_broken', verdict: 'unchecked', evidence: 'tracking sweep did not return a usable summary for this account' };
}

function evaluateLandingPageUnreachable(accountId: string, trackingSummary: any): CauseEvaluation {
  const destinationAlerts = trackingSummary?.destinationAlerts ?? 0;
  const destinationOk = trackingSummary?.destinationOk ?? 0;
  const destinationUnverifiable = trackingSummary?.destinationUnverifiable;
  if (destinationAlerts > 0) {
    const alerts: any[] = trackingSummary?.capturedAlerts ?? [];
    const destAlert = alerts.find(a => a?.context?.['Ad Account'] === accountId && a?.context?.['Alert Class'] === DESTINATION_ALERT_CLASS);
    return {
      cause: 'landing_page_unreachable',
      verdict: 'supported',
      evidence: destAlert?.message ?? `${destinationAlerts} destination-coverage alert(s) on this sweep`,
    };
  }
  if (destinationOk > 0 && destinationUnverifiable === 0) {
    return { cause: 'landing_page_unreachable', verdict: 'ruled_out', evidence: `${destinationOk} destination(s) confirmed reachable and carrying this account's pixel, zero unverifiable` };
  }
  return { cause: 'landing_page_unreachable', verdict: 'unchecked', evidence: 'destination coverage could not be confirmed either way for this sweep' };
}

/**
 * `monitor_lead_volume`'s own status already encodes exactly this distinction — 'drought' means
 * the trailing window is genuinely below this campaign's own historical floor (real demand drop),
 * 'normal' means today's zero is within this campaign's own normal noise band (normal variance),
 * 'insufficient_history' means neither can be judged yet. Reused directly rather than
 * re-implemented, per the same "don't redefine an existing rule in prose" principle already
 * applied to the destination/objective exclusion check elsewhere in this codebase.
 *
 * A drought verdict is never treated as `supported` evidence for genuine_demand_drop, though —
 * `leadVolumeMonitor.ts`'s own contract (`requiresTrackingValidation: true` on every drought) is
 * that a caller MUST run a Conversion Tracking Validator pass before treating a drought as
 * confirmed, because a broken pixel/CAPI can produce the exact same "leads collapsed" signal as a
 * genuine demand drop. CTV is a skill (LLM + tools), not code this pure orchestrator can call —
 * same structural gap as budget_exhausted having no reachable evidence source — so a drought here
 * stays `unchecked` for genuine_demand_drop rather than a confident, unvalidated `supported`.
 * Ruling out normal_variance does NOT need CTV: it only claims the OBSERVED count fell outside its
 * own normal noise band, which is true regardless of what caused the collapse.
 */
function evaluateDemandVsVariance(report: { campaigns: CampaignVolumeReport[] } | undefined): CauseEvaluation[] {
  if (!report || report.campaigns.length === 0) {
    return [
      { cause: 'genuine_demand_drop', verdict: 'unchecked', evidence: 'no lead-volume report available for this account' },
      { cause: 'normal_variance', verdict: 'unchecked', evidence: 'no lead-volume report available for this account' },
    ];
  }
  // Account-level verdict: if ANY campaign is in a genuine drought, that outranks a normal
  // finding elsewhere on the account — a single campaign's real collapse must not be masked by
  // another campaign on the same account reporting normal.
  const droughtCampaign = report.campaigns.find(c => c.status === 'drought');
  if (droughtCampaign) {
    return [
      {
        cause: 'genuine_demand_drop',
        verdict: 'unchecked',
        evidence: `at least one campaign is below its own historical floor (${droughtCampaign.reason}), but this requires a Conversion Tracking Validator pass before it can be treated as a confirmed demand drop rather than a tracking failure — this orchestrator has no CTV access`,
      },
      { cause: 'normal_variance', verdict: 'ruled_out', evidence: `at least one campaign is below its own historical floor: ${droughtCampaign.reason}` },
    ];
  }
  const normalCampaign = report.campaigns.find(c => c.status === 'normal');
  if (normalCampaign && report.campaigns.every(c => c.status === 'normal')) {
    return [
      { cause: 'genuine_demand_drop', verdict: 'ruled_out', evidence: `no campaign is below its own historical floor: ${normalCampaign.reason}` },
      { cause: 'normal_variance', verdict: 'supported', evidence: normalCampaign.reason },
    ];
  }
  return [
    { cause: 'genuine_demand_drop', verdict: 'unchecked', evidence: 'not every campaign has sufficient history to judge variance' },
    { cause: 'normal_variance', verdict: 'unchecked', evidence: 'not every campaign has sufficient history to judge variance' },
  ];
}
