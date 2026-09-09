/**
 * ENG-1839 — is a managed domain actually reachable by a browser?
 *
 * Why this exists, and why the obvious approach was wrong:
 *
 * `verifyDomain` answers a CONFIGURATION question — is ownership verified, and does DNS point
 * at Vercel. Both were true for all three domains that shipped unreachable: DNS resolved
 * correctly to cname.vercel-dns.com, ownership is inherent for our own apex, and only the
 * certificate failed. A configuration check therefore reports those pages healthy, which is
 * why a first attempt at surfacing this was reverted — a warning system whose silence means
 * "not actually checked" is worse than none, because silence gets read as verified.
 *
 * This asks the REACHABILITY question instead: attempt the request a visitor would make, and
 * classify what comes back.
 *
 * ## Why failures are counted rather than acted on immediately
 *
 * Measured against the real broken domain, the failure surfaces as ECONNRESET
 * ("Client network socket disconnected before secure TLS connect"). That code is ambiguous —
 * a transient network blip produces exactly the same one. So:
 *
 *   - treating it as definitive would let one blip persist a false "unreachable" and show a
 *     customer a wrong reason;
 *   - treating it as inconclusive and never persisting would never catch the real bug.
 *
 * Ambiguous failures are therefore counted, and only a run of them is believed. A single
 * success resets the count. Definitive failures (DNS has no such name, an actual certificate
 * error) need no repetition — they cannot be transient.
 */
import https from "https";

/** Consecutive ambiguous failures before a domain is believed unreachable. */
export const UNREACHABLE_CONFIRMATIONS = 3;
/** Per-probe timeout. A hung socket must not accumulate. */
export const PROBE_TIMEOUT_MS = 8000;

export type ReachabilityVerdict =
  | { state: "reachable"; httpStatus: number }
  /** Cannot be transient — act on the first occurrence. */
  | { state: "unreachable"; definitive: true; reason: string; code: string }
  /** Could be transient — only believed after UNREACHABLE_CONFIRMATIONS in a row. */
  | { state: "suspect"; reason: string; code: string };

/**
 * Node error codes that cannot plausibly be a passing blip.
 *
 * ECONNRESET is deliberately ABSENT: it is what our real failure produces AND what a transient
 * network fault produces, so it is classified `suspect` and must repeat to be believed.
 */
const DEFINITIVE: Record<string, string> = {
  ENOTFOUND: "The domain does not resolve in DNS.",
  ERR_TLS_CERT_ALTNAME_INVALID: "The SSL certificate does not cover this domain.",
  CERT_HAS_EXPIRED: "The SSL certificate has expired.",
  DEPTH_ZERO_SELF_SIGNED_CERT: "The SSL certificate is not trusted.",
  SELF_SIGNED_CERT_IN_CHAIN: "The SSL certificate is not trusted.",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "The SSL certificate could not be verified.",
};

const SUSPECT: Record<string, string> = {
  ECONNRESET:
    "The connection closed during the SSL handshake — the site has no usable certificate.",
  EPROTO: "The SSL handshake failed.",
  ECONNREFUSED: "The server refused the connection.",
  ETIMEDOUT: "The server did not respond.",
  TIMEOUT: "The server did not respond.",
  EAI_AGAIN: "DNS lookup failed temporarily.",
};

/**
 * Probe one domain. Never throws — every outcome is a verdict.
 *
 * HEAD, not GET: reachability is about whether the connection and certificate work, and a HEAD
 * avoids pulling a full page body from a customer's site on every sweep.
 */
export function probeDomain(
  domain: string,
  timeoutMs: number = PROBE_TIMEOUT_MS
): Promise<ReachabilityVerdict> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: ReachabilityVerdict) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };

    const req = https.request(
      { host: domain, path: "/", method: "HEAD", timeout: timeoutMs },
      (res) => {
        const status = res.statusCode ?? 0;
        res.resume(); // drain so the socket can be released
        // Any HTTP answer at all means TLS completed and the site is serving. A 404 is a
        // routing question, not a reachability one, and is not this check's business.
        done(
          status > 0 && status < 500
            ? { state: "reachable", httpStatus: status }
            : {
                state: "suspect",
                reason: `The server returned HTTP ${status}.`,
                code: `HTTP_${status}`,
              }
        );
      }
    );

    req.on("timeout", () => {
      req.destroy();
      done({ state: "suspect", reason: SUSPECT.TIMEOUT, code: "TIMEOUT" });
    });

    req.on("error", (err: NodeJS.ErrnoException) => {
      const code = err.code ?? "UNKNOWN";
      if (DEFINITIVE[code]) {
        done({ state: "unreachable", definitive: true, reason: DEFINITIVE[code], code });
        return;
      }
      done({
        state: "suspect",
        reason: SUSPECT[code] ?? "The site could not be reached.",
        code,
      });
    });

    req.end();
  });
}

export interface ReachabilityDecision {
  /** What to persist as `status`, or null to leave the stored status untouched. */
  nextStatus: "active" | "error" | null;
  /** Human-readable cause, when unhealthy. */
  errorMessage?: string;
  /** Running count of consecutive non-reachable probes. */
  consecutiveFailures: number;
  /** Whether the caller should write at all (the check time is always worth stamping). */
  shouldPersist: boolean;
}

/**
 * Turn one probe into a persistence decision, given how many times this domain has failed in a
 * row already.
 *
 * Pure and exported so the believe/don't-believe policy — the part that decides whether a
 * customer sees a warning — is testable without network access.
 */
export function decideFromVerdict(
  verdict: ReachabilityVerdict,
  priorConsecutiveFailures: number,
  threshold: number = UNREACHABLE_CONFIRMATIONS
): ReachabilityDecision {
  if (verdict.state === "reachable") {
    // A success clears the slate: a domain that serves is healthy regardless of past blips.
    return { nextStatus: "active", consecutiveFailures: 0, shouldPersist: true };
  }

  if (verdict.state === "unreachable") {
    return {
      nextStatus: "error",
      errorMessage: verdict.reason,
      consecutiveFailures: priorConsecutiveFailures + 1,
      shouldPersist: true,
    };
  }

  // Suspect: count it, but do not tell the customer anything until it has repeated. Persisting
  // the count (and not the status) is what makes a single blip harmless while a genuine,
  // sustained failure still surfaces.
  const consecutiveFailures = priorConsecutiveFailures + 1;
  if (consecutiveFailures >= threshold) {
    return {
      nextStatus: "error",
      errorMessage: verdict.reason,
      consecutiveFailures,
      shouldPersist: true,
    };
  }
  return { nextStatus: null, consecutiveFailures, shouldPersist: true };
}
