/**
 * Policy DSL — parses + evaluates funnel-cascade rule conditions.
 *
 * The DSL is intentionally narrow: it covers the patterns the manifest needs
 * to express ("count below threshold", "ratio of A:B below threshold", "no
 * events of type X", "A happened but B did not within a window") and nothing
 * else. This keeps rules readable, parseable in a few hundred lines, and
 * safe to evaluate (no eval(), no shell-out).
 *
 * Supported condition syntax (case-sensitive, whitespace-tolerant):
 *
 *   1. Count threshold:
 *        "<eventType>_count[<dim>=<val>]? <op> <number>"
 *        e.g. "landed_count < 100", "complaint_received_count > 0",
 *             "landed_count[landerPath=/ai-eval] < 100"
 *
 *   2. Ratio threshold:
 *        "<eventTypeA>_count[<dim>=<val>]? / <eventTypeB>_count[<dim>=<val>]? <op> <number>"
 *        e.g. "form_submitted_count / landed_count < 0.1",
 *             "eval_started_count / landed_count[landerPath=/ai-eval] < 0.1"
 *
 *   Dimension filter (optional, on any count): "[<key>=<value>]" immediately
 *   after "_count" restricts the count to events whose dimensions[key] === value.
 *   The value may contain "/" (e.g. a pathname). Use it to compare like-for-like
 *   when one event is fired site-wide but the other only on one page.
 *
 *   3. Zero shortcut:
 *        "<eventType>_count = 0"
 *        (Same as #1 with op = and number 0, but a useful idiom.)
 *
 *   4. Coincidence (A happened but B did not within a window):
 *        "<eventTypeA> but no <eventTypeB> within <N>h"
 *        e.g. "signed_up but no onboarding_started within 24h"
 *
 * Operators: <, >, <=, >=, =, !=
 *
 * Time-window scoping:
 *   By default a condition evaluates against the full event window passed
 *   to `evaluate()`. Append "over <N>d" to scope to the last N days:
 *     "landed_count < 100 over 7d"
 *   The "over Nd" suffix is parsed but currently informational — the caller
 *   passes the actual window. Rules document their intended window for
 *   reviewer clarity.
 */

import type { NormalizedEvent, TimeWindow } from '../types';

// ---------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------

export type Operator = '<' | '>' | '<=' | '>=' | '=' | '!=';

/** Optional dimension filter on a count, e.g. `landed_count[landerPath=/ai-eval]`.
 * Restricts the count to events whose `dimensions[dimensionKey]` equals
 * `dimensionValue`. Without it, `landed_count` counts landings across every
 * page that fires the event — comparing that to a single-page numerator
 * produces a meaningless ratio (this is exactly what made `capture-broken`
 * a permanent false alarm). */
export interface EventFilter {
  dimensionKey: string;
  dimensionValue: string;
}

export type ParsedCondition =
  | {
      kind: 'count';
      eventType: string;
      filter?: EventFilter;
      op: Operator;
      threshold: number;
      windowDays?: number;
    }
  | {
      kind: 'ratio';
      numeratorType: string;
      numeratorFilter?: EventFilter;
      denominatorType: string;
      denominatorFilter?: EventFilter;
      op: Operator;
      threshold: number;
      windowDays?: number;
    }
  | {
      kind: 'coincidence';
      presentEventType: string;
      absentEventType: string;
      withinHours: number;
    };

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

// Optional `[dimensionKey=dimensionValue]` filter immediately after `_count`.
// The value may contain anything except `]` (so pathnames like `/ai-eval` work).
const FILTER = String.raw`(?:\[([a-z_][a-z0-9_]*)=([^\]]+)\])?`;
const COUNT_PATTERN = new RegExp(
  String.raw`^([a-z_][a-z0-9_]*)_count` + FILTER + String.raw`\s*(<=|>=|!=|<|>|=)\s*(-?\d+(?:\.\d+)?)(?:\s+over\s+(\d+)d)?$`,
  'i',
);
const RATIO_PATTERN = new RegExp(
  String.raw`^([a-z_][a-z0-9_]*)_count` +
    FILTER +
    String.raw`\s*\/\s*([a-z_][a-z0-9_]*)_count` +
    FILTER +
    String.raw`\s*(<=|>=|!=|<|>|=)\s*(-?\d+(?:\.\d+)?)(?:\s+over\s+(\d+)d)?$`,
  'i',
);
const COINCIDENCE_PATTERN = /^([a-z_][a-z0-9_]*)\s+but\s+no\s+([a-z_][a-z0-9_]*)\s+within\s+(\d+)h$/i;

/** Build an EventFilter from the optional `[key=value]` capture groups. */
function toFilter(key: string | undefined, value: string | undefined): EventFilter | undefined {
  if (!key || value === undefined) return undefined;
  return { dimensionKey: key, dimensionValue: value.trim() };
}

export class ConditionParseError extends Error {
  constructor(public readonly condition: string, public readonly reason: string) {
    super(`[loops/policy] Failed to parse condition "${condition}": ${reason}`);
    this.name = 'ConditionParseError';
  }
}

/** Parse a condition string into a `ParsedCondition`. Throws if the string
 * doesn't match any supported pattern. */
export function parseCondition(condition: string): ParsedCondition {
  const trimmed = condition.trim();
  if (!trimmed) {
    throw new ConditionParseError(condition, 'empty');
  }

  // Try ratio first (more specific than count).
  const ratioMatch = RATIO_PATTERN.exec(trimmed);
  if (ratioMatch) {
    const [, num, numFk, numFv, den, denFk, denFv, op, threshold, windowDays] = ratioMatch;
    const numeratorFilter = toFilter(numFk, numFv);
    const denominatorFilter = toFilter(denFk, denFv);
    return {
      kind: 'ratio',
      numeratorType: num,
      ...(numeratorFilter ? { numeratorFilter } : {}),
      denominatorType: den,
      ...(denominatorFilter ? { denominatorFilter } : {}),
      op: op as Operator,
      threshold: Number(threshold),
      windowDays: windowDays ? Number(windowDays) : undefined,
    };
  }

  const countMatch = COUNT_PATTERN.exec(trimmed);
  if (countMatch) {
    const [, eventType, fk, fv, op, threshold, windowDays] = countMatch;
    const filter = toFilter(fk, fv);
    return {
      kind: 'count',
      eventType,
      ...(filter ? { filter } : {}),
      op: op as Operator,
      threshold: Number(threshold),
      windowDays: windowDays ? Number(windowDays) : undefined,
    };
  }

  const coincidenceMatch = COINCIDENCE_PATTERN.exec(trimmed);
  if (coincidenceMatch) {
    const [, present, absent, withinHours] = coincidenceMatch;
    return {
      kind: 'coincidence',
      presentEventType: present,
      absentEventType: absent,
      withinHours: Number(withinHours),
    };
  }

  throw new ConditionParseError(condition, 'no matching pattern');
}

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

/** Apply a comparison operator. */
export function applyOp(left: number, op: Operator, right: number): boolean {
  switch (op) {
    case '<':
      return left < right;
    case '>':
      return left > right;
    case '<=':
      return left <= right;
    case '>=':
      return left >= right;
    case '=':
      return left === right;
    case '!=':
      return left !== right;
  }
}

/** Count events of a given type within the window, optionally restricted to
 * events matching a single dimension key/value. */
function countByType(
  events: readonly NormalizedEvent[],
  eventType: string,
  filter?: EventFilter,
): number {
  let n = 0;
  for (const e of events) {
    if (e.eventType !== eventType) continue;
    if (filter) {
      const v = e.dimensions?.[filter.dimensionKey];
      if (v === undefined || v === null || String(v) !== filter.dimensionValue) continue;
    }
    n++;
  }
  return n;
}

/** Group events by subjectId for coincidence detection. */
function eventsBySubject(events: readonly NormalizedEvent[]): Map<string, NormalizedEvent[]> {
  const map = new Map<string, NormalizedEvent[]>();
  for (const e of events) {
    const arr = map.get(e.subjectId) ?? [];
    arr.push(e);
    map.set(e.subjectId, arr);
  }
  return map;
}

/** Evaluate a parsed condition against an event window. */
export function evaluateParsed(
  parsed: ParsedCondition,
  events: readonly NormalizedEvent[],
  _window: TimeWindow,
): boolean {
  switch (parsed.kind) {
    case 'count': {
      const n = countByType(events, parsed.eventType, parsed.filter);
      return applyOp(n, parsed.op, parsed.threshold);
    }
    case 'ratio': {
      const num = countByType(events, parsed.numeratorType, parsed.numeratorFilter);
      const den = countByType(events, parsed.denominatorType, parsed.denominatorFilter);
      if (den === 0) {
        // Convention: when the denominator is 0 we don't fire any ratio
        // rule — there's no signal to interpret. "form_submitted / landed
        // < 0.1" should NOT fire when there are no landings at all; the
        // volume-anemic rule (top-of-funnel-cold) handles that case
        // separately by checking landed_count directly.
        return false;
      }
      return applyOp(num / den, parsed.op, parsed.threshold);
    }
    case 'coincidence': {
      const bySubject = eventsBySubject(events);
      const withinMs = parsed.withinHours * 60 * 60 * 1000;
      let coincidenceCount = 0;
      for (const subjectEvents of bySubject.values()) {
        const present = subjectEvents.find((e) => e.eventType === parsed.presentEventType);
        if (!present) continue;
        const absentInWindow = subjectEvents.find(
          (e) =>
            e.eventType === parsed.absentEventType &&
            e.ts.getTime() >= present.ts.getTime() &&
            e.ts.getTime() <= present.ts.getTime() + withinMs,
        );
        if (!absentInWindow) coincidenceCount++;
      }
      // Fires when AT LEAST ONE subject has the coincidence.
      return coincidenceCount > 0;
    }
  }
}

/** Top-level: parse + evaluate in one call. Convenient for tests and for the
 * orchestrator's per-rule loop. */
export function evaluate(condition: string, events: readonly NormalizedEvent[], window: TimeWindow): boolean {
  return evaluateParsed(parseCondition(condition), events, window);
}
