/**
 * ENG-2947 (slice of ENG-2770, feeds ENG-2769): pure usage-alert outcome analyzer.
 *
 * Input is exported log text containing `[usageTelemetry] {json}` lines as
 * written by `llmUsageTelemetry.defaultSink`. No I/O, no persistence: a durable
 * store is ENG-2770's data-plane decision and stays out of this module.
 */
import {
  USAGE_TELEMETRY_EVENTS,
  USAGE_TELEMETRY_VERSION,
  redactInternalEconomics,
} from "./llmUsageTelemetry";

const LINE_PREFIX = "[usageTelemetry] ";
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export type AlertFunnelOutcome =
  | "upgrade"
  | "book_call"
  | "contact"
  | "see_options"
  | "dismissed"
  | "none";

/** Strongest gesture wins when a subject does several. */
const OUTCOME_BY_EVENT: Record<string, Exclude<AlertFunnelOutcome, "none">> = {
  [USAGE_TELEMETRY_EVENTS.alertUpgrade]: "upgrade",
  [USAGE_TELEMETRY_EVENTS.alertBookCall]: "book_call",
  [USAGE_TELEMETRY_EVENTS.alertContact]: "contact",
  [USAGE_TELEMETRY_EVENTS.alertSeeOptions]: "see_options",
  [USAGE_TELEMETRY_EVENTS.alertDismissed]: "dismissed",
};
const OUTCOME_RANK: AlertFunnelOutcome[] = [
  "upgrade",
  "book_call",
  "contact",
  "see_options",
  "dismissed",
  "none",
];

export interface ParsedTelemetryEvent {
  event: string;
  billingUserId: string;
  tsMs: number;
}

export interface ParseSkips {
  nonTelemetry: number;
  malformed: number;
  unknownVersion: number;
}

export interface SubjectOutcome {
  billingUserId: string;
  firstOffTrackAt: string | null;
  alertShown: boolean;
  firstAlertAt: string | null;
  outcome: AlertFunnelOutcome;
  modelSwitchesWithin7d: number;
}

export interface AlertOutcomeReport {
  telemetryVersion: string;
  linesRead: number;
  eventsParsed: number;
  skipped: ParseSkips;
  subjects: SubjectOutcome[];
  aggregates: {
    subjectsWithAlert: number;
    alertShownCount: number;
    outcomeCounts: Record<AlertFunnelOutcome, number>;
    /** outcome subjects / subjects shown an alert; 0 when none shown. */
    ctaConversionRates: Record<Exclude<AlertFunnelOutcome, "none">, number>;
    modelSwitchesWithin7dAfterFirstAlert: number;
    subjectsSwitchedWithin7d: number;
  };
}

/** Parse one log line. Never throws; returns a skip reason instead. */
export function parseTelemetryLine(
  line: string,
): { ok: true; value: ParsedTelemetryEvent & { onTrack?: unknown } } | { ok: false; reason: keyof ParseSkips } {
  const idx = line.indexOf(LINE_PREFIX);
  if (idx < 0) return { ok: false, reason: "nonTelemetry" };
  let obj: unknown;
  try {
    obj = JSON.parse(line.slice(idx + LINE_PREFIX.length).trim());
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    return { ok: false, reason: "malformed" };
  }
  const rec = obj as Record<string, unknown>;
  if (rec.telemetryVersion !== USAGE_TELEMETRY_VERSION) return { ok: false, reason: "unknownVersion" };
  const tsMs = typeof rec.ts === "string" ? Date.parse(rec.ts) : NaN;
  if (typeof rec.event !== "string" || typeof rec.billingUserId !== "string" || !rec.billingUserId || Number.isNaN(tsMs)) {
    return { ok: false, reason: "malformed" };
  }
  return { ok: true, value: { event: rec.event, billingUserId: rec.billingUserId, tsMs, onTrack: rec.onTrack } };
}

export function analyzeUsageAlertOutcomes(lines: Iterable<string>): AlertOutcomeReport {
  const skipped: ParseSkips = { nonTelemetry: 0, malformed: 0, unknownVersion: 0 };
  const bySubject = new Map<string, Array<ParsedTelemetryEvent & { onTrack?: unknown }>>();
  let linesRead = 0;
  let eventsParsed = 0;

  for (const line of lines) {
    linesRead++;
    if (!line.trim()) {
      skipped.nonTelemetry++;
      continue;
    }
    const parsed = parseTelemetryLine(line);
    if (!parsed.ok) {
      skipped[parsed.reason]++;
      continue;
    }
    eventsParsed++;
    const list = bySubject.get(parsed.value.billingUserId) ?? [];
    list.push(parsed.value);
    bySubject.set(parsed.value.billingUserId, list);
  }

  const subjects: SubjectOutcome[] = [];
  let alertShownCount = 0;
  for (const [billingUserId, events] of [...bySubject.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    events.sort((a, b) => a.tsMs - b.tsMs);
    const offTrack = events.find((e) => e.event === USAGE_TELEMETRY_EVENTS.forecastComputed && e.onTrack === false);
    const shown = events.filter((e) => e.event === USAGE_TELEMETRY_EVENTS.alertShown);
    alertShownCount += shown.length;
    const firstAlert = shown[0];
    let outcome: AlertFunnelOutcome = "none";
    let switches = 0;
    if (firstAlert) {
      for (const e of events) {
        if (e.tsMs < firstAlert.tsMs) continue;
        const o = OUTCOME_BY_EVENT[e.event];
        if (o && OUTCOME_RANK.indexOf(o) < OUTCOME_RANK.indexOf(outcome)) outcome = o;
        if (e.event === USAGE_TELEMETRY_EVENTS.changeApplied && e.tsMs - firstAlert.tsMs <= SEVEN_DAYS_MS) switches++;
      }
    }
    subjects.push({
      billingUserId,
      firstOffTrackAt: offTrack ? new Date(offTrack.tsMs).toISOString() : null,
      alertShown: Boolean(firstAlert),
      firstAlertAt: firstAlert ? new Date(firstAlert.tsMs).toISOString() : null,
      outcome,
      modelSwitchesWithin7d: switches,
    });
  }

  const shownSubjects = subjects.filter((s) => s.alertShown);
  const outcomeCounts = Object.fromEntries(OUTCOME_RANK.map((o) => [o, 0])) as Record<AlertFunnelOutcome, number>;
  for (const s of shownSubjects) outcomeCounts[s.outcome]++;
  const rate = (n: number) => (shownSubjects.length ? n / shownSubjects.length : 0);

  const report: AlertOutcomeReport = {
    telemetryVersion: USAGE_TELEMETRY_VERSION,
    linesRead,
    eventsParsed,
    skipped,
    subjects,
    aggregates: {
      subjectsWithAlert: shownSubjects.length,
      alertShownCount,
      outcomeCounts,
      ctaConversionRates: {
        upgrade: rate(outcomeCounts.upgrade),
        book_call: rate(outcomeCounts.book_call),
        contact: rate(outcomeCounts.contact),
        see_options: rate(outcomeCounts.see_options),
        dismissed: rate(outcomeCounts.dismissed),
      },
      modelSwitchesWithin7dAfterFirstAlert: shownSubjects.reduce((n, s) => n + s.modelSwitchesWithin7d, 0),
      subjectsSwitchedWithin7d: shownSubjects.filter((s) => s.modelSwitchesWithin7d > 0).length,
    },
  };
  // AC4 backstop: output is built only from whitelisted fields above, but run
  // the shared redactor and refuse to emit if it would remove anything.
  const redacted = redactInternalEconomics(report as unknown as Record<string, unknown>);
  if (redacted.redactedKeys) {
    throw new Error(`usageAlertOutcomeAnalysis: money field in output: ${String(redacted.redactedKeys)}`);
  }
  return report;
}
