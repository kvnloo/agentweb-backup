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
import { buildSmokeTestEmail, buildSmokeTestPhone, isSmokeTestLead, phoneDigits } from "../utils/smokeTestLead";
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

/* eslint-disable-next-line no-irregular-whitespace */
/**
 * (See pollForLeadByPhone below for the per-run cleanup this pairs with.)
 *
 * Cleanup path for a lander that has NO email field.
 *
 * Such a page cannot carry our synthetic address, so the lander invents a placeholder —
 * `noemail+<timestamp>@<its own domain>` was observed live on campaign.waterheater.app —
 * and posts that. The smoke-test ADDRESS never matches it, so pollForLead misses it and the
 * synthetic row stays in the customer's CRM permanently. This matters MORE after the fill
 * fixes in this branch, not less: those pages used to fail validation and never submit at
 * all, so they created nothing. Now they submit, so every deploy would leave a row behind.
 *
 * Matched on the synthetic phone AND a createdAt at or after our own submit, so a real
 * lead can never be selected: the number is in the NANP's reserved fictional range, and the
 * time window is this one run.
 */
// Bounds on the start-of-run sweep: it runs on every deploy, so it must stay cheap.
const SWEEP_MAX_PAGES = 3;
const SWEEP_MAX_DELETES = 20;
// acquireSmokeTestSlot is module-scoped, so it serialises runs within ONE process. Across
// two backend instances, run B's start-of-run sweep would otherwise see run A's row (it
// predates B's start and carries the marker) and delete it out from under A's poll —
// turning a passing page into a false FAIL. Leave anything recent alone; a genuinely
// stranded row is minutes old by the next deploy, never seconds.
const SWEEP_MIN_AGE_MS = 2 * 60 * 1000;
/**
 * Delete synthetic leads that a PREVIOUS run stranded in this list.
 *
 * The per-run cleanup only has `pollMaxAttempts × pollIntervalMs` (8s by default) to find
 * the row it just created. If the capture write lands after that, the run reports FAIL and
 * the row is never deleted — which is how 45 synthetic leads accumulated across nine lists
 * between 2026-08-11 and 2026-08-20, four of them in a paying customer's CRM.
 *
 * That race matters more now: the fill fixes on this branch turn landers that used to fail
 * validation (creating nothing) into landers that submit, so more rows flow through an
 * 8-second window. Sweeping at the START of each run makes the failure self-correcting —
 * whatever the last deploy stranded, this one removes.
 *
 * Only rows provably ours are touched — isSmokeTestLead matches the smoke-test address OR
 * the reserved fictional phone. Note the limit of that second marker: it only reaches the
 * row if the lander posted its phone field as the top-level `phone` key. A lander using
 * `phoneNumber`/`tel`/`contact_phone` lands it in customFields, where neither suppression
 * nor this sweep can see it — a false negative, never a false positive. `beforeIso` is this run's start, so the row we are about to
 * create is never in scope.
 */
async function sweepStrandedSmokeLeads(listId: string, beforeIso: string): Promise<number> {
  let deleted = 0;
  let lastKey: any = undefined;
  try {
    for (let page = 0; page < SWEEP_MAX_PAGES && deleted < SWEEP_MAX_DELETES; page++) {
      const result = await crmDb.getLeadsByListId(listId, 100, lastKey);
      for (const lead of (result?.items || []) as any[]) {
        if (deleted >= SWEEP_MAX_DELETES) break;
        // Only rows that predate this run — never the one we are about to create.
        const createdAt = String(lead?.createdAt || "");
        if (!createdAt || createdAt >= beforeIso) continue;
        // Old enough that no in-flight run on another instance can still be polling for it.
        const createdMs = Date.parse(createdAt);
        if (!Number.isFinite(createdMs) || Date.now() - createdMs < SWEEP_MIN_AGE_MS) continue;
        if (!isSmokeTestLead(lead)) continue;
        if (!lead?.leadId) continue;
        await crmDb.deleteLead(listId, lead.leadId);
        deleted++;
        // This deletes rows from a paying customer's CRM. Log every one: if the marker ever
        // over-matches, an audit trail is the only way anyone finds out.
        console.log(
          `[smokeTest] swept stranded synthetic lead ${lead.leadId} from list ${listId} (created ${lead.createdAt})`
        );
      }
      lastKey = result?.lastEvaluatedKey;
      if (!lastKey) break;
    }
  } catch (err: any) {
    // Never let housekeeping change the run's verdict — but do not swallow it silently.
    console.warn(`[smokeTest] stranded-lead sweep failed for list ${listId}: ${err?.message || err}`);
  }
  if (deleted > 0) console.log(`[smokeTest] swept ${deleted} stranded synthetic lead(s) from list ${listId}`);
  return deleted;
}

async function pollForLeadByPhone(
  listId: string,
  phone: string,
  submittedAtIso: string
): Promise<{ leadId: string } | null> {
  // Shared with the suppression sites so an E.164 phone can never match in one place and
  // miss in the other.
  const wanted = phoneDigits(phone);
  if (!wanted) return null;
  for (let attempt = 0; attempt < pollMaxAttempts; attempt++) {
    try {
      // ScanIndexForward:false — newest first, so our row is at the top of page one.
      const page = await crmDb.getLeadsByListId(listId, 25);
      const hit = (page?.items || []).find(
        (lead: any) =>
          phoneDigits(lead?.phone) === wanted &&
          String(lead?.createdAt || "") >= submittedAtIso
      );
      if (hit?.leadId) return { leadId: hit.leadId as string };
    } catch {
      // list unreadable — nothing to clean up
    }
    if (attempt < pollMaxAttempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }
  return null;
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
  /** The field's own constraints, so a synthetic value cannot violate them. */
  min?: string | null;
  max?: string | null;
  step?: string | null;
  maxLength?: number | null;
};

export type SmokeFields = {
  /** Selector prefix for the chosen form ("" when the page has no form at all). */
  scope: string;
  fields: SmokeField[];
  selects: { selector: string; options: string[] }[];
  checkables: {
    selector: string;
    type: string;
    name: string | null;
    required: boolean;
    /**
     * True when `selector` targets the control's LABEL rather than the input itself (the
     * shadcn/Radix pattern renders a visually-hidden input whose label is its only clickable
     * surface). Diagnostic only — the caller drives every checkable through check() first
     * and falls back to click(), so it does not branch on this.
     */
    viaLabel: boolean;
    /** Already-checked controls must not be toggled back off. */
    checked: boolean;
    /** True for a role=checkbox/radio/switch widget rather than a native input. */
    isAria: boolean;
  }[];
  /** Submit control resolved page-side (handles a `form=`-associated button); null when none. */
  submitSelector: string | null;
  /** Collapsed ARIA disclosures inside the form, to be opened before a second discovery pass. */
  disclosureTriggers: string[];
  /** Required controls the page has but we could not reach — the usual reason a submit is blocked. */
  skippedRequired: number;
  /** True when the page has no <form> and no fillable control at all. */
  noFormOnPage: boolean;
  /** Every form on the page was an authentication form; there is no lead form to drive. */
  authFormOnly: boolean;
  /** iframes in the main document — a form may be embedded in one, invisible to page.evaluate. */
  iframeCount: number;
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
  const CLICK_MARK = "data-agentweb-smoke-click";
  const DISCLOSURE_MARK = "data-agentweb-smoke-disclosure";
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

  const hasBox = (el: Element): boolean => {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const absLeft = rect.left + (window.scrollX || 0);
    const absTop = rect.top + (window.scrollY || 0);
    if (absLeft + rect.width <= 0 || absTop + rect.height <= 0) return false;
    const docWidth = document.documentElement.scrollWidth;
    if (docWidth > 0 && absLeft >= docWidth) return false;
    return true;
  };

  /**
   * A visually-hidden control is still reachable when its label carries the box — that is
   * how shadcn/Radix checkboxes are built, and clicking the label toggles the input. Returns
   * the label only when the label itself is actually visible.
   */
  const clickableLabel = (el: Element): HTMLElement | null => {
    const labels = (el as any).labels as NodeListOf<HTMLElement> | undefined;
    if (!labels || !labels.length) return null;
    const label = labels[0];
    const style = typeof getComputedStyle === "function" ? getComputedStyle(label) : null;
    if (style && (style.display === "none" || style.visibility === "hidden")) return null;
    return hasBox(label) ? label : null;
  };

  // Skip anything a real visitor could not fill. Playwright counts an element as visible
  // when it merely has a non-empty bounding box, so an off-canvas honeypot
  // (position:absolute;left:-9999px) WOULD be filled, and a display:none control instead
  // eats the full action timeout. Both are handled here, before we ever build a selector.
  // allowLabelProxy: only a checkbox/radio can be operated through its label. A text input
  // cannot be filled by clicking one, so letting an invisible one through there would just
  // spend a fill timeout per field.
  const usable = (el: Element, allowLabelProxy?: boolean): boolean => {
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
    // Checked BEFORE the control's own style and geometry: a shadcn/Radix checkbox is
    // deliberately invisible (display:none or sr-only) and its label is the only clickable
    // surface, so judging the input by its own box rejects a control a visitor can plainly use.
    if (allowLabelProxy && clickableLabel(el)) return true;
    const style = typeof getComputedStyle === "function" ? getComputedStyle(el) : null;
    if (style) {
      if (style.display === "none" || style.visibility === "hidden") return false;
      // Playwright's own visibility test ignores opacity, and this samples once, right after
      // networkidle — so a required control mid-fade-in was being dropped rather than waited
      // for. opacity:0 on an OPTIONAL control is still treated as a hidden trap.
      if (style.opacity === "0" && !(el as HTMLInputElement).required) return false;
    }
    return hasBox(el);
  };

  // Clear every marker this function stamps, so a second discovery pass cannot inherit
  // stale targets from the first.
  // Sweep CLICK_MARK only. Its values restart at 0 each pass and page.click is non-strict,
  // so a surviving pass-1 mark would alias onto the wrong element.
  for (const stale of all(document, `[${CLICK_MARK}]`)) stale.removeAttribute(CLICK_MARK);
  // DISCLOSURE_MARK must SURVIVE across passes: the caller opens a trigger using the pass-1
  // selector and closes it with that same selector after re-discovery. Clearing it stranded
  // the close click — the trigger is no longer in `[aria-expanded="false"]` once opened, so
  // pass 2 could not re-stamp it, and the mark could be reissued to a different collapsed
  // trigger, which the close pass would then OPEN right before submit.
  let nextDisclosureMark = 0;
  for (const marked of all(document, `[${DISCLOSURE_MARK}]`)) {
    const n = Number(marked.getAttribute(DISCLOSURE_MARK));
    if (Number.isFinite(n) && n >= nextDisclosureMark) nextDisclosureMark = n + 1;
  }

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
    // (An auth form is rejected structurally in the selection loop, not by score: a score
    // can always win when it is the only candidate.)
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
  let rejectedAuthForm = false;
  for (const candidate of forms) {
    // A password field means authentication, never lead capture. This has to skip the
    // candidate outright — scoring it -1000 still won when it was the only form on the page,
    // and the smoke test then typed a synthetic address into a login box and clicked submit
    // against a real auth endpoint on every deploy.
    if (candidate.querySelector('input[type="password"]')) {
      rejectedAuthForm = true;
      continue;
    }
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

  // Every form on the page was rejected as an authentication form. Falling through to
  // document-wide discovery would type a synthetic address into the login box and click its
  // submit against a real auth endpoint — the exact behaviour the rejection exists to stop.
  const authFormOnly = form === null && rejectedAuthForm;
  const controls: Element[] = form
    ? (controlsOf(form) as Element[])
    : authFormOnly
      ? []
      : all(document, "input, select, textarea");
  // Index space for controls with neither id nor name. `>> nth=` resolves against the
  // scoped set, so the index must be taken over that same set and in the same order.
  const addressableScoped = form ? all(form, "input, textarea") : all(document, "input, textarea");
  const selFor = (el: Element): string => {
    const input = el as HTMLInputElement;
    // A control associated by `form="id"` submits with the form while living OUTSIDE its
    // subtree, so a form-scoped descendant selector cannot reach it.
    const prefix = form && !form.contains(el) ? "" : scope;
    if (input.id) return `${prefix}[id="${esc(input.id)}"]`;
    if (input.name) return `${prefix}[name="${esc(input.name)}"]`;
    // A form=-associated control living outside the form cannot be reached by a
    // form-scoped selector, and without an id or name there is nothing else to key on.
    const index = addressableScoped.indexOf(el);
    if (index < 0) return "";
    return `${scope}:is(input, textarea) >> nth=${index}`;
  };

  // Elements discovery actually emitted a selector for. skippedRequired is derived from
  // this rather than re-deriving usable(), so it also catches required controls of types
  // outside FILLABLE (datetime-local, color, file...) and ones dropped for having no
  // addressable id, name or index.
  const emitted = new Set<Element>();
  const fields: SmokeField[] = [];
  for (const el of controls) {
    if (!matches(el, FILLABLE) || !usable(el)) continue;
    const selector = selFor(el);
    if (!selector) continue;
    const isTextarea = el.tagName.toUpperCase() === "TEXTAREA";
    const input = el as HTMLInputElement;
    const maxLengthAttr = el.getAttribute("maxlength");
    emitted.add(el);
    fields.push({
      selector,
      hint: hintFor(el),
      kind: isTextarea ? "textarea" : input.type || "text",
      min: el.getAttribute("min"),
      max: el.getAttribute("max"),
      step: el.getAttribute("step"),
      maxLength: maxLengthAttr ? Number(maxLengthAttr) : null,
    });
  }

  const selects: { selector: string; options: string[] }[] = [];
  // Gated on authFormOnly for the same reason `controls` is: selecting an option in a login
  // form's realm dropdown and then clicking its submit posts to a real auth endpoint.
  const allSelects = (
    authFormOnly ? [] : form ? all(form, "select") : all(document, "select")
  ) as HTMLSelectElement[];
  allSelects.forEach((sel, index) => {
    if (!usable(sel)) return;
    emitted.add(sel);
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

  let clickTargets = 0;
  const checkables: SmokeFields["checkables"] = [];
  // Native inputs plus ARIA widgets. shadcn/Radix renders a checkbox as
  // <button role="checkbox" aria-checked> with a visually-hidden proxy input carrying
  // aria-hidden — which usable() rejects — so keying only on input[type=checkbox] made the
  // control invisible everywhere: never filled, and never even counted as unreachable.
  const ARIA_CHECKABLE = '[role="checkbox"], [role="radio"], [role="switch"]';
  // form.elements is an HTMLFormControlsCollection — only form-associated elements — so a
  // <div role="checkbox"> inside the form never appeared there. Union the subtree scan in.
  const ariaEls = form ? all(form, ARIA_CHECKABLE) : all(document, ARIA_CHECKABLE);
  const checkableSeen = new Set<Element>();
  const checkableEls = [...controls, ...ariaEls].filter((el) => {
    if (checkableSeen.has(el)) return false;
    if (!matches(el, `input[type="checkbox"], input[type="radio"], ${ARIA_CHECKABLE}`)) return false;
    // A <button> with no type attribute is a SUBMIT control. Treating one as a checkable
    // makes check() click it, submitting the form mid-fill — before the response listener
    // is attached and before the submit timestamp is taken.
    if (el.tagName.toUpperCase() === "BUTTON" && (el as HTMLButtonElement).type !== "button") return false;
    checkableSeen.add(el);
    return true;
  });
  checkableEls.forEach((el) => {
    if (!usable(el, true)) return;
    const input = el as HTMLInputElement;
    const ariaRole = el.getAttribute("role");
    const isAria = !!ariaRole && matches(el, ARIA_CHECKABLE);
    const label = hasBox(el) ? null : clickableLabel(el);
    const viaLabel = label !== null;
    let selector: string;
    if (!viaLabel) {
      selector = selFor(el);
      if (!selector && isAria) {
        el.setAttribute(CLICK_MARK, String(clickTargets++));
        selector = `[${CLICK_MARK}="${clickTargets - 1}"]`;
      }
    } else {
      // Stamp the exact label we mean. A `label:has([id="x"])` selector only matches a label
      // that CONTAINS the input, while shadcn/ui ships the two as siblings
      // (`<Checkbox id="terms" /><label for="terms">`) — so the emitted selector matched
      // nothing and the click timed out on a control discovery had called reachable.
      label!.setAttribute(CLICK_MARK, String(clickTargets++));
      selector = `[${CLICK_MARK}="${clickTargets - 1}"]`;
    }
    if (!selector) return;
    emitted.add(el);
    checkables.push({
      selector,
      // An ARIA widget reports its role. Playwright's check() drives these natively —
      // kAriaCheckedRoles in its injected script covers checkbox/radio/switch and reads
      // aria-checked — so no special path is needed here.
      type: isAria ? (ariaRole === "radio" ? "radio" : "checkbox") : input.type,
      name: input.name || el.getAttribute("name") || null,
      required: isAria ? el.getAttribute("aria-required") === "true" : input.required,
      viaLabel,
      // Reported so an already-satisfied control is never toggled back off.
      checked: isAria ? el.getAttribute("aria-checked") === "true" : !!input.checked,
      isAria,
    });
  });

  // Collapsed ARIA disclosures (a "What's happening?" popover holding a checkbox group).
  // Reported rather than clicked here: opening one needs a trusted event, which only
  // Playwright's own click produces — an in-page el.click() leaves React's state untouched.
  // Selectors must stay stable across the open/close round-trip: after the open click the
  // trigger's aria-expanded flips to "true", so an id-less `[aria-expanded="false"] >>
  // nth=i` selector no longer matches the same element on close (it can match a different
  // collapsed trigger or fail outright). Stamp a marker attribute at discovery time and
  // select on that instead.
  // Each trigger costs up to FIELD_TIMEOUT_MS to open and the same to close, and the whole
  // run holds the single smoke-test slot. A quiz/accordion lander should not stall a queue.
  const MAX_DISCLOSURES = 5;
  const disclosureTriggers: string[] = [];
  if (form) {
    const triggers = all(form, '[aria-expanded="false"]');
    triggers.forEach((t) => {
      if (disclosureTriggers.length >= MAX_DISCLOSURES) return;
      if (!hasBox(t)) return;
      // A <button> with no type inside a form defaults to type="submit". Clicking one here
      // would submit the form before a single field has been filled, and before the response
      // listener even exists.
      const tag = t.tagName.toUpperCase();
      // HTMLButtonElement.type always resolves ("submit" when the attribute is absent), so
      // a typeless <button> inside a form is a submit control — clicking one here would
      // submit before a single field is filled.
      if (tag === "BUTTON" && (t as HTMLButtonElement).type !== "button") return;
      // An <input> is never a disclosure, and an <a href> click navigates away and destroys
      // the page. An anchor with no real href is a common hand-written disclosure — keep it.
      if (tag === "INPUT") return;
      if (tag === "A") {
        const href = t.getAttribute("href");
        if (href && href !== "#") return;
      }
      // Only open a disclosure that actually holds a checkbox/radio group. aria-expanded
      // ALSO marks Radix Select triggers ("Select your issue"), and opening one of those
      // puts a listbox overlay over the page that swallows every later click, including the
      // submit — observed turning a working lander into a total failure. The panel named by
      // aria-controls has to contain checkables for the click to be worth the risk.
      const controlsId = t.getAttribute("aria-controls");
      const panel = controlsId ? document.getElementById(controlsId) : null;
      if (!panel || !panel.querySelector('input[type="checkbox"], input[type="radio"]')) return;
      // A Radix Popover/Dialog renders its panel in a portal at document.body, outside the
      // form. Controls harvested from form.elements can never reach those, so opening it
      // buys nothing and leaves an overlay sitting over the rest of the form.
      if (!form.contains(panel)) return;
      if (t.id) {
        disclosureTriggers.push(`${scope}[id="${esc(t.id)}"]`);
      } else {
        // Reuse an existing mark so a selector handed out on a previous pass keeps pointing
        // at this same element.
        const existing = t.getAttribute(DISCLOSURE_MARK);
        const mark = existing !== null ? existing : String(nextDisclosureMark++);
        t.setAttribute(DISCLOSURE_MARK, mark);
        disclosureTriggers.push(`${scope}[${DISCLOSURE_MARK}="${mark}"]`);
      }
    });
  }

  // Resolve the submit control here rather than guessing a selector Node-side: a sticky
  // footer `<button type="submit" form="lead">` submits this form while living outside its
  // subtree, so a form-scoped CSS selector would miss it and burn the click timeout.
  let submitSelector: string | null = null;
  if (form) {
    const submitControl = controlsOf(form).find(
      (c) =>
        /^(?:submit|image)$/i.test(c.type || "") &&
        !c.disabled &&
        // An ARIA checkable reports type "submit" when it is a typeless <button>; it is a
        // checkbox, not the form's submit control.
        !matches(c, ARIA_CHECKABLE)
    );
    if (submitControl) {
      if (submitControl.id) {
        // Scope it when it lives inside the form: responsive landers ship the same form
        // (and the same ids) two or three times, page.click is non-strict, and the
        // collapsed duplicate comes first in DOM order.
        submitSelector = form.contains(submitControl)
          ? `${scope}[id="${esc(submitControl.id)}"]`
          : `[id="${esc(submitControl.id)}"]`;
      } else if (submitControl.name) {
        submitSelector = form.contains(submitControl)
          ? `${scope}[name="${esc(submitControl.name)}"]`
          : `[name="${esc(submitControl.name)}"]`;
      } else {
        // Stamp it. `button[type="submit"]` does not match a <button> with no type
        // attribute, even though that button IS the form's submit control — which cost the
        // full submit timeout before falling back to requestSubmit.
        submitControl.setAttribute(CLICK_MARK, String(clickTargets++));
        submitSelector = `[${CLICK_MARK}="${clickTargets - 1}"]`;
      }
    }
  }

  // Required controls that exist but were filtered out (invisible, off-canvas, custom
  // widget with no reachable input or label). These are the usual reason a lander's own
  // validation blocks submit, and saying so beats reporting "no lead in the CRM".
  const requiredCandidates = [...controls, ...ariaEls].filter(
    (el, i, arr) => arr.indexOf(el) === i
  );
  const skippedRequired = requiredCandidates.filter((el) => {
    const input = el as HTMLInputElement;
    const required = input.required || el.getAttribute("aria-required") === "true";
    if (!required) return false;
    return !emitted.has(el);
  }).length;
  const noFormOnPage =
    (forms.length === 0 || authFormOnly) && fields.length === 0 && checkables.length === 0;
  // A HubSpot/Typeform/Calendly embed is a normal lead-capture lander, and page.evaluate
  // only ever sees the main frame — so "no lead form" would be confidently wrong.
  const iframeCount = all(document, "iframe").length;

  return {
    scope,
    fields,
    selects,
    checkables,
    submitSelector,
    disclosureTriggers,
    skippedRequired,
    noFormOnPage,
    authFormOnly,
    iframeCount,
  };
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
  const value = chooseSyntheticValue(field, email, phone);
  // Respect the field's own constraints: a value that violates min/max/maxlength fails the
  // lander's validation and blocks submit, which is the false negative this path exists to
  // remove. Length is trimmed last so a clamped number is never re-truncated.
  if (field.kind === "number") {
    const num = (v: string | null | undefined): number | null => {
      if (v == null || v === "") return null;
      const parsed = Number(v);
      return Number.isFinite(parsed) ? parsed : null;
    };
    const min = num(field.min);
    const max = num(field.max);
    const step = num(field.step);
    let clamped = Number.isFinite(Number(value)) ? Number(value) : 1;
    if (max !== null && clamped > max) clamped = max;
    // min is applied AFTER max: when the two contradict each other (min > max) the field is
    // unsatisfiable either way, and landing below min is the more common validation failure.
    if (min !== null && clamped < min) clamped = min;
    // A `step` field rejects anything off its ladder, so "5" fails step="10" outright.
    if (step !== null && step > 0) {
      const base = min !== null ? min : 0;
      const snapped = base + Math.ceil((clamped - base) / step) * step;
      clamped = max !== null && snapped > max ? base : snapped;
    }
    return String(clamped);
  }
  if (field.kind === "date") {
    // Compare only against a well-formed YYYY-MM-DD bound. String comparison against a
    // `max="12/31/2026"` would "clamp" to that literal, and Chromium rejects any non-ISO
    // value outright — dropping a required date that previously filled fine.
    const isIsoDate = (v: string | null | undefined): v is string => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);
    if (isIsoDate(field.max) && value > field.max) return field.max;
    if (isIsoDate(field.min) && value < field.min) return field.min;
    return value;
  }
  if (field.maxLength && field.maxLength > 0 && value.length > field.maxLength) {
    return value.slice(0, field.maxLength);
  }
  return value;
}

function chooseSyntheticValue(field: SmokeField, email: string, phone: string): string {
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
  /** Controls that were already checked and deliberately left alone. */
  alreadySatisfied: number;
  /** Selector prefix for the form that was driven ("" when the page has no form). */
  scope: string;
  /** Submit control resolved page-side, or null when discovery could not find one. */
  submitSelector: string | null;
  /** Required controls the page has but we could not reach. */
  skippedRequired: number;
  /** The page has no form and nothing fillable — there is no capture path to test. */
  noFormOnPage: boolean;
  /** Every form on the page was an authentication form; there is no lead form to drive. */
  authFormOnly: boolean;
  /** iframes in the main document, for an honest "no lead form" message. */
  iframeCount: number;
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
  let discovered = await browserPage.evaluate(discoverSmokeFields).catch(() => null);

  // Open any collapsed disclosure inside the form before deciding what is fillable. A
  // required checkbox group can live behind a "What's happening?" popover, and until it is
  // open the group is unreachable — the lander's own JS then blocks submit while HTML5
  // checkValidity() still reports true, which reads here as a working page that "did not
  // land a lead". The click has to come from Playwright: an in-page el.click() flips no
  // React state. Re-discover afterwards so the newly revealed controls are picked up.
  const openedTriggers: string[] = [];
  if (discovered && discovered.disclosureTriggers && discovered.disclosureTriggers.length > 0) {
    for (const trigger of discovered.disclosureTriggers) {
      try {
        await browserPage.click(trigger, { timeout: FIELD_TIMEOUT_MS });
        openedTriggers.push(trigger);
      } catch {
        // not actually openable — leave it
      }
    }
    if (openedTriggers.length > 0) {
      const reDiscovered = await browserPage.evaluate(discoverSmokeFields).catch(() => null);
      if (reDiscovered) discovered = reDiscovered;
    }
  }

  if (!discovered) {
    return {
      lastTextSelector: null,
      emailFilled: false,
      filled: 0,
      attempted: 0,
      alreadySatisfied: 0,
      scope: "",
      submitSelector: null,
      skippedRequired: 0,
      noFormOnPage: false,
      authFormOnly: false,
      iframeCount: 0,
    };
  }

  const fields = discovered.fields || [];
  const selects = discovered.selects || [];
  const checkables = discovered.checkables || [];

  let alreadySatisfied = 0;
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
  const toCheck: { selector: string; viaLabel?: boolean; checked?: boolean; isAria?: boolean }[] =
    requiredBoxes.length > 0 || radiosByGroup.size > 0
      ? [...requiredBoxes, ...radiosByGroup.values()]
      : checkables.length > 0
        ? // Prefer a native checkbox: a role="switch" ("SMS updates") appearing earlier in
          // the form would otherwise steal this slot from the consent box the lander's own
          // validation actually gates submit on.
          [checkables.find((c) => c.type === "checkbox" && !c.isAria) ?? checkables[0]]
        : [];
  for (const control of toCheck) {
    // Already satisfied — leave it alone. A pre-checked required consent box is common, and
    // toggling it off is a false FAIL manufactured out of a working page.
    if (control.checked) {
      alreadySatisfied++;
      continue;
    }
    try {
      // check() first, even for a label target: Playwright retargets a label to its control
      // ("follow-label" in dom.js) and is idempotent — it reads the checked state and returns
      // early if it already matches. click() is neither, so it can UNCHECK a box. click()
      // stays only as a fallback for widgets check() cannot resolve.
      await browserPage.check(control.selector, { timeout: FIELD_TIMEOUT_MS });
      filled++;
    } catch (err: any) {
      // check() CLICKS and then re-reads; "did not change its state" means the click landed
      // but the control is controlled/deferred. Clicking again would toggle it back off.
      // Only retry when check() could not treat the target as a checkable at all — defensive
      // only: every selector discovery emits (native inputs, the three ARIA roles, and
      // label targets, which retarget via follow-label) is something check() can drive, so
      // this branch is not expected to fire in production.
      const message = String(err?.message || "");
      if (!/Not a checkbox or radio button|Element is not an <input>/i.test(message)) continue;
      try {
        await browserPage.click(control.selector, { timeout: FIELD_TIMEOUT_MS });
        filled++;
      } catch {
        // custom checkbox widget with no reachable input or label — leave alone
      }
    }
  }

  // Count only what was actually attempted: a select with no selectable options is skipped
  // above, so including it would make "filled 4/5" indistinguishable from a real failure.
  // Collapse anything we opened: a popover left open can overlay the submit button and
  // swallow the click that follows.
  for (const trigger of openedTriggers) {
    try {
      await browserPage.click(trigger, { timeout: FIELD_TIMEOUT_MS });
    } catch {
      // already closed, or the trigger moved — the submit click auto-waits for actionability
    }
  }

  const attempted =
    fields.length + selects.filter((s) => s.options && s.options.length > 0).length + toCheck.length;
  return {
    lastTextSelector,
    emailFilled,
    filled,
    attempted,
    alreadySatisfied,
    scope: discovered.scope || "",
    submitSelector: discovered.submitSelector ?? null,
    skippedRequired: discovered.skippedRequired ?? 0,
    noFormOnPage: !!discovered.noFormOnPage,
    authFormOnly: !!discovered.authFormOnly,
    iframeCount: discovered.iframeCount ?? 0,
  };
}


/**
 * Runs the smoke test for a just-deployed page. NEVER throws — every failure mode (browser
 * launch, navigation, form submission, CRM lookup, even the result-persist/alert calls
 * themselves) is caught and reported as a failed result rather than propagated, since this
 * always runs fire-and-forget (`void runGenerationSmokeTest(...)`) with nobody awaiting it.
 * (The result-persist and alert calls at the very end sit OUTSIDE that try/finally — both
 * call sites in v0Service attach their own .catch, which is what actually holds the
 * never-throws guarantee there.)
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
  // Anything synthetic already in this list predates us, so sweep before creating our row.
  const sweptStranded = await sweepStrandedSmokeLeads(leadListId, checkedAt);
  const pixelExpected = !!page.metaPixelId;
  let leadCaptured = false;
  let pixelFired = false;
  let error: string | undefined;
  let diagnostics = "no submission attempted";
  let handoffId: string | null = null;
  let noFormOnPage = false;
  let authFormOnly = false;
  let iframeCount = 0;
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
    // Built by the shared helper, so the number we FILL and the number webhooks.ts
    // SUPPRESSES on can never drift apart. 415-555-0100..0199 is the NANP's reserved
    // fictional range inside a real area code — accepted by libphonenumber-style validators
    // (unlike a bare "555" area code, which is unassignable and blocked submit on exactly
    // the landers this path was added for), provably unroutable (unlike an arbitrary
    // 555-XXXX line: 555-1212 is live directory assistance), and impossible for a real
    // visitor to hold, which is what makes it safe to key suppression off.
    const testPhone = buildSmokeTestPhone();
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
    const submittedAtIso = new Date().toISOString();
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
    // Both are always long, digit-only and unique to this run — buildSmokeTestEmail embeds a
    // 13-digit timestamp and the phone is 10 digits.
    const fingerprints = [email.replace(/\D/g, ""), testPhone];
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
    // Nothing to submit: an auth-only page has no lead form, and a form-less page has no
    // control worth clicking. Attempting anyway costs SUBMIT_TIMEOUT_MS and — on an
    // auth-only page — would click the login form's submit via the unscoped fallback.
    const nothingToSubmit = fillOutcome.authFormOnly || fillOutcome.noFormOnPage;
    try {
      if (nothingToSubmit) throw new Error("no lead form to submit");
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
      const submitted = nothingToSubmit
        ? false
        : await browserPage.evaluate(submitMarkedForm).catch(() => false);
      if (submitted) {
        submitPath = "requestSubmit";
      } else if (lastTextSelector && !nothingToSubmit) {
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
    // Final 2xx carrying our synthetic data. Note this inspects the STATUS LINE only — a
    // handler that catches its own CRM failure and still returns 200 {"ok":false} would pass
    // this check. That is a narrower hole than the URL-only evidence it replaced, not a
    // closed one; reading the body would close it.
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
    // No `navigatedAway` conjunct: handoffEvidence already requires the post-submit URL to
    // be a DIFFERENT origin than the pre-submit one, which is proof of navigation on its
    // own. waitForURL resolves on the `load` event, so a slow third-party chat app made a
    // genuine handoff look like no navigation at all.
    const redirectedToHandoff = handoffEvidence !== null && submitAccepted;
    if (redirectedToHandoff) handoffId = handoffEvidence;

    // Always poll — on the handoff path too, and even when no email-keyed field was found.
    // This is the CLEANUP path as much as the verification path: skipping it leaves the
    // synthetic lead in the customer's list forever. That matters most in exactly the case
    // that tempts you to skip it, because a lander whose only contact field is an untyped
    // `name="contact"` receives "Smoke Test" rather than the smoke-test address —
    // webhooks.ts validates presence but not format, so a real lead row is created that the
    // ADDRESS marker will never match. The synthetic phone is what covers that case, both
    // here and at the suppression sites (isSmokeTestLead).
    // Only the PASS CONDITION branches on the redirect.
    // When no email field existed, fall back to the phone so the row we just created is
    // still found and deleted rather than stranded in the customer's CRM.
    const lead = emailFilled
      ? await pollForLead(leadListId, email)
      : await pollForLeadByPhone(leadListId, testPhone, submittedAtIso);
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
    noFormOnPage = fillOutcome.noFormOnPage;
    authFormOnly = fillOutcome.authFormOnly;
    iframeCount = fillOutcome.iframeCount;
    diagnostics = [
      `filled ${fillOutcome.filled}/${fillOutcome.attempted} field(s)`,
      ...(fillOutcome.alreadySatisfied > 0
        ? [`${fillOutcome.alreadySatisfied} already satisfied`]
        : []),
      ...(sweptStranded > 0 ? [`swept ${sweptStranded} stranded synthetic lead(s)`] : []),
      ...(fillOutcome.skippedRequired > 0
        ? [`${fillOutcome.skippedRequired} required control(s) unreachable`]
        : []),
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
        ? authFormOnly
          ? "page's only form is an authentication form (has a password field) — there is no lead form to submit"
          : noFormOnPage
          ? // Blaming the CRM for a page that has no form at all sends whoever reads the
            // alert looking for a capture bug that cannot exist. Say what is actually true.
            iframeCount > 0
            ? `no lead form in the main document (${iframeCount} iframe(s) present — the form may be embedded, which this test cannot reach)`
            : "page has no lead form — nothing to submit, so no lead can ever be captured"
          : `lead did not land in the CRM within the timeout (${diagnostics})`
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
