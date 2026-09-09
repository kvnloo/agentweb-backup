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
