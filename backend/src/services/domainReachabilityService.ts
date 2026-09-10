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

/**
 * Consecutive ambiguous failures before a domain is believed unreachable.
 *
 * TWO, paired with the daily sweep cadence — so a domain is reported after roughly two days of
 * continuous failure. It was three while the sweep ran hourly, where three strikes bought only
 * three hours of evidence and a single bad afternoon could produce them.
 *
 * Consecutive DAILY failures are much stronger evidence than consecutive hourly ones: two
 * probes a full day apart cannot both be caught by the same transient incident, so a lower
 * count buys more confidence here, not less. Raising it to three would only add a day of a
 * customer staring at a page that does not load.
 *
 * The output is a passive banner in the customer's portal, not an alert — nothing pages anyone
 * — so the cost of being a day late is a day of silence, and the cost of being wrong is a
 * customer told their working site is broken. Two balances those.
 */
export const UNREACHABLE_CONFIRMATIONS = 2;
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
  // ENOTFOUND is deliberately NOT here. A domain attached moments ago has not propagated yet,
  // and flipping it to unreachable on the first probe is precisely the false positive the
  // threshold exists to prevent. It goes through SUSPECT like any other transient condition.
  //
  // Only ONE code qualifies as definitive, and the test is not "how sure does this sound" but
  // "could OUR side manufacture it?" A hostname mismatch is a statement about what the remote
  // certificate CONTAINS. Our clock cannot fabricate it, our trust store cannot fabricate it,
  // and an intercepting proxy would not — a proxy mints a certificate FOR the hostname it was
  // asked for, so interception shows up as a trust-chain failure, not an altname failure.
  ERR_TLS_CERT_ALTNAME_INVALID: "The SSL certificate does not cover this domain.",
};

const SUSPECT: Record<string, string> = {
  ENOTFOUND: "The domain does not resolve in DNS.",
  /*
   * Certificate TRUST and VALIDITY failures live here, not in DEFINITIVE, because every one of
   * them is producible by a fault on OUR side and is indistinguishable from the remote cause at
   * the socket:
   *
   *   DEPTH_ZERO_SELF_SIGNED_CERT    ← a TLS-intercepting egress proxy
   *   SELF_SIGNED_CERT_IN_CHAIN      ← the same
   *   UNABLE_TO_VERIFY_LEAF_SIGNATURE ← a missing or broken CA trust store
   *                                    (NODE_EXTRA_CA_CERTS, a ca-certificates regression)
   *
   * They were DEFINITIVE, and `decideFromVerdict` commits an `unreachable` verdict BEFORE
   * consulting the threshold — so a single sweep under any of those faults would have told
   * every customer in the product that their own site's certificate is untrusted. A monitor
   * that cries wolf gets tuned out, which is the same way the bug this service exists to catch
   * survived unnoticed in the first place.
   *
   * The cost is real and accepted: these failures now take UNREACHABLE_CONFIRMATIONS daily
   * rounds to report rather than one probe. Against pages that sat broken for months — and
   * against the alternative, which is accusing every customer at once when the fault is ours —
   * that is not the expensive direction to be wrong in.
   */
  /*
   * CERT_HAS_EXPIRED belongs HERE, not in DEFINITIVE, and the reason is not the one that
   * first suggests itself.
   *
   * The clock-skew objection is genuinely dead: the sweep scans DynamoDB before probing, on an
   * aws-sdk v2 client with `correctClockSkew` unset (default false), and SigV4 rejects a
   * request >5 minutes off — so a prober skewed by days throws on the scan and never probes.
   * That argument is sound, and it is also beside the point.
   *
   * The real reason is that this code is not a statement about the CUSTOMER's certificate.
   * OpenSSL reports error 10 for ANY expired certificate in the built chain, at any depth.
   * Verified locally: a leaf valid for another year, chained to a root that has expired,
   * yields `error 10 at 1 depth lookup: certificate has expired`. So an expired root in Node's
   * bundled store, in the OS ca-certificates package, or in an egress proxy's CA makes EVERY
   * domain report expiry at once — with a correct clock. That is the DST Root CA X3 shape from
   * 2021: valid leaves, browsers fine, OpenSSL saying expired.
   *
   * Which means it fails this module's own membership test — our trust store CAN manufacture
   * it — and it is the same mechanism that keeps the three codes below suspect. It was briefly
   * promoted to DEFINITIVE to cut reporting latency; that traded a bounded delay for a
   * fleet-wide false accusation, which is the wrong direction.
   *
   * Distinguishing leaf expiry from chain expiry is possible but not free: on this error Node
   * populates only `err.code` — no `err.cert` — so it needs `rejectUnauthorized: false` plus
   * `socket.getPeerCertificate(true)` and our own validity comparison. Worth doing; not worth
   * bundling into this change.
   */
  CERT_HAS_EXPIRED: "The SSL certificate has expired.",
  DEPTH_ZERO_SELF_SIGNED_CERT: "The SSL certificate is not trusted.",
  SELF_SIGNED_CERT_IN_CHAIN: "The SSL certificate is not trusted.",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "The SSL certificate could not be verified.",
  ECONNRESET:
    "The connection closed during the SSL handshake — the site has no usable certificate.",
  EPROTO: "The SSL handshake failed.",
  ECONNREFUSED: "The server refused the connection.",
  ETIMEDOUT: "The server did not respond.",
  TIMEOUT: "The server did not respond.",
  EAI_AGAIN: "DNS lookup failed temporarily.",
};

/**
 * Which side of the SUSPECT/DEFINITIVE boundary a socket error falls on.
 *
 * Exported so the boundary itself is testable. It is a SAFETY boundary, not a confidence one:
 * `decideFromVerdict` commits an `unreachable` verdict before consulting the confirmation
 * threshold, so anything definitive reaches the customer on the FIRST probe. The membership
 * test is therefore "could our own infrastructure manufacture this code?", never "how
 * conclusive does it sound" — a code we can produce ourselves has fleet-wide blast radius.
 *
 * Unknown codes fall to suspect: an unrecognised failure is not evidence of a broken site.
 */
export function verdictForCode(code: string): ReachabilityVerdict {
  if (DEFINITIVE[code]) {
    return { state: "unreachable", definitive: true, reason: DEFINITIVE[code], code };
  }
  return { state: "suspect", reason: SUSPECT[code] ?? "The site could not be reached.", code };
}

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

    /*
     * Identify ourselves. A header-less HEAD from an unknown IP is exactly the shape a WAF or
     * bot-protection layer is built to refuse, and a 503 from Cloudflare counts as a failed
     * probe here — so an anonymous prober can conclude that a perfectly healthy customer site
     * is unreachable, and say so to its owner. A real User-Agent with a contact URL means an
     * operator seeing this traffic can identify and allow it instead of blocking it.
     */
    const req = https.request(
      {
        host: domain,
        path: "/",
        method: "HEAD",
        timeout: timeoutMs,
        headers: {
          "User-Agent": "AgentWeb-DomainMonitor/1.0 (+https://agentweb.pro; uptime check)",
          Accept: "*/*",
        },
      },
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
      done(verdictForCode(err.code ?? "UNKNOWN"));
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
