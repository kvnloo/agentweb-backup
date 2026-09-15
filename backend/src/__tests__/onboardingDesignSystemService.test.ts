/**
 * Onboarding design-system build service tests (ENG-328).
 *
 * Covers the invariants this feature depends on:
 *  - the mandatory step ALWAYS reaches a terminal 'ready' state, even when
 *    the real scrape can't succeed (no admin override exists anywhere in
 *    onboarding — see the plan's manual-fallback decision), by falling back
 *    to brandGuidelines-derived content instead of leaving the account
 *    stuck;
 *  - re-runs upsert design.md in place via the persisted kbTaskId rather
 *    than creating a duplicate-named Knowledge Base entry;
 *  - the deterministic token-merge/markdown-assembly helpers produce the
 *    acceptance criteria's required fields (hex colors, fonts, logo URLs,
 *    layout notes).
 *
 * We do NOT exercise the real cssExtractor/agentModeService here — those are
 * injected as fakes, mirroring onboardingBrandBuildService.test.ts's pattern.
 */

jest.mock("../services/db", () => ({
  userDb: {
    getUserById: jest.fn(),
    updateUser: jest.fn(),
  },
  taskDb: {
    getTaskById: jest.fn(),
    createTask: jest.fn(),
  },
}));

jest.mock("uuid", () => ({ v4: jest.fn(() => "generated-task-id") }));

import {
  triggerDesignSystemBuildForUser,
  discoverSecondaryPageUrls,
  mergeDesignTokens,
  buildLayoutNotes,
  assembleDesignMarkdown,
  buildManualFallbackMarkdown,
} from "../services/onboardingDesignSystemService";

const { userDb, taskDb } = require("../services/db");

beforeEach(() => {
  userDb.getUserById.mockReset();
  userDb.updateUser.mockReset();
  taskDb.getTaskById.mockReset();
  taskDb.createTask.mockReset();
});

const emptyTokens = () => ({
  colors: { all: [], backgrounds: [], text: [], borders: [], accents: [] },
  typography: { fontFamilies: [], fontSizes: [], fontWeights: [], lineHeights: [] },
  visualEffects: { boxShadows: [], textShadows: [], borderRadius: [], transitions: [] },
});

describe("onboardingDesignSystemService — pure helpers", () => {
  describe("discoverSecondaryPageUrls", () => {
    it("picks up to 3 same-origin keyword-matched links, first match per keyword wins", () => {
      const html = `
        <a href="/about">About</a>
        <a href="/pricing">Pricing</a>
        <a href="https://acme.com/product">Product</a>
        <a href="/company">Company (should not override /about's slot)</a>
        <a href="/team">Team</a>
      `;
      const urls = discoverSecondaryPageUrls(html, "https://acme.com");
      expect(urls).toHaveLength(3);
      expect(urls).toContain("https://acme.com/about");
      expect(urls).toContain("https://acme.com/pricing");
      expect(urls).toContain("https://acme.com/product");
    });

    it("ignores cross-origin links (SSRF/scope safety — never crawl off-site)", () => {
      const html = `<a href="https://evil.example.com/about">About</a>`;
      expect(discoverSecondaryPageUrls(html, "https://acme.com")).toEqual([]);
    });

    it("returns [] for unparseable base URL or no matches", () => {
      expect(discoverSecondaryPageUrls("<a href='/x'>x</a>", "not-a-url")).toEqual([]);
      expect(discoverSecondaryPageUrls("<a href='/blog'>Blog</a>", "https://acme.com")).toEqual([]);
    });
  });

  describe("mergeDesignTokens", () => {
    it("passes a single page's tokens through unchanged", () => {
      const t = { ...emptyTokens(), colors: { ...emptyTokens().colors, all: [{ value: "#111", count: 3, contexts: ["color"] }] } };
      expect(mergeDesignTokens([t])).toBe(t);
    });

    it("sums usage counts for the same color/font across pages instead of overwriting", () => {
      const page1 = {
        ...emptyTokens(),
        colors: { ...emptyTokens().colors, all: [{ value: "#111111", count: 2, contexts: ["color"] }] },
        typography: { ...emptyTokens().typography, fontFamilies: [{ family: "Inter", count: 4 }] },
      };
      const page2 = {
        ...emptyTokens(),
        colors: { ...emptyTokens().colors, all: [{ value: "#111111", count: 5, contexts: ["background"] }, { value: "#ffffff", count: 1, contexts: [] }] },
        typography: { ...emptyTokens().typography, fontFamilies: [{ family: "Inter", count: 3 }] },
      };
      const merged = mergeDesignTokens([page1, page2]);
      const black = merged.colors.all.find((c: any) => c.value === "#111111");
      expect(black.count).toBe(7);
      const white = merged.colors.all.find((c: any) => c.value === "#ffffff");
      expect(white.count).toBe(1);
      const inter = merged.typography.fontFamilies.find((f: any) => f.family === "Inter");
      expect(inter.count).toBe(7);
    });

    it("takes the first page's type scale when present", () => {
      const withScale = { ...emptyTokens(), typography: { ...emptyTokens().typography, scale: { h1: { fontSize: "48px", lineHeight: "1.1", fontWeight: 700 } } } };
      const withoutScale = emptyTokens();
      const merged = mergeDesignTokens([withScale, withoutScale]);
      expect(merged.typography.scale.h1.fontSize).toBe("48px");
    });
  });

  describe("buildLayoutNotes", () => {
    it("reports no signal when computedElements is missing entirely", () => {
      expect(buildLayoutNotes(undefined)[0]).toMatch(/no layout signal/i);
    });

    it("detects header/hero/cta/footer presence from sampled selector keys", () => {
      const notes = buildLayoutNotes({ header: {}, hero: {}, cta: {}, footer: {} } as any);
      expect(notes.some((n) => /header\/navigation/i.test(n) && /detected\.$/.test(n))).toBe(true);
      expect(notes.some((n) => /hero section detected/i.test(n))).toBe(true);
      expect(notes.some((n) => /call-to-action/i.test(n))).toBe(true);
      expect(notes.some((n) => /footer region detected\.$/i.test(n))).toBe(true);
    });

    it("reports absence explicitly rather than omitting the note", () => {
      const notes = buildLayoutNotes({ body: {} } as any);
      expect(notes.some((n) => /no distinct header\/navigation/i.test(n))).toBe(true);
      expect(notes.some((n) => /no distinct footer/i.test(n))).toBe(true);
    });
  });

  describe("assembleDesignMarkdown", () => {
    it("includes hex colors, fonts, logo URL, and layout notes (acceptance criterion 2)", () => {
      const md = assembleDesignMarkdown({
        url: "https://acme.com",
        brandIdentity: { brandName: "Acme", logoUrl: "https://acme.com/logo.png", favicon: "https://acme.com/favicon.ico", tagline: "Widgets for all" },
        brandTokens: {
          colors: { primary: "#112233", secondary: "#445566", palette: ["#112233", "#445566"] },
          typography: { headingFont: "Inter", bodyFont: "Inter", fontWeights: { regular: 400, semibold: 600, bold: 700 } },
          visualEffects: { primaryShadow: "0 1px 2px rgba(0,0,0,0.1)", borderRadius: "8px" },
        },
        detailedTokens: { ...emptyTokens(), colors: { ...emptyTokens().colors, all: [{ value: "#112233", count: 10, contexts: ["color"] }] } },
        layoutNotes: ["Header/navigation region detected."],
        pagesScanned: ["https://acme.com"],
        generatedAt: "2026-01-01T00:00:00.000Z",
      });
      expect(md).toContain("#112233");
      expect(md).toContain("Inter");
      expect(md).toContain("https://acme.com/logo.png");
      expect(md).toContain("Header/navigation region detected.");
      expect(md).toContain("# Design System — Acme");
    });
  });

  describe("buildManualFallbackMarkdown", () => {
    it("derives colors/fonts from brandGuidelines and explains it's not a live scrape", () => {
      const user = {
        companyName: "Acme",
        brandGuidelines: {
          brandData: { brandName: "Acme", primaryColor: "#112233", secondaryColor: "#445566", fontFamily: "Inter", tagline: "Widgets" },
          attachments: [{ type: "logo", url: "https://acme.com/logo.png" }],
        },
      };
      const md = buildManualFallbackMarkdown(user, "2026-01-01T00:00:00.000Z", "site unreachable");
      expect(md).toContain("#112233");
      expect(md).toContain("Inter");
      expect(md).toContain("https://acme.com/logo.png");
      expect(md).toMatch(/could not be scraped/i);
      expect(md).toContain("site unreachable");
    });

    it("degrades to 'unknown' placeholders rather than throwing when brandGuidelines is absent", () => {
      const md = buildManualFallbackMarkdown({}, "2026-01-01T00:00:00.000Z");
      expect(md).toContain("unknown");
      expect(md).not.toThrow;
    });
  });
});

describe("onboardingDesignSystemService — triggerDesignSystemBuildForUser (orchestration)", () => {
  it("falls back to a manual design.md and still reaches 'ready' when there is no companyUrl", async () => {
    userDb.getUserById.mockResolvedValue({ userId: "u1", designSystem: { status: "running" } });
    taskDb.createTask.mockResolvedValue(undefined);
    const updateKnowledgeBaseFile = jest.fn().mockResolvedValue({ success: true });

    await triggerDesignSystemBuildForUser("u1", { updateKnowledgeBaseFile });

    expect(updateKnowledgeBaseFile).toHaveBeenCalledWith(
      "generated-task-id",
      "design.md",
      expect.any(String),
      "replace",
      "u1",
      expect.any(String)
    );
    const lastCall = userDb.updateUser.mock.calls[userDb.updateUser.mock.calls.length - 1];
    expect(lastCall[1].designSystem.status).toBe("ready");
    expect(lastCall[1].designSystem.source).toBe("manual_fallback");
    expect(lastCall[1].designSystem.kbTaskId).toBe("generated-task-id");
  });

  it("falls back to manual and still reaches 'ready' when the real scrape throws", async () => {
    userDb.getUserById.mockResolvedValue({
      userId: "u1",
      productDomain: "https://acme.com",
      designSystem: { status: "running" },
    });
    const updateKnowledgeBaseFile = jest.fn().mockResolvedValue({ success: true });
    const extractCSSFromURL = jest.fn().mockRejectedValue(new Error("site unreachable"));

    await triggerDesignSystemBuildForUser("u1", {
      extractCSSFromURL,
      analyzeDesignTokens: jest.fn(),
      inferBrandTokens: jest.fn(),
      fetchHtml: jest.fn(),
      updateKnowledgeBaseFile,
    });

    const lastCall = userDb.updateUser.mock.calls[userDb.updateUser.mock.calls.length - 1];
    expect(lastCall[1].designSystem.status).toBe("ready");
    expect(lastCall[1].designSystem.source).toBe("manual_fallback");
    // The scrape failure reason is preserved in the artifact for the user.
    const mdArg = updateKnowledgeBaseFile.mock.calls[updateKnowledgeBaseFile.mock.calls.length - 1][2];
    expect(mdArg).toContain("site unreachable");
  });

  it("terminal-fails when BOTH the scrape and the manual fallback fail", async () => {
    userDb.getUserById.mockResolvedValue({
      userId: "u1",
      productDomain: "https://acme.com",
      designSystem: { status: "running" },
    });
    const updateKnowledgeBaseFile = jest.fn().mockResolvedValue({ success: false, error: "Knowledge Base is down" });
    const extractCSSFromURL = jest.fn().mockRejectedValue(new Error("site unreachable"));

    await triggerDesignSystemBuildForUser("u1", {
      extractCSSFromURL,
      analyzeDesignTokens: jest.fn(),
      inferBrandTokens: jest.fn(),
      fetchHtml: jest.fn(),
      updateKnowledgeBaseFile,
    });

    const lastCall = userDb.updateUser.mock.calls[userDb.updateUser.mock.calls.length - 1];
    expect(lastCall[1].designSystem.status).toBe("failed");
    expect(lastCall[1].designSystem.error).toMatch(/site unreachable/);
    expect(lastCall[1].designSystem.error).toMatch(/Knowledge Base is down/);
  });

  it("writes design.md via a real scrape and marks source:'scrape' on success", async () => {
    userDb.getUserById.mockResolvedValue({
      userId: "u1",
      productDomain: "https://acme.com",
      designSystem: { status: "running" },
    });
    const homepage = {
      url: "https://acme.com",
      brandIdentity: { brandName: "Acme", logoUrl: "https://acme.com/logo.png" },
      computedElements: { header: {}, footer: {} },
    };
    const extractCSSFromURL = jest.fn().mockResolvedValue(homepage);
    const analyzeDesignTokens = jest.fn().mockResolvedValue(emptyTokens());
    const inferBrandTokens = jest.fn().mockReturnValue({
      colors: { primary: "#112233", secondary: "#445566", palette: [] },
      typography: { headingFont: "Inter", bodyFont: "Inter", fontWeights: { regular: 400, semibold: 600, bold: 700 } },
      visualEffects: { primaryShadow: "none", borderRadius: "0" },
    });
    const fetchHtml = jest.fn().mockResolvedValue("<html></html>");
    const updateKnowledgeBaseFile = jest.fn().mockResolvedValue({ success: true });

    await triggerDesignSystemBuildForUser("u1", {
      extractCSSFromURL,
      analyzeDesignTokens,
      inferBrandTokens,
      fetchHtml,
      updateKnowledgeBaseFile,
    });

    expect(taskDb.createTask).toHaveBeenCalledTimes(1);
    expect(updateKnowledgeBaseFile).toHaveBeenCalledWith(
      "generated-task-id",
      "design.md",
      expect.stringContaining("#112233"),
      "replace",
      "u1",
      expect.any(String)
    );
    const lastCall = userDb.updateUser.mock.calls[userDb.updateUser.mock.calls.length - 1];
    expect(lastCall[1].designSystem.status).toBe("ready");
    expect(lastCall[1].designSystem.source).toBe("scrape");
  });

  it("re-runs upsert design.md via the persisted kbTaskId instead of creating a duplicate task", async () => {
    userDb.getUserById.mockResolvedValue({
      userId: "u1",
      productDomain: "https://acme.com",
      designSystem: { status: "running", kbTaskId: "existing-task-id" },
    });
    taskDb.getTaskById.mockResolvedValue({ taskId: "existing-task-id", userId: "u1" });
    const homepage = { url: "https://acme.com", brandIdentity: {}, computedElements: {} };
    const updateKnowledgeBaseFile = jest.fn().mockResolvedValue({ success: true });

    await triggerDesignSystemBuildForUser("u1", {
      extractCSSFromURL: jest.fn().mockResolvedValue(homepage),
      analyzeDesignTokens: jest.fn().mockResolvedValue(emptyTokens()),
      inferBrandTokens: jest.fn().mockReturnValue({
        colors: { primary: "#000", secondary: "#000", palette: [] },
        typography: { headingFont: "x", bodyFont: "x", fontWeights: { regular: 400, semibold: 600, bold: 700 } },
        visualEffects: { primaryShadow: "none", borderRadius: "0" },
      }),
      fetchHtml: jest.fn().mockResolvedValue(""),
      updateKnowledgeBaseFile,
    });

    expect(taskDb.getTaskById).toHaveBeenCalledWith("existing-task-id");
    expect(taskDb.createTask).not.toHaveBeenCalled();
    expect(updateKnowledgeBaseFile.mock.calls[0][0]).toBe("existing-task-id");
  });
});
