import {
  normalizeCanonicalUrl,
  normalizeExternalPageName,
  buildExternalLandingPageRecord,
  isExternalLandingPageRecord,
  ExternalLandingPageValidationError,
} from "../services/externalLandingPageCatalog";

describe("ENG-1238 external lander catalog (TDD RED first)", () => {
  test("FAIL-1: canonical URL validation rejects non-URL input", () => {
    expect(() => normalizeCanonicalUrl("not a url at all !@#")).toThrow(
      ExternalLandingPageValidationError
    );
  });

  test("FAIL-2: name validation rejects blank names", () => {
    expect(() => normalizeExternalPageName("   ")).toThrow(
      ExternalLandingPageValidationError
    );
  });

  test("FAIL-3: built record carries external identity + metadata, no build fields", () => {
    const record = buildExternalLandingPageRecord(
      {
        userId: "u1",
        name: "AI Readiness Roadmap",
        canonicalUrl: "https://www.hireemma.ai/ai-readiness-roadmap",
        context: "Cold-intent control",
        repoRef: "AgentWebPro/agentweb-landing-page",
        projectRef: "agentweb-landing-page",
        leadListId: "list_1786727568488_vchiqixf5",
      },
      "page-1",
      "2026-09-18T00:00:00.000Z"
    );
    expect(record.status).toBe("deployed");
    expect(record.sourceType).toBe("external");
    expect(record.canonicalUrl).toBe("https://www.hireemma.ai/ai-readiness-roadmap");
    expect(record.deployedUrl).toBe("https://www.hireemma.ai/ai-readiness-roadmap");
    expect(record.leadListId).toBe("list_1786727568488_vchiqixf5");
    expect(record.repoRef).toBe("AgentWebPro/agentweb-landing-page");
    // No build/deploy behind an imported record — these must stay absent so
    // build/deploy/poller/janitor paths can never match it.
    for (const f of [
      "v0ProjectId",
      "v0ChatId",
      "vercelProjectId",
      "githubRepoUrl",
      "templateHtml",
      "siteId",
      "originatingSessionId",
    ]) {
      expect(record[f]).toBeUndefined();
    }
  });

  test("FAIL-4: https is required; http canonical URLs are rejected", () => {
    expect(() =>
      buildExternalLandingPageRecord(
        { userId: "u1", name: "x", canonicalUrl: "http://example.com/page" },
        "page-2",
        "2026-09-18T00:00:00.000Z"
      )
    ).toThrow(ExternalLandingPageValidationError);
  });

  test("PASS-port: non-default https port is preserved in normalized canonical URL", () => {
    expect(normalizeCanonicalUrl("https://example.com:8443/page")).toBe(
      "https://example.com:8443/page"
    );
  });

  test("PASS-context-bound: prompt is built from bounded context, not raw input", () => {
    const long = "x".repeat(5000);
    const record = buildExternalLandingPageRecord(
      { userId: "u1", name: "x", canonicalUrl: "https://example.com/p", context: long },
      "page-3",
      "2026-09-18T00:00:00.000Z"
    );
    expect(record.context).toHaveLength(2000);
    expect(record.prompt.length).toBeLessThanOrEqual(
      "Imported externally-deployed page: ".length + 2000
    );
    expect(record.prompt).not.toContain("x".repeat(2001));
  });

  test("PASS-unchanged: external-record predicate is false for builder pages", () => {
    expect(isExternalLandingPageRecord({})).toBe(false);
    expect(isExternalLandingPageRecord({ sourceType: "external" })).toBe(true);
  });
});
