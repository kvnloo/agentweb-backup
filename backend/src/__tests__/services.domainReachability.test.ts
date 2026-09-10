/**
 * ENG-1839 — the believe/don't-believe policy for domain reachability.
 *
 * This is the part that decides whether a customer is shown "this page may not be reachable",
 * so it is pinned away from the network. The first attempt at this feature was reverted for
 * getting exactly these judgements wrong: it checked configuration rather than reachability
 * (so it reported all three genuinely-broken domains healthy), and it persisted a failure on
 * any thrown error (so a Vercel 429 would have shown a customer a false, wrongly-worded
 * warning).
 */
import {
  decideFromVerdict,
  probeDomain,
  verdictForCode,
  UNREACHABLE_CONFIRMATIONS,
  type ReachabilityVerdict,
} from "../services/domainReachabilityService";

const reachable: ReachabilityVerdict = { state: "reachable", httpStatus: 200 };
const suspect: ReachabilityVerdict = {
  state: "suspect",
  reason: "The connection closed during the SSL handshake — the site has no usable certificate.",
  code: "ECONNRESET",
};
const definitive: ReachabilityVerdict = {
  state: "unreachable",
  definitive: true,
  reason: "The SSL certificate does not cover this domain.",
  code: "ERR_TLS_CERT_ALTNAME_INVALID",
};

describe("decideFromVerdict — a single blip must not reach the customer", () => {
  it("writes NOTHING to status on a first ambiguous failure", () => {
    // ECONNRESET is what our real broken domain returns AND what a transient network fault
    // returns. Acting on the first one is how the reverted attempt would have shown false
    // warnings during a Vercel incident.
    const d = decideFromVerdict(suspect, 0);
    expect(d.nextStatus).toBeNull();
    expect(d.consecutiveFailures).toBe(1);
    expect(d.shouldPersist).toBe(true); // the count and check-time still get recorded
  });

  it("still writes nothing one probe below the threshold", () => {
    expect(decideFromVerdict(suspect, UNREACHABLE_CONFIRMATIONS - 2).nextStatus).toBeNull();
  });

  it("believes it once the failure has repeated to the threshold", () => {
    const d = decideFromVerdict(suspect, UNREACHABLE_CONFIRMATIONS - 1);
    expect(d.nextStatus).toBe("error");
    expect(d.errorMessage).toMatch(/SSL handshake/i);
  });

  it("clears the slate on any success, so a recovered domain stops warning", () => {
    const d = decideFromVerdict(reachable, UNREACHABLE_CONFIRMATIONS + 5);
    expect(d.nextStatus).toBe("active");
    expect(d.consecutiveFailures).toBe(0);
  });

  it("acts immediately on a failure that cannot be transient", () => {
    // A name that does not resolve is not a blip; waiting for repetition would only delay a
    // certain answer.
    const d = decideFromVerdict(definitive, 0);
    expect(d.nextStatus).toBe("error");
    expect(d.errorMessage).toMatch(/certificate does not cover/i);
  });
});

/*
 * ENG-1839. The SUSPECT/DEFINITIVE split is a safety boundary, and the test for membership is
 * NOT "how conclusive does this error sound" but "could OUR OWN infrastructure manufacture it?"
 *
 * `decideFromVerdict` commits an `unreachable` verdict BEFORE consulting the threshold, so a
 * definitive code fires on the first probe. Any code a prober-side fault can produce therefore
 * has fleet-wide blast radius: one sweep under a TLS-intercepting proxy, a broken CA trust
 * store, or forward clock skew would tell every customer in the product that their own site's
 * certificate is untrusted — text that blames them for our fault.
 *
 * Nothing pinned this before, so moving a code between the two tables was a silent change.
 */
describe("SUSPECT vs DEFINITIVE — only remote-caused failures may be definitive", () => {
  const proberFaultCodes = [
    ["CERT_HAS_EXPIRED", "forward clock skew expires every certificate at once"],
    ["DEPTH_ZERO_SELF_SIGNED_CERT", "a TLS-intercepting egress proxy"],
    ["SELF_SIGNED_CERT_IN_CHAIN", "a TLS-intercepting egress proxy"],
    ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "a missing or broken CA trust store"],
    ["ENOTFOUND", "an egress DNS outage"],
    ["ECONNRESET", "any transient network fault"],
    ["ETIMEDOUT", "a NAT or routing failure"],
    ["EAI_AGAIN", "an egress DNS outage"],
  ] as const;

  it.each(proberFaultCodes)(
    "%s is SUSPECT — reproducible by %s",
    (code) => {
      const verdict = verdictForCode(code);
      expect(verdict.state).toBe("suspect");
      // Must survive two rounds without telling the customer anything.
      expect(decideFromVerdict(verdict, 0).nextStatus).toBeNull();
      expect(decideFromVerdict(verdict, 1).nextStatus).toBeNull();
    }
  );

  it("a hostname mismatch stays DEFINITIVE — our side cannot fabricate it", () => {
    /*
     * The one code that survives the test. A mismatch is a statement about what the REMOTE
     * certificate contains: our clock cannot forge it, our trust store cannot forge it, and an
     * intercepting proxy mints a certificate FOR the requested hostname, so interception
     * surfaces as a trust-chain failure rather than this.
     */
    const verdict = verdictForCode("ERR_TLS_CERT_ALTNAME_INVALID");
    expect(verdict.state).toBe("unreachable");
    expect(decideFromVerdict(verdict, 0).nextStatus).toBe("error");
  });
});

describe("probeDomain — classification", () => {
  it("treats a name that cannot resolve as SUSPECT, not definitive", async () => {
    // ENOTFOUND must go through the threshold: a domain attached moments ago has not
    // propagated yet, and flipping it to unreachable on the first probe is exactly the false
    // positive the threshold exists to prevent.
    const v = await probeDomain("this-host-does-not-exist.agentwebforms.invalid", 5000);
    expect(v.state).toBe("suspect");
    expect(decideFromVerdict(v, 0).nextStatus).toBeNull();
  }, 15000);

  it("never throws — every outcome is a verdict", async () => {
    await expect(probeDomain("this-host-does-not-exist.invalid", 3000)).resolves.toBeDefined();
  }, 15000);

  it("returns a verdict rather than hanging when a host does not answer", async () => {
    // 203.0.113.0/24 is TEST-NET-3 (RFC 5737) — reserved, never routed, so this exercises the
    // timeout path without depending on any real host being down.
    const v = await probeDomain("203.0.113.1", 2000);
    expect(["suspect", "unreachable"]).toContain(v.state);
  }, 15000);
});
