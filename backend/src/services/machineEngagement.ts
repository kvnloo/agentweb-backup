/**
 * ENG-2524 / ENG-2565 (children of ENG-325): observability tripwire for machine-generated
 * engagement.
 *
 * Corporate link scanners (Safe Links, Proofpoint, Mimecast) click within seconds of
 * delivery. We do NOT suppress those exits — the parent forbids an uncalibrated filter —
 * we only flag them so a human can see when it starts happening. User-agent is
 * deliberately not an input: Gmail's GoogleImageProxy represents a real human open.
 */

/**
 * ENG-325's sampled prod data: the fastest observed human click was 18.7s after send.
 * 5s leaves a wide margin below that while still catching on-delivery scanner clicks.
 */
export const SUSPECTED_MACHINE_GAP_MS = 5_000;

export function isSuspectedMachineEngagement(eventType: string, gapFromSendMs: number | null): boolean {
  if (eventType !== 'email.opened' && eventType !== 'email.clicked') return false;
  if (gapFromSendMs === null || !Number.isFinite(gapFromSendMs)) return false;
  return gapFromSendMs >= 0 && gapFromSendMs < SUSPECTED_MACHINE_GAP_MS;
}

/**
 * Parse a Resend send timestamp. Resend emits `YYYY-MM-DD HH:MM:SS.ffffff+00`, which
 * `Date` does not reliably accept (space separator, microseconds, `+00` offset).
 * Returns epoch ms, or null when missing/unparseable — never throws.
 */
export function parseResendTimestamp(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  let s = String(value).trim().replace(' ', 'T');
  // Trim fractional seconds to milliseconds.
  s = s.replace(/(\.\d{3})\d+/, '$1');
  // `+00` / `-07` → `+00:00` / `-07:00`.
  s = s.replace(/([+-]\d{2})$/, '$1:00');
  const ms = new Date(s).getTime();
  return Number.isFinite(ms) ? ms : null;
}
