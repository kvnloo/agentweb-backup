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
  derivePrefix,
  hostOfUrl,
  isRepairableSubdomain,
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

/*
 * Scope selection. This runs BEFORE any classification, so anything it wrongly admits is
 * already inside a script whose `--remove-old` orphan branch deletes from Vercel with no
 * `--map` and no per-record confirmation. Getting this wrong destroys data that was never
 * ours to touch.
 */
describe("repair-overlong-subdomains — isRepairableSubdomain", () => {
  const OVERLONG_CUSTOM = "landing-pages-for-our-north-american-division.myagentwebforms.com";

  it("selects an over-length MANAGED subdomain", () => {
    expect(isRepairableSubdomain(rec({ type: "subdomain" }) as any)).toBe(true);
  });

  it("ignores a managed subdomain that is within the ceiling", () => {
    expect(
      isRepairableSubdomain(rec({ type: "subdomain", domain: "short.agentwebforms.com" }) as any)
    ).toBe(false);
  });

  it("NEVER selects a customer's own custom domain, however long", () => {
    /*
     * `addCustomDomain` has no length ceiling — `validateDomain` checks format only — so a
     * customer can store a domain longer than the cert limit. It is still theirs. Selecting it
     * put it on the orphan path, which deletes from Vercel irreversibly.
     */
    expect(isRepairableSubdomain(rec({ type: "custom", domain: OVERLONG_CUSTOM }) as any)).toBe(false);
    // Even one that genuinely sits under our base domain is not ours to rewrite.
    expect(isRepairableSubdomain(rec({ type: "custom" }) as any)).toBe(false);
  });

  it("does not match a look-alike registrable domain", () => {
    /*
     * The bug this pins: `endsWith("agentwebforms.com")` with no leading dot also matches
     * `myagentwebforms.com`, an unrelated domain that merely ends in the same letters.
     */
    expect(OVERLONG_CUSTOM.endsWith("agentwebforms.com")).toBe(true); // the trap
    expect(
      isRepairableSubdomain(rec({ type: "subdomain", domain: OVERLONG_CUSTOM }) as any)
    ).toBe(false);
  });

  it("ignores a record with no domain", () => {
    expect(isRepairableSubdomain(rec({ type: "subdomain", domain: undefined }) as any)).toBe(false);
  });
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

    it("is empty for the production fixture", () => {
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

  it("tolerates malformed customDomainUrl without throwing", () => {
    // Pages on a DIFFERENT project, so only the parsing behaviour is under test here.
    const pages = [
      { id: "p-bad", vercelProjectId: "prj_other", customDomainUrl: "not a url" },
      { id: "p-empty2", vercelProjectId: "prj_other", customDomainUrl: "" },
    ];
    const { isOrphan, affectedPages, cascade } = classifyRecord(rec(), pages);
    expect(isOrphan).toBe(true);
    expect(affectedPages).toHaveLength(0);
    expect(cascade).toHaveLength(0);
  });

  describe("a same-project page with no stored URL blocks the detach", () => {
    // This previously asserted the OPPOSITE — that such a page leaves the record an orphan —
    // which pinned a defect rather than a behaviour. `assignManagedSubdomain` creates the
    // domain record and persists the page's customDomainUrl in a SEPARATE write, so a failure
    // between the two leaves a deployed page whose only working URL comes from the domain row.
    // Detaching it destroys that page's URL, silently, which is the same failure shape as the
    // bug this whole ticket is about.

    it("is NOT an orphan when a same-project page stores no URL", () => {
      const pages = [{ id: "p-legacy", vercelProjectId: PROJ }];
      const c = classifyRecord(rec(), pages);
      expect(c.isOrphan).toBe(false);
      expect(c.projectPagesWithoutUrl.map((p) => p.id)).toEqual(["p-legacy"]);
    });

    it("does not try to rewrite it — there is no stored URL to rewrite", () => {
      const pages = [{ id: "p-legacy", vercelProjectId: PROJ }];
      expect(classifyRecord(rec(), pages).affectedPages).toHaveLength(0);
    });

    it("still treats a no-URL page on a DIFFERENT project as irrelevant", () => {
      const pages = [{ id: "p-elsewhere", vercelProjectId: "prj_other" }];
      expect(classifyRecord(rec(), pages).isOrphan).toBe(true);
    });

    it("ignores a page with no vercelProjectId at all", () => {
      // A failed generation can leave a page with neither field; it belongs to no project and
      // must not block an unrelated record's detach.
      const pages = [{ id: "p-orphaned-page" }];
      expect(classifyRecord(rec(), pages).isOrphan).toBe(true);
    });
  });
});

describe("derivePrefix — the account's own identity, not the page name", () => {
  // Deriving from the PAGE name is what produces "create-a-high-converting-mobile-first-
  // emergenc", and a guess from the page title already went wrong once on this ticket
  // ("waterheater" for a customer whose product domain is smartwaterheater.ai). The account's
  // productDomain is the customer's own declared identity — data, not inference.

  it("uses the registrable name from productDomain", () => {
    expect(derivePrefix({ productDomain: "https://smartwaterheater.ai/" }, "dom-1")).toBe(
      "smartwaterheater"
    );
  });

  it("strips www and any path", () => {
    expect(derivePrefix({ productDomain: "https://www.argusoft.com/pricing" }, "dom-1")).toBe(
      "argusoft"
    );
  });

  it("tolerates a bare host with no scheme", () => {
    expect(derivePrefix({ productDomain: "openfutureforum.com" }, "dom-1")).toBe(
      "openfutureforum"
    );
  });

  it("falls back to companyName when no productDomain is set", () => {
    expect(derivePrefix({ companyName: "Acme Widgets Inc." }, "dom-1")).toBe("acme-widgets-inc");
  });

  it("falls back to the record id when the account has neither", () => {
    const p = derivePrefix({}, "6f5e0a2d-7ea9-4d88-8391-b2197f409271");
    expect(p).toBe("lp-6f5e0a2d");
  });

  it("falls back when the account is missing entirely", () => {
    expect(derivePrefix(undefined, "6f5e0a2d-7ea9")).toBe("lp-6f5e0a2d");
  });

  it("always yields a label that fits the certifiable ceiling", () => {
    // The whole point of the ticket: whatever comes out must not recreate the bug.
    const long = derivePrefix({ companyName: "A".repeat(300) }, "dom-1");
    expect(`${long}.agentwebforms.com`.length).toBeLessThanOrEqual(64);
  });

  it("always yields a label the validator accepts", () => {
    for (const u of [
      { productDomain: "https://Foo-Bar.Example.com/" },
      { companyName: "Weird!! Name?? Ltd." },
      { companyName: "---" },
      {},
    ]) {
      expect(derivePrefix(u, "abcdefgh-1234")).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/);
    }
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
