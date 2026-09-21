/**
 * Unit tests for the PAGE-SIDE half of the smoke test (`discoverSmokeFields`).
 *
 * landingPageSmokeTest.test.ts mocks page.evaluate, so the discovery callback never runs
 * there — the form choice, the honeypot/visibility filtering and every selector it builds
 * were invisible to the suite. This file runs the real function against a real DOM (jsdom,
 * in a child process — see helpers/runSmokeDiscovery.js for why), so a regression in any
 * of them fails a test instead of only failing in production.
 *
 * All fixtures run in one child process in beforeAll; each `it` asserts on its slice.
 */
import { spawnSync } from "child_process";
import path from "path";

const HELPER = path.join(__dirname, "helpers", "runSmokeDiscovery.js");
const SCOPE = 'form[data-agentweb-smoke-form="1"] ';

// Mirrors SmokeFields. Kept in sync by the typecheck in this file's own CI note: the build
// config excludes __tests__, so nothing else catches drift here.
type Discovered = {
  scope: string;
  fields: { selector: string; hint: string; kind: string; min?: string | null; max?: string | null; step?: string | null; maxLength?: number | null }[];
  selects: { selector: string; options: string[] }[];
  checkables: {
    selector: string;
    type: string;
    name: string | null;
    required: boolean;
    viaLabel: boolean;
    checked: boolean;
    isAria: boolean;
  }[];
  submitSelector: string | null;
  disclosureTriggers: string[];
  skippedRequired: number;
  noFormOnPage: boolean;
  authFormOnly: boolean;
  iframeCount: number;
};

/** Cases default to discoverSmokeFields; `fn` selects another exported page-side function. */
const SUBMIT_CASES: Record<string, string> = {
  submitMarked: `
    <form id="newsletter"><input type="email" name="EMAIL"><button type="submit">Join</button></form>
    <form id="lead" data-agentweb-smoke-form="1"><input type="email" name="email"><button type="submit">Send</button></form>`,
  submitNoMarkedForm: `
    <form id="newsletter"><input type="email" name="EMAIL"><button type="submit">Join</button></form>
    <div><input type="email" name="email"><button>Send</button></div>`,
};

const CASES: Record<string, string> = {
  twoForms: `
    <form id="newsletter"><input type="text" name="newsletter_email"><button type="submit">Join</button></form>
    <form id="lead">
      <input type="email" name="email" required>
      <input type="tel" name="phone" required>
      <button type="submit">Get estimate</button>
    </form>`,
  awkwardIdentifiers: `<form><input type="email" id=":r0:"><input type="text" name='a"b'></form>`,
  unfillable: `
    <form>
      <input type="email" name="email">
      <input type="text" name="disabled_field" disabled>
      <input type="text" name="readonly_field" readonly>
      <input type="hidden" name="hidden_field">
      <input type="text" name="aria_hidden_field" aria-hidden="true">
      <input type="text" name="zero_box" data-rect="0,0,0,0">
    </form>`,
  honeypots: `
    <form>
      <input type="email" name="email">
      <input type="text" name="offcanvas_trap" data-rect="-9999,0,120,24">
      <input type="text" name="above_viewport_trap" data-rect="0,-9999,120,24">
      <input type="text" name="bot-field">
      <input type="text" name="_gotcha">
      <input type="text" name="honeypot">
      <input type="text" name="b_36c4fd991d0dfc11_2a5c1f0d">
    </form>`,
  honeypotLookalikes: `
    <form>
      <input type="email" name="email" required>
      <input type="email" name="confirm_email" required>
      <input type="text" name="honeymoon_destination" required>
      <input type="text" name="hp_model" required>
      <input type="text" name="b_2b_leads">
    </form>`,
  requiredTrapName: `
    <form>
      <input type="email" name="email" required>
      <input type="text" name="honeypot" required>
    </form>`,
  newsletterVsLead: `
    <form id="lead">
      <input type="text" name="full_name" required>
      <input type="text" name="phone_number" required>
      <input type="text" name="zip" required>
      <button type="submit">Get estimate</button>
    </form>
    <form id="newsletter"><input type="email" name="EMAIL" required><button type="submit">Join</button></form>`,
  loginForm: `
    <form id="login"><input type="email" name="email" required><input type="password" name="password" required></form>
    <form id="lead"><input type="text" name="full_name" required><input type="text" name="phone" required></form>`,
  formAssociated: `
    <form id="lead"><input type="email" name="email" required></form>
    <input form="lead" name="zip" required>
    <button form="lead" type="submit" id="sticky-submit">Send</button>`,
  collapsedDuplicateForm: `
    <form id="mobile-variant">
      <input type="text" name="firstName" required data-rect="0,0,0,0">
      <input type="email" name="email" required data-rect="0,0,0,0">
      <input type="tel" name="phone" required data-rect="0,0,0,0">
    </form>
    <form id="desktop-variant">
      <input type="text" name="firstName" required>
      <input type="email" name="email" required>
      <input type="tel" name="phone" required>
    </form>`,
  labelProxyCheckbox: `
    <form>
      <input type="email" name="email" required>
      <label data-rect="0,0,266,42">Water leaking<input type="checkbox" id="sym-leak" name="symptoms" data-rect="0,0,0,0"></label>
      <label data-rect="0,0,266,42">No hot water<input type="checkbox" id="sym-cold" name="symptoms" data-rect="0,0,0,0"></label>
    </form>`,
  disclosureWithCheckboxes: `
    <form>
      <input type="email" name="email" required>
      <button type="button" id="symptoms-trigger" aria-expanded="false" aria-controls="symptoms-panel">What's happening?</button>
      <div id="symptoms-panel"><input type="checkbox" id="s1" name="symptoms"></div>
    </form>`,
  disclosureWithoutId: `
    <form>
      <input type="email" name="email" required>
      <button type="button" aria-expanded="false" aria-controls="anon-panel">Details</button>
      <div id="anon-panel"><input type="checkbox" id="a1" name="flags"></div>
      <button type="button" aria-expanded="false" aria-controls="other-panel">Other</button>
      <div id="other-panel"><input type="checkbox" id="a2" name="flags"></div>
    </form>`,
  radixSelectTrigger: `
    <form>
      <input type="email" name="email" required>
      <button type="button" id="issueType" aria-expanded="false" aria-controls="radix-listbox">Select your issue</button>
      <div id="radix-listbox" role="listbox"><div role="option">No hot water</div></div>
    </form>`,
  opacityControls: `
    <form>
      <input type="email" name="email" required>
      <input type="text" name="fading_required" required style="opacity:0">
      <input type="text" name="fading_optional" style="opacity:0">
    </form>`,
  constraints: `
    <form>
      <input type="number" name="budget" min="1000" required>
      <input type="date" name="slot" max="2026-12-31" required>
      <input type="text" name="code" maxlength="4" required>
    </form>`,
  siblingLabelCheckbox: `
    <form>
      <input type="email" name="email" required>
      <div>
        <input type="checkbox" id="terms" name="terms" required data-rect="0,0,0,0">
        <label for="terms" data-rect="0,0,200,24">Accept terms</label>
      </div>
    </form>`,
  precheckedConsent: `
    <form>
      <input type="email" name="email" required>
      <label data-rect="0,0,200,24">I agree<input type="checkbox" name="consent" required checked data-rect="0,0,0,0"></label>
    </form>`,
  typelessButtonTrigger: `
    <form>
      <input type="email" name="email" required>
      <button aria-expanded="false" aria-controls="p1">Pick options</button>
      <div id="p1"><input type="checkbox" name="opt"></div>
    </form>`,
  onlyLoginForm: `
    <form id="login"><input type="email" name="email" required><input type="password" name="pw" required></form>`,
  twoIdlessTriggers: `
    <form>
      <input type="email" name="email" required>
      <button type="button" aria-expanded="false" aria-controls="pa">A</button>
      <div id="pa"><input type="checkbox" name="a"></div>
      <button type="button" aria-expanded="false" aria-controls="pb">B</button>
      <div id="pb"><input type="checkbox" name="b"></div>
    </form>`,
  anchorTrigger: `
    <form>
      <input type="email" name="email" required>
      <a href="#" role="button" aria-expanded="false" aria-controls="ap">More</a>
      <div id="ap"><input type="checkbox" name="opt"></div>
    </form>`,
  portalledPanel: `
    <form>
      <input type="email" name="email" required>
      <button type="button" aria-expanded="false" aria-controls="portal">Options</button>
    </form>
    <div id="portal"><input type="checkbox" name="opt"></div>`,
  manyDisclosures: `
    <form>
      <input type="email" name="email" required>
      <button type="button" aria-expanded="false" aria-controls="p1">1</button><div id="p1"><input type="checkbox" name="a"></div>
      <button type="button" aria-expanded="false" aria-controls="p2">2</button><div id="p2"><input type="checkbox" name="b"></div>
      <button type="button" aria-expanded="false" aria-controls="p3">3</button><div id="p3"><input type="checkbox" name="c"></div>
      <button type="button" aria-expanded="false" aria-controls="p4">4</button><div id="p4"><input type="checkbox" name="d"></div>
      <button type="button" aria-expanded="false" aria-controls="p5">5</button><div id="p5"><input type="checkbox" name="e"></div>
      <button type="button" aria-expanded="false" aria-controls="p6">6</button><div id="p6"><input type="checkbox" name="f"></div>
      <button type="button" aria-expanded="false" aria-controls="p7">7</button><div id="p7"><input type="checkbox" name="g"></div>
    </form>`,
  duplicateSubmitIds: `
    <form id="mobile"><input type="email" name="email" required data-rect="0,0,0,0"><button type="submit" id="go" data-rect="0,0,0,0">Go</button></form>
    <form id="desktop"><input type="email" name="email" required><button type="submit" id="go">Go</button></form>`,
  radixCheckbox: `
    <form>
      <input type="email" name="email" required>
      <button type="button" role="checkbox" id="terms-rx" aria-checked="false" aria-required="true">Accept</button>
      <input type="checkbox" aria-hidden="true" tabindex="-1" data-rect="0,0,0,0">
      <button type="button" role="checkbox" id="news-rx" aria-checked="true">Newsletter</button>
    </form>`,
  unreachableRequired: `
    <form>
      <input type="email" name="email" required>
      <input type="datetime-local" name="slot" required>
      <input type="color" name="brand" required>
      <input type="file" name="cv" required>
    </form>`,
  numberConstraints: `
    <form>
      <input type="number" name="budget" min="1000" step="500" required>
      <input type="number" name="qty" min="10" max="4" required>
    </form>`,
  typelessAriaButton: `
    <form>
      <input type="email" name="email" required>
      <button role="checkbox" id="terms" aria-required="true">Accept</button>
      <button type="submit" id="go">Send</button>
    </form>`,
  switchBeforeConsent: `
    <form>
      <input type="email" name="email" required>
      <button type="button" role="switch" id="sms" aria-checked="false">SMS updates</button>
      <input type="checkbox" id="consent" name="consent">
    </form>`,
  divAriaCheckbox: `
    <form>
      <input type="email" name="email" required>
      <div role="checkbox" id="divbox" aria-required="true" aria-checked="false">Agree</div>
    </form>`,
  authOnlyWithSelect: `
    <form id="login">
      <input type="email" name="email" required>
      <input type="password" name="pw" required>
      <select id="realm"><option value="">-</option><option value="admin">admin</option></select>
      <button type="submit" id="signin">Sign in</button>
    </form>`,
  iframeEmbed: `<div><h1>Get a quote</h1><iframe src="https://forms.example.com/x"></iframe></div>`,
  preMarked: `
    <form id="already" data-agentweb-smoke-form="1"><input type="text" name="q"></form>
    <form id="lead"><input type="email" name="email" required><input type="tel" name="phone" required></form>`,
  belowFold: `
    <form>
      <input type="email" name="email">
      <input type="text" name="below_fold" data-rect="0,4000,120,24">
    </form>`,
  fieldTypes: `
    <form>
      <textarea name="project_details" required></textarea>
      <input type="number" name="headcount" required>
      <input type="url" name="company_site" required>
      <input type="date" name="preferred_date" required>
      <input type="search" name="lookup">
      <input name="untyped">
    </form>`,
  hints: `
    <form>
      <label for="z">ZIP code</label>
      <input id="z" name="pc" autocomplete="postal-code" placeholder="94025">
    </form>`,
  selectOutsideForm: `
    <select id="site-language"><option value="en">EN</option></select>
    <form>
      <input type="email" name="email">
      <select><option value="">Pick…</option><option value="gas">Gas</option></select>
    </form>`,
  checkables: `
    <form>
      <input type="checkbox" name="terms" id="terms" required>
      <input type="checkbox" name="news" id="news">
      <input type="radio" name="plan" id="plan-a" required>
      <input type="radio" name="plan" id="plan-b" required>
    </form>`,
  anonymousControls: `<form><input type="text"><input type="email"></form>`,
  noForm: `<div><input type="email" name="email"><input type="tel" name="phone"></div>`,
};

let out: Record<
  string,
  {
    result?: any;
    markedFormIds?: string[];
    submitted?: string[];
    selectorMatches?: Record<string, number | string>;
    secondPass?: {
      triggers: string[];
      pass1StillResolves: { selector: string; matches: number; sameElement: boolean }[];
    };
    error?: string;
  }
> = {};

beforeAll(() => {
  const cases: any[] = [
    ...Object.entries(CASES).map(([name, html]) => ({ name, html })),
    { name: "twoIdlessTriggersRoundTrip", html: CASES.twoIdlessTriggers, twoPass: true },
    ...Object.entries(SUBMIT_CASES).map(([name, html]) => ({ name, html, fn: "submitMarkedForm" })),
  ];
  const child = spawnSync(process.execPath, [HELPER], {
    input: JSON.stringify({ cases }),
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (child.status !== 0) {
    throw new Error(`discovery helper failed (status ${child.status}):\n${child.stderr}`);
  }
  out = JSON.parse(child.stdout).results;
}, 60_000);

/** Reads one fixture's result, surfacing a page-side throw as a test failure rather than undefined. */
function got(name: keyof typeof CASES): Discovered {
  const entry = out[name as string];
  if (!entry || entry.error) throw new Error(`fixture "${name}" threw: ${entry?.error}`);
  return entry.result!;
}
const selectorsOf = (d: Discovered) => d.fields.map((f) => f.selector);

describe("discoverSmokeFields", () => {
  it("drives the lead form, not a newsletter form that happens to come first in the DOM", () => {
    // The fields that get filled and the submit button that gets clicked must belong to
    // the SAME form: discovery used to scope to the first form while the submit click
    // stayed page-global and non-strict, so it clicked whichever button matched first.
    expect(out.twoForms.markedFormIds).toEqual(["lead"]);
    expect(got("twoForms").scope).toBe(SCOPE);
    expect(selectorsOf(got("twoForms"))).toEqual([
      `${SCOPE}[name="email"]`,
      `${SCOPE}[name="phone"]`,
    ]);
  });

  it("addresses ids through [id=...] so a React useId value does not produce an invalid selector", () => {
    // React 18's useId() emits ids like ":r0:" (shadcn/ui form primitives use it), and
    // `#:r0:` is rejected outright by Playwright's CSS parser — the fill threw, the
    // per-field catch swallowed it, and the form stayed empty with no diagnostic.
    expect(selectorsOf(got("awkwardIdentifiers"))).toEqual([
      `${SCOPE}[id=":r0:"]`,
      `${SCOPE}[name="a\\"b"]`,
    ]);
  });

  it("skips controls a real visitor cannot fill", () => {
    expect(selectorsOf(got("unfillable"))).toEqual([`${SCOPE}[name="email"]`]);
  });

  it("skips honeypots — both the off-canvas kind and the named kind", () => {
    // Playwright counts an element as visible when it merely has a non-empty bounding box,
    // so an off-canvas honeypot WOULD be filled — and the lander's own spam filter would
    // then drop the lead, which reads here as a broken form.
    expect(selectorsOf(got("honeypots"))).toEqual([`${SCOPE}[name="email"]`]);
  });

  it("keeps a legitimately below-the-fold field (a large positive top is not off-canvas)", () => {
    expect(selectorsOf(got("belowFold"))).toContain(`${SCOPE}[name="below_fold"]`);
  });

  it("covers the field types that block validation but were never filled", () => {
    expect(got("fieldTypes").fields.map((f) => f.kind)).toEqual([
      "textarea", "number", "url", "date", "search", "text",
    ]);
  });

  it("builds the hint from name/id/placeholder/autocomplete/label text", () => {
    const [field] = got("hints").fields;
    for (const part of ["pc", "postal-code", "94025", "zip code"]) {
      expect(field.hint).toContain(part);
    }
  });

  it("indexes a nameless select against the scoped form, not the whole page", () => {
    const [select] = got("selectOutsideForm").selects;
    // `>> nth=` resolves against `form[...] select`, so index 0 is the form's first select,
    // not the language switcher sitting above the form.
    expect(select.selector).toBe(`${SCOPE}select >> nth=0`);
    // Placeholder options (empty value) are never chosen.
    expect(select.options).toEqual(["gas"]);
  });

  it("reports checkbox/radio requiredness so every required box gets checked", () => {
    expect(got("checkables").checkables).toEqual([
      { selector: `${SCOPE}[id="terms"]`, type: "checkbox", name: "terms", required: true, viaLabel: false, checked: false, isAria: false },
      { selector: `${SCOPE}[id="news"]`, type: "checkbox", name: "news", required: false, viaLabel: false, checked: false, isAria: false },
      { selector: `${SCOPE}[id="plan-a"]`, type: "radio", name: "plan", required: true, viaLabel: false, checked: false, isAria: false },
      { selector: `${SCOPE}[id="plan-b"]`, type: "radio", name: "plan", required: true, viaLabel: false, checked: false, isAria: false },
    ]);
  });

  it("falls back to an index selector for a control with neither id nor name", () => {
    expect(selectorsOf(got("anonymousControls"))).toEqual([
      `${SCOPE}:is(input, textarea) >> nth=0`,
      `${SCOPE}:is(input, textarea) >> nth=1`,
    ]);
  });

  it("drives the lead form even when the only type=email control is a footer newsletter", () => {
    // Regression: weighting `input[type=email|tel]` heavily made a one-field subscribe box
    // outrank a real lead form whose phone/zip/name controls are all type="text" — which is
    // the shape of the landers this path was written for (they often have no email field).
    expect(out.newsletterVsLead.markedFormIds).toEqual(["lead"]);
    expect(selectorsOf(got("newsletterVsLead")).length).toBe(3);
  });

  it("never drives an authentication form", () => {
    expect(out.loginForm.markedFormIds).toEqual(["lead"]);
  });

  it("keeps legitimate fields whose names merely look like honeypots", () => {
    // `confirm_email`, `honeymoon_destination` and `hp_model` are ordinary required fields.
    // Skipping them left client-side validation blocking submit — a false FAIL, and the
    // diagnostics then reported a 100% fill rate because skipped controls were not counted.
    expect(selectorsOf(got("honeypotLookalikes"))).toEqual([
      `${SCOPE}[name="email"]`,
      `${SCOPE}[name="confirm_email"]`,
      `${SCOPE}[name="honeymoon_destination"]`,
      `${SCOPE}[name="hp_model"]`,
      `${SCOPE}[name="b_2b_leads"]`,
    ]);
  });

  it("required beats a honeypot-looking name — a real trap is never required", () => {
    expect(selectorsOf(got("requiredTrapName"))).toEqual([
      `${SCOPE}[name="email"]`,
      `${SCOPE}[name="honeypot"]`,
    ]);
  });

  it("sees controls associated by the form= attribute, and the submit button outside the form", () => {
    // form.elements, not querySelectorAll: a required control outside the form's subtree
    // still blocks submit, and a sticky-footer submit button still submits it.
    expect(selectorsOf(got("formAssociated"))).toEqual([
      `${SCOPE}[name="email"]`,
      '[name="zip"]',
    ]);
    expect(got("formAssociated").submitSelector).toBe('[id="sticky-submit"]');
    // The out-of-subtree control must NOT carry the form scope, or it resolves to nothing.
    expect(selectorsOf(got("formAssociated"))[1]).toBe('[name="zip"]');
  });

  it("skips a collapsed responsive duplicate and drives the form that is actually usable", () => {
    // Observed live: v0 landers ship the same form two or three times for mobile/desktop and
    // collapse the inactive ones to a 0x0 box. Scoring every control made the duplicates tie,
    // so the dead one won on DOM order and discovery returned zero fields — nothing was
    // filled and the page failed its own smoke test.
    expect(out.collapsedDuplicateForm.markedFormIds).toEqual(["desktop-variant"]);
    expect(selectorsOf(got("collapsedDuplicateForm")).length).toBe(3);
  });

  it("reaches a visually-hidden checkbox through its label", () => {
    // Observed live: the shadcn/Radix pattern renders a 0x0 input whose label is the only
    // clickable surface. Judging the input by its own box skipped a control a visitor can
    // plainly use, so a required symptom group stayed unselected and submit stayed blocked.
    const boxes = got("labelProxyCheckbox").checkables;
    expect(boxes.map((c: any) => c.viaLabel)).toEqual([true, true]);
    // Selector targets a stamped marker, and it resolves to exactly one element.
    expect(out.labelProxyCheckbox.selectorMatches![boxes[0].selector]).toBe(1);
  });

  it("opens a disclosure that holds a checkbox group", () => {
    const triggers = got("disclosureWithCheckboxes").disclosureTriggers;
    expect(triggers).toHaveLength(1);
    expect(out.disclosureWithCheckboxes.selectorMatches![triggers[0]]).toBe(1);
  });

  it("marks id-less disclosure triggers with a stable marker, not a stateful nth selector", () => {
    // After the open click the trigger's aria-expanded flips to "true", so an
    // `[aria-expanded="false"] >> nth=i` selector no longer addresses the same
    // element on close. Marker selectors survive the round-trip.
    const triggers = got("disclosureWithoutId").disclosureTriggers;
    expect(triggers).toEqual([
      `${SCOPE}[data-agentweb-smoke-disclosure="0"]`,
      `${SCOPE}[data-agentweb-smoke-disclosure="1"]`,
    ]);
    for (const sel of triggers) expect(sel).not.toContain("nth=");
    // The second discovery pass (after opening) must still find the same marker.
    expect(got("disclosureWithoutId").disclosureTriggers).toEqual(triggers);
  });

  it("never opens a Radix select trigger, which also carries aria-expanded", () => {
    // Opening one puts a listbox overlay over the page that swallows every later click,
    // including the submit — observed turning a working lander into a total failure.
    expect(got("radixSelectTrigger").disclosureTriggers).toEqual([]);
  });

  it("waits on a required control that is mid-fade, but still skips an optional invisible one", () => {
    // Playwright's own visibility test ignores opacity and auto-waits; this sampled once,
    // right after networkidle, so a required control mid-animation was dropped outright.
    const names = selectorsOf(got("opacityControls"));
    expect(names).toContain(`${SCOPE}[name="fading_required"]`);
    expect(names).not.toContain(`${SCOPE}[name="fading_optional"]`);
  });

  it("carries each field's own constraints out of the page", () => {
    const byName = Object.fromEntries(got("constraints").fields.map((f: any) => [f.hint.split(" ")[0], f]));
    expect(byName.budget.min).toBe("1000");
    expect(byName.slot.max).toBe("2026-12-31");
    expect(byName.code.maxLength).toBe(4);
  });

  it("every selector discovery emits resolves to exactly one element", () => {
    // The assertion that was missing. Checking the selector STRING let a selector that
    // matches nothing pass as correct through three rounds of testing.
    const offenders: string[] = [];
    for (const [name, entry] of Object.entries(out)) {
      if (!entry || entry.error || !entry.selectorMatches) continue;
      for (const [selector, count] of Object.entries(entry.selectorMatches)) {
        if (count !== 1) offenders.push(`${name}: ${selector} -> ${count}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("reaches a sibling <label for=...> checkbox, which is how shadcn/ui ships one", () => {
    // `label:has([id=x])` requires the label to CONTAIN the input; shadcn renders them as
    // siblings, so the emitted selector matched nothing and the click timed out on a control
    // discovery had just called reachable.
    const boxes = got("siblingLabelCheckbox").checkables;
    expect(boxes).toHaveLength(1);
    expect(boxes[0].viaLabel).toBe(true);
    expect(out.siblingLabelCheckbox.selectorMatches![boxes[0].selector]).toBe(1);
  });

  it("reports an already-checked control so it is never toggled back off", () => {
    expect(got("precheckedConsent").checkables[0].checked).toBe(true);
  });

  it("never treats a typeless <button> as a disclosure trigger — it submits the form", () => {
    expect(got("typelessButtonTrigger").disclosureTriggers).toEqual([]);
  });

  it("refuses an authentication form even when it is the only form on the page", () => {
    // A -1000 score still wins when nothing else competes; disqualification has to skip
    // the candidate outright.
    expect(out.onlyLoginForm.markedFormIds).toEqual([]);
    expect(got("onlyLoginForm").scope).toBe("");
  });

  it("disclosure selectors do not depend on aria-expanded, which the opening click flips", () => {
    // `>> nth=` over `[aria-expanded="false"]` is invalidated by the very click that opens
    // the first trigger: the element leaves the matched set, so the close pass could land on
    // a different still-collapsed element and OPEN it, right before submit.
    const triggers = got("twoIdlessTriggers").disclosureTriggers;
    expect(triggers).toHaveLength(2);
    for (const t of triggers) {
      expect(t).not.toMatch(/aria-expanded/);
      expect(out.twoIdlessTriggers.selectorMatches![t]).toBe(1);
    }
    expect(new Set(triggers).size).toBe(2);
  });

  it("a disclosure selector still addresses the SAME element after re-discovery", () => {
    // The caller opens a trigger with a pass-1 selector and closes it with that same selector
    // after re-discovery. If the marker is swept, the close click either hits nothing (the
    // panel stays open over the submit button) or the mark is reissued to a different
    // collapsed trigger, which the close pass then OPENS immediately before submit.
    const sp = out.twoIdlessTriggersRoundTrip.secondPass!;
    expect(sp).toBeDefined();
    for (const r of sp.pass1StillResolves) {
      expect({ selector: r.selector, matches: r.matches, sameElement: r.sameElement }).toEqual({
        selector: r.selector,
        matches: 1,
        sameElement: true,
      });
    }
  });

  it("an authentication-only page yields nothing fillable, rather than driving the login box", () => {
    // Skipping the form but then falling through to whole-document discovery picked the
    // login input straight back up — unscoped, so the blast radius grew.
    const r = got("onlyLoginForm");
    expect(r.fields).toEqual([]);
    expect(r.checkables).toEqual([]);
    expect(r.authFormOnly).toBe(true);
    expect(r.noFormOnPage).toBe(true);
  });

  it("an anchor disclosure with no real href is still opened", () => {
    expect(got("anchorTrigger").disclosureTriggers).toHaveLength(1);
  });

  it("never opens a disclosure whose panel is portalled outside the form", () => {
    // Radix Popover/Dialog renders into document.body. Controls harvested from form.elements
    // cannot reach those, so opening it buys nothing and leaves an overlay over the form.
    expect(got("portalledPanel").disclosureTriggers).toEqual([]);
  });

  it("caps how many disclosures one run will open", () => {
    // Each costs up to two 3s interactions and the run holds the single smoke-test slot.
    expect(got("manyDisclosures").disclosureTriggers).toHaveLength(5);
  });

  it("scopes an id-based submit selector when the control is inside the form", () => {
    // Responsive landers ship the same form and the same ids two or three times, and
    // page.click is non-strict — the collapsed duplicate comes first in DOM order.
    const r = got("duplicateSubmitIds");
    expect(out.duplicateSubmitIds.markedFormIds).toEqual(["desktop"]);
    expect(r.submitSelector).toBe(`${SCOPE}[id="go"]`);
    expect(out.duplicateSubmitIds.selectorMatches![r.submitSelector!]).toBe(1);
  });

  it("sees a Radix/shadcn <button role=checkbox>, which has no checkable input at all", () => {
    // Radix renders the control as a button plus an aria-hidden proxy input that usable()
    // rejects. Keying only on input[type=checkbox] made the control invisible everywhere —
    // never filled, and not even counted as unreachable.
    const boxes = got("radixCheckbox").checkables;
    expect(boxes).toHaveLength(2);
    expect(boxes[0]).toMatchObject({ type: "checkbox", required: true, checked: false });
    // aria-checked=true must be reported so it is never toggled back off
    expect(boxes[1]).toMatchObject({ required: false, checked: true });
    for (const b of boxes) expect(out.radixCheckbox.selectorMatches![b.selector]).toBe(1);
  });

  it("counts required controls it cannot address, including types outside FILLABLE", () => {
    // datetime-local / color / file are required and unfillable; the old count re-derived
    // usable() and so reported 0 for exactly the pages the diagnostic was added for.
    expect(got("unreachableRequired").skippedRequired).toBe(3);
  });

  it("carries min/max/step so a synthetic value cannot violate them", () => {
    const byName = Object.fromEntries(
      got("numberConstraints").fields.map((f: any) => [f.hint.split(" ")[0], f])
    );
    expect(byName.budget).toMatchObject({ min: "1000", step: "500" });
    expect(byName.qty).toMatchObject({ min: "10", max: "4" });
  });

  it("never treats a typeless <button role=checkbox> as a checkable, nor as the submit control", () => {
    // HTMLButtonElement.type resolves to "submit" when the attribute is absent, so the same
    // element satisfied both the ARIA-checkable match and the submit-control find. check()
    // would then click it, submitting the form mid-fill — before the response listener is
    // attached and before the submit timestamp is taken.
    const r = got("typelessAriaButton");
    expect(r.checkables).toEqual([]);
    expect(r.submitSelector).toBe(`${SCOPE}[id="go"]`);
    expect(r.skippedRequired).toBe(1);
  });

  it("the no-required fallback prefers a native checkbox over a role=switch", () => {
    // Toggling an "SMS updates" switch while leaving the consent box unchecked is a false
    // FAIL manufactured from a page that previously passed.
    const boxes = got("switchBeforeConsent").checkables;
    expect(boxes.map((c: any) => c.selector)).toEqual([
      `${SCOPE}[id="sms"]`,
      `${SCOPE}[id="consent"]`,
    ]);
    expect(boxes[0].isAria).toBe(true);
    expect(boxes[1].isAria).toBe(false);
  });

  it("finds a <div role=checkbox>, which form.elements never lists", () => {
    // HTMLFormControlsCollection contains only form-associated elements, so keying discovery
    // on form.elements left a div-based ARIA checkbox invisible everywhere.
    const boxes = got("divAriaCheckbox").checkables;
    expect(boxes).toHaveLength(1);
    expect(boxes[0]).toMatchObject({ isAria: true, required: true, checked: false });
  });

  it("an auth-only page leaks no selects for the fill step to touch", () => {
    // Selecting a realm and then clicking the login form's submit posts to a real auth endpoint.
    const r = got("authOnlyWithSelect");
    expect(r.authFormOnly).toBe(true);
    expect(r.selects).toEqual([]);
    expect(r.fields).toEqual([]);
  });

  it("counts iframes, so an embedded form is not reported as 'no lead form'", () => {
    expect(got("iframeEmbed").iframeCount).toBe(1);
    expect(got("iframeEmbed").noFormOnPage).toBe(true);
  });

  it("clears a stale marker so only one form is ever marked", () => {
    expect(out.preMarked.markedFormIds).toEqual(["lead"]);
  });

  it("a page with no <form> at all yields an empty scope and unscoped selectors", () => {
    expect(got("noForm").scope).toBe("");
    expect(selectorsOf(got("noForm"))).toEqual(['[name="email"]', '[name="phone"]']);
  });

  it("submitMarkedForm submits ONLY the marked form", () => {
    expect(out.submitMarked.submitted).toEqual(["lead"]);
    expect(out.submitMarked.result).toBe(true);
  });

  it("submitMarkedForm reports false rather than falling back to the first form on the page", () => {
    // The regression this pins: `querySelector("form")?.requestSubmit()` RESOLVES when the
    // marker is missing, and a `|| document.querySelector("form")` fallback would submit the
    // newsletter form — exactly when we least understand the page. Reporting false is what
    // lets the caller reach the Enter fallback instead.
    expect(out.submitNoMarkedForm.submitted).toEqual([]);
    expect(out.submitNoMarkedForm.result).toBe(false);
  });
});
