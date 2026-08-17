/**
 * Usage-runway telemetry — ENG-1212 AC6, ENG-1210 AC12, ENG-1215 AC4.
 *
 * Three acceptance criteria ask for telemetry, and all three attach the same
 * condition: it must not expose internal dollar values. That shared condition is
 * why this is a module with one exit rather than `console.log` at each call
 * site. Every forecast, recommendation and attribution object in this codebase
 * carries micro-USD fields, so the easy mistake is spreading a whole object into
 * a dimensions bag and shipping the internal economics with it.
 * `redactInternalEconomics` assumes that mistake will eventually be made and
 * removes them structurally, including from nested objects.
 *
 * ## Why a log sink, and what that does and does not satisfy
 *
 * The house pattern for product telemetry is the loops framework
 * (`fireLoopEvent` onto `AW-LoopEvents`), which `onboardingTelemetry` uses. It
 * is deliberately NOT used here. `fireLoopEvent` no-ops unless the loop id is
 * registered, and a `LoopManifest` demands a mutation surface, generator, critic
 * and approval config — it describes a loop that PROPOSES AND APPLIES changes,
 * and registering one puts it in the cron scheduler's iteration. Declaring all
 * that to record a forecast would be a fiction, and a running analyst over usage
 * events is not something to switch on as a side effect of adding telemetry.
 *
 * So the default sink is a structured, versioned log line. That genuinely
 * satisfies ENG-1212 AC6 — the forecast's inputs and output version are
 * recorded, so any figure a customer was shown can be reproduced. It does NOT
 * yet satisfy the analytic half of ENG-1210 AC12 and ENG-1215 AC4, which want
 * forecast-vs-actual compared over time: that needs a queryable store, and a new
 * table is a data-plane change. The sink is injectable precisely so that store
 * can be dropped in later without touching a single call site.
 */

/** Bump when the dimension contract changes, so old lines stay interpretable. */
export const USAGE_TELEMETRY_VERSION = "usage-telemetry-2026-08-v1";

export const USAGE_TELEMETRY_EVENTS = {
  /** A runway forecast was produced and shown. Carries inputs + output version. */
  forecastComputed: "runway_forecast_computed",
  /** A switch recommendation was surfaced to a customer. */
  recommendationShown: "runway_recommendation_shown",
  /** A customer previewed a combined set of switches (nothing persisted). */
  previewComputed: "runway_preview_computed",
} as const;

export type UsageTelemetryEvent =
  (typeof USAGE_TELEMETRY_EVENTS)[keyof typeof USAGE_TELEMETRY_EVENTS];

export type TelemetryDimensions = Record<string, unknown>;

/** Where events go. Swappable so a queryable store can replace the log later. */
export type UsageTelemetrySink = (event: string, dimensions: TelemetryDimensions) => void;

/**
 * Any dimension whose NAME implies money.
 *
 * Name-based because the values are plain numbers — there is nothing about
 * `4000000` that marks it as micro-USD. Every money-carrying field in this
 * codebase is named for what it holds (`costMicroUsd`, `costUsd`, `totalCost`,
 * `estimatedSavingsMicroUsd`, `hardThresholdMicroUsd`), so the name is the
 * signal available. Deliberately broad: a false positive costs one dimension,
 * a false negative is the disclosure three ACs forbid.
 */
const MONEY_KEY = /(microusd|usd|cost|price|dollar|amount|threshold|revenue|margin)/i;

/** Keys that survive `MONEY_KEY` despite being customer-safe day/percent figures. */
const MONEY_KEY_EXEMPT = /^(percentUsed|shareOfTotal|callCount|completeDays\w*|estimatedDays\w*)$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Strip internal economics from a dimensions bag, recursively.
 *
 * Records what it removed under `redactedKeys` rather than dropping silently:
 * a missing dimension would otherwise be indistinguishable from a call site that
 * never sent it, and "we withheld this" is a different fact from "this was never
 * measured" when someone is debugging a telemetry gap months later.
 */
export function redactInternalEconomics(dimensions: TelemetryDimensions): TelemetryDimensions {
  const removed: string[] = [];

  const walk = (input: TelemetryDimensions): TelemetryDimensions => {
    const out: TelemetryDimensions = {};
    for (const [key, value] of Object.entries(input)) {
      if (MONEY_KEY.test(key) && !MONEY_KEY_EXEMPT.test(key)) {
        removed.push(key);
        continue;
      }
      out[key] = isPlainObject(value) ? walk(value) : value;
    }
    return out;
  };

  const result = walk(dimensions);
  if (removed.length) result.redactedKeys = removed;
  return result;
}

let sink: UsageTelemetrySink | null = null;

/** Test hook: capture events, or pass null to restore the default log sink. */
export function __setUsageTelemetrySinkForTests(next: UsageTelemetrySink | null): void {
  sink = next;
}

function defaultSink(event: string, dimensions: TelemetryDimensions): void {
  // One line, one JSON object, stable prefix — greppable in EB logs and
  // parseable without a schema. `console.log` rather than a logger because this
  // codebase has no structured logger and inventing one here would be scope.
  // eslint-disable-next-line no-console
  console.log(`[usageTelemetry] ${JSON.stringify({ event, ...dimensions })}`);
}

/**
 * Record one usage-runway telemetry event. Best-effort; never throws.
 *
 * `billingUserId` is the SUBJECT, not the acting user: forecasts are per billing
 * subject, so recording the actor would split one org's telemetry across its
 * members and make any later forecast-vs-actual join wrong.
 *
 * This sits on the request path for `/usage-runway`, so a recording failure must
 * never turn a working forecast into a 500.
 */
export async function recordUsageTelemetry(
  billingUserId: string,
  event: UsageTelemetryEvent,
  dimensions: TelemetryDimensions = {},
): Promise<void> {
  try {
    const safe = redactInternalEconomics({
      ...dimensions,
      billingUserId,
      telemetryVersion: USAGE_TELEMETRY_VERSION,
      ts: new Date().toISOString(),
    });
    (sink || defaultSink)(event, safe);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[usageTelemetry] emit failed (swallowed)", {
      event,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
