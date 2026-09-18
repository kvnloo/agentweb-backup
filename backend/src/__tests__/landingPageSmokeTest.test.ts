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
  // No navigation after submit by default — exercises the CRM-poll path.
  url: jest.fn().mockReturnValue("https://test-page.vercel.app"),
  waitForURL: jest.fn().mockRejectedValue(new Error("no navigation")),
  fill: jest.fn().mockResolvedValue(undefined),
  click: jest.fn().mockResolvedValue(undefined),
  press: jest.fn().mockResolvedValue(undefined),
  selectOption: jest.fn().mockResolvedValue(undefined),
  check: jest.fn().mockResolvedValue(undefined),
  // Minimal single-email-field lander by default — mirrors the original tests.
  evaluate: jest.fn().mockResolvedValue({
    textInputs: ['input[type="email"]'],
    telInputs: [],
    otherTexts: [],
    selects: [],
    checkables: [],
  }),
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

  it("SUCCESS: form has no submit button in first form → requestSubmit on the first form (never a page-wide retry)", async () => {
    mockGetLeadByEmail.mockResolvedValueOnce({ leadId: "lead-abc" });
    // Scoped click misses (no actionable submit control on the first form);
    // a <form> exists, so the code submits it directly — the unscoped
    // page-wide click must NOT run (it could hit another form's button).
    mockPage.click.mockRejectedValueOnce(new Error("no button in first form"));

    await runGenerationSmokeTest({ ...BASE_PAGE });

    expect(mockPage.click).toHaveBeenCalledWith(
      'form >> nth=0 >> button[type="submit"], form >> nth=0 >> input[type="submit"]'
    );
    expect(mockPage.click).toHaveBeenCalledTimes(1);
    // Discovery evaluate ran during field-fill; one more evaluate checks for a
    // <form> (exists → requestSubmit), then requestSubmit runs it directly.
    expect(mockPage.evaluate).toHaveBeenCalledTimes(3);
    expect(mockPage.press).not.toHaveBeenCalled();
    const result = mockUpdateLandingPageSmokeTestResult.mock.calls[0][1];
    expect(result.ok).toBe(true);
  });

  it("SUCCESS: form has no submit button at all → submits the form directly", async () => {
    mockGetLeadByEmail.mockResolvedValueOnce({ leadId: "lead-abc" });
    // Force the scoped click to miss. The shared default evaluate mock resolves
    // the discovery object (truthy), so the <form>-exists branch runs
    // requestSubmit directly and the Enter fallback never fires.
    mockPage.click.mockRejectedValue(new Error("no button found"));

    await runGenerationSmokeTest({ ...BASE_PAGE });

    expect(mockPage.evaluate).toHaveBeenCalled();
    expect(mockPage.press).not.toHaveBeenCalled();
    const result = mockUpdateLandingPageSmokeTestResult.mock.calls[0][1];
    expect(result.ok).toBe(true);
  });

  it("SUCCESS: submit click scoped to first form (second form's button ignored)", async () => {
    mockGetLeadByEmail.mockResolvedValueOnce({ leadId: "lead-abc" });

    await runGenerationSmokeTest({ ...BASE_PAGE });

    // The first click attempt targets the discovered first form, never a
    // page-wide selector that could hit another form's submit control.
    expect(mockPage.click).toHaveBeenNthCalledWith(
      1,
      'form >> nth=0 >> button[type="submit"], form >> nth=0 >> input[type="submit"]'
    );
    const result = mockUpdateLandingPageSmokeTestResult.mock.calls[0][1];
    expect(result.ok).toBe(true);
  });

  it("SUCCESS: no form element either → bare click miss falls back to Enter in last filled text field", async () => {
    mockGetLeadByEmail.mockResolvedValueOnce({ leadId: "lead-abc" });
    // Discovery resolves (records the email selector); the form-presence
    // evaluate returns false (no <form>), so the else branch's bare click also
    // misses and the fallback presses Enter in the last filled text field.
    (mockPage.evaluate as jest.Mock)
      .mockResolvedValueOnce({
        textInputs: ['input[type="email"]'],
        telInputs: [],
        otherTexts: [],
        selects: [],
        checkables: [],
      })
      .mockResolvedValueOnce(false);
    mockPage.click
      .mockRejectedValueOnce(new Error("no scoped button"))
      .mockRejectedValueOnce(new Error("no bare button"));

    await runGenerationSmokeTest({ ...BASE_PAGE });

    expect(mockPage.press).toHaveBeenCalledWith('input[type="email"]', "Enter");
  });

  it("SUCCESS: React multi-field form (name/phone/zip + selects + checkboxes) → fills all fields, lead lands → ok:true", async () => {
    // Mirrors campaign.waterheater.app root 2026-09-18: the old fill-email-only path
    // left client-side validation failing so submit never fired (false-negative FAIL).
    (mockPage.evaluate as jest.Mock).mockResolvedValueOnce({
      textInputs: [],
      telInputs: ["#phone"],
      otherTexts: ['#full_name', '#zip'],
      selects: [
        { selector: "#urgency", options: ["emergency", "tomorrow"] },
        { selector: "#heater_type", options: ["gas", "electric"] },
      ],
      checkables: [
        { selector: "#symptom-no_hot_water", type: "checkbox", name: "symptom", required: true },
        { selector: "#symptom-leak", type: "checkbox", name: "symptom", required: true },
        { selector: "#plan-basic", type: "radio", name: "plan", required: true },
        { selector: "#plan-plus", type: "radio", name: "plan", required: true },
        { selector: "#opt-news", type: "checkbox", name: "news", required: false },
      ],
    });
    mockGetLeadByEmail.mockResolvedValueOnce({ leadId: "lead-abc" });

    await runGenerationSmokeTest({ ...BASE_PAGE });

    expect(mockPage.fill).toHaveBeenCalledWith("#phone", expect.stringMatching(/^41555501\d{2}$/));
    expect(mockPage.fill).toHaveBeenCalledWith("#full_name", "Smoke");
    expect(mockPage.fill).toHaveBeenCalledWith("#zip", "94025");
    expect(mockPage.selectOption).toHaveBeenCalledWith("#urgency", "emergency");
    expect(mockPage.selectOption).toHaveBeenCalledWith("#heater_type", "gas");
    // Every required checkbox + one radio per required group; optional untouched.
    expect(mockPage.check).toHaveBeenCalledWith("#symptom-no_hot_water");
    expect(mockPage.check).toHaveBeenCalledWith("#symptom-leak");
    expect(mockPage.check).toHaveBeenCalledWith("#plan-basic");
    expect(mockPage.check).not.toHaveBeenCalledWith("#plan-plus");
    expect(mockPage.check).not.toHaveBeenCalledWith("#opt-news");
    expect(mockDeleteLead).toHaveBeenCalledWith("list-1", "lead-abc");
    expect(mockSendLandingPageSmokeTestAlert).not.toHaveBeenCalled();
    const result = mockUpdateLandingPageSmokeTestResult.mock.calls[0][1];
    expect(result.ok).toBe(true);
    expect(result.leadCaptured).toBe(true);
  });

  it("SUCCESS: URL/website text field gets a URL-shaped value", async () => {
    (mockPage.evaluate as jest.Mock).mockResolvedValueOnce({
      textInputs: [],
      telInputs: [],
      otherTexts: ['#company_website'],
      selects: [],
      checkables: [],
    });
    mockGetLeadByEmail.mockResolvedValueOnce({ leadId: "lead-abc" });

    await runGenerationSmokeTest({ ...BASE_PAGE });

    expect(mockPage.fill).toHaveBeenCalledWith("#company_website", "https://example.com");
  });

  it("SUCCESS: name-only control uses a [name=...] selector, not #name", async () => {
    // A checkbox-only mock shape (plain strings, no required info) still works
    // via the best-effort fallback.
    (mockPage.evaluate as jest.Mock).mockResolvedValueOnce({
      textInputs: [],
      telInputs: [],
      otherTexts: ['[name="company"]'],
      selects: [],
      checkables: ["#legacy-box"],
    });
    mockGetLeadByEmail.mockResolvedValueOnce({ leadId: "lead-abc" });

    await runGenerationSmokeTest({ ...BASE_PAGE });

    expect(mockPage.fill).toHaveBeenCalledWith('[name="company"]', "Smoke");
    expect(mockPage.check).toHaveBeenCalledWith("#legacy-box");
  });

  it("SUCCESS: chat-handoff form redirects with handoff_id instead of a CRM row → ok:true without polling", async () => {
    // Mirrors campaign.waterheater.app root 2026-09-18: POST /api/hero-estimate returns
    // { handoff_id } and redirects to chat.waterheater.app/text — no CRM lead row exists
    // to poll for, so pollForLead would always miss even though the pipeline worked.
    (mockPage.evaluate as jest.Mock).mockResolvedValueOnce({
      textInputs: [],
      telInputs: ["phone"],
      otherTexts: ["full_name", "zip"],
      selects: [],
      checkables: [],
    });
    (mockPage.waitForURL as jest.Mock).mockResolvedValueOnce(undefined);
    (mockPage.url as jest.Mock)
      .mockReturnValueOnce("https://campaign.waterheater.app/")
      .mockReturnValueOnce("https://chat.waterheater.app/text?handoff_id=abc123");

    await runGenerationSmokeTest({ ...BASE_PAGE });

    expect(mockGetLeadByEmail).not.toHaveBeenCalled();
    expect(mockDeleteLead).not.toHaveBeenCalled();
    expect(mockSendLandingPageSmokeTestAlert).not.toHaveBeenCalled();
    const result = mockUpdateLandingPageSmokeTestResult.mock.calls[0][1];
    expect(result.ok).toBe(true);
    expect(result.leadCaptured).toBe(true);
    // Handoff evidence is persisted so it can be verified against the chat backend.
    expect(result.handoffId).toBe("abc123");
  });

  it("FAIL: same-origin handoff_id URL still polls the CRM (no optimistic read of our own hop)", async () => {
    (mockPage.waitForURL as jest.Mock).mockResolvedValueOnce(undefined);
    (mockPage.url as jest.Mock)
      .mockReturnValueOnce("https://campaign.waterheater.app/")
      // Same origin with a REAL handoff_id param — still polls, because only a
      // cross-origin hop proves the pipeline left the deployed origin.
      .mockReturnValueOnce("https://campaign.waterheater.app/text?handoff_id=abc123");
    mockGetLeadByEmail.mockResolvedValue(null); // never found

    await runGenerationSmokeTest({ ...BASE_PAGE });

    expect(mockGetLeadByEmail).toHaveBeenCalled(); // not treated as a handoff
    const result = mockUpdateLandingPageSmokeTestResult.mock.calls[0][1];
    expect(result.ok).toBe(false);
    expect(result.handoffId).toBeUndefined();
  });

  it("FAIL: handoff-looking text nested inside another param's value still polls the CRM (no regex false pass)", async () => {
    (mockPage.waitForURL as jest.Mock).mockResolvedValueOnce(undefined);
    (mockPage.url as jest.Mock)
      .mockReturnValueOnce("https://campaign.waterheater.app/")
      // Cross-origin, but handoff_id appears only inside next's encoded value —
      // searchParams.get("handoff_id") is null, so this must poll the CRM.
      .mockReturnValueOnce("https://chat.waterheater.app/text?next=%2Ftext%3Fhandoff_id%3Dabc123");
    mockGetLeadByEmail.mockResolvedValue(null); // never found

    await runGenerationSmokeTest({ ...BASE_PAGE });

    expect(mockGetLeadByEmail).toHaveBeenCalled(); // not treated as a handoff
    const result = mockUpdateLandingPageSmokeTestResult.mock.calls[0][1];
    expect(result.ok).toBe(false);
    expect(result.handoffId).toBeUndefined();
  });

  it("FAIL: cross-origin navigation without handoff_id still polls the CRM", async () => {
    (mockPage.waitForURL as jest.Mock).mockResolvedValueOnce(undefined);
    (mockPage.url as jest.Mock)
      .mockReturnValueOnce("https://test-page.vercel.app")
      .mockReturnValueOnce("https://other.example.com/thanks");
    mockGetLeadByEmail.mockResolvedValue(null); // never found

    await runGenerationSmokeTest({ ...BASE_PAGE });

    expect(mockGetLeadByEmail).toHaveBeenCalled(); // not treated as a handoff
    const result = mockUpdateLandingPageSmokeTestResult.mock.calls[0][1];
    expect(result.ok).toBe(false);
    expect(result.handoffId).toBeUndefined();
  });

  it("FAIL: navigation without handoff_id still polls the CRM (no false pass on anchor scrolls)", async () => {
    (mockPage.waitForURL as jest.Mock).mockResolvedValueOnce(undefined);
    (mockPage.url as jest.Mock)
      .mockReturnValueOnce("https://test-page.vercel.app")
      .mockReturnValueOnce("https://test-page.vercel.app#pricing");
    mockGetLeadByEmail.mockResolvedValue(null); // never found

    await runGenerationSmokeTest({ ...BASE_PAGE });

    expect(mockGetLeadByEmail).toHaveBeenCalled();
    const result = mockUpdateLandingPageSmokeTestResult.mock.calls[0][1];
    expect(result.ok).toBe(false);
    expect(result.leadCaptured).toBe(false);
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
