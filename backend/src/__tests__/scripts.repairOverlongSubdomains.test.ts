/**
 * ENG-1839 — decision logic for the over-length subdomain repair script.
 *
 * The script is data-plane: it attaches and detaches live customer domains. The dangerous
 * decisions are (a) whether a broken record is in use or orphaned, and (b) whether detaching
 * it would trigger removeDomain's page-blanking cascade. Both are pure functions and are
 * pinned here, away from AWS.
 *
 * Fixtures mirror the three records actually found in production on 2026-09-09.
 */
import {
  classifyRecord,
  hostOfUrl,
} from "../scripts/repair-overlong-subdomains";

const PROJ = "prj_KGnTpOQtOJ1I1zYl302YRgS8itLj";
const LONG = "premium-dark-landing-page-for-open-future-forum-forum-sel.agentwebforms.com";

const rec = (over: Partial<any> = {}) => ({
  id: "dom-1",
  userId: "user-1",
  domain: LONG,
  vercelProjectId: PROJ,
  ...over,
});

describe("repair-overlong-subdomains — classifyRecord", () => {
  it("treats a record no page references as an ORPHAN", () => {
    // Real shape: the customer's pages live on a SHORT host; the over-length record is
    // attached to Vercel but unused. Minting a replacement for it would go unused too.
    const pages = [
      { id: "p-root", vercelProjectId: PROJ, customDomainUrl: "https://open-future-forum.agentwebforms.com" },
      {
        id: "p-sub",
        vercelProjectId: PROJ,
        customDomainUrl:
          "https://open-future-forum.agentwebforms.com/premium-dark-landing-page-for-open-future-forum-forum-sel",
      },
    ];
    const { isOrphan, affectedPages, cascade } = classifyRecord(rec(), pages);
    expect(isOrphan).toBe(true);
    expect(affectedPages).toHaveLength(0);
    expect(cascade).toHaveLength(0);
  });

  it("treats a record a page points at as IN USE", () => {
    const pages = [{ id: "p-1", vercelProjectId: PROJ, customDomainUrl: `https://${LONG}` }];
    const { isOrphan, affectedPages } = classifyRecord(rec(), pages);
    expect(isOrphan).toBe(false);
    expect(affectedPages.map((p) => p.id)).toEqual(["p-1"]);
  });

  it("matches by HOST, so a page whose URL carries a path is still found", () => {
    const pages = [{ id: "p-1", vercelProjectId: PROJ, customDomainUrl: `https://${LONG}/pricing` }];
    expect(classifyRecord(rec(), pages).affectedPages.map((p) => p.id)).toEqual(["p-1"]);
  });

  it("does NOT match a page whose long PATH merely resembles the host", () => {
    // The substring appears in the path but the host is different. Treating this as a match
    // would re-point a page that was never on the broken host.
    const pages = [
      {
        id: "p-sub",
        vercelProjectId: PROJ,
        customDomainUrl:
          "https://open-future-forum.agentwebforms.com/premium-dark-landing-page-for-open-future-forum-forum-sel",
      },
    ];
    expect(classifyRecord(rec(), pages).affectedPages).toHaveLength(0);
  });

  describe("removeDomain cascade blast radius", () => {
    // Mirrors removeDomain: pages on the SAME project that HAVE a subdomainPrefix and whose
    // customDomainUrl CONTAINS the removed domain get customDomainUrl + subdomainPrefix
    // blanked. The script must refuse to detach when this is non-empty.

    it("flags a page that would be blanked", () => {
      const pages = [
        {
          id: "p-danger",
          vercelProjectId: PROJ,
          subdomainPrefix: "shop",
          customDomainUrl: `https://shop.${LONG}`,
        },
      ];
      expect(classifyRecord(rec(), pages).cascade.map((p) => p.id)).toEqual(["p-danger"]);
    });

    it("ignores a page without a subdomainPrefix (removeDomain's scan filter excludes it)", () => {
      const pages = [{ id: "p-safe", vercelProjectId: PROJ, customDomainUrl: `https://${LONG}` }];
      expect(classifyRecord(rec(), pages).cascade).toHaveLength(0);
    });

    it("ignores a page on a DIFFERENT vercel project", () => {
      const pages = [
        {
          id: "p-other",
          vercelProjectId: "prj_other",
          subdomainPrefix: "shop",
          customDomainUrl: `https://shop.${LONG}`,
        },
      ];
      expect(classifyRecord(rec(), pages).cascade).toHaveLength(0);
    });

    it("is empty for all three records actually found in production", () => {
      // Guards the specific detach we intend to run. If this ever fails, the data changed and
      // the detach must be re-reviewed before running.
      const prod = [
        { id: "p-root", vercelProjectId: PROJ, customDomainUrl: "https://open-future-forum.agentwebforms.com" },
        {
          id: "p-sub",
          vercelProjectId: PROJ,
          customDomainUrl:
            "https://open-future-forum.agentwebforms.com/premium-dark-landing-page-for-open-future-forum-forum-sel",
        },
      ];
      expect(classifyRecord(rec(), prod).cascade).toHaveLength(0);
    });
  });

  it("tolerates missing and malformed customDomainUrl without throwing", () => {
    const pages = [
      { id: "p-none", vercelProjectId: PROJ },
      { id: "p-bad", vercelProjectId: PROJ, customDomainUrl: "not a url" },
      { id: "p-empty", vercelProjectId: PROJ, customDomainUrl: "" },
    ];
    const { isOrphan, affectedPages, cascade } = classifyRecord(rec(), pages);
    expect(isOrphan).toBe(true);
    expect(affectedPages).toHaveLength(0);
    expect(cascade).toHaveLength(0);
  });
});

describe("repair-overlong-subdomains — hostOfUrl", () => {
  it("extracts the host and ignores path", () => {
    expect(hostOfUrl("https://example.com/a/b")).toBe("example.com");
  });
  it("returns empty for undefined or unparseable input rather than throwing", () => {
    expect(hostOfUrl(undefined)).toBe("");
    expect(hostOfUrl("not a url")).toBe("");
    expect(hostOfUrl("")).toBe("");
  });
});
