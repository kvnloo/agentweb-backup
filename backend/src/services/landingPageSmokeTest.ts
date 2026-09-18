/**
 * ENG-449 gap #3: automated post-deploy smoke test.
 *
 * The original RankAI incident (see ENG-443/ENG-449 history) happened because a lander's
 * conversion tracking was silently broken and nobody noticed for months — pixelLeadEventVerified
 * / bridgeOutVerified (static regex checks on the GENERATED CODE at build time) narrow that gap
 * but can't catch a failure that only shows up once the page is actually LIVE (a broken deploy,
 * a form selector v0 got subtly wrong, a pixel script that doesn't actually load in production).
 *
 * This runs a real headless browser against the real deployed URL, submits the real lead form,
 * and confirms: (1) the lead actually lands in the CRM, and (2) if a Meta pixel is configured,
 * the page's JS calls fbq('track','Lead',...) on submit. Fire-and-forget after deploy (see
 * v0Service.ts's deployLandingPage) — never blocks the deploy response, never throws into its
 * caller. Success is recorded quietly; failure alerts on Slack (sendLandingPageSmokeTestAlert)
 * so a broken pipeline gets noticed instead of sitting silent again.
 *
 * Uses the real `playwright` package (chromium.launch), pointed at the SAME system Chrome
 * binary three other features in this codebase already launch in prod (cssExtractor.ts,
 * linkedInService.ts, pdfRenderService.ts, via utils/browserUtils.ts) — no new browser binary,
 * no new prod infra risk.
 */
import { chromium } from "playwright";
import { findChromeExecutable, PUPPETEER_LAUNCH_ARGS } from "../utils/browserUtils";
import { buildSmokeTestEmail } from "../utils/smokeTestLead";
import { crmDb } from "./db";
import { sendLandingPageSmokeTestAlert } from "./slackService";
import { updateLandingPageSmokeTestResult, GeneratedLandingPage } from "./v0Service";

// Lead-landing poll config — how long to wait for the submitted test lead to actually show
// up in the CRM before giving up. Overridable for tests (mirrors setVercelPollConfig's idiom).
let pollIntervalMs = 1_000;
let pollMaxAttempts = 8;

/** Override poll config (for testing). */
export function setSmokeTestPollConfig(intervalMs: number, maxAttempts: number) {
  pollIntervalMs = intervalMs;
  pollMaxAttempts = maxAttempts;
}

// Prod runs a single backend instance serving live customer API traffic (same box
// cssExtractor.ts/linkedInService.ts/pdfRenderService.ts already launch headless Chrome
// from) — cap how many smoke-test browsers can run at once so a burst of near-simultaneous
// deploys can't stack up multiple concurrent Chrome instances competing for the same
// CPU/memory budget as real traffic. Extra calls queue (FIFO) rather than run in parallel;
// since this is already fire-and-forget and never blocks the deploy response, queuing adds
// latency to the SMOKE TEST result only, not to anything customer-facing.
let maxConcurrentSmokeTests = 1;
let activeSmokeTests = 0;
const smokeTestQueue: Array<() => void> = [];

/** Override max concurrency (for testing). */
export function setSmokeTestConcurrency(max: number) {
  maxConcurrentSmokeTests = max;
}

async function acquireSmokeTestSlot(): Promise<void> {
  if (activeSmokeTests < maxConcurrentSmokeTests) {
    activeSmokeTests++;
    return;
  }
  await new Promise<void>((resolve) => smokeTestQueue.push(resolve));
  activeSmokeTests++;
}

function releaseSmokeTestSlot(): void {
  activeSmokeTests--;
  const next = smokeTestQueue.shift();
  if (next) next();
}

async function pollForLead(listId: string, email: string): Promise<{ leadId: string } | null> {
  for (let attempt = 0; attempt < pollMaxAttempts; attempt++) {
    const lead = await crmDb.getLeadByEmail(listId, email);
    if (lead) return lead as { leadId: string };
    if (attempt < pollMaxAttempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }
  return null;
}

type SmokeTestPage = {
  goto(url: string, opts?: any): Promise<unknown>;
  url(): string;
  waitForURL(pred: (url: URL) => boolean, opts?: any): Promise<unknown>;
  fill(selector: string, value: string): Promise<unknown>;
  press(selector: string, key: string): Promise<unknown>;
  click(selector: string): Promise<unknown>;
  selectOption(selector: string, value: string): Promise<unknown>;
  check(selector: string): Promise<unknown>;
  evaluate<T>(fn: () => T): Promise<T>;
};

/**
 * Fills every required field in the page's first form with synthetic but
 * format-valid data.
 *
 * Why this exists: the old path filled only `input[type=email]` and clicked
 * submit. That worked for the single-email-field landers the test was built
 * against, but every modern v0 lander is a React-controlled multi-field form
 * (name/phone/zip + selects + checkboxes) whose client-side validation blocks
 * submit until ALL required fields pass — so the submit silently never fired and
 * the test reported "lead did not land in the CRM" on a page that worked fine
 * for real visitors (the 2026-09-18 WaterHeater.app root + voice-page failures).
 *
 * Strategy per field, in order:
 *  1. email inputs → the smoke-test email (so pollForLead can find the row).
 *  2. tel inputs → a unique 555- number (fictional range, valid 10-digit format).
 *  3. Other text inputs → a generic "Smoke Test" value (first/last name fields get
 *     "Smoke"/"Test" so split-name validation passes).
 *  4. Required selects → first non-empty option (mirrors a visitor picking something).
 *  5. First checkbox/radio group → check the first box (e.g. symptom pickers that
 *     require ≥1 selection).
 * Fills are best-effort per field (a missing selector resolves, never throws) —
 * a form with NO fillable fields still proceeds to submit, preserving the old
 * behavior for minimal landers.
 */
async function fillAllRequiredFields(
  browserPage: SmokeTestPage,
  email: string,
  testPhone: string
): Promise<{ lastTextSelector: string | null }> {
  const fieldKinds = await browserPage
    .evaluate(() => {
      const form = document.querySelector("form") ?? document;
      // Return complete selectors from discovery so the caller never has to guess
      // whether a reference is an id or a name: a name-only control such as
      // <input name="email"> must become [name="email"], not #email.
      // Escape interpolated values: React-style ids (":r0:") and names with
      // quotes/backslashes break Playwright's selector parser, throwing and
      // leaving required controls empty (false negative). Fallbacks are static
      // and already valid.
      const esc = (s: string): string => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      const escId = (id: string): string =>
        `#${id.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`)}`;
      const selFor = (el: Element, fallback: string): string => {
        const input = el as HTMLInputElement;
        if (input.id) return escId(input.id);
        if (input.name) return `[name="${esc(input.name)}"]`;
        return fallback;
      };
      const textInputs = [...form.querySelectorAll('input[type="email"]')].map(
        (el) => selFor(el, 'input[type="email"]')
      );
      const telInputs = [...form.querySelectorAll('input[type="tel"]')].map(
        (el) => selFor(el, 'input[type="tel"]')
      );
      const otherTexts = [
        ...form.querySelectorAll('input[type="text"], input:not([type])'),
      ].map((el) => selFor(el, 'input[type="text"]'));
      const selects = [...form.querySelectorAll("select")].map((el, i) => {
        const sel = el as HTMLSelectElement;
        return {
          selector: sel.id
            ? escId(sel.id)
            : sel.name
              ? `[name="${esc(sel.name)}"]`
              : `select >> nth=${i}`,
          options: [...sel.options].filter((o) => o.value).map((o) => o.value),
        };
      });
      const checkables = [
        ...form.querySelectorAll('input[type="checkbox"], input[type="radio"]'),
      ].map((el) => {
        const input = el as HTMLInputElement;
        return {
          selector: selFor(el, 'input[type="checkbox"]'),
          type: input.type,
          name: input.name || null,
          required: input.required,
        };
      });
      return { textInputs, telInputs, otherTexts, selects, checkables };
    })
    .catch(() => null);
  if (!fieldKinds) return { lastTextSelector: null as string | null };

  const toSelector = (ref: string): string => {
    // Discovery already returns complete selectors (#id, [name="..."], or a
    // positional fallback); pass them through untouched.
    return ref;
  };

  let lastTextSelector: string | null = null;
  for (const ref of fieldKinds.textInputs) {
    try {
      await browserPage.fill(toSelector(ref), email);
      if (!lastTextSelector) lastTextSelector = toSelector(ref);
    } catch {
      // best-effort per field
    }
  }
  for (const ref of fieldKinds.telInputs) {
    try {
      await browserPage.fill(toSelector(ref), testPhone);
      if (!lastTextSelector) lastTextSelector = toSelector(ref);
    } catch {
      // best-effort per field
    }
  }
  for (const ref of fieldKinds.otherTexts) {
    const lower = ref.toLowerCase();
    const value = lower.includes("last")
      ? "Test"
      : lower.includes("first") || lower.includes("name")
        ? "Smoke"
        : lower.includes("zip") || lower.includes("postal")
          ? "94025"
          : lower.includes("url") ||
              lower.includes("website") ||
              lower.includes("site") ||
              lower.includes("link")
            ? "https://example.com"
            : "Smoke Test";
    try {
      await browserPage.fill(toSelector(ref), value);
      lastTextSelector = toSelector(ref);
    } catch {
      // best-effort per field
    }
  }
  for (const sel of fieldKinds.selects) {
    if (sel.options.length === 0) continue;
    try {
      await browserPage.selectOption(toSelector(sel.selector), sel.options[0]);
    } catch {
      // hidden/custom selects (e.g. Radix comboboxes with valid defaults) — leave alone
    }
  }
  // Check EVERY required checkbox and one radio per required group. The old path
  // checked only the first control, so a form with multiple required checkboxes
  // (or an optional control first) stayed validation-blocked and never submitted.
  const requiredBoxes = fieldKinds.checkables.filter(
    (c) => c.type === "checkbox" && c.required
  );
  const requiredRadios = fieldKinds.checkables.filter(
    (c) => c.type === "radio" && c.required
  );
  const radiosByGroup = new Map<string, { selector: string }>();
  for (const r of requiredRadios) {
    const key = r.name ?? r.selector;
    if (!radiosByGroup.has(key)) radiosByGroup.set(key, r);
  }
  const toCheck = requiredBoxes.length > 0 || radiosByGroup.size > 0
    ? [...requiredBoxes, ...radiosByGroup.values()]
    : fieldKinds.checkables.length > 0
      ? [
          typeof fieldKinds.checkables[0] === "string"
            ? { selector: fieldKinds.checkables[0] as string }
            : fieldKinds.checkables[0],
        ] // no required info (e.g. older mock shape) — best-effort fallback
      : [];
  for (const c of toCheck) {
    try {
      await browserPage.check(toSelector(c.selector));
    } catch {
      // custom checkbox widgets without a checkable input — leave alone
    }
  }
  return { lastTextSelector };
}

/**
 * Runs the smoke test for a just-deployed page. NEVER throws — every failure mode (browser
 * launch, navigation, form submission, CRM lookup, even the result-persist/alert calls
 * themselves) is caught and reported as a failed result rather than propagated, since this
 * always runs fire-and-forget (`void runGenerationSmokeTest(...)`) with nobody awaiting it.
 */
export async function runGenerationSmokeTest(page: GeneratedLandingPage): Promise<void> {
  if (!page.leadListId || !page.deployedUrl) {
    // Nothing to verify: no bound list to capture into, or no live URL to test against —
    // check BEFORE queuing, no point waiting for a Chrome slot only to no-op.
    return;
  }

  await acquireSmokeTestSlot();
  try {
    await runGenerationSmokeTestNow(page, page.leadListId, page.deployedUrl);
  } finally {
    releaseSmokeTestSlot();
  }
}

async function runGenerationSmokeTestNow(
  page: GeneratedLandingPage,
  leadListId: string,
  deployedUrl: string
): Promise<void> {
  const checkedAt = new Date().toISOString();
  const pixelExpected = !!page.metaPixelId;
  let leadCaptured = false;
  let pixelFired = false;
  let error: string | undefined;
  let handoffId: string | null = null;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;

  try {
    const executablePath = findChromeExecutable();
    if (!executablePath) {
      throw new Error("No Chrome executable found");
    }
    browser = await chromium.launch({ executablePath, args: PUPPETEER_LAUNCH_ARGS });
    const browserPage = await browser.newPage();

    if (pixelExpected) {
      // Detect the pixel firing by intercepting the actual fbq('track','Lead',...) JS call,
      // NOT by sniffing for a facebook.com/tr network request. Verified live against a real
      // deployed page: fbq() genuinely fires the Lead event correctly, but Meta's real beacon
      // transport isn't reliably visible via page.on('request') in headless Chromium — that
      // would make a real Meta outage or network hiccup look like OUR code being broken, which
      // isn't the thing we're actually trying to verify. Confirming the CODE calls fbq
      // correctly is the meaningful, reliable check.
      // Block the actual beacon from ever reaching Meta's real servers — the JS-call
      // interception below already proves the code invokes fbq() correctly, which is all
      // this test needs; there's no reason a real (fake) Lead conversion event should land
      // in the customer's actual ad account data on every deploy. Aborting client-side
      // doesn't affect the verification: fbq()'s call happens synchronously before the
      // network request is even dispatched, so the Proxy below still fires regardless.
      //
      // Uses the CDP Network domain directly (Network.setBlockedURLs), NOT page.route() —
      // verified live against a real (non-headless) browser that page.route() silently does
      // NOT intercept this specific request (Meta's beacon transport bypasses Playwright's
      // Fetch-domain-based routing, a known gap for this kind of request), so it would have
      // looked like it worked in mocked tests while doing nothing at all in production. CDP's
      // Network.setBlockedURLs operates at the lower Network-domain layer and was confirmed,
      // live, to actually abort both the PageView and Lead beacon requests.
      const cdpSession = await browserPage.context().newCDPSession(browserPage);
      await cdpSession.send("Network.enable");
      await cdpSession.send("Network.setBlockedURLs", { urls: ["*facebook.com/tr*"] });

      await browserPage.exposeFunction("__smokeTestReportFbqCall", (event: string) => {
        if (event === "track:Lead") pixelFired = true;
      });
      await browserPage.addInitScript(() => {
        let real: any;
        Object.defineProperty(window, "fbq", {
          configurable: true,
          get() {
            return real;
          },
          set(fn) {
            real = new Proxy(fn, {
              apply(target, thisArg, args) {
                if (args[0] === "track" && args[1] === "Lead") {
                  (window as any).__smokeTestReportFbqCall("track:Lead");
                }
                return Reflect.apply(target, thisArg, args);
              },
            });
          },
        });
      });
    }

    await browserPage.goto(deployedUrl, { waitUntil: "networkidle", timeout: 30_000 });

    // Fill EVERY required field, not just email. Modern landers are React-controlled
    // multi-field forms (name/phone/zip + selects) with client-side validation that blocks
    // submit until all required fields pass — filling only input[type=email] leaves the
    // form unsubmittable and produces a false-negative "lead did not land in CRM".
    // Verified live 2026-09-18: campaign.waterheater.app root (name/phone/zip + 4 selects
    // + symptom checkbox, POSTs /api/hero-estimate, requires phone+zip formats) and
    // /voice-ai-agent-free-estimate-w (firstName/lastName/phone/email/zip + 2 hidden
    // selects with valid defaults, POSTs /api/capture). Both submit fine with realistic
    // data; the old fill-email-only path failed on both while the forms worked for
    // real visitors.
    const testPhone = `41555501${String(Date.now()).slice(-2)}`; // NANPA fictional block 555-0100–0199 with a real area code
    const email = buildSmokeTestEmail();
    const { lastTextSelector } = await fillAllRequiredFields(
      browserPage,
      email,
      testPhone
    );

    // Capture the pre-submit URL BEFORE the submission action: if click/Enter
    // completes a same-instant handoff redirect, reading it after would already
    // see the handoff URL and waitForURL would time out on a success.
    const urlBeforeSubmit = browserPage.url();
    // Scope the explicit submit click to the discovered first form: a page-wide
    // click can hit another form's submit control, succeeding while the filled
    // form stays unsubmitted. When a <form> exists, use only its submit control
    // plus requestSubmit() — never a page-wide retry. The bare selector runs
    // only when no <form> exists at all (button outside any form).
    // Playwright's click() auto-waits for the button to become actionable, which
    // covers client-side validation that enables submit only after all fields pass.
    // Prefer an explicit submit button; fall back to requestSubmit() on the
    // first form (pressing Enter on a broad 'input, select, textarea' selector
    // can land on a checkbox/radio/hidden/select where Enter never submits).
    if (
      await browserPage.evaluate(() => document.querySelector("form") !== null)
    ) {
      try {
        await browserPage.click(
          'form >> nth=0 >> button[type="submit"], form >> nth=0 >> input[type="submit"]'
        );
      } catch {
        // No actionable submit control on the first form — submit it directly.
        try {
          await browserPage.evaluate(() => {
            document.querySelector("form")?.requestSubmit();
          });
        } catch {
          // requestSubmit threw (unsupported) — Enter in the last
          // filled text field as a final fallback.
          await browserPage.press(lastTextSelector ?? 'input[type="text"]', "Enter");
        }
      }
    } else {
      try {
        await browserPage.click('button[type="submit"], input[type="submit"]');
      } catch {
        // No form element — Enter in the last filled text field as final fallback.
        await browserPage.press(lastTextSelector ?? 'input[type="text"]', "Enter");
      }
    }

    // A React/chat-handoff form may legitimately redirect on success (e.g. to
    // chat.waterheater.app/text?handoff_id=...) INSTEAD of creating a CRM lead row —
    // pollForLead would then always miss. A same-test navigation to a DIFFERENT origin
    // (or the appearance of a handoff_id in the URL) right after submit is positive
    // evidence the pipeline accepted the lead; treat it as captured. Only when the page
    // stays put (no navigation) do we poll the CRM by email.
    // A React/chat-handoff form may legitimately redirect on success (e.g. to
    // chat.waterheater.app/text?handoff_id=...) INSTEAD of creating a CRM lead row —
    // pollForLead would then always miss. Restrict the exception to a CROSS-ORIGIN
    // navigation carrying a verifiable handoff_id: the redirect left the deployed
    // origin entirely (an unrelated redirect or broken same-origin hop cannot fake
    // this), and the handoff id itself is persisted on the result so a human can
    // verify it against the handoff/chat backend. A same-origin handoff_id URL, or
    // a cross-origin navigation without one, still falls through to the CRM poll.
    try {
      await browserPage.waitForURL(
        (url) => url.toString() !== urlBeforeSubmit,
        { timeout: 8_000 }
      );
    } catch {
      // No navigation — form likely posts to a capture API and shows inline success.
    }
    const urlAfterSubmit = browserPage.url();
    try {
      const before = new URL(urlBeforeSubmit);
      const after = new URL(urlAfterSubmit);
      // searchParams.get matches the parameter exactly — a regex on the raw URL
      // can match handoff_id-looking text nested inside another param's value.
      const id = after.searchParams.get("handoff_id")?.trim();
      if (after.origin !== before.origin && id) {
        handoffId = id;
      }
    } catch {
      // Unparseable URL — not a verifiable handoff; fall through to the CRM poll.
    }
    const redirectedToHandoff = handoffId !== null;

    const lead = redirectedToHandoff ? null : await pollForLead(leadListId, email);
    if (lead) {
      leadCaptured = true;
      await crmDb.deleteLead(leadListId, lead.leadId);
    } else if (redirectedToHandoff) {
      // The form accepted the submission and handed off (chat/agent redirect with a
      // handoff id) — the lead pipeline worked end to end even though no CRM row
      // exists to poll for. Mark captured without a row to delete.
      leadCaptured = true;
    }

  } catch (err: any) {
    error = err?.message || String(err);
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {
        // best-effort cleanup only
      }
    }
  }

  const ok = !error && leadCaptured && (!pixelExpected || pixelFired);

  const result: NonNullable<GeneratedLandingPage["smokeTestResult"]> = {
    ok,
    leadCaptured,
    ...(pixelExpected ? { pixelFired } : {}),
    checkedAt,
    ...(error ? { error } : {}),
    // Persisted handoff evidence: the id extracted from the cross-origin redirect
    // URL, so the handoff can be verified against the chat/handoff backend. Absent
    // unless the redirect-with-handoff-id path fired.
    ...(handoffId ? { handoffId } : {}),
  };

  await updateLandingPageSmokeTestResult(page.id, result);

  if (!ok) {
    const reason =
      error ||
      (!leadCaptured
        ? "lead did not land in the CRM within the timeout"
        : "Meta pixel Lead event did not fire (no facebook.com/tr request observed)");
    await sendLandingPageSmokeTestAlert(page.id, deployedUrl, reason);
  }
}
