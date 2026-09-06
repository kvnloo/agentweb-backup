// Mock aws-sdk (put/update), the coding-agent loop, and v0Service's buildPageSlug
// so the orchestration can be tested without loading the heavy v0Service module.
const mockPut = jest.fn();
const mockUpdate = jest.fn();
jest.mock("aws-sdk", () => {
  const client = () => ({ put: mockPut, update: mockUpdate });
  return {
    __esModule: true,
    default: {
      DynamoDB: { DocumentClient: jest.fn().mockImplementation(client) },
      config: { update: jest.fn() },
    },
    DynamoDB: { DocumentClient: jest.fn().mockImplementation(client) },
    config: { update: jest.fn() },
  };
});

const mockRunCodingAgent = jest.fn();
jest.mock("../services/codingAgentService", () => ({
  LANDING_PAGE_PREVIEW_BRANCH: "draft/agentweb-preview",
  runCodingAgent: (...a: any[]) => mockRunCodingAgent(...a),
}));

const mockMcpFetch = jest.fn();
jest.mock("../mcp/server/httpClient", () => ({
  mcpFetch: (...a: any[]) => mockMcpFetch(...a),
}));

jest.mock("../services/v0Service", () => ({
  buildPageSlug: (n: string) =>
    n.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30),
}));

const mockIncrementUserTokenUsage = jest.fn();
jest.mock("../services/tokenUsageService", () => ({
  incrementUserTokenUsage: (...a: any[]) => mockIncrementUserTokenUsage(...a),
}));

import { addPageViaCodingAgent, buildSubPageTask } from "../services/codingAgentSubpageService";

const ok = (v: any) => ({ promise: () => Promise.resolve(v) });
const site = {
  id: "site-1",
  siteId: "site-1",
  userId: "u1",
  githubRepoUrl: "https://github.com/o/r",
  vercelProjectId: "vp1",
} as any;

beforeEach(() => {
  mockPut.mockReset().mockReturnValue(ok({}));
  mockUpdate.mockReset().mockReturnValue(ok({}));
  mockRunCodingAgent.mockReset();
  mockMcpFetch.mockReset();
  mockIncrementUserTokenUsage.mockReset().mockResolvedValue(undefined);
});

describe("addPageViaCodingAgent", () => {
  it("stages on a draft, runs the agent with Opus, then promotes to main on a green build", async () => {
    mockRunCodingAgent.mockResolvedValue({
      success: true,
      message: "done",
      iterations: 5,
      previewUrl: "https://r.vercel.app/pricing",
    });
    mockMcpFetch.mockResolvedValue({ success: true, live_url: "https://acme.agentwebforms.com/pricing" });

    const res = await addPageViaCodingAgent(
      site,
      "u1",
      "Build a 3-tier pricing page",
      "Pricing",
      { brandName: "Acme" } as any,
      { originatingSessionId: "s9", leadListId: "list1" }
    );

    const put = mockPut.mock.calls[0][0].Item;
    expect(put.slug).toBe("pricing");
    expect(put.githubRepoUrl).toBe("https://github.com/o/r");
    expect(put.siteId).toBe("site-1"); // belongs to the existing site
    expect(put.originatingSessionId).toBe("s9");
    expect(put.status).toBe("generating");

    const [task, ctx] = mockRunCodingAgent.mock.calls[0];
    expect(ctx.llmModel).toContain("opus-4-8"); // net-new design → most capable model
    expect(ctx.pageId).toBe(put.id);
    expect(ctx.sessionId).toBe("s9");
    expect(ctx.draftBranch).toBe("draft/agentweb-preview"); // staged on the reusable preview branch, not main
    expect(task).toContain("app/pricing/page.tsx");

    // Promoted to main via the publish endpoint, using the same draft branch.
    const pubCall = mockMcpFetch.mock.calls[0][0];
    expect(pubCall.path).toBe(`/api/landing-pages/v0/generated/${put.id}/publish`);
    expect(pubCall.body.branch).toBe(ctx.draftBranch);
    expect(pubCall.context.userId).toBe("u1");

    expect(res.status).toBe("deployed");
    expect(res.deployedUrl).toBe("https://acme.agentwebforms.com/pricing"); // the live URL, not the preview
  });

  it("does NOT promote to main when the build never goes green (main untouched)", async () => {
    mockRunCodingAgent.mockResolvedValue({ success: false, message: "build broke", iterations: 3 });
    const res = await addPageViaCodingAgent(site, "u1", "p", "Contact", {} as any);
    expect(mockMcpFetch).not.toHaveBeenCalled(); // never publishes a failing build
    expect(res.status).toBe("failed");
    expect(res.errorMessage).toContain("build broke");
  });

  it("leaves the page as a draft (main untouched) when the build is green but the promote fails", async () => {
    mockRunCodingAgent.mockResolvedValue({
      success: true,
      message: "done",
      iterations: 4,
      previewUrl: "https://r.vercel.app/contact",
    });
    mockMcpFetch.mockRejectedValue(new Error("merge conflict"));
    const res = await addPageViaCodingAgent(site, "u1", "p", "Contact", {} as any);
    expect(res.status).toBe("draft");
    expect(res.deployedUrl).toBe("https://r.vercel.app/contact"); // the verified preview
    expect(res.errorMessage).toContain("publish to main failed");
  });

  it("maps a thrown agent error to a failed record (never throws to the caller)", async () => {
    mockRunCodingAgent.mockRejectedValue(new Error("LLM down"));
    const res = await addPageViaCodingAgent(site, "u1", "p", "About", {} as any);
    expect(res.status).toBe("failed");
    expect(res.errorMessage).toContain("LLM down");
  });

  it("charges the coding-agent LLM spend to the caller's monthly usage cap (ENG-200)", async () => {
    mockRunCodingAgent.mockResolvedValue({
      success: true,
      message: "done",
      iterations: 5,
      previewUrl: "https://r.vercel.app/pricing",
      usageTotals: { totalTokens: 1200, costUsd: 0.42 },
    });
    mockMcpFetch.mockResolvedValue({ success: true, live_url: "https://acme.agentwebforms.com/pricing" });

    await addPageViaCodingAgent(site, "u1", "p", "Pricing", {} as any);

    // The sub-page coding loop makes its own high-cost LLM calls the parent meter
    // never sees; without this the spend escapes the per-user cap.
    expect(mockIncrementUserTokenUsage).toHaveBeenCalledWith("u1", 1200, 0.42);
  });

  it("charges the LLM spend even when the build never goes green (turns still cost money)", async () => {
    mockRunCodingAgent.mockResolvedValue({
      success: false,
      message: "build broke",
      iterations: 3,
      usageTotals: { totalTokens: 800, costUsd: 0.31 },
    });

    const res = await addPageViaCodingAgent(site, "u1", "p", "Contact", {} as any);

    expect(res.status).toBe("failed");
    expect(mockIncrementUserTokenUsage).toHaveBeenCalledWith("u1", 800, 0.31);
  });

  it("does not charge the cap when the agent reports no usage totals", async () => {
    mockRunCodingAgent.mockResolvedValue({
      success: false,
      message: "auth denied before any LLM call",
      iterations: 0,
    });

    await addPageViaCodingAgent(site, "u1", "p", "About", {} as any);

    expect(mockIncrementUserTokenUsage).not.toHaveBeenCalled();
  });

  it("never lets a cap-charge failure break sub-page generation (fail-open)", async () => {
    mockRunCodingAgent.mockResolvedValue({
      success: true,
      message: "done",
      iterations: 2,
      previewUrl: "https://r.vercel.app/faq",
      usageTotals: { totalTokens: 500, costUsd: 0.1 },
    });
    mockMcpFetch.mockResolvedValue({ success: true, live_url: "https://acme.agentwebforms.com/faq" });
    mockIncrementUserTokenUsage.mockRejectedValue(new Error("dynamo down"));

    const res = await addPageViaCodingAgent(site, "u1", "p", "FAQ", {} as any);

    expect(res.status).toBe("deployed"); // metering failure did not surface
  });

  it("rejects a site with no deployed repo before creating anything", async () => {
    await expect(
      addPageViaCodingAgent({ id: "x", userId: "u1" } as any, "u1", "p", "N", {} as any)
    ).rejects.toThrow(/deployed GitHub repo/);
    expect(mockPut).not.toHaveBeenCalled();
  });
});

describe("buildSubPageTask — reference-first, verify-last prompt", () => {
  it("instructs read-existing-design first, includes the brief + lead list, and verifies the build", () => {
    const t = buildSubPageTask(
      "pricing",
      "Pricing",
      "Build a 3-tier pricing page",
      { brandName: "Acme", primaryColor: "#ff0000" } as any,
      "list1"
    );
    expect(t).toMatch(/home page|app\/page\.tsx/i); // learn existing design first
    expect(t).toMatch(/read_file/); // via the read tool
    expect(t).toContain("Build a 3-tier pricing page"); // the brief verbatim
    expect(t).toContain("list1"); // lead-list wiring
    expect(t).toMatch(/check_deployment/); // verify before finishing
    expect(t).toMatch(/report_to_user/);
    expect(t).toContain("Acme");
  });

  it("falls back to 'match the existing site' when no brand context is given", () => {
    const t = buildSubPageTask("about", "About", "An about page", {} as any);
    expect(t).toMatch(/existing site/i);
  });
});

describe('ENG-1328 — the coding-agent sub-page path carries the conversion pair', () => {
  // Greptile on #2481: this path received no Google Ads config at all. It relied purely
  // on "mirror the home page's form" to carry the tracking call across — inference, not
  // instruction. An agent can reasonably build a clean form and drop the call, and
  // nothing notices until a campaign reports zero conversions.
  const { buildSubPageTask } = require('../services/codingAgentSubpageService') as any;
  const brand = { brandName: 'Acme' } as any;
  const ga = { conversionId: 'AW-18192751758', conversionLabel: 'qAnwCOLmx-McEI65_eJD' };

  it('names the exact pair in the task, rather than leaving it to be inferred', () => {
    const task = buildSubPageTask('pricing', 'Pricing', 'brief', brand, 'list1', ga);
    expect(task).toContain('conversionId: "AW-18192751758"');
    expect(task).toContain('conversionLabel: "qAnwCOLmx-McEI65_eJD"');
    expect(task).toContain('fireLeadTracking');
  });

  it('requires the shared eventId so the offline import cannot double-count', () => {
    const task = buildSubPageTask('pricing', 'Pricing', 'brief', brand, 'list1', ga);
    expect(task).toContain('crypto.randomUUID()');
    expect(task).toMatch(/eventId/);
  });

  it('forbids hand-authored gtag calls', () => {
    const task = buildSubPageTask('pricing', 'Pricing', 'brief', brand, 'list1', ga);
    expect(task).toMatch(/Do NOT hand-author a gtag\(\) call/);
    expect(task).toMatch(/gtag\('config', \.\.\.\)/);
  });

  it('says nothing about Google Ads when the site has none', () => {
    const task = buildSubPageTask('pricing', 'Pricing', 'brief', brand, 'list1', undefined);
    expect(task).not.toContain('fireLeadTracking');
    expect(task).not.toContain('googleAds');
  });

  it('states the consequence, so the instruction is not silently dropped as boilerplate', () => {
    const task = buildSubPageTask('pricing', 'Pricing', 'brief', brand, 'list1', ga);
    expect(task).toMatch(/captures leads that report no conversion/);
  });
});

describe('ENG-1328 — a partial pair is never persisted or instructed (CodeRabbit, #2481)', () => {
  // FAIL cases first, per the repo's test rule: invalid inputs, boundary values, and the
  // half-configured record that is the realistic failure here.
  const { buildSubPageTask } = require('../services/codingAgentSubpageService') as any;
  const brand = { brandName: 'Acme' } as any;
  const AWID = 'AW-18192751758';

  it('emits no Google Ads instructions for an id with no label', () => {
    const task = buildSubPageTask('p', 'P', 'brief', brand, 'list1',
      { conversionId: AWID, conversionLabel: '' } as any);
    expect(task).not.toContain('fireLeadTracking');
  });

  it('emits none for a label with no id', () => {
    const task = buildSubPageTask('p', 'P', 'brief', brand, 'list1',
      { conversionId: '', conversionLabel: 'lbl' } as any);
    expect(task).not.toContain('fireLeadTracking');
  });

  it('emits none when both halves are empty strings', () => {
    const task = buildSubPageTask('p', 'P', 'brief', brand, 'list1',
      { conversionId: '', conversionLabel: '' } as any);
    expect(task).not.toContain('fireLeadTracking');
  });

  it('emits none when the pair object itself is undefined', () => {
    expect(buildSubPageTask('p', 'P', 'brief', brand, 'list1', undefined)).not.toContain('fireLeadTracking');
  });

  it('still emits the rest of the task when the pair is absent', () => {
    // Boundary: dropping the tracking block must not drop the page brief with it.
    const task = buildSubPageTask('p', 'P', 'the brief text', brand, 'list1', undefined);
    expect(task).toContain('the brief text');
    expect(task).toContain('app/p/page.tsx');
  });
});
