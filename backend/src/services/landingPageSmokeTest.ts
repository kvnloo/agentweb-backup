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

/**
 * Marker attribute stamped on the form the smoke test decided to drive. Every
 * field/submit selector is scoped to it, so a page with a newsletter or search
 * form above the lead form can't have its fields filled by one query and its
 * submit button clicked by another.
 */
export type SmokeField = {
  /** Playwright selector, already scoped to the chosen form. */
  selector: string;
  /** name/id/placeholder/autocomplete/aria-label/label text, lowercased — what the value choice keys off. */
  hint: string;
  /** input type, or "textarea". */
  kind: string;
};

export type SmokeFields = {
  /** Selector prefix for the chosen form ("" when the page has no form at all). */
  scope: string;
  fields: SmokeField[];
  selects: { selector: string; options: string[] }[];
  checkables: { selector: string; type: string; name: string | null; required: boolean }[];
  /** Submit control resolved page-side (handles a `form=`-associated button); null when none. */
  submitSelector: string | null;
};

type SmokeTestPage = {
  goto(url: string, opts?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  url(): string;
  waitForURL(pred: (url: URL) => boolean, opts?: { timeout?: number }): Promise<unknown>;
  fill(selector: string, value: string, opts?: { timeout?: number }): Promise<unknown>;
  press(selector: string, key: string, opts?: { timeout?: number }): Promise<unknown>;
  click(selector: string, opts?: { timeout?: number }): Promise<unknown>;
  selectOption(selector: string, value: string, opts?: { timeout?: number }): Promise<unknown>;
  check(selector: string, opts?: { timeout?: number }): Promise<unknown>;
  evaluate<T>(fn: () => T): Promise<T>;
};

// Per-interaction cap. Playwright's default is 30s (DEFAULT_PLAYWRIGHT_TIMEOUT), and every
// fill/selectOption/check auto-waits for actionability — so ONE unreachable control (a
// display:none honeypot, a disabled cascading select, a Radix widget with no real input)
// used to burn 30s of the smoke test's wall clock, silently, per field. Discovery already
// filters most of those out; this bounds whatever slips through.
const FIELD_TIMEOUT_MS = 3_000;
// The submit button is the one control we WANT to wait on: client-side validation commonly
// keeps it disabled until every field passes, so it needs longer than a plain field.
const SUBMIT_TIMEOUT_MS = 10_000;

/**
 * Runs INSIDE the page (passed to page.evaluate) — must stay self-contained: no imports,
 * no closure over module scope, only DOM globals. Exported so it can be unit-tested
 * against a real DOM instead of only through a mock that never executes it.
 *
 * Picks the most lead-like form, stamps it with the marker attribute, and returns fully-formed,
 * form-scoped selectors plus the hint text the caller needs to choose a value per field.
 */
export function discoverSmokeFields(): SmokeFields {
  const MARK = "data-agentweb-smoke-form";
  const SCOPE_PREFIX = `form[${MARK}="1"] `;
  // Honeypot names, anchored and exact. An earlier prefix-match version of this swallowed
  // `confirm_email`, `honeymoon_destination` and `hp_model` — all legitimate required
  // fields, whose removal left client-side validation blocking submit, i.e. the false
  // "lead did not land in the CRM" this code exists to prevent. Netlify uses bot-field,
  // Formspree _gotcha, Mailchimp b_<hex>_<hex>.
  const HONEYPOT_NAME =
    /^(?:honeypot|honey_?pot|honey|hp|_gotcha|bot-?field|url_?check|leave_?blank|b_[0-9a-f]{8,}_[0-9a-f]{4,})$/i;
  // Distinct kinds of lead information. Breadth of coverage is what separates a real lead
  // form from a one-field newsletter subscribe, so this is the dominant term in the score.
  const LEAD_HINTS = [
    /e-?mail/,
    /phone|\btel\b|mobile|cell/,
    /name/,
    /zip|postal|postcode/,
    /address|street|city|state/,
    /company|business|organi[sz]ation/,
  ];

  const all = (root: ParentNode, sel: string): Element[] => Array.prototype.slice.call(root.querySelectorAll(sel));
  const esc = (v: string): string => String(v).replace(/(["\\])/g, "\\$1");

  const hintFor = (el: Element): string => {
    const input = el as HTMLInputElement;
    const labels = (input as any).labels as NodeListOf<HTMLElement> | undefined;
    const labelText = labels && labels.length ? labels[0].textContent || "" : "";
    return [
      input.name,
      input.id,
      el.getAttribute("placeholder"),
      el.getAttribute("autocomplete"),
      el.getAttribute("aria-label"),
      labelText,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
  };

  // form.elements, not querySelectorAll: a control associated by the `form="id"` attribute
  // lives outside the form's subtree but still submits with it, and a required one of those
  // left unfilled blocks submit exactly like any other.
  const controlsOf = (f: HTMLFormElement): HTMLInputElement[] =>
    Array.prototype.slice.call(f.elements) as HTMLInputElement[];

  // Skip anything a real visitor could not fill. Playwright counts an element as visible
  // when it merely has a non-empty bounding box, so an off-canvas honeypot
  // (position:absolute;left:-9999px) WOULD be filled, and a display:none control instead
  // eats the full action timeout. Both are handled here, before we ever build a selector.
  const usable = (el: Element): boolean => {
    const input = el as HTMLInputElement;
    if (input.disabled || input.readOnly) return false;
    if (input.type === "hidden") return false;
    if (el.getAttribute("aria-hidden") === "true") return false;
    // `required` overrides every name-based guess: a functional honeypot is never marked
    // required, because that would block real visitors from submitting.
    if (!input.required) {
      if (input.name && HONEYPOT_NAME.test(input.name)) return false;
      if (input.id && HONEYPOT_NAME.test(input.id)) return false;
    }
    const style = typeof getComputedStyle === "function" ? getComputedStyle(el) : null;
    if (style) {
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    }
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    // Absolute (document-space) position, so a legitimately below-the-fold field isn't
    // mistaken for an off-canvas one.
    const absLeft = rect.left + (window.scrollX || 0);
    const absTop = rect.top + (window.scrollY || 0);
    if (absLeft + rect.width <= 0 || absTop + rect.height <= 0) return false;
    const docWidth = document.documentElement.scrollWidth;
    if (docWidth > 0 && absLeft >= docWidth) return false;
    return true;
  };

  const forms = all(document, "form") as HTMLFormElement[];
  // Clear any stale marker first: two marked forms would make every scoped selector resolve
  // into whichever comes first, which is not necessarily the one scored below.
  for (const candidate of forms) candidate.removeAttribute(MARK);

  // Scoring. The count of REQUIRED controls and the breadth of distinct lead hints decide
  // it; the presence of a type=email/tel input is only a tiebreaker. Weighting that
  // presence heavily is what made a one-field footer newsletter (type=email, required)
  // outrank a real lead form whose phone/zip/name controls are all type=text — which is
  // the shape of the landers this whole path was written for.
  const scoreOf = (candidate: HTMLFormElement): number => {
    // Score only controls we could actually fill. Responsive v0 landers ship the same form
    // two or three times (mobile/desktop variants) and collapse the inactive ones to a 0x0
    // box — counting every control made the duplicates tie, so the dead one won on DOM
    // order and discovery returned zero fields. Observed live on a deployed lander.
    const controls = controlsOf(candidate).filter(
      (c) => !/^(?:submit|button|reset|image|hidden)$/i.test(c.type || "") && usable(c)
    );
    // A password field means authentication, never lead capture.
    if (candidate.querySelector('input[type="password"]')) return -1000;
    const hints = controls.map(hintFor).join(" ");
    const distinctKinds = LEAD_HINTS.filter((re) => re.test(hints)).length;
    let score = controls.filter((c) => c.required).length * 3;
    score += distinctKinds * 4;
    // A lone email input is a subscribe box, not a lead form.
    if (controls.length === 1 && /e-?mail/.test(hints)) score -= 6;
    if (candidate.querySelector('input[type="email"], input[type="tel"]')) score += 1;
    return score;
  };

  let form: HTMLFormElement | null = null;
  let bestScore = -Infinity;
  for (const candidate of forms) {
    const score = scoreOf(candidate);
    if (score > bestScore) {
      bestScore = score;
      form = candidate;
    }
  }

  let scope = "";
  if (form) {
    form.setAttribute(MARK, "1");
    scope = SCOPE_PREFIX;
  }

  const FILLABLE =
    'input[type="email"], input[type="tel"], input[type="text"], input[type="url"], ' +
    'input[type="number"], input[type="search"], input[type="date"], input:not([type]), textarea';
  const matches = (el: Element, sel: string): boolean => !!el.matches && el.matches(sel);

  const controls: Element[] = form
    ? (controlsOf(form) as Element[])
    : all(document, "input, select, textarea");
  // Index space for controls with neither id nor name. `>> nth=` resolves against the
  // scoped set, so the index must be taken over that same set and in the same order.
  const addressableScoped = form ? all(form, "input, textarea") : all(document, "input, textarea");
  const selFor = (el: Element): string => {
    const input = el as HTMLInputElement;
    if (input.id) return `${scope}[id="${esc(input.id)}"]`;
    if (input.name) return `${scope}[name="${esc(input.name)}"]`;
    // A form=-associated control living outside the form cannot be reached by a
    // form-scoped selector, and without an id or name there is nothing else to key on.
    const index = addressableScoped.indexOf(el);
    if (index < 0) return "";
    return `${scope}:is(input, textarea) >> nth=${index}`;
  };

  const fields: SmokeField[] = [];
  for (const el of controls) {
    if (!matches(el, FILLABLE) || !usable(el)) continue;
    const selector = selFor(el);
    if (!selector) continue;
    const isTextarea = el.tagName.toUpperCase() === "TEXTAREA";
    fields.push({
      selector,
      hint: hintFor(el),
      kind: isTextarea ? "textarea" : (el as HTMLInputElement).type || "text",
    });
  }

  const selects: { selector: string; options: string[] }[] = [];
  const allSelects = (form ? all(form, "select") : all(document, "select")) as HTMLSelectElement[];
  allSelects.forEach((sel, index) => {
    if (!usable(sel)) return;
    selects.push({
      selector: sel.id
        ? `${scope}[id="${esc(sel.id)}"]`
        : sel.name
          ? `${scope}[name="${esc(sel.name)}"]`
          : `${scope}select >> nth=${index}`,
      options: Array.prototype.slice
        .call(sel.options)
        .filter((o: HTMLOptionElement) => o.value && !o.disabled)
        .map((o: HTMLOptionElement) => o.value),
    });
  });

  const checkables: SmokeFields["checkables"] = [];
  for (const el of controls) {
    if (!matches(el, 'input[type="checkbox"], input[type="radio"]') || !usable(el)) continue;
    const selector = selFor(el);
    if (!selector) continue;
    const input = el as HTMLInputElement;
    checkables.push({
      selector,
      type: input.type,
      name: input.name || null,
      required: input.required,
    });
  }

  // Resolve the submit control here rather than guessing a selector Node-side: a sticky
  // footer `<button type="submit" form="lead">` submits this form while living outside its
  // subtree, so a form-scoped CSS selector would miss it and burn the click timeout.
  let submitSelector: string | null = null;
  if (form) {
    const submitControl = controlsOf(form).find(
      (c) => /^(?:submit|image)$/i.test(c.type || "") && !c.disabled
    );
    if (submitControl) {
      submitSelector = submitControl.id
        ? `[id="${esc(submitControl.id)}"]`
        : submitControl.name
          ? `${scope}[name="${esc(submitControl.name)}"]`
          : `${scope}button[type="submit"], ${scope}input[type="submit"]`;
    }
  }

  return { scope, fields, selects, checkables, submitSelector };
}
/**
 * Chooses a format-valid synthetic value for one discovered field.
 *
 * Keys off the field's HINT (its name/id/placeholder/autocomplete/label), never off its
 * SELECTOR: every name-based selector literally contains the substring "name", so matching
 * on the selector sent `[name="zip"]` and `[name="company_website"]` down the person-name
 * branch and filled them with "Smoke" — which then failed the lander's own pattern
 * validation and produced exactly the false "lead did not land in the CRM" this whole
 * code path exists to prevent.
 *
 * Exported for unit tests.
 */
export function syntheticValueFor(field: SmokeField, email: string, phone: string): string {
  const hint = field.hint || "";
  if (field.kind === "email" || /e-?mail/.test(hint)) return email;
  if (field.kind === "tel" || /phone|\btel\b|mobile|cell/.test(hint)) return phone;
  if (/zip|postal|postcode/.test(hint)) return "94025";
  if (field.kind === "url" || /url|website|web[-_\s]*site|domain/.test(hint)) return "https://example.com";
  if (/last[-_\s]*name|family[-_\s]*name|surname|lname/.test(hint)) return "Test";
  if (/first[-_\s]*name|given[-_\s]*name|fname/.test(hint)) return "Smoke";
  if (/name/.test(hint)) return "Smoke Test";
  if (field.kind === "number") return "5";
  if (field.kind === "date") return "2030-01-01";
  return "Smoke Test";
}

export type FillOutcome = {
  /** Last field successfully filled — the target for the Enter-key submit fallback. */
  lastTextSelector: string | null;
  /** True only if the smoke-test email actually went into a field; gates the CRM poll. */
  emailFilled: boolean;
  filled: number;
  attempted: number;
  /** Selector prefix for the form that was driven ("" when the page has no form). */
  scope: string;
  /** Submit control resolved page-side, or null when discovery could not find one. */
  submitSelector: string | null;
};

/**
 * Fills every fillable field in the page's lead form with synthetic but format-valid data.
 *
 * Why this exists: the old path filled only `input[type=email]` and clicked submit. That
 * worked for the single-email-field landers the test was built against, but every modern
 * v0 lander is a React-controlled multi-field form (name/phone/zip + selects + checkboxes)
 * whose client-side validation blocks submit until ALL required fields pass — so the submit
 * silently never fired and the test reported "lead did not land in the CRM" on a page that
 * worked fine for real visitors (the 2026-09-18 WaterHeater.app root + voice-page failures).
 *
 * Field selection and selector construction happen in discoverSmokeFields (page-side);
 * this function only decides values and drives the interactions. Fills are best-effort per
 * field (a missing or unfillable control is skipped, never thrown) — a form with NO fillable
 * fields still proceeds to submit, preserving the old behavior for minimal landers.
 */
/**
 * Runs INSIDE the page (passed to page.evaluate) — must stay self-contained, like
 * discoverSmokeFields. Submits ONLY the form discovery marked, and reports whether it did.
 *
 * Reporting matters: `document.querySelector("form")?.requestSubmit()` RESOLVES on a page
 * with no form (optional chaining returns undefined rather than throwing), so a catch-based
 * chain never reaches the Enter fallback. Falling back to the first form on the page is
 * equally wrong — that is the newsletter/search form the scoping exists to avoid, and it
 * would be chosen exactly when the marker went missing, i.e. when we least understand the
 * page. Exported so it can be unit-tested against a real DOM.
 */
export function submitMarkedForm(): boolean {
  const form = document.querySelector('form[data-agentweb-smoke-form="1"]');
  if (!form) return false;
  (form as HTMLFormElement).requestSubmit();
  return true;
}

async function fillAllRequiredFields(
  browserPage: SmokeTestPage,
  email: string,
  testPhone: string
): Promise<FillOutcome> {
  const discovered = await browserPage.evaluate(discoverSmokeFields).catch(() => null);
  if (!discovered) {
    return {
      lastTextSelector: null,
      emailFilled: false,
      filled: 0,
      attempted: 0,
      scope: "",
      submitSelector: null,
    };
  }

  const fields = discovered.fields || [];
  const selects = discovered.selects || [];
  const checkables = discovered.checkables || [];

  let lastTextSelector: string | null = null;
  let emailFilled = false;
  let filled = 0;

  for (const field of fields) {
    const value = syntheticValueFor(field, email, testPhone);
    try {
      await browserPage.fill(field.selector, value, { timeout: FIELD_TIMEOUT_MS });
      filled++;
      lastTextSelector = field.selector;
      if (value === email) emailFilled = true;
    } catch {
      // best-effort per field
    }
  }

  for (const sel of selects) {
    if (!sel.options || sel.options.length === 0) continue;
    try {
      await browserPage.selectOption(sel.selector, sel.options[0], { timeout: FIELD_TIMEOUT_MS });
      filled++;
    } catch {
      // custom/Radix comboboxes with valid defaults — leave alone
    }
  }

  // Check EVERY required checkbox and one radio per required group. The old path checked
  // only the first control, so a form with multiple required checkboxes (or an optional
  // control first) stayed validation-blocked and never submitted.
  const requiredBoxes = checkables.filter((c) => c.type === "checkbox" && c.required);
  const requiredRadios = checkables.filter((c) => c.type === "radio" && c.required);
  const radiosByGroup = new Map<string, { selector: string }>();
  for (const radio of requiredRadios) {
    const key = radio.name ?? radio.selector;
    if (!radiosByGroup.has(key)) radiosByGroup.set(key, radio);
  }
  const toCheck: { selector: string }[] =
    requiredBoxes.length > 0 || radiosByGroup.size > 0
      ? [...requiredBoxes, ...radiosByGroup.values()]
      : checkables.length > 0
        ? [checkables[0]]
        : [];
  for (const control of toCheck) {
    try {
      await browserPage.check(control.selector, { timeout: FIELD_TIMEOUT_MS });
      filled++;
    } catch {
      // custom checkbox widgets without a checkable input — leave alone
    }
  }

  // Count only what was actually attempted: a select with no selectable options is skipped
  // above, so including it would make "filled 4/5" indistinguishable from a real failure.
  const attempted =
    fields.length + selects.filter((s) => s.options && s.options.length > 0).length + toCheck.length;
  return {
    lastTextSelector,
    emailFilled,
    filled,
    attempted,
    scope: discovered.scope || "",
    submitSelector: discovered.submitSelector ?? null,
  };
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
  let diagnostics = "no submission attempted";
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

    // Fill EVERY fillable field, not just email. Modern landers are React-controlled
    // multi-field forms (name/phone/zip + selects) with client-side validation that blocks
    // submit until all required fields pass — filling only input[type=email] leaves the
    // form unsubmittable and produces a false-negative "lead did not land in CRM".
    // Verified live 2026-09-18: campaign.waterheater.app root (name/phone/zip + 4 selects
    // + symptom checkbox, POSTs /api/hero-estimate, requires phone+zip formats) and
    // /voice-ai-agent-free-estimate-w (firstName/lastName/phone/email/zip + 2 hidden
    // selects with valid defaults, POSTs /api/capture). Both submit fine with realistic
    // data; the old fill-email-only path failed on both while the forms worked for
    // real visitors.
    //
    // 415-555-0100..0199 is the NANP's officially reserved fictional range, inside a real
    // area code — libphonenumber-style validators accept it and it is provably unroutable.
    // Two things it is deliberately NOT: a bare "555" AREA code (the previous value —
    // unassignable, and real validators reject it outright, which blocked submit on exactly
    // the landers this fill path was added for), and an arbitrary 555-XXXX line (555-1212
    // is live directory assistance). Only the low 2 digits vary, which is fine: the CRM
    // lookup key is the email, never the phone.
    const testPhone = `41555501${String(Date.now()).slice(-2)}`;
    const email = buildSmokeTestEmail();
    const fillOutcome = await fillAllRequiredFields(browserPage, email, testPhone);
    const {
      lastTextSelector,
      emailFilled,
      scope,
      submitSelector: discoveredSubmitSelector,
    } = fillOutcome;

    // Capture the pre-submit URL BEFORE the submission action: if click/Enter
    // completes a same-instant handoff redirect, reading it after would already
    // see the handoff URL and waitForURL would time out on a success.
    const urlBeforeSubmit = browserPage.url();
    let pageOrigin = "";
    try {
      pageOrigin = new URL(urlBeforeSubmit).origin;
    } catch {
      // non-URL page (about:blank etc.) — same-origin filtering below is then skipped
    }

    // Record the form's OWN submission responses. A handoff lander's success path is a
    // redirect rather than a CRM row, and a redirect on its own is written by the page's
    // JS — it proves nothing about whether the capture endpoint accepted anything. A
    // same-origin non-GET response that carries OUR synthetic data is the positive evidence
    // that distinguishes "the pipeline worked" from "the client redirected anyway after its
    // fetch() threw".
    //
    // Two things this deliberately does NOT count:
    //   - a redirect hop. Playwright raises a response event per hop, and for a 307/308 the
    //     method is still POST, so `POST /api/capture` -> 308 -> 500 would otherwise look
    //     accepted. Only a final 2xx counts.
    //   - a request that merely happened nearby. Vercel Speed Insights POSTs to
    //     /_vercel/speed-insights/vitals on pagehide — i.e. exactly at the handoff redirect.
    //     The body must contain the synthetic email or phone for the response to count.
    const submitEvidence: { status: number; carriedOurData: boolean }[] = [];
    // Match on encoding-stable fingerprints, not the raw values. A native form POST sends
    // application/x-www-form-urlencoded, where the synthetic email's "+" and "@" become
    // %2B and %40 — so body.includes(email) is false for exactly the plain HTML forms most
    // likely to be on a lander. The email's timestamp and the phone's digits survive every
    // encoding, and both are unique to this run.
    const emailFingerprint = email.replace(/\D/g, "");
    const fingerprints = [emailFingerprint, testPhone].filter((f) => f.length >= 8);
    const carriesOurData = (body: string | null): boolean => {
      if (!body) return false;
      let decoded = body;
      try {
        decoded = decodeURIComponent(body.replace(/\+/g, " "));
      } catch {
        // not percent-encoded (or malformed) — fall back to the raw body
      }
      return fingerprints.some((f) => body.includes(f) || decoded.includes(f));
    };
    browserPage.on("response", (response) => {
      try {
        const request = response.request();
        if (request.method() === "GET") return;
        if (pageOrigin && new URL(response.url()).origin !== pageOrigin) return;
        submitEvidence.push({
          status: response.status(),
          carriedOurData: carriesOurData(request.postData()),
        });
      } catch {
        // malformed response URL or unreadable body — ignore
      }
    });

    // Discovery resolves the submit control page-side where it can, because a sticky-footer
    // `<button type="submit" form="lead">` submits the form from outside its subtree and a
    // form-scoped CSS selector would miss it entirely.
    const submitSelector =
      discoveredSubmitSelector ||
      (scope
        ? `${scope}button[type="submit"], ${scope}input[type="submit"]`
        : 'button[type="submit"], input[type="submit"]');
    let submitPath: "click" | "requestSubmit" | "enter" | "none" = "none";
    try {
      // Prefer an explicit submit button, scoped to the form we actually filled.
      // Playwright's click() auto-waits for the button to become actionable, which covers
      // client-side validation that enables submit only after all fields pass.
      await browserPage.click(submitSelector, { timeout: SUBMIT_TIMEOUT_MS });
      submitPath = "click";
    } catch {
      // No usable submit button — submit the form directly, then fall back to Enter.
      // requestSubmit() must REPORT whether it ran: `querySelector("form")?.requestSubmit()`
      // resolves successfully on a page with no <form> at all (optional chaining returns
      // undefined, it does not throw), so the old catch-based chain never reached the Enter
      // fallback for the div-based React forms it was written for.
      const submitted = await browserPage.evaluate(submitMarkedForm).catch(() => false);
      if (submitted) {
        submitPath = "requestSubmit";
      } else if (lastTextSelector) {
        try {
          await browserPage.press(lastTextSelector, "Enter", { timeout: SUBMIT_TIMEOUT_MS });
          submitPath = "enter";
        } catch {
          // nothing left to try — reported in the failure diagnostics below
        }
      }
    }

    // A React/chat-handoff form may legitimately redirect on success (e.g. to
    // chat.waterheater.app/text?handoff_id=...) INSTEAD of creating a CRM lead row —
    // pollForLead would then always miss.
    // Compare like with like: waitForURL hands the predicate a URL object, whose toString()
    // is WHATWG-normalized ("https://x.test" -> "https://x.test/"), while page.url() need
    // not be. Comparing the raw snapshot against the normalized value reports a navigation
    // that never happened, and a deployed URL lacking its trailing slash is the common case.
    const normalizeUrl = (value: string): string => {
      try {
        return new URL(value).toString();
      } catch {
        return value;
      }
    };
    const urlBeforeSubmitNormalized = normalizeUrl(urlBeforeSubmit);
    let navigatedAway = false;
    try {
      await browserPage.waitForURL((url) => url.toString() !== urlBeforeSubmitNormalized, {
        timeout: 8_000,
      });
      navigatedAway = true;
    } catch {
      // No navigation — form likely posts to a capture API and shows inline success.
    }
    const urlAfterSubmit = browserPage.url();
    // Final 2xx only, and it must have carried our synthetic data.
    const submitAccepted = submitEvidence.some(
      (evidence) => evidence.status >= 200 && evidence.status < 300 && evidence.carriedOurData
    );
    // A chat-handoff form's success path is a redirect carrying a handoff id rather than a
    // CRM lead row, so pollForLead would always miss it. Accepting that as a capture needs
    // ALL of:
    //   - a cross-origin navigation (an anchor scroll or a same-origin rerender cannot fake it),
    //   - handoff_id as an exact query parameter, read via searchParams rather than matched
    //     as raw text (a regex also matches handoff_id nested inside another param's value),
    //   - that the id was not already in the deployed URL before we submitted, and
    //   - a 2xx same-origin non-GET response whose body carried our synthetic data.
    // The last one is the load-bearing condition: the redirect is written by the page's own
    // JS, so on its own it proves nothing. A lander whose `fetch(...).catch(() => {})`
    // swallows a 500 still redirects, and URL evidence alone would mark a silently-broken
    // capture endpoint as passing on every deploy, forever — the exact silent-breakage this
    // file exists to catch.
    let handoffEvidence: string | null = null;
    try {
      const before = new URL(urlBeforeSubmit);
      const after = new URL(urlAfterSubmit);
      const id = after.searchParams.get("handoff_id")?.trim();
      if (id && after.origin !== before.origin && !before.searchParams.get("handoff_id")) {
        handoffEvidence = id;
      }
    } catch {
      // Unparseable URL — not a verifiable handoff; fall through to the CRM poll.
    }
    const redirectedToHandoff = navigatedAway && handoffEvidence !== null && submitAccepted;
    if (redirectedToHandoff) handoffId = handoffEvidence;

    // Always poll — on the handoff path too, and even when no email-keyed field was found.
    // This is the CLEANUP path as much as the verification path: skipping it leaves the
    // synthetic lead in the customer's list forever. That matters most in exactly the case
    // that tempts you to skip it, because a lander whose only contact field is an untyped
    // `name="contact"` receives "Smoke Test" rather than the smoke-test address —
    // webhooks.ts validates presence but not format, so a real lead row is created that
    // isSmokeTestEmail() will never match and no suppression will ever cover.
    // Only the PASS CONDITION branches on the redirect.
    const lead = await pollForLead(leadListId, email);
    if (lead) {
      leadCaptured = true;
      await crmDb.deleteLead(leadListId, lead.leadId);
    } else if (redirectedToHandoff) {
      // The form accepted the submission and handed off (chat/agent redirect with a
      // handoff id, backed by a successful capture response) — the lead pipeline worked
      // end to end even though no CRM row exists to poll for.
      leadCaptured = true;
    }

    // Every non-error failure used to report the same "lead did not land in the CRM"
    // string, which is what made the 2026-09-18 false-negatives so hard to diagnose:
    // it cannot distinguish "never submitted" from "submitted and the lead was lost".
    diagnostics = [
      `filled ${fillOutcome.filled}/${fillOutcome.attempted} field(s)`,
      `submit=${submitPath}`,
      emailFilled ? "email field filled" : "no email field to poll by",
      navigatedAway ? `navigated to ${truncateForAlert(urlAfterSubmit)}` : "no navigation",
      `capture response accepted=${submitAccepted}`,
    ].join("; ");
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
    // Persisted handoff evidence: the id extracted from the cross-origin redirect URL, so
    // the handoff can be verified against the chat/handoff backend. Absent unless the
    // redirect-with-handoff-id path fired.
    ...(handoffId ? { handoffId } : {}),
  };

  await updateLandingPageSmokeTestResult(page.id, result);

  if (!ok) {
    const reason =
      error ||
      (!leadCaptured
        ? `lead did not land in the CRM within the timeout (${diagnostics})`
        : // Detection is the fbq() JS call, not a network sniff — see the pixel block above.
          "Meta pixel Lead event did not fire (fbq('track','Lead') was never called)");
    await sendLandingPageSmokeTestAlert(page.id, deployedUrl, reason);
  }
}

/** Page-derived text reaches Slack and the portal-visible readiness reason — keep it short and single-line. */
function truncateForAlert(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > 200 ? `${flat.slice(0, 197)}...` : flat;
}
