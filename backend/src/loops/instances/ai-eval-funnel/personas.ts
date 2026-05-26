/**
 * Three scripted personas per ACCEPTANCE_SPEC.md:
 *   1. Early-Dipper      — lands, doesn't submit, leaves
 *   2. Completer         — finishes the full funnel
 *   3. Complainer/Timeout — eval fails OR exceeds patience OR complaint received
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
  return [mk(id, 'landed', baseOffsetMinutesAgo)];
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
    mk(id, 'landed', baseOffsetMinutesAgo),
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
// Persona 3 — Complainer / Timeout. Three variants per spec.
// ---------------------------------------------------------------------------

/** Variant A: the eval fails with a concrete LLM-side error. */
export function evalFailureEvents(idx: number, baseOffsetMinutesAgo = 30): NormalizedEvent[] {
  const id = `failure-${idx}`;
  return [
    mk(id, 'landed', baseOffsetMinutesAgo),
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
    mk(id, 'landed', baseOffsetMinutesAgo),
    mk(id, 'form_submitted', baseOffsetMinutesAgo - 1),
    mk(id, 'eval_started', baseOffsetMinutesAgo - 1),
    mk(id, 'eval_abandoned', baseOffsetMinutesAgo - 4, {
      elapsedMs: 180_000,
      lastPollStatus: 'AI is generating your report...',
    }),
  ];
}

/** Variant C: the user completes but then files a complaint downstream. */
export function complaintEvents(idx: number, baseOffsetMinutesAgo = 50): NormalizedEvent[] {
  const id = `complaint-${idx}`;
  return [
    mk(id, 'landed', baseOffsetMinutesAgo),
    mk(id, 'form_submitted', baseOffsetMinutesAgo - 1),
    mk(id, 'eval_started', baseOffsetMinutesAgo - 1),
    mk(id, 'eval_completed', baseOffsetMinutesAgo - 3),
    mk(id, 'report_viewed', baseOffsetMinutesAgo - 4),
    mk(id, 'complaint_received', baseOffsetMinutesAgo - 30, {
      complaintText:
        "The eval said my brand was 'generic' but didn't say what specifically to change. I was hoping for actionable advice.",
      complaintChannel: 'email',
    }),
  ];
}

// ---------------------------------------------------------------------------
// Composite scenarios — 3+ instances of each persona type, enough to fire
// the relevant rules per the ACCEPTANCE_SPEC.
//
// Tuning notes (so a reviewer doesn't have to redo this math):
//   landed_count = 100 dippers + 2 completers + 4 failures + 3 timeouts + 2 complaints
//                = 111 landed events
//   form_submitted_count = 2 + 4 + 3 + 2 = 11 (dippers don't submit)
//   capture-broken: 11/111 = 0.099 < 0.1  → fires ✓
//   top-of-funnel-cold: landed_count (111) < 100  → does NOT fire (intentional —
//     we want exactly one rule per friction class, not extra duplicates)
//   eval-failing: 4 failed / (4 + 3 + 2 + 2) started = 4/11 = 0.36 > 0.2 → fires ✓
//   wait-too-long: 3 abandoned > 0 → fires ✓
//   complaint-received: 2 > 0 → fires ✓
//   no-signup: 2 signup_clicked / (2 + 2) eval_completed = 2/4 = 0.5 → does NOT fire ✓
//   sign-then-bail: 2 signed_up, both started onboarding → does NOT fire ✓
// ---------------------------------------------------------------------------

/** Default smoke scenario: produces enough events to fire `capture-broken`,
 * `eval-failing`, `wait-too-long`, and `complaint-received`. */
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

  // 2 complaints.
  for (let i = 0; i < 2; i++) events.push(...complaintEvents(i, 900 + i * 30));

  return events;
}

/** Completer-only scenario — asserts NO friction rules fire when the funnel
 * is healthy. */
export function completerOnlyEvents(): NormalizedEvent[] {
  const events: NormalizedEvent[] = [];
  for (let i = 0; i < 200; i++) events.push(...completerEvents(i, 20 + i * 2));
  return events;
}
