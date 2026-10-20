/**
 * ENG-2562 (child of ENG-2167): pure drip sequence schedule preview.
 *
 * Projects when each step of a sequence will actually go out for one recipient.
 * Step N is due at step N-1's actual send time + its delayMinutes (step 0 is
 * relative to enrolledAt). When a send window is supplied, each due time is
 * snapped forward with nextAllowedSendAt. No I/O, no clock reads, no wiring.
 */

import { nextAllowedSendAt, type SendWindow, type SendWindowErrorCode } from './dripSendWindow';

export interface PreviewStepInput {
  delayMinutes: number;
}

export interface PreviewSequenceScheduleInput {
  enrolledAt: Date;
  steps: readonly PreviewStepInput[];
  window?: SendWindow | null;
  recipientTimezone?: string | null;
  fallbackTimezone: string;
}

export interface PreviewStep {
  stepIndex: number;
  dueAt: Date;
  sendAt: Date;
  deferredMinutes: number;
}

export type PreviewErrorCode = 'invalid_enrolled_at' | 'invalid_delay' | SendWindowErrorCode;

export type PreviewSequenceScheduleResult =
  | { ok: true; steps: PreviewStep[]; timezone: string | null; usedFallback: boolean }
  | { ok: false; error: { code: PreviewErrorCode; message: string; stepIndex?: number } };

const MINUTE_MS = 60_000;

export function previewSequenceSchedule(input: PreviewSequenceScheduleInput): PreviewSequenceScheduleResult {
  const { enrolledAt, steps, window, recipientTimezone, fallbackTimezone } = input;
  if (!(enrolledAt instanceof Date) || Number.isNaN(enrolledAt.getTime())) {
    return { ok: false, error: { code: 'invalid_enrolled_at', message: 'enrolledAt must be a valid Date' } };
  }

  const out: PreviewStep[] = [];
  let anchor = enrolledAt.getTime();
  let timezone: string | null = null;
  let usedFallback = false;

  for (let i = 0; i < steps.length; i++) {
    const delay = steps[i]?.delayMinutes;
    if (typeof delay !== 'number' || !Number.isInteger(delay) || delay < 0) {
      return {
        ok: false,
        error: { code: 'invalid_delay', message: `delayMinutes must be a non-negative integer (got ${String(delay)})`, stepIndex: i },
      };
    }
    const dueAt = new Date(anchor + delay * MINUTE_MS);
    let sendAt = dueAt;
    if (window) {
      const snapped = nextAllowedSendAt({ dueAt, recipientTimezone, window, fallbackTimezone });
      if (!snapped.ok) {
        return { ok: false, error: { ...snapped.error, stepIndex: i } };
      }
      sendAt = snapped.sendAt;
      timezone = snapped.timezone;
      usedFallback = snapped.usedFallback;
    }
    out.push({
      stepIndex: i,
      dueAt,
      sendAt,
      deferredMinutes: Math.round((sendAt.getTime() - dueAt.getTime()) / MINUTE_MS),
    });
    anchor = sendAt.getTime();
  }

  return { ok: true, steps: out, timezone, usedFallback };
}
