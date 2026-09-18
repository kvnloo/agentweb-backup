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
const FN_NAME = "discoverSmokeFields";

function extractFunctionJs() {
  const source = fs.readFileSync(SERVICE, "utf8");
  const sourceFile = ts.createSourceFile(SERVICE, source, ts.ScriptTarget.ES2018, true);
  const declaration = sourceFile.statements.find(
    (statement) => ts.isFunctionDeclaration(statement) && statement.name && statement.name.text === FN_NAME
  );
  if (!declaration) throw new Error(`${FN_NAME} not found in ${SERVICE}`);
  // Drop the `export` modifier: with it, transpileModule emits `exports.<name> = ...`,
  // which has no meaning inside a browser window realm.
  const tsText = source
    .slice(declaration.getStart(sourceFile), declaration.getEnd())
    .replace(/^export\s+/, "");
  return ts.transpileModule(tsText, {
    compilerOptions: { target: ts.ScriptTarget.ES2018, module: ts.ModuleKind.None },
  }).outputText;
}

function runCase(fnJs, html) {
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
  win.eval(fnJs);
  const result = win.eval(`${FN_NAME}()`);
  const markedFormIds = Array.prototype.slice
    .call(win.document.querySelectorAll("form[data-agentweb-smoke-form]"))
    .map((form) => form.id || "(unnamed)");
  return { result: JSON.parse(JSON.stringify(result)), markedFormIds };
}

function main() {
  const input = JSON.parse(fs.readFileSync(0, "utf8"));
  const fnJs = extractFunctionJs();
  const results = {};
  for (const testCase of input.cases) {
    try {
      results[testCase.name] = runCase(fnJs, testCase.html);
    } catch (err) {
      results[testCase.name] = { error: err && err.message ? err.message : String(err) };
    }
  }
  process.stdout.write(JSON.stringify({ results }));
}

main();
