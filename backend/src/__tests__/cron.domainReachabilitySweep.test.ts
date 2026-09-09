/**
 * ENG-1839 — scoping rule for the reachability sweep.
 *
 * Scope is a signal-quality decision, not a cost one. A domain whose page is not deployed will
 * fail a probe, and that failure is EXPECTED; a monitor that reports expected failures gets
 * tuned out, which is the same way the original bug survived — everything read healthy, so
 * nobody looked. Inverting that to "everything reads unhealthy" fails identically.
 */
import { selectDomainsToProbe } from "../cron/domainReachabilityCron";

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
