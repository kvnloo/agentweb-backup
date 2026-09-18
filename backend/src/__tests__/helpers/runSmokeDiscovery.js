/**
 * Runs landingPageSmokeTest.ts's page-side `discoverSmokeFields` against a real DOM.
 *
 * Why a child process: jsdom's dependency chain is ESM-only, and this repo's jest config
 * does not transform node_modules (cssExtractor.test.ts mocks jsdom out for the same
 * reason). Plain node loads it fine, so the jest test shells out here once with every
 * fixture and asserts on the JSON that comes back.
 *
 * Why the TypeScript compiler API rather than importing the module: `discoverSmokeFields`
 * is shipped to the browser by page.evaluate, which serializes it — it MUST stay
 * self-contained (no imports, no closure over module scope). Extracting just that
 * declaration and evaluating it in a bare window realm is what proves that invariant, and
 * it keeps this helper from pulling in playwright/AWS/Slack at import time.
 *
 * Protocol: JSON on stdin `{ cases: [{ name, html }] }` → JSON on stdout
 * `{ results: { [name]: { result, markedFormIds } } }`.
 */
const fs = require("fs");
const path = require("path");
const ts = require("typescript");
const { JSDOM } = require("jsdom");

const SERVICE = path.join(__dirname, "..", "..", "services", "landingPageSmokeTest.ts");
const DEFAULT_FN = "discoverSmokeFields";

function extractFunctionJs(fnName) {
  const source = fs.readFileSync(SERVICE, "utf8");
  const sourceFile = ts.createSourceFile(SERVICE, source, ts.ScriptTarget.ES2018, true);
  const declaration = sourceFile.statements.find(
    (statement) => ts.isFunctionDeclaration(statement) && statement.name && statement.name.text === fnName
  );
  if (!declaration) throw new Error(`${fnName} not found in ${SERVICE}`);
  // Drop the `export` modifier: with it, transpileModule emits `exports.<name> = ...`,
  // which has no meaning inside a browser window realm.
  const tsText = source
    .slice(declaration.getStart(sourceFile), declaration.getEnd())
    .replace(/^export\s+/, "");
  return ts.transpileModule(tsText, {
    compilerOptions: { target: ts.ScriptTarget.ES2018, module: ts.ModuleKind.None },
  }).outputText;
}

function runCase(fnJs, html, fnName, twoPass) {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, {
    runScripts: "outside-only",
  });
  const win = dom.window;
  // jsdom has no layout engine, so every getBoundingClientRect() is 0x0 and every control
  // would look invisible. Give each element a default box, overridable per element with
  // data-rect="left,top,width,height" so off-canvas honeypots can be modelled.
  win.Element.prototype.getBoundingClientRect = function () {
    const raw = this.getAttribute("data-rect");
    const parts = raw ? raw.split(",").map(Number) : [0, 0, 120, 24];
    const [left, top, width, height] = parts;
    return {
      left, top, width, height,
      right: left + width, bottom: top + height,
      x: left, y: top,
      toJSON() { return {}; },
    };
  };
  // jsdom does not implement requestSubmit; record calls so a submit case can assert on it.
  const submitted = [];
  win.HTMLFormElement.prototype.requestSubmit = function () { submitted.push(this.id || "(unnamed)"); };
  win.eval(fnJs);
  const result = win.eval(`${fnName}()`);
  // Resolve every selector discovery emitted against the real DOM. Asserting the selector
  // STRING is what let a `label:has([id=x])` — which matches nothing on shadcn's sibling
  // `<label for=x>` markup — pass as correct through three rounds of testing.
  const resolveCount = (selector) => {
    try {
      let nodes = null;
      for (const part of String(selector).split(">>").map((x) => x.trim())) {
        const nth = /^nth=(\d+)$/.exec(part);
        if (nth) {
          const i = Number(nth[1]);
          nodes = nodes && nodes[i] ? [nodes[i]] : [];
          continue;
        }
        nodes = Array.prototype.slice.call(win.document.querySelectorAll(part));
      }
      return nodes ? nodes.length : 0;
    } catch (err) {
      return `UNSUPPORTED: ${err.message.split("\n")[0].slice(0, 60)}`;
    }
  };
  const selectorMatches = {};
  if (result && typeof result === "object") {
    for (const f of result.fields || []) selectorMatches[f.selector] = resolveCount(f.selector);
    for (const sel of result.selects || []) selectorMatches[sel.selector] = resolveCount(sel.selector);
    for (const c of result.checkables || []) selectorMatches[c.selector] = resolveCount(c.selector);
    for (const t of result.disclosureTriggers || []) selectorMatches[t] = resolveCount(t);
    if (result.submitSelector) selectorMatches[result.submitSelector] = resolveCount(result.submitSelector);
  }

  // Two-pass round trip. The caller opens a disclosure with a pass-1 selector and closes it
  // with that SAME selector after re-discovery, so a marker that does not survive the second
  // pass strands the close click — or worse, gets reissued to a different collapsed trigger
  // that the close pass then opens. Simulate the open (flip aria-expanded) and re-run.
  let secondPass = null;
  if (twoPass && result && Array.isArray(result.disclosureTriggers)) {
    const before = result.disclosureTriggers.map((sel) => {
      let nodes = [];
      try { nodes = Array.prototype.slice.call(win.document.querySelectorAll(sel)); } catch {}
      return { selector: sel, el: nodes[0] || null };
    });
    // "open" the first trigger exactly as a real click would
    if (before[0] && before[0].el) before[0].el.setAttribute("aria-expanded", "true");
    const again = win.eval(`${fnName}()`);
    secondPass = {
      triggers: JSON.parse(JSON.stringify(again.disclosureTriggers || [])),
      pass1StillResolves: before.map((b) => {
        let nodes = [];
        try { nodes = Array.prototype.slice.call(win.document.querySelectorAll(b.selector)); } catch {}
        return {
          selector: b.selector,
          matches: nodes.length,
          sameElement: nodes.length === 1 && nodes[0] === b.el,
        };
      }),
    };
  }

  const markedFormIds = Array.prototype.slice
    .call(win.document.querySelectorAll("form[data-agentweb-smoke-form]"))
    .map((form) => form.id || "(unnamed)");
  return { result: JSON.parse(JSON.stringify(result)), markedFormIds, submitted, selectorMatches, secondPass };
}

function main() {
  const input = JSON.parse(fs.readFileSync(0, "utf8"));
  const results = {};
  const cache = {};
  for (const testCase of input.cases) {
    const fnName = testCase.fn || DEFAULT_FN;
    try {
      if (!cache[fnName]) cache[fnName] = extractFunctionJs(fnName);
      results[testCase.name] = runCase(cache[fnName], testCase.html, fnName, testCase.twoPass);
    } catch (err) {
      results[testCase.name] = { error: err && err.message ? err.message : String(err) };
    }
  }
  process.stdout.write(JSON.stringify({ results }));
}

main();
