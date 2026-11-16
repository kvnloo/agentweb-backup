/**
 * ENG-2110 PR 3: certificate expiry math shared by the host (its own server certificate, logged at start-up) and the backend (its client
 * certificate, logged on every provider refresh). Both certificates last ~13 months and, the day either expires, every call between the
 * backend and the worker fails as an unexplained "unreachable": so both sides say so well before.
 */
import { X509Certificate } from "crypto";

export const DAY_MS = 24 * 60 * 60 * 1000;
/** Warn when fewer than this many days are left. */
export const CERT_WARN_DAYS = 30;

/** Whole days from `now` to `notAfterMs` (negative once expired). Pure. */
export function daysUntil(notAfterMs: number, now: number): number {
  return Math.floor((notAfterMs - now) / DAY_MS);
}

/** The certificate's notAfter (ms), or undefined if it cannot be parsed. Reads only the public certificate, never a key. */
export function certNotAfterMs(certPem: string | Buffer): number | undefined {
  try {
    const t = new Date(new X509Certificate(certPem).validTo).getTime();
    return Number.isFinite(t) ? t : undefined;
  } catch {
    return undefined;
  }
}
