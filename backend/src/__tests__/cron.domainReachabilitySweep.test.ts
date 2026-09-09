/**
 * ENG-1839 — scoping rule for the reachability sweep.
 *
 * Scope is a signal-quality decision, not a cost one. A domain whose page is not deployed will
 * fail a probe, and that failure is EXPECTED; a monitor that reports expected failures gets
 * tuned out, which is the same way the original bug survived — everything read healthy, so
 * nobody looked. Inverting that to "everything reads unhealthy" fails identically.
 */
import { selectDomainsToProbe } from "../cron/domainReachabilityCron";

const dom = (id: string, domain: string) => ({ id, domain, vercelProjectId: "p" });

describe("selectDomainsToProbe", () => {
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

  it("tolerates missing and malformed page URLs without throwing", () => {
    const domains = [dom("d1", "live.agentwebforms.com")];
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
