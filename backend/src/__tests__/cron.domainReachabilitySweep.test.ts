/**
 * ENG-1839 — scoping rule for the reachability sweep.
 *
 * Scope is a signal-quality decision, not a cost one. A domain whose page is not deployed will
 * fail a probe, and that failure is EXPECTED; a monitor that reports expected failures gets
 * tuned out, which is the same way the original bug survived — everything read healthy, so
 * nobody looked. Inverting that to "everything reads unhealthy" fails identically.
 */
import { selectDomainsToProbe, MIN_RECHECK_INTERVAL_MS } from "../cron/domainReachabilityCron";

const dom = (id: string, domain: string, over: Record<string, any> = {}) =>
  ({ id, domain, vercelProjectId: "p", status: "active", ...over });

describe("selectDomainsToProbe", () => {
  it("skips a custom domain that Vercel has not verified yet", () => {
    // A domain at `pending_verification` has no DNS pointed at it, so it WILL fail a probe —
    // an expected failure. Probing it means a normal domain-setup flow shows "this page may
    // not be reachable" three hours in. Same signal-quality reasoning that excludes
    // not-yet-deployed pages.
    const domains = [dom("d1", "new.acme.io", { type: "custom", status: "pending_verification" })];
    const pages = [{ status: "deployed", customDomainUrl: "https://new.acme.io" }];
    expect(selectDomainsToProbe(domains, pages)).toHaveLength(0);
  });

  it("skips a domain already marked errored by verification", () => {
    const domains = [dom("d1", "bad.acme.io", { status: "error" })];
    const pages = [{ status: "deployed", customDomainUrl: "https://bad.acme.io" }];
    expect(selectDomainsToProbe(domains, pages)).toHaveLength(0);
  });

  it("probes a domain backing a deployed page", () => {
    const domains = [dom("d1", "live.agentwebforms.com")];
    const pages = [{ status: "deployed", customDomainUrl: "https://live.agentwebforms.com" }];
    expect(selectDomainsToProbe(domains, pages).map((d) => d.id)).toEqual(["d1"]);
  });

  it("skips a domain whose page is still building — that failure would be expected", () => {
    const domains = [dom("d1", "building.agentwebforms.com")];
    const pages = [
      { status: "generating", customDomainUrl: "https://building.agentwebforms.com" },
    ];
    expect(selectDomainsToProbe(domains, pages)).toHaveLength(0);
  });

  it("skips an orphan — attached to Vercel but backing no page", () => {
    // One of the three production records is exactly this. It is a real anomaly, but it is an
    // ORPHAN, not an unreachable page; repair-overlong-subdomains.ts is what detects it.
    const domains = [dom("d1", "orphan.agentwebforms.com")];
    const pages = [{ status: "deployed", customDomainUrl: "https://something-else.agentwebforms.com" }];
    expect(selectDomainsToProbe(domains, pages)).toHaveLength(0);
  });

  it("matches by HOST, so a page whose URL carries a path still counts", () => {
    const domains = [dom("d1", "root.agentwebforms.com")];
    const pages = [{ status: "deployed", customDomainUrl: "https://root.agentwebforms.com/pricing" }];
    expect(selectDomainsToProbe(domains, pages).map((d) => d.id)).toEqual(["d1"]);
  });

  it("does not match a page whose long PATH merely resembles the host", () => {
    const domains = [dom("d1", "premium-dark-page.agentwebforms.com")];
    const pages = [
      { status: "deployed", customDomainUrl: "https://short.agentwebforms.com/premium-dark-page" },
    ];
    expect(selectDomainsToProbe(domains, pages)).toHaveLength(0);
  });

  it("probes a domain whose deployed page stores NO url (M1)", () => {
    // assignManagedSubdomain persists the page url in a write separate from creating the
    // domain record, so a failure between the two leaves a deployed page whose only working
    // URL comes from the domain row. Matching solely on stored hosts would leave exactly that
    // legacy/broken population unmonitored — the population most likely to be broken.
    const domains = [dom("d1", "legacy.agentwebforms.com")];
    const pages = [{ status: "deployed", vercelProjectId: "p" }];
    expect(selectDomainsToProbe(domains, pages).map((d) => d.id)).toEqual(["d1"]);
  });

  it("does not probe on project fallback when the page is not deployed", () => {
    const domains = [dom("d1", "legacy.agentwebforms.com")];
    const pages = [{ status: "generating", vercelProjectId: "p" }];
    expect(selectDomainsToProbe(domains, pages)).toHaveLength(0);
  });

  it("tolerates missing and malformed page URLs without throwing", () => {
    const domains = [dom("d1", "live.agentwebforms.com")];
    // No vercelProjectId on the url-less entries, so the M1 project fallback cannot fire and
    // only the host-matching path is under test.
    const pages = [
      { status: "deployed" },
      { status: "deployed", customDomainUrl: "" },
      { status: "deployed", customDomainUrl: "not a url" },
      { status: "deployed", customDomainUrl: "https://live.agentwebforms.com" },
    ];
    expect(selectDomainsToProbe(domains, pages).map((d) => d.id)).toEqual(["d1"]);
  });

  it("probes a domain shared by several deployed pages exactly once", () => {
    const domains = [dom("d1", "shared.agentwebforms.com")];
    const pages = [
      { status: "deployed", customDomainUrl: "https://shared.agentwebforms.com" },
      { status: "deployed", customDomainUrl: "https://shared.agentwebforms.com/b" },
    ];
    expect(selectDomainsToProbe(domains, pages)).toHaveLength(1);
  });
});

/*
 * The period guard. This is what makes the sweep safe to run more than once per period, and it
 * stands in for the coordination a distributed lock would otherwise need — the cron is an
 * in-process interval, so EVERY instance runs its own copy.
 */
describe("selectDomainsToProbe — recheck interval", () => {
  const NOW = Date.parse("2026-09-10T06:15:00.000Z");
  const deployedPages = [{ status: "deployed", customDomainUrl: "https://a.agentwebforms.com" }];
  const at = (msAgo: number) =>
    dom("d1", "a.agentwebforms.com", {
      lastReachabilityCheckAt: new Date(NOW - msAgo).toISOString(),
    });

  it("probes a domain that has never been checked", () => {
    expect(selectDomainsToProbe([dom("d1", "a.agentwebforms.com")], deployedPages, NOW)).toHaveLength(1);
  });

  it("skips a domain already checked this period", () => {
    expect(selectDomainsToProbe([at(60 * 60 * 1000)], deployedPages, NOW)).toHaveLength(0);
  });

  it("probes again once the interval has elapsed", () => {
    expect(selectDomainsToProbe([at(MIN_RECHECK_INTERVAL_MS + 1000)], deployedPages, NOW)).toHaveLength(1);
  });

  it("treats an unparseable timestamp as never checked rather than skipping forever", () => {
    // Failing open matters: skipping on a bad value would silently retire a domain from
    // monitoring with no error anywhere.
    const bad = dom("d1", "a.agentwebforms.com", { lastReachabilityCheckAt: "not-a-date" });
    expect(selectDomainsToProbe([bad], deployedPages, NOW)).toHaveLength(1);
  });

  it("a SECOND instance sweeping minutes later selects nothing", () => {
    /*
     * The multi-instance case, concretely. `consecutiveFailures` is read-then-set, not an
     * atomic ADD, so a second instance running after the first would read the freshly-written
     * count and advance it again — tripping the confirmation threshold on fewer real days of
     * failure than the threshold claims, and telling a customer their site is down early.
     */
    const afterFirstSweep = [at(0)];
    const fiveMinutesLater = NOW + 5 * 60 * 1000;
    expect(selectDomainsToProbe(afterFirstSweep, deployedPages, fiveMinutesLater)).toHaveLength(0);
  });

  it("picks up exactly the remainder when a previous sweep died partway", () => {
    // Self-healing, and the reason this is better than a lease: no lock to expire or leak.
    const domains = [
      at(0),                                                        // stamped before the crash
      dom("d2", "b.agentwebforms.com"),                             // never reached
    ];
    const pages = [
      { status: "deployed", customDomainUrl: "https://a.agentwebforms.com" },
      { status: "deployed", customDomainUrl: "https://b.agentwebforms.com" },
    ];
    expect(selectDomainsToProbe(domains, pages, NOW + 60_000).map((d) => d.id)).toEqual(["d2"]);
  });
});
