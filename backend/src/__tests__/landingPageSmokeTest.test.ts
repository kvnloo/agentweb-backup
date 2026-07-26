/**
 * ENG-449 gap #3: automated post-deploy Playwright smoke test.
 * Mocks `playwright` the same way cssExtractor.test.ts / linkedInService.test.ts already
 * mock `puppeteer-core` — established convention in this repo.
 */

// Captures the callback passed to exposeFunction("__smokeTestReportFbqCall", cb) so tests
// can simulate the page's JS calling fbq('track','Lead',...) by invoking it directly —
// mirrors how the real implementation detects the call (see landingPageSmokeTest.ts).
let exposedFbqReporter: ((event: string) => void) | undefined;
const mockCdpSession = { send: jest.fn().mockResolvedValue(undefined) };
const mockContext = { newCDPSession: jest.fn().mockResolvedValue(mockCdpSession) };
const mockPage = {
  on: jest.fn(),
  context: jest.fn(() => mockContext),
  exposeFunction: jest.fn((name: string, fn: (event: string) => void) => {
    if (name === "__smokeTestReportFbqCall") exposedFbqReporter = fn;
    return Promise.resolve();
  }),
  addInitScript: jest.fn().mockResolvedValue(undefined),
  goto: jest.fn().mockResolvedValue(undefined),
  fill: jest.fn().mockResolvedValue(undefined),
  click: jest.fn().mockResolvedValue(undefined),
  press: jest.fn().mockResolvedValue(undefined),
};
const mockBrowser = {
  newPage: jest.fn().mockResolvedValue(mockPage),
  close: jest.fn().mockResolvedValue(undefined),
};
const mockLaunch = jest.fn().mockResolvedValue(mockBrowser);

jest.mock("playwright", () => ({
  chromium: { launch: (...args: any[]) => mockLaunch(...args) },
}));

jest.mock("../utils/browserUtils", () => ({
  findChromeExecutable: jest.fn().mockReturnValue("/usr/bin/google-chrome"),
  PUPPETEER_LAUNCH_ARGS: ["--no-sandbox"],
}));

const mockGetLeadByEmail = jest.fn();
const mockDeleteLead = jest.fn();
jest.mock("../services/db", () => ({
  crmDb: {
    getLeadByEmail: (...args: any[]) => mockGetLeadByEmail(...args),
    deleteLead: (...args: any[]) => mockDeleteLead(...args),
  },
}));

const mockSendLandingPageSmokeTestAlert = jest.fn().mockResolvedValue(undefined);
jest.mock("../services/slackService", () => ({
  sendLandingPageSmokeTestAlert: (...args: any[]) => mockSendLandingPageSmokeTestAlert(...args),
}));

const mockUpdateLandingPageSmokeTestResult = jest.fn().mockResolvedValue(undefined);
jest.mock("../services/v0Service", () => ({
  updateLandingPageSmokeTestResult: (...args: any[]) => mockUpdateLandingPageSmokeTestResult(...args),
}));

import { runGenerationSmokeTest, setSmokeTestPollConfig, setSmokeTestConcurrency } from "../services/landingPageSmokeTest";

const BASE_PAGE = {
  id: "page-1",
  userId: "user-1",
  name: "Test Page",
  prompt: "Build a page",
  status: "deployed" as const,
  iterations: 0,
  leadListId: "list-1",
  deployedUrl: "https://test-page.vercel.app",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("runGenerationSmokeTest", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    exposedFbqReporter = undefined;
    setSmokeTestPollConfig(0, 3); // fast polling for tests
    setSmokeTestConcurrency(1); // prod's actual default — reset each test
  });

  it("SKIP: no leadListId → never launches a browser", async () => {
    await runGenerationSmokeTest({ ...BASE_PAGE, leadListId: undefined });
    expect(mockLaunch).not.toHaveBeenCalled();
    expect(mockUpdateLandingPageSmokeTestResult).not.toHaveBeenCalled();
  });

  it("SKIP: no deployedUrl → never launches a browser", async () => {
    await runGenerationSmokeTest({ ...BASE_PAGE, deployedUrl: undefined });
    expect(mockLaunch).not.toHaveBeenCalled();
    expect(mockUpdateLandingPageSmokeTestResult).not.toHaveBeenCalled();
  });

  it("SUCCESS: lead lands in CRM, no pixel configured → ok:true, no Slack alert, test lead deleted", async () => {
    mockGetLeadByEmail.mockResolvedValueOnce({ leadId: "lead-abc" });

    await runGenerationSmokeTest({ ...BASE_PAGE });

    expect(mockLaunch).toHaveBeenCalledWith(
      expect.objectContaining({ executablePath: "/usr/bin/google-chrome" })
    );
    expect(mockPage.goto).toHaveBeenCalledWith(
      "https://test-page.vercel.app",
      expect.objectContaining({ waitUntil: "networkidle" })
    );
    expect(mockPage.fill).toHaveBeenCalledWith('input[type="email"]', expect.stringContaining("smoke-test+"));
    // No pixel configured — never sets up the fbq-call interception or the beacon block.
    expect(mockPage.exposeFunction).not.toHaveBeenCalled();
    expect(mockPage.addInitScript).not.toHaveBeenCalled();
    expect(mockContext.newCDPSession).not.toHaveBeenCalled();
    expect(mockDeleteLead).toHaveBeenCalledWith("list-1", "lead-abc");
    expect(mockSendLandingPageSmokeTestAlert).not.toHaveBeenCalled();
    expect(mockBrowser.close).toHaveBeenCalled();

    const result = mockUpdateLandingPageSmokeTestResult.mock.calls[0][1];
    expect(result.ok).toBe(true);
    expect(result.leadCaptured).toBe(true);
    expect(result.pixelFired).toBeUndefined();
  });

  it("SUCCESS: lead lands + pixel fires (fbq('track','Lead',...) call observed) → ok:true", async () => {
    mockGetLeadByEmail.mockResolvedValueOnce({ leadId: "lead-abc" });
    mockPage.click.mockImplementationOnce(async () => {
      // Simulate the page's own JS calling fbq('track','Lead',...) on submit — the real
      // implementation detects this via an exposed function + addInitScript proxy, not by
      // sniffing network requests (Meta's actual beacon transport isn't reliably visible
      // to page.on('request') in headless Chromium — verified live against a real page).
      exposedFbqReporter?.("track:Lead");
    });

    await runGenerationSmokeTest({ ...BASE_PAGE, metaPixelId: "123456" });

    const result = mockUpdateLandingPageSmokeTestResult.mock.calls[0][1];
    expect(result.ok).toBe(true);
    expect(result.pixelFired).toBe(true);
    expect(mockSendLandingPageSmokeTestAlert).not.toHaveBeenCalled();
    // The real beacon is blocked (via CDP Network.setBlockedURLs — verified live that
    // page.route() does NOT actually intercept this request type) so no fake conversion
    // ever reaches the customer's real ad account — verification relies on the JS-call
    // interception alone, not on the beacon actually reaching Meta.
    expect(mockCdpSession.send).toHaveBeenCalledWith("Network.setBlockedURLs", {
      urls: ["*facebook.com/tr*"],
    });
  });

  it("FAIL: pixel configured but fbq('track','Lead',...) never observed → ok:false, Slack alert sent", async () => {
    mockGetLeadByEmail.mockResolvedValueOnce({ leadId: "lead-abc" });
    // exposedFbqReporter is never invoked — pixel call never observed.

    await runGenerationSmokeTest({ ...BASE_PAGE, metaPixelId: "123456" });

    const result = mockUpdateLandingPageSmokeTestResult.mock.calls[0][1];
    expect(result.ok).toBe(false);
    expect(result.pixelFired).toBe(false);
    expect(result.leadCaptured).toBe(true);
    expect(mockSendLandingPageSmokeTestAlert).toHaveBeenCalledWith(
      "page-1",
      "https://test-page.vercel.app",
      expect.stringContaining("pixel")
    );
  });

  it("FAIL: lead never lands in the CRM within the timeout → ok:false, Slack alert sent, lead-list untouched", async () => {
    mockGetLeadByEmail.mockResolvedValue(null); // never found, every poll attempt

    await runGenerationSmokeTest({ ...BASE_PAGE });

    expect(mockDeleteLead).not.toHaveBeenCalled();
    const result = mockUpdateLandingPageSmokeTestResult.mock.calls[0][1];
    expect(result.ok).toBe(false);
    expect(result.leadCaptured).toBe(false);
    expect(mockSendLandingPageSmokeTestAlert).toHaveBeenCalledWith(
      "page-1",
      "https://test-page.vercel.app",
      expect.stringContaining("CRM")
    );
  });

  it("FAIL: browser launch itself throws → caught, ok:false, Slack alert sent, function still resolves", async () => {
    mockLaunch.mockRejectedValueOnce(new Error("Chrome crashed"));

    await expect(runGenerationSmokeTest({ ...BASE_PAGE })).resolves.toBeUndefined();

    const result = mockUpdateLandingPageSmokeTestResult.mock.calls[0][1];
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Chrome crashed/);
    expect(mockSendLandingPageSmokeTestAlert).toHaveBeenCalledWith(
      "page-1",
      "https://test-page.vercel.app",
      expect.stringContaining("Chrome crashed")
    );
  });

  it("FAIL: no Chrome executable found → caught, ok:false, browser never launched", async () => {
    const { findChromeExecutable } = require("../utils/browserUtils");
    (findChromeExecutable as jest.Mock).mockReturnValueOnce(undefined);

    await runGenerationSmokeTest({ ...BASE_PAGE });

    expect(mockLaunch).not.toHaveBeenCalled();
    const result = mockUpdateLandingPageSmokeTestResult.mock.calls[0][1];
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/No Chrome executable found/);
  });

  it("SUCCESS: form has no submit button → falls back to pressing Enter", async () => {
    mockGetLeadByEmail.mockResolvedValueOnce({ leadId: "lead-abc" });
    mockPage.click.mockRejectedValueOnce(new Error("no button found"));

    await runGenerationSmokeTest({ ...BASE_PAGE });

    expect(mockPage.press).toHaveBeenCalledWith('input[type="email"]', "Enter");
    const result = mockUpdateLandingPageSmokeTestResult.mock.calls[0][1];
    expect(result.ok).toBe(true);
  });

  it("SUCCESS (concurrency cap): with max=1, a second smoke test never launches Chrome until the first one's browser closes", async () => {
    setSmokeTestConcurrency(1);
    mockGetLeadByEmail.mockResolvedValue({ leadId: "lead-abc" });

    const events: string[] = [];
    let resolveFirstClose!: () => void;
    mockLaunch
      .mockImplementationOnce(async () => {
        events.push("launch-1");
        return {
          newPage: () => Promise.resolve(mockPage),
          close: () => new Promise<void>((resolve) => { resolveFirstClose = () => { events.push("close-1"); resolve(); }; }),
        };
      })
      .mockImplementationOnce(async () => {
        events.push("launch-2");
        return mockBrowser;
      });

    const p1 = runGenerationSmokeTest({ ...BASE_PAGE, id: "page-1" });
    const p2 = runGenerationSmokeTest({ ...BASE_PAGE, id: "page-2" });

    // Give p1 a moment to reach its (still-pending) browser.close() call.
    await new Promise((r) => setTimeout(r, 20));
    expect(events).toEqual(["launch-1"]); // launch-2 must NOT have happened yet

    resolveFirstClose();
    await Promise.all([p1, p2]);

    expect(events).toEqual(["launch-1", "close-1", "launch-2"]);
  });
});
