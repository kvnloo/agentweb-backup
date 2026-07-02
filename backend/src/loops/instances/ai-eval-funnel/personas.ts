/**
 * Three scripted personas per ACCEPTANCE_SPEC.md:
 *   1. Early-Dipper      — lands, doesn't submit, leaves
 *   2. Completer         — finishes the full funnel
 *   3. Failure/Timeout   — eval fails OR exceeds patience
 *
 * (The old complaint variant was removed 2026-07-02 — its only real-data
 * feeder was a fuzzy LLM satisfaction score, i.e. noise, not a hard complaint.)
 *
 * All event timestamps are computed as `anchor - offset minutes ago` so they
 * fall in the recent past relative to runtime, well inside the orchestrator's
 * default 7-day window. Within a single persona, events are chronologically
 * ordered: the persona's `baseOffsetMinutesAgo` is when the persona's first
 * event happened, and subsequent events happen progressively later (smaller
 * offsetMinutesAgo).
 */

import type { NormalizedEvent } from '../../core/types';
import { asSubjectId } from '../../core/types';

let smokeAnchor: Date | null = null;

/** Override the anchor time. Used by tests that need deterministic timestamps. */
export function setPersonaAnchor(anchor: Date): void {
  smokeAnchor = anchor;
}

function anchorTime(): Date {
  if (smokeAnchor) return smokeAnchor;
  return new Date();
}

function mk(
  subjectId: string,
  eventType: string,
  /** Positive minutes BEFORE the anchor. Smaller = closer to "now". */
  offsetMinutesAgo: number,
  dimensions?: NormalizedEvent['dimensions'],
): NormalizedEvent {
  return {
    subjectId: asSubjectId(subjectId),
    eventType,
    ts: new Date(anchorTime().getTime() - offsetMinutesAgo * 60 * 1000),
    ...(dimensions ? { dimensions } : {}),
  };
}

// ---------------------------------------------------------------------------
// Persona 1 — Early-Dipper. Lands, leaves without submitting.
// ---------------------------------------------------------------------------

export function earlyDipperEvents(idx: number, baseOffsetMinutesAgo = 10): NormalizedEvent[] {
  const id = `dipper-${idx}`;
  return [mk(id, 'landed', baseOffsetMinutesAgo, { landerPath: '/ai-eval' })];
}

// ---------------------------------------------------------------------------
// Persona 2 — Completer. Full funnel including signup + onboarding start.
//
// Within a persona, events progress over ~8 minutes. The persona's base
// (earliest event) is at baseOffsetMinutesAgo; later events are 1..8 minutes
// closer to "now".
// ---------------------------------------------------------------------------

export function completerEvents(idx: number, baseOffsetMinutesAgo = 20): NormalizedEvent[] {
  const id = `completer-${idx}`;
  return [
    mk(id, 'landed', baseOffsetMinutesAgo, { landerPath: '/ai-eval' }),
    mk(id, 'form_submitted', baseOffsetMinutesAgo - 1),
    mk(id, 'eval_started', baseOffsetMinutesAgo - 1),
    mk(id, 'eval_completed', baseOffsetMinutesAgo - 3),
    mk(id, 'report_viewed', baseOffsetMinutesAgo - 4),
    mk(id, 'signup_clicked', baseOffsetMinutesAgo - 6),
    mk(id, 'signed_up', baseOffsetMinutesAgo - 7),
    mk(id, 'onboarding_started', baseOffsetMinutesAgo - 8),
  ];
}

// ---------------------------------------------------------------------------
// Persona 3 — Failure / Timeout. Two variants per spec.
// ---------------------------------------------------------------------------

/** Variant A: the eval fails with a concrete LLM-side error. */
export function evalFailureEvents(idx: number, baseOffsetMinutesAgo = 30): NormalizedEvent[] {
  const id = `failure-${idx}`;
  return [
    mk(id, 'landed', baseOffsetMinutesAgo, { landerPath: '/ai-eval' }),
    mk(id, 'form_submitted', baseOffsetMinutesAgo - 1),
    mk(id, 'eval_started', baseOffsetMinutesAgo - 1),
    mk(id, 'eval_failed', baseOffsetMinutesAgo - 2, {
      errorMessage:
        'Agent stuck on step "Brand Deep-Dive" — Playwright timed out scraping insightful-tech.com after 60s',
      failedStep: 'brand_deep_dive',
    }),
  ];
}

/** Variant B: the user abandons during the polling phase (>120s wait). */
export function timeoutEvents(idx: number, baseOffsetMinutesAgo = 40): NormalizedEvent[] {
  const id = `timeout-${idx}`;
  return [
    mk(id, 'landed', baseOffsetMinutesAgo, { landerPath: '/ai-eval' }),
    mk(id, 'form_submitted', baseOffsetMinutesAgo - 1),
    mk(id, 'eval_started', baseOffsetMinutesAgo - 1),
    mk(id, 'eval_abandoned', baseOffsetMinutesAgo - 4, {
      elapsedMs: 180_000,
      lastPollStatus: 'AI is generating your report...',
    }),
  ];
}

// ---------------------------------------------------------------------------
// Composite scenarios — 3+ instances of each persona type, enough to fire
// the relevant rules per the ACCEPTANCE_SPEC.
//
// Tuning notes (so a reviewer doesn't have to redo this math):
//   All landed events carry dimensions.landerPath='/ai-eval', so the
//   landerPath-scoped rules see the full 109.
//   landed_count[landerPath=/ai-eval] = 100 dippers + 2 completers + 4 failures
//                + 3 timeouts = 109 landed events
//   eval_started_count = 2 + 4 + 3 = 9 (dippers don't submit/start)
//   capture-broken: eval_started_count / landed[/ai-eval] = 9/109 = 0.083 < 0.1  → fires ✓
//   top-of-funnel-cold: landed_count[landerPath=/ai-eval] (109) < 100  → does NOT fire
//     (intentional — one rule per friction class, not extra duplicates)
//   eval-failing: 4 failed / (4 + 3 + 2) started = 4/9 = 0.44 > 0.2 → fires ✓
//   wait-too-long: 3 abandoned > 0 → fires ✓
//   no-signup: 2 signup_clicked / 2 eval_completed = 1.0 → does NOT fire ✓
//   sign-then-bail: 2 signed_up, both started onboarding → does NOT fire ✓
// (complaint-received rule + complaint persona removed 2026-07-02.)
// ---------------------------------------------------------------------------

/** Default smoke scenario: produces enough events to fire `capture-broken`,
 * `eval-failing`, and `wait-too-long`. */
export function defaultSmokeEvents(): NormalizedEvent[] {
  const events: NormalizedEvent[] = [];

  // 100 early-dippers spread across the window (10..510 minutes ago).
  for (let i = 0; i < 100; i++) events.push(...earlyDipperEvents(i, 10 + i * 5));

  // 2 completers (the healthy baseline).
  for (let i = 0; i < 2; i++) events.push(...completerEvents(i, 600 + i * 20));

  // 4 eval failures.
  for (let i = 0; i < 4; i++) events.push(...evalFailureEvents(i, 700 + i * 15));

  // 3 timeouts.
  for (let i = 0; i < 3; i++) events.push(...timeoutEvents(i, 800 + i * 15));

  return events;
}

/** Completer-only scenario — asserts NO friction rules fire when the funnel
 * is healthy. */
export function completerOnlyEvents(): NormalizedEvent[] {
  const events: NormalizedEvent[] = [];
  for (let i = 0; i < 200; i++) events.push(...completerEvents(i, 20 + i * 2));
  return events;
}
