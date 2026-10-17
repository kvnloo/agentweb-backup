/**
 * ENG-2524 (child of ENG-325): observability tripwire for machine-generated engagement.
 *
 * Corporate link scanners (Safe Links, Proofpoint, Mimecast) click within seconds of
 * delivery. We do NOT suppress those exits — the parent forbids an uncalibrated filter —
 * we only flag them so a human can see when it starts happening. User-agent is
 * deliberately not an input: Gmail's GoogleImageProxy represents a real human open.
 */
export const SUSPECTED_MACHINE_GAP_MS = 2_000;

export function isSuspectedMachineEngagement(eventType: string, gapFromSendMs: number | null): boolean {
  if (eventType !== 'email.opened' && eventType !== 'email.clicked') return false;
  if (gapFromSendMs === null || !Number.isFinite(gapFromSendMs)) return false;
  return gapFromSendMs >= 0 && gapFromSendMs < SUSPECTED_MACHINE_GAP_MS;
}
