/**
 * ENG-449 gap #3: automated post-deploy Playwright smoke test.
 * Mocks `playwright` the same way cssExtractor.test.ts / linkedInService.test.ts already
 * mock `puppeteer-core` — established convention in this repo.
 *
 * NOTE: page.evaluate is mocked here, so the page-side field DISCOVERY never executes in
 * this file — it is unit-tested against a real DOM in landingPageSmokeTest.discovery.test.ts.
 * These tests cover the Node-side decisions: value choice, submit fallbacks, what counts
 * as a capture, and what the failure reason says.
 */

// Captures the callback passed to exposeFunction("__smokeTestReportFbqCall", cb) so tests
// can simulate the page's JS calling fbq('track','Lead',...) by invoking it directly —
// mirrors how the real implementation detects the call (see landingPageSmokeTest.ts).
let exposedFbqReporter: ((event: string) => void) | undefined;
// Captures page.on("response", cb) so tests can simulate the form's own submit response —
// the evidence the implementation requires before trusting a handoff redirect.
let responseListener: ((response: any) => void) | undefined;

/** Every value the run has typed into the page so far. */
const filledValues = () => (mockPage.fill as jest.Mock).mock.calls.map((c) => c[1]);
/** A request body carrying the run's own synthetic data — what real capture evidence looks like. */
const ourPayload = () => JSON.stringify({ values: filledValues() });

/**
 * Simulate one response arriving on the page. Defaults to what a genuine capture looks
 * like: a same-origin POST, final 2xx, body carrying this run's synthetic data.
 */
function emitResponse({
  url = "https://test-page.vercel.app/api/capture",
  status = 200,
  method = "POST",
  body,
}: { url?: string; status?: number; method?: string; body?: string | null } = {}) {
  const postData = body === undefined ? ourPayload() : body;
  responseListener?.({
    url: () => url,
    status: () => status,
    request: () => ({ method: () => method, postData: () => postData }),
  });
}

/** The default single-email-field lander shape returned by the mocked discovery. */
const SINGLE_EMAIL_FIELD = {
  scope: 'form[data-agentweb-smoke-form="1"] ',
  fields: [
    {
      selector: 'form[data-agentweb-smoke-form="1"] [id="email"]',
      hint: "email",
      kind: "email",
    },
  ],
  selects: [],
  checkables: [],
  submitSelector: null,
  disclosureTriggers: [],
  skippedRequired: 0,
  noFormOnPage: false,
  authFormOnly: false,
  iframeCount: 0,
};

const mockCdpSession = { send: jest.fn().mockResolvedValue(undefined) };
const mockContext = { newCDPSession: jest.fn().mockResolvedValue(mockCdpSession) };
const mockPage = {
  on: jest.fn((event: string, fn: (response: any) => void) => {
    if (event === "response") responseListener = fn;
  }),
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
  evaluate: jest.fn().mockResolvedValue(SINGLE_EMAIL_FIELD),
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
const mockGetLeadsByListId = jest.fn();
jest.mock("../services/db", () => ({
  crmDb: {
    getLeadByEmail: (...args: any[]) => mockGetLeadByEmail(...args),
    deleteLead: (...args: any[]) => mockDeleteLead(...args),
    getLeadsByListId: (...args: any[]) => mockGetLeadsByListId(...args),
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

import {
  runGenerationSmokeTest,
  setSmokeTestPollConfig,
  setSmokeTestConcurrency,
  syntheticValueFor,
} from "../services/landingPageSmokeTest";

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
    mockGetLeadByEmail.mockReset();
    mockGetLeadByEmail.mockResolvedValue(null);
    mockGetLeadsByListId.mockReset();
    mockGetLeadsByListId.mockResolvedValue({ items: [], lastEvaluatedKey: null, hasMore: false });
    (mockPage.evaluate as jest.Mock).mockResolvedValue(SINGLE_EMAIL_FIELD);
    (mockPage.url as jest.Mock).mockReturnValue("https://test-page.vercel.app");
    (mockPage.waitForURL as jest.Mock).mockRejectedValue(new Error("no navigation"));
    exposedFbqReporter = undefined;
    responseListener = undefined;
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
    expect(mockPage.fill).toHaveBeenCalledWith(
      'form[data-agentweb-smoke-form="1"] [id="email"]',
      expect.stringContaining("smoke-test+"),
      expect.objectContaining({ timeout: expect.any(Number) })
    );
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

  it("FAIL: pixel configured but fbq('track','Lead',...) never observed → ok:false, alert names the fbq call, not a network request", async () => {
    mockGetLeadByEmail.mockResolvedValueOnce({ leadId: "lead-abc" });
    // exposedFbqReporter is never invoked — pixel call never observed.

    await runGenerationSmokeTest({ ...BASE_PAGE, metaPixelId: "123456" });

    const result = mockUpdateLandingPageSmokeTestResult.mock.calls[0][1];
    expect(result.ok).toBe(false);
    expect(result.pixelFired).toBe(false);
    expect(result.leadCaptured).toBe(true);
    const reason = mockSendLandingPageSmokeTestAlert.mock.calls[0][2];
    expect(reason).toContain("fbq('track','Lead')");
    // Detection stopped being a network sniff; the alert must not send an engineer
    // looking for a request this test never watches.
    expect(reason).not.toContain("facebook.com/tr");
  });

  it("FAIL: lead never lands in the CRM → ok:false, alert carries submit diagnostics, lead-list untouched", async () => {
    await runGenerationSmokeTest({ ...BASE_PAGE });

    expect(mockDeleteLead).not.toHaveBeenCalled();
    const result = mockUpdateLandingPageSmokeTestResult.mock.calls[0][1];
    expect(result.ok).toBe(false);
    expect(result.leadCaptured).toBe(false);
    const reason = mockSendLandingPageSmokeTestAlert.mock.calls[0][2];
    expect(reason).toContain("CRM");
    // The diagnostics are the whole point: "never submitted" and "submitted, lead lost"
    // used to produce the identical string.
    expect(reason).toContain("filled 1/1 field(s)");
    expect(reason).toContain("submit=click");
    expect(reason).toContain("no navigation");
    expect(reason).toContain("capture response accepted=false");
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

  it("SUBMIT: the submit button is scoped to the form that was filled", async () => {
    mockGetLeadByEmail.mockResolvedValueOnce({ leadId: "lead-abc" });

    await runGenerationSmokeTest({ ...BASE_PAGE });

    // A newsletter/search form earlier in the DOM must not be the one we click.
    expect(mockPage.click).toHaveBeenCalledWith(
      'form[data-agentweb-smoke-form="1"] button[type="submit"], form[data-agentweb-smoke-form="1"] input[type="submit"]',
      expect.objectContaining({ timeout: expect.any(Number) })
    );
  });

  it("SUCCESS: no submit button but a <form> exists → requestSubmit() reports true, Enter never pressed", async () => {
    mockGetLeadByEmail.mockResolvedValueOnce({ leadId: "lead-abc" });
    mockPage.click.mockRejectedValueOnce(new Error("no button found"));
    (mockPage.evaluate as jest.Mock)
      .mockResolvedValueOnce(SINGLE_EMAIL_FIELD) // discovery
      .mockResolvedValueOnce(true); // requestSubmit ran

    await runGenerationSmokeTest({ ...BASE_PAGE });

    expect(mockPage.press).not.toHaveBeenCalled();
    const result = mockUpdateLandingPageSmokeTestResult.mock.calls[0][1];
    expect(result.ok).toBe(true);
  });

  it("SUCCESS: div-based form with no <form> element → requestSubmit() reports false → Enter in the last filled field", async () => {
    // The regression this covers: `document.querySelector("form")?.requestSubmit()` RESOLVES
    // on a page with no form (optional chaining returns undefined rather than throwing), so
    // a catch-based chain never reached this fallback — the click timed out, the evaluate
    // no-opped, and nothing was ever submitted.
    mockGetLeadByEmail.mockResolvedValueOnce({ leadId: "lead-abc" });
    mockPage.click.mockRejectedValueOnce(new Error("no button found"));
    (mockPage.evaluate as jest.Mock)
      .mockResolvedValueOnce(SINGLE_EMAIL_FIELD) // discovery
      .mockResolvedValueOnce(false); // no <form> to requestSubmit

    await runGenerationSmokeTest({ ...BASE_PAGE });

    expect(mockPage.press).toHaveBeenCalledWith(
      'form[data-agentweb-smoke-form="1"] [id="email"]',
      "Enter",
      expect.objectContaining({ timeout: expect.any(Number) })
    );
  });

  it("SUBMIT: nothing fillable and no submit button → submit=none is reported, not silently swallowed", async () => {
    (mockPage.evaluate as jest.Mock)
      .mockResolvedValueOnce({ scope: "", fields: [], selects: [], checkables: [] })
      .mockResolvedValueOnce(false);
    mockPage.click.mockRejectedValueOnce(new Error("no button found"));

    await runGenerationSmokeTest({ ...BASE_PAGE });

    expect(mockPage.press).not.toHaveBeenCalled();
    const reason = mockSendLandingPageSmokeTestAlert.mock.calls[0][2];
    expect(reason).toContain("submit=none");
    expect(reason).toContain("no email field to poll by");
  });

  it("SUCCESS: React multi-field form (name/phone/zip + selects + checkboxes) → fills all fields, lead lands → ok:true", async () => {
    // Mirrors campaign.waterheater.app root 2026-09-18: the old fill-email-only path
    // left client-side validation failing so submit never fired (false-negative FAIL).
    (mockPage.evaluate as jest.Mock).mockResolvedValueOnce({
      scope: 'form[data-agentweb-smoke-form="1"] ',
      fields: [
        { selector: "#phone", hint: "phone", kind: "tel" },
        { selector: "#full_name", hint: "full_name your name", kind: "text" },
        { selector: "#zip", hint: "zip postal-code", kind: "text" },
        { selector: "#notes", hint: "notes tell us about the problem", kind: "textarea" },
      ],
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
      submitSelector: null,
      disclosureTriggers: [],
      skippedRequired: 0,
      noFormOnPage: false,
      authFormOnly: false,
      iframeCount: 0,
    });
    mockGetLeadByEmail.mockResolvedValueOnce({ leadId: "lead-abc" });

    await runGenerationSmokeTest({ ...BASE_PAGE });

    const filled = (selector: string) =>
      (mockPage.fill as jest.Mock).mock.calls.find((c) => c[0] === selector)?.[1];
    // 415-555-0100..0199: the NANP's reserved fictional range inside a REAL area code.
    // A bare 555 area code is unassignable and libphonenumber-style validators reject it;
    // an arbitrary 555-XXXX line can be live (555-1212 is directory assistance).
    expect(filled("#phone")).toMatch(/^41555501\d{2}$/);
    expect(filled("#full_name")).toBe("Smoke Test");
    expect(filled("#zip")).toBe("94025");
    expect(filled("#notes")).toBe("Smoke Test");
    expect(mockPage.selectOption).toHaveBeenCalledWith(
      "#urgency",
      "emergency",
      expect.objectContaining({ timeout: expect.any(Number) })
    );
    expect(mockPage.selectOption).toHaveBeenCalledWith(
      "#heater_type",
      "gas",
      expect.objectContaining({ timeout: expect.any(Number) })
    );
    // Every required checkbox + one radio per required group; optional untouched.
    const checked = (mockPage.check as jest.Mock).mock.calls.map((c) => c[0]);
    expect(checked).toEqual(
      expect.arrayContaining(["#symptom-no_hot_water", "#symptom-leak", "#plan-basic"])
    );
    expect(checked).not.toContain("#plan-plus");
    expect(checked).not.toContain("#opt-news");
    // No email field on this form, so cleanup goes through the phone path instead of the
    // email poll. The list is empty here, so there is nothing to delete.
    expect(mockGetLeadByEmail).not.toHaveBeenCalled();
    expect(mockGetLeadsByListId).toHaveBeenCalled();
    const result = mockUpdateLandingPageSmokeTestResult.mock.calls[0][1];
    expect(result.ok).toBe(false);
    expect(result.leadCaptured).toBe(false);
  });

  it("VALUES: a name-based selector no longer drags every field into the person-name branch", () => {
    // The bug this locks out: the chooser matched on the SELECTOR, and every
    // `[name="..."]` selector contains the substring "name", so `[name="zip"]` was filled
    // with "Smoke" and failed the lander's own \d{5} pattern.
    const v = (hint: string, kind = "text") =>
      syntheticValueFor({ selector: `[name="${hint}"]`, hint, kind }, "smoke@x.test", "4155550100");
    expect(v("zip")).toBe("94025");
    expect(v("postal_code")).toBe("94025");
    expect(v("company_website")).toBe("https://example.com");
    expect(v("email")).toBe("smoke@x.test");
    expect(v("phone")).toBe("4155550100");
    expect(v("first_name")).toBe("Smoke");
    expect(v("last_name")).toBe("Test");
    expect(v("full_name")).toBe("Smoke Test");
    expect(v("company")).toBe("Smoke Test");
    // autocomplete tokens are part of the hint and must route the same way
    expect(v("postal-code")).toBe("94025");
    expect(v("family-name")).toBe("Test");
    expect(v("given-name")).toBe("Smoke");
  });

  it("SUCCESS: chat-handoff redirect BACKED BY an accepted capture response → ok:true", async () => {
    // Mirrors campaign.waterheater.app root 2026-09-18: POST /api/hero-estimate returns
    // { handoff_id } and redirects to chat.waterheater.app/text — no CRM lead row exists
    // to poll for, so pollForLead would always miss even though the pipeline worked.
    (mockPage.evaluate as jest.Mock).mockResolvedValueOnce({
      scope: "",
      fields: [
        { selector: "#phone", hint: "phone", kind: "tel" },
        { selector: "#full_name", hint: "full_name", kind: "text" },
      ],
      selects: [],
      checkables: [],
      submitSelector: null,
      disclosureTriggers: [],
      skippedRequired: 0,
      noFormOnPage: false,
      authFormOnly: false,
      iframeCount: 0,
    });
    mockPage.click.mockImplementationOnce(async () => {
      emitResponse({ url: "https://campaign.waterheater.app/api/hero-estimate", status: 200 });
    });
    (mockPage.waitForURL as jest.Mock).mockResolvedValueOnce(undefined);
    (mockPage.url as jest.Mock)
      .mockReturnValueOnce("https://campaign.waterheater.app/")
      .mockReturnValueOnce("https://chat.waterheater.app/text?handoff_id=abc123");

    await runGenerationSmokeTest({ ...BASE_PAGE });

    expect(mockSendLandingPageSmokeTestAlert).not.toHaveBeenCalled();
    // Cleanup still runs on the handoff path — by phone here, since the form has no email.
    expect(mockGetLeadsByListId).toHaveBeenCalled();
    const result = mockUpdateLandingPageSmokeTestResult.mock.calls[0][1];
    expect(result.ok).toBe(true);
    expect(result.leadCaptured).toBe(true);
    // The id is persisted so the handoff can be checked against the chat backend by hand.
    expect(result.handoffId).toBe("abc123");
  });

  it("FAIL (no false pass): handoff redirect with NO accepted capture response → ok:false", async () => {
    // The dangerous case: a lander whose `await fetch(...).catch(() => {})` swallows a 500
    // and redirects anyway. The URL still carries handoff_id, so URL evidence alone would
    // mark a silently-broken capture endpoint as passing on every deploy, forever.
    (mockPage.evaluate as jest.Mock).mockResolvedValueOnce({
      scope: "",
      fields: [{ selector: "#phone", hint: "phone", kind: "tel" }],
      selects: [],
      checkables: [],
      submitSelector: null,
      disclosureTriggers: [],
      skippedRequired: 0,
      noFormOnPage: false,
      authFormOnly: false,
      iframeCount: 0,
    });
    mockPage.click.mockImplementationOnce(async () => {
      emitResponse({ url: "https://campaign.waterheater.app/api/hero-estimate", status: 500 });
    });
    (mockPage.waitForURL as jest.Mock).mockResolvedValueOnce(undefined);
    (mockPage.url as jest.Mock)
      .mockReturnValueOnce("https://campaign.waterheater.app/")
      .mockReturnValueOnce("https://chat.waterheater.app/text?handoff_id=abc123");

    await runGenerationSmokeTest({ ...BASE_PAGE });

    const result = mockUpdateLandingPageSmokeTestResult.mock.calls[0][1];
    expect(result.ok).toBe(false);
    expect(result.leadCaptured).toBe(false);
    expect(mockSendLandingPageSmokeTestAlert).toHaveBeenCalled();
  });

  it("FAIL (no false pass): a cross-origin analytics POST is not capture evidence", async () => {
    (mockPage.evaluate as jest.Mock).mockResolvedValueOnce({
      scope: "",
      fields: [{ selector: "#phone", hint: "phone", kind: "tel" }],
      selects: [],
      checkables: [],
      submitSelector: null,
      disclosureTriggers: [],
      skippedRequired: 0,
      noFormOnPage: false,
      authFormOnly: false,
      iframeCount: 0,
    });
    mockPage.click.mockImplementationOnce(async () => {
      emitResponse({ url: "https://api.segment.io/v1/track", status: 200 });
    });
    (mockPage.waitForURL as jest.Mock).mockResolvedValueOnce(undefined);
    (mockPage.url as jest.Mock)
      .mockReturnValueOnce("https://campaign.waterheater.app/")
      .mockReturnValueOnce("https://chat.waterheater.app/text?handoff_id=abc123");

    await runGenerationSmokeTest({ ...BASE_PAGE });

    expect(mockUpdateLandingPageSmokeTestResult.mock.calls[0][1].ok).toBe(false);
  });

  it("FAIL (no false pass): a handoff_id already in the deployed URL can't pass on its own", async () => {
    (mockPage.evaluate as jest.Mock).mockResolvedValueOnce({
      scope: "",
      fields: [{ selector: "#phone", hint: "phone", kind: "tel" }],
      selects: [],
      checkables: [],
      submitSelector: null,
      disclosureTriggers: [],
      skippedRequired: 0,
      noFormOnPage: false,
      authFormOnly: false,
      iframeCount: 0,
    });
    mockPage.click.mockImplementationOnce(async () => {
      emitResponse({ url: "https://campaign.waterheater.app/api/x", status: 200 });
    });
    (mockPage.waitForURL as jest.Mock).mockResolvedValueOnce(undefined);
    (mockPage.url as jest.Mock)
      .mockReturnValueOnce("https://campaign.waterheater.app/?handoff_id=preexisting")
      .mockReturnValueOnce("https://chat.waterheater.app/text?handoff_id=preexisting");

    await runGenerationSmokeTest({ ...BASE_PAGE });

    expect(mockUpdateLandingPageSmokeTestResult.mock.calls[0][1].ok).toBe(false);
  });

  it("FAIL (no false pass): handoff_id as a bare substring, not a real query param, is ignored", async () => {
    (mockPage.evaluate as jest.Mock).mockResolvedValueOnce({
      scope: "",
      fields: [{ selector: "#phone", hint: "phone", kind: "tel" }],
      selects: [],
      checkables: [],
      submitSelector: null,
      disclosureTriggers: [],
      skippedRequired: 0,
      noFormOnPage: false,
      authFormOnly: false,
      iframeCount: 0,
    });
    mockPage.click.mockImplementationOnce(async () => {
      emitResponse({ url: "https://campaign.waterheater.app/api/x", status: 200 });
    });
    (mockPage.waitForURL as jest.Mock).mockResolvedValueOnce(undefined);
    (mockPage.url as jest.Mock)
      .mockReturnValueOnce("https://campaign.waterheater.app/")
      .mockReturnValueOnce("https://chat.waterheater.app/thanks?utm_content=handoff_id%3D1");

    await runGenerationSmokeTest({ ...BASE_PAGE });

    expect(mockUpdateLandingPageSmokeTestResult.mock.calls[0][1].ok).toBe(false);
  });

  it("FAIL (no false pass): a SAME-origin redirect carrying handoff_id is not a handoff", async () => {
    (mockPage.evaluate as jest.Mock).mockResolvedValueOnce({
      scope: "",
      fields: [{ selector: "#phone", hint: "phone", kind: "tel" }],
      selects: [],
      checkables: [],
      submitSelector: null,
      disclosureTriggers: [],
      skippedRequired: 0,
      noFormOnPage: false,
      authFormOnly: false,
      iframeCount: 0,
    });
    mockPage.click.mockImplementationOnce(async () => {
      emitResponse({ url: "https://campaign.waterheater.app/api/x", status: 200 });
    });
    (mockPage.waitForURL as jest.Mock).mockResolvedValueOnce(undefined);
    (mockPage.url as jest.Mock)
      .mockReturnValueOnce("https://campaign.waterheater.app/")
      .mockReturnValueOnce("https://campaign.waterheater.app/thanks?handoff_id=abc123");

    await runGenerationSmokeTest({ ...BASE_PAGE });

    expect(mockUpdateLandingPageSmokeTestResult.mock.calls[0][1].ok).toBe(false);
  });

  it("SWEEP: removes synthetic leads a PREVIOUS run stranded, and nothing else", async () => {
    // The per-run poll only has 8s to find the row it created. When the capture write lands
    // later the row is never deleted — 45 leads accumulated that way across nine lists in
    // August, four in a paying customer's CRM. Sweeping at the start of each run makes it
    // self-correcting.
    mockGetLeadsByListId.mockResolvedValue({
      items: [
        { leadId: "stranded-email", email: "smoke-test+1787265258@agentweb.pro", createdAt: "2026-08-20T00:00:00.000Z" },
        { leadId: "stranded-phone", email: "noemail+123@lander.test", phone: "(415) 555-0142", createdAt: "2026-08-20T00:00:00.000Z" },
        { leadId: "REAL-customer-lead", email: "someone@acme.com", phone: "4155551234", createdAt: "2026-08-20T00:00:00.000Z" },
        { leadId: "real-lead-no-phone", email: "buyer@corp.com", createdAt: "2026-08-20T00:00:00.000Z" },
      ],
      lastEvaluatedKey: null,
      hasMore: false,
    });

    await runGenerationSmokeTest({ ...BASE_PAGE });

    const deleted = mockDeleteLead.mock.calls.map((c) => c[1]);
    expect(deleted).toContain("stranded-email");
    expect(deleted).toContain("stranded-phone");
    // a real customer lead must never be touched
    expect(deleted).not.toContain("REAL-customer-lead");
    expect(deleted).not.toContain("real-lead-no-phone");
  });

  it("SWEEP: never deletes a row created during this run", async () => {
    // beforeIso is the run's own start, so our freshly-created row is out of scope.
    mockGetLeadsByListId.mockResolvedValue({
      items: [
        { leadId: "ours-this-run", email: "smoke-test+9999999999999@agentweb.pro", createdAt: "2099-01-01T00:00:00.000Z" },
      ],
      lastEvaluatedKey: null,
      hasMore: false,
    });

    await runGenerationSmokeTest({ ...BASE_PAGE });

    expect(mockDeleteLead.mock.calls.map((c) => c[1])).not.toContain("ours-this-run");
  });

  it("SWEEP: a failing lead list never affects the run's verdict", async () => {
    mockGetLeadByEmail.mockResolvedValueOnce({ leadId: "lead-abc" });
    mockGetLeadsByListId.mockRejectedValue(new Error("DynamoDB unavailable"));

    await runGenerationSmokeTest({ ...BASE_PAGE });

    expect(mockUpdateLandingPageSmokeTestResult.mock.calls[0][1].ok).toBe(true);
  });

  it("CLEANUP: a lander with no email field still gets its synthetic lead deleted, by phone", async () => {
    // The lander invents its own placeholder address (observed live:
    // noemail+<ts>@waterheater.app), so isSmokeTestEmail never matches and pollForLead
    // misses it. Before the fill fixes on this branch such pages failed validation and
    // created nothing; now they submit, so every deploy would strand a row in the
    // customer's CRM.
    (mockPage.evaluate as jest.Mock).mockResolvedValueOnce({
      ...SINGLE_EMAIL_FIELD,
      fields: [{ selector: "#phone", hint: "phone", kind: "tel" }],
    });
    const phoneOf = () =>
      ((mockPage.fill as jest.Mock).mock.calls.find((c) => c[0] === "#phone") || [])[1];
    // Built at call time: the synthetic number is derived from the clock, and the CRM
    // stores it formatted, so the match has to normalise.
    mockGetLeadsByListId.mockImplementation(async () => {
      const digits = String(phoneOf() || "").replace(/\D/g, "");
      const formatted = `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
      return {
        items: [
          { leadId: "other-real-lead", phone: "4155551234", createdAt: "2030-01-01T00:00:00.000Z" },
          { leadId: "ours", phone: formatted, createdAt: "2030-01-01T00:00:00.000Z" },
        ],
        lastEvaluatedKey: null,
        hasMore: false,
      };
    });

    await runGenerationSmokeTest({ ...BASE_PAGE });

    expect(String(phoneOf())).toMatch(/^41555501\d{2}$/);
    expect(mockGetLeadByEmail).not.toHaveBeenCalled();
    expect(mockDeleteLead).toHaveBeenCalledWith("list-1", "ours");
  });

  it("CLEANUP: a pre-existing lead with the same phone but an older timestamp is never deleted", async () => {
    (mockPage.evaluate as jest.Mock).mockResolvedValueOnce({
      ...SINGLE_EMAIL_FIELD,
      fields: [{ selector: "#phone", hint: "phone", kind: "tel" }],
    });
    mockGetLeadsByListId.mockImplementation(async () => {
      const digits = String(
        ((mockPage.fill as jest.Mock).mock.calls.find((c) => c[0] === "#phone") || [])[1] || ""
      ).replace(/\D/g, "");
      return {
        items: [{ leadId: "older", phone: digits, createdAt: "2000-01-01T00:00:00.000Z" }],
        lastEvaluatedKey: null,
        hasMore: false,
      };
    });

    await runGenerationSmokeTest({ ...BASE_PAGE });

    expect(mockDeleteLead).not.toHaveBeenCalled();
  });

  it("DIAGNOSIS: an iframe-embedded form is not reported as 'no lead form'", async () => {
    (mockPage.evaluate as jest.Mock).mockResolvedValueOnce({
      scope: "", fields: [], selects: [], checkables: [], submitSelector: null,
      disclosureTriggers: [], skippedRequired: 0, noFormOnPage: true,
      authFormOnly: false, iframeCount: 2,
    });

    await runGenerationSmokeTest({ ...BASE_PAGE });

    const reason = mockSendLandingPageSmokeTestAlert.mock.calls[0][2];
    expect(reason).toContain("2 iframe(s)");
    expect(reason).toContain("may be embedded");
  });

  it("CLEANUP: a handoff form that ALSO writes a CRM row still gets its synthetic lead deleted", async () => {
    // Skipping the poll on the handoff path left one smoke-test lead in the customer's
    // list per deploy, forever.
    mockGetLeadByEmail.mockResolvedValueOnce({ leadId: "lead-abc" });
    mockPage.click.mockImplementationOnce(async () => {
      emitResponse({ url: "https://test-page.vercel.app/api/capture", status: 200 });
    });
    (mockPage.waitForURL as jest.Mock).mockResolvedValueOnce(undefined);
    (mockPage.url as jest.Mock)
      .mockReturnValueOnce("https://test-page.vercel.app")
      .mockReturnValueOnce("https://chat.test-page.app/text?handoff_id=abc123");

    await runGenerationSmokeTest({ ...BASE_PAGE });

    expect(mockGetLeadByEmail).toHaveBeenCalled();
    expect(mockDeleteLead).toHaveBeenCalledWith("list-1", "lead-abc");
    expect(mockUpdateLandingPageSmokeTestResult.mock.calls[0][1].ok).toBe(true);
  });

  // Each case below kills a mutant that survived the previous revision of this suite: the
  // handoff gate was only ever exercised at 200-vs-500 on a single response, so the non-GET
  // filter, the 3xx boundary and the attribution check were all untested.
  const PHONE_ONLY = [{ selector: "#phone", hint: "phone", kind: "tel" }];
  const EMAIL_ONLY = [{ selector: "#email", hint: "email", kind: "email" }];
  const handoffRun = async (emit: () => void, fields = PHONE_ONLY) => {
    (mockPage.evaluate as jest.Mock).mockResolvedValueOnce({
      scope: "",
      fields,
      selects: [],
      checkables: [],
      submitSelector: null,
      disclosureTriggers: [],
      skippedRequired: 0,
      noFormOnPage: false,
      authFormOnly: false,
      iframeCount: 0,
    });
    mockPage.click.mockImplementationOnce(async () => emit());
    (mockPage.waitForURL as jest.Mock).mockResolvedValueOnce(undefined);
    (mockPage.url as jest.Mock)
      .mockReturnValueOnce("https://campaign.waterheater.app/")
      .mockReturnValueOnce("https://chat.waterheater.app/text?handoff_id=abc123");
    await runGenerationSmokeTest({ ...BASE_PAGE });
    return mockUpdateLandingPageSmokeTestResult.mock.calls[0][1];
  };

  it("EVIDENCE: a redirect hop is not acceptance — POST 308 then 500 must fail", async () => {
    // Playwright raises a response event per redirect hop, and for a 307/308 the method is
    // still POST. Accepting any status < 400 therefore passed a capture endpoint that 308'd
    // and then 500'd — verbatim the swallowed-500 case the handoff gate exists to catch.
    const result = await handoffRun(() => {
      emitResponse({ url: "https://campaign.waterheater.app/api/x", status: 308 });
      emitResponse({ url: "https://campaign.waterheater.app/api/x", status: 500 });
    });
    expect(result.ok).toBe(false);
  });

  it("EVIDENCE: a GET is not acceptance, however successful", async () => {
    const result = await handoffRun(() => {
      emitResponse({ url: "https://campaign.waterheater.app/api/x", status: 200, method: "GET" });
    });
    expect(result.ok).toBe(false);
  });

  it("EVIDENCE: a same-origin POST that did not carry our data is not acceptance", async () => {
    // Vercel Speed Insights POSTs to /_vercel/speed-insights/vitals on pagehide — i.e.
    // exactly at the handoff redirect. Same origin, non-GET, 200, and nothing to do with us.
    const result = await handoffRun(() => {
      emitResponse({
        url: "https://campaign.waterheater.app/_vercel/speed-insights/vitals",
        status: 200,
        body: '{"event":"vitals"}',
      });
    });
    expect(result.ok).toBe(false);
  });

  it("EVIDENCE: a urlencoded form POST still attributes, despite %2B/%40 escaping", async () => {
    // A native <form> POST sends application/x-www-form-urlencoded, where the synthetic
    // email's "+" and "@" become %2B and %40. Matching the raw value missed exactly the
    // plain HTML forms most likely to be on a lander, so a handoff page with an email
    // field and no phone field failed attribution on every deploy.
    let encodedBody = "";
    const result = await handoffRun(() => {
      encodedBody = new URLSearchParams(
        Object.fromEntries(filledValues().map((v, i) => [`f${i}`, v]))
      ).toString();
      emitResponse({
        url: "https://campaign.waterheater.app/api/x",
        status: 200,
        body: encodedBody,
      });
    }, EMAIL_ONLY);
    // The escaping this case exists for — asserted out here, since a throw inside the
    // click mock would be swallowed by the implementation's own catch.
    expect(encodedBody).toContain("%40");
    expect(encodedBody).not.toContain("@");
    expect(result.ok).toBe(true);
  });

  it("EVIDENCE: a 2xx POST carrying our synthetic data IS acceptance", async () => {
    const result = await handoffRun(() => {
      emitResponse({ url: "https://campaign.waterheater.app/api/hero-estimate", status: 200 });
    });
    expect(result.ok).toBe(true);
    expect(result.handoffId).toBe("abc123");
  });

  it("NAVIGATION: the waitForURL predicate actually distinguishes a moved URL from a still one", async () => {
    // The predicate was never executed by any test — inverting it to `===` used to leave
    // the whole suite green.
    mockGetLeadByEmail.mockResolvedValueOnce({ leadId: "lead-abc" });
    await runGenerationSmokeTest({ ...BASE_PAGE });

    const predicate = (mockPage.waitForURL as jest.Mock).mock.calls[0][0];
    expect(predicate(new URL("https://test-page.vercel.app/thanks"))).toBe(true);
    expect(predicate(new URL("https://test-page.vercel.app"))).toBe(false);
  });

  it("SUBMIT: a page-resolved submit control (form= button outside the form) is used as-is", async () => {
    mockGetLeadByEmail.mockResolvedValueOnce({ leadId: "lead-abc" });
    (mockPage.evaluate as jest.Mock).mockResolvedValueOnce({
      ...SINGLE_EMAIL_FIELD,
      submitSelector: '[id="sticky-submit"]',
    });

    await runGenerationSmokeTest({ ...BASE_PAGE });

    expect(mockPage.click).toHaveBeenCalledWith(
      '[id="sticky-submit"]',
      expect.objectContaining({ timeout: expect.any(Number) })
    );
  });

  it("DIAGNOSTICS: a hostile redirect URL is flattened and truncated before it reaches Slack", async () => {
    const longUrl = `https://evil.test/${"a".repeat(400)}`;
    (mockPage.waitForURL as jest.Mock).mockResolvedValueOnce(undefined);
    (mockPage.url as jest.Mock)
      .mockReturnValueOnce("https://test-page.vercel.app")
      .mockReturnValueOnce(longUrl);

    await runGenerationSmokeTest({ ...BASE_PAGE });

    const reason = mockSendLandingPageSmokeTestAlert.mock.calls[0][2];
    expect(reason).not.toContain("\n");
    expect(reason).toContain("...");
    expect(reason.length).toBeLessThan(longUrl.length);
  });

  it("DISCLOSURE: opens a collapsed checkbox group, re-discovers, then closes it before submit", async () => {
    // The root waterheater lander: a required symptom group behind a "What's happening?"
    // popover. Until it is open the group is unreachable, the lander's own JS blocks submit,
    // and HTML5 checkValidity() still reports true — a working page reported as a failure.
    mockGetLeadByEmail.mockResolvedValueOnce({ leadId: "lead-abc" });
    (mockPage.evaluate as jest.Mock)
      .mockResolvedValueOnce({ ...SINGLE_EMAIL_FIELD, disclosureTriggers: ["#symptoms-trigger"] })
      .mockResolvedValueOnce({
        ...SINGLE_EMAIL_FIELD,
        disclosureTriggers: [],
        skippedRequired: 0,
        noFormOnPage: false,
        authFormOnly: false,
        iframeCount: 0,
        checkables: [
          { selector: '[data-agentweb-smoke-click="0"]', type: "checkbox", name: "symptoms",
            required: true, viaLabel: true, checked: false },
        ],
      });

    await runGenerationSmokeTest({ ...BASE_PAGE });

    const clicks = (mockPage.click as jest.Mock).mock.calls.map((c) => c[0]);
    // opened, then closed again so the popover cannot overlay the submit button
    expect(clicks.filter((c) => c === "#symptoms-trigger").length).toBe(2);
    // A label target goes through check(), which Playwright retargets to the control and
    // which is idempotent; click() would toggle and is only the fallback.
    expect(mockPage.check).toHaveBeenCalledWith(
      '[data-agentweb-smoke-click="0"]',
      expect.objectContaining({ timeout: expect.any(Number) })
    );
    expect(clicks).not.toContain('[data-agentweb-smoke-click="0"]');
  });

  it("CHECKABLES: an already-checked required control is left alone, never toggled off", async () => {
    // click() is not idempotent. A pre-checked required consent box — common on GDPR/TCPA
    // landers — would be UNCHECKED, blocking submit on a page that was fine.
    mockGetLeadByEmail.mockResolvedValueOnce({ leadId: "lead-abc" });
    (mockPage.evaluate as jest.Mock).mockResolvedValueOnce({
      ...SINGLE_EMAIL_FIELD,
      checkables: [
        { selector: "#consent", type: "checkbox", name: "consent", required: true,
          viaLabel: false, checked: true },
      ],
    });

    await runGenerationSmokeTest({ ...BASE_PAGE });

    expect(mockPage.check).not.toHaveBeenCalledWith("#consent", expect.anything());
    expect((mockPage.click as jest.Mock).mock.calls.map((c) => c[0])).not.toContain("#consent");
    expect(mockUpdateLandingPageSmokeTestResult.mock.calls[0][1].ok).toBe(true);
  });

  it("CHECKABLES: click() is the fallback when check() cannot resolve the widget", async () => {
    mockGetLeadByEmail.mockResolvedValueOnce({ leadId: "lead-abc" });
    (mockPage.evaluate as jest.Mock).mockResolvedValueOnce({
      ...SINGLE_EMAIL_FIELD,
      checkables: [
        { selector: "#odd", type: "checkbox", name: "x", required: true, viaLabel: true, checked: false },
      ],
    });
    // Playwright's own wording when the target cannot be treated as a checkable at all.
    (mockPage.check as jest.Mock).mockRejectedValueOnce(
      new Error("Not a checkbox or radio button")
    );

    await runGenerationSmokeTest({ ...BASE_PAGE });

    expect((mockPage.click as jest.Mock).mock.calls.map((c) => c[0])).toContain("#odd");
  });

  it("DISCLOSURE: a trigger that will not open is not retried and does not block the run", async () => {
    mockGetLeadByEmail.mockResolvedValueOnce({ leadId: "lead-abc" });
    (mockPage.evaluate as jest.Mock).mockResolvedValueOnce({
      ...SINGLE_EMAIL_FIELD,
      disclosureTriggers: ["#stuck"],
    });
    mockPage.click.mockRejectedValueOnce(new Error("not clickable"));

    await runGenerationSmokeTest({ ...BASE_PAGE });

    // No second discovery pass, and the run still reaches a verdict.
    expect(mockUpdateLandingPageSmokeTestResult.mock.calls[0][1].ok).toBe(true);
  });

  it("HANDOFF: a slow chat app that never fires `load` is still a capture", async () => {
    // waitForURL resolves on the load event. Requiring it as well as the cross-origin check
    // made a genuine handoff to a slow third-party chat app look like no navigation at all —
    // the cross-origin comparison already proves the page moved.
    (mockPage.evaluate as jest.Mock).mockResolvedValueOnce({
      scope: "",
      fields: [{ selector: "#phone", hint: "phone", kind: "tel" }],
      selects: [],
      checkables: [],
      submitSelector: null,
      disclosureTriggers: [],
      skippedRequired: 0,
      noFormOnPage: false,
      authFormOnly: false,
      iframeCount: 0,
    });
    mockPage.click.mockImplementationOnce(async () => {
      emitResponse({ url: "https://campaign.waterheater.app/api/x", status: 200 });
    });
    (mockPage.waitForURL as jest.Mock).mockRejectedValueOnce(new Error("Timeout 8000ms"));
    (mockPage.url as jest.Mock)
      .mockReturnValueOnce("https://campaign.waterheater.app/")
      .mockReturnValueOnce("https://chat.waterheater.app/text?handoff_id=abc123");

    await runGenerationSmokeTest({ ...BASE_PAGE });

    const result = mockUpdateLandingPageSmokeTestResult.mock.calls[0][1];
    expect(result.ok).toBe(true);
    expect(result.handoffId).toBe("abc123");
  });

  it("DIAGNOSIS: a page with no form is not reported as a CRM failure", async () => {
    // Blaming the CRM for a page that has no capture mechanism at all sends whoever reads
    // the alert hunting a bug that cannot exist. 10 of 42 live landers are in this state.
    (mockPage.evaluate as jest.Mock).mockResolvedValueOnce({
      scope: "", fields: [], selects: [], checkables: [],
      submitSelector: null, disclosureTriggers: [], skippedRequired: 0, noFormOnPage: true,
    });

    await runGenerationSmokeTest({ ...BASE_PAGE });

    const reason = mockSendLandingPageSmokeTestAlert.mock.calls[0][2];
    expect(reason).toContain("no lead form");
    expect(reason).not.toContain("CRM within the timeout");
  });

  it("DIAGNOSIS: an auth-only page says so, instead of blaming the CRM", async () => {
    (mockPage.evaluate as jest.Mock).mockResolvedValueOnce({
      scope: "", fields: [], selects: [], checkables: [], submitSelector: null,
      disclosureTriggers: [], skippedRequired: 0, noFormOnPage: true, authFormOnly: true,
    });

    await runGenerationSmokeTest({ ...BASE_PAGE });

    const reason = mockSendLandingPageSmokeTestAlert.mock.calls[0][2];
    expect(reason).toContain("authentication form");
    expect(reason).not.toContain("CRM within the timeout");
  });

  it("CHECKABLES: a deferred-state control is not clicked again after check() already toggled it", async () => {
    // check() clicks and re-reads; "did not change its state" means the click LANDED but the
    // control is controlled/deferred. Retrying with click() would toggle it back off.
    mockGetLeadByEmail.mockResolvedValueOnce({ leadId: "lead-abc" });
    (mockPage.evaluate as jest.Mock).mockResolvedValueOnce({
      ...SINGLE_EMAIL_FIELD,
      checkables: [
        { selector: "#deferred", type: "checkbox", name: "c", required: true, viaLabel: false, checked: false },
      ],
    });
    (mockPage.check as jest.Mock).mockRejectedValueOnce(
      new Error("Clicking the checkbox did not change its state")
    );

    await runGenerationSmokeTest({ ...BASE_PAGE });

    expect((mockPage.click as jest.Mock).mock.calls.map((c) => c[0])).not.toContain("#deferred");
  });

  it("DIAGNOSIS: unreachable required controls are named, since they are why submit blocks", async () => {
    (mockPage.evaluate as jest.Mock).mockResolvedValueOnce({
      ...SINGLE_EMAIL_FIELD, disclosureTriggers: [], skippedRequired: 3, noFormOnPage: false,
    });

    await runGenerationSmokeTest({ ...BASE_PAGE });

    expect(mockSendLandingPageSmokeTestAlert.mock.calls[0][2]).toContain("3 required control(s) unreachable");
  });

  it("VALUES: synthetic values respect the field's own min/max/maxlength", () => {
    const v = (f: any) => syntheticValueFor(f, "smoke@x.test", "4155550100");
    // an unclamped "5" fails min=1000 and blocks submit — the false negative we are removing
    expect(v({ selector: "#b", hint: "budget", kind: "number", min: "1000" })).toBe("1000");
    expect(v({ selector: "#q", hint: "quantity", kind: "number", max: "3" })).toBe("3");
    expect(v({ selector: "#d", hint: "preferred date", kind: "date", max: "2026-12-31" })).toBe("2026-12-31");
    expect(v({ selector: "#d2", hint: "preferred date", kind: "date", min: "2031-01-01" })).toBe("2031-01-01");
    // A non-ISO bound is ignored, not written into the field: "2030-01-01" > "12/31/2026" by
    // string compare, and Chromium rejects any non-ISO value outright — which would drop a
    // required date that previously filled fine.
    expect(v({ selector: "#d3", hint: "preferred date", kind: "date", max: "12/31/2026" })).toBe("2030-01-01");
    expect(v({ selector: "#n", hint: "full name", kind: "text", maxLength: 5 })).toBe("Smoke");
  });

  it("FAIL: navigation without handoff_id still polls the CRM (no false pass on anchor scrolls)", async () => {
    (mockPage.waitForURL as jest.Mock).mockResolvedValueOnce(undefined);
    (mockPage.url as jest.Mock)
      .mockReturnValueOnce("https://test-page.vercel.app")
      .mockReturnValueOnce("https://test-page.vercel.app#pricing");

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
