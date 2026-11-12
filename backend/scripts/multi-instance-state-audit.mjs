#!/usr/bin/env node
// ENG-2949 (ENG-134 prep): static inventory of per-process in-memory state that
// breaks when the backend runs on more than one instance.
//
// Pure static scan of backend/src — no network, no AWS, no runtime import of app
// code. Deterministic: files are walked in sorted order and the output carries no
// timestamps, so the same tree always yields byte-identical reports.
//
//   node backend/scripts/multi-instance-state-audit.mjs \
//     [--src backend/src] [--json out.json] [--md out.md]
//
// With no --json/--md the markdown report is printed to stdout.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CATEGORIES = ["auth/session", "oauth-state", "token single-use", "rate-limit", "cache-safe", "unclassified"];

const MODULE_STORE = /^(?:export\s+)?(?:const|let|var)\s+(\w+)\b[^=]*=\s*new\s+(Map|Set|WeakMap|LRUCache)\s*(?:<[^(]*>)?\s*\(([^)]*)\)?/;

// Ordered: first match wins. Path rules use the posix-relative file path.
const RULES = [
  { cat: "token single-use", name: /consum|preview|confirm|nonce|usedToken|singleUse|cancell?ed/i },
  { cat: "rate-limit", name: /rate|limit|callLog|cooldown|throttle|attempts/i },
  { cat: "oauth-state", name: /pkce|tokenSession|oauth|stateStore|pendingState/i },
  { cat: "oauth-state", file: /^routes\/\w*Auth\.ts$/, name: /session|state/i },
  { cat: "cache-safe", name: /cache|lock|inFlight|memo|migrated|reported|seen|warned|logged/i },
  { cat: "auth/session", name: /session|socket|generation|owner|connection|client/i },
];

export function classify(file, name) {
  for (const r of RULES) {
    if (r.file && !r.file.test(file)) continue;
    if (r.name.test(name)) return r.cat;
  }
  return "unclassified";
}

function walk(dir, root, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === "__tests__" || ent.name === "node_modules" || ent.name === "scripts") continue;
      walk(full, root, out);
    } else if (/\.ts$/.test(ent.name) && !/\.(test|spec)\.ts$/.test(ent.name) && !ent.name.endsWith(".d.ts")) {
      out.push(path.relative(root, full).split(path.sep).join("/"));
    }
  }
  return out;
}

function findLine(text, re) {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) return i + 1;
  return null;
}

// Stores the ENG-134 concerns map onto that have already moved off per-process
// memory. Each is re-proven against the tree on every run; a check that no
// longer matches is reported as `unverified` rather than silently trusted.
const RESOLVED = [
  { concern: "Gmail OAuth connect tokens", issue: "ENG-301", file: "routes/gmailAuth.ts", re: /oauthTokenSessionStore/, note: "held in DynamoDB via services/oauthTokenSessionStore.ts" },
  { concern: "OAuth token session store (shared)", issue: "ENG-301", file: "services/oauthTokenSessionStore.ts", re: /export\s+(async\s+)?function\s+storeTokenSession/, note: "durable one-time store available to other providers" },
  { concern: "MCP sessions", issue: "ENG-114", file: "mcp/server/mcpSessionStore.ts", re: /.*/, note: "durable MCP session store + rehydration (mcp/server/mcpSessionRehydration.ts)" },
  { concern: "Zoma preview/confirm tokens", issue: "ENG-2945", file: "mcp/zomaWriteGuard.ts", re: /ConsumedTokenStore/, note: "ConsumedTokenStore interface" },
  { concern: "Login session", issue: "-", file: "controllers/auth.ts", re: /jwt\.sign\(/, note: "stateless JWT; no server-side session store" },
  { concern: "Password-reset tokens", issue: "-", file: "controllers/auth.ts", re: /resetPasswordToken:/, note: "persisted on the user record, not in process memory" },
];

export function scan(srcRoot) {
  const files = walk(srcRoot, srcRoot, []);
  const findings = [];
  let constantLookups = 0;
  for (const file of files) {
    const text = fs.readFileSync(path.join(srcRoot, file), "utf8");
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      const m = MODULE_STORE.exec(line);
      if (!m) return;
      const args = (m[3] ?? "").trim();
      // A store seeded from a literal (`new Set(['a','b'])`) is a constant lookup
      // table, identical on every instance — not state.
      if (args !== "") { constantLookups++; return; }
      findings.push({ file, line: i + 1, name: m[1], kind: m[2], category: classify(file, m[1]) });
    });
    if (/from\s+['"]socket\.io['"]/.test(text)) {
      const ln = findLine(text, /new\s+Server\s*\(/);
      if (ln && !/\.adapter\s*\(|createAdapter/.test(text)) {
        findings.push({ file, line: ln, name: "io (Socket.IO server)", kind: "Socket.IO", category: "auth/session", note: "no cross-instance adapter; engine.io sessions are per-process" });
      }
    }
    const ms = findLine(text, /MemoryStore\b/);
    if (ms) findings.push({ file, line: ms, name: "MemoryStore", kind: "session-store", category: "auth/session" });
  }
  const resolved = RESOLVED.map((r) => {
    const full = path.join(srcRoot, r.file);
    const line = fs.existsSync(full) ? findLine(fs.readFileSync(full, "utf8"), r.re) : null;
    return { ...r, re: undefined, line, status: line ? "resolved" : "unverified" };
  });
  const counts = Object.fromEntries(CATEGORIES.map((c) => [c, findings.filter((f) => f.category === c).length]));
  return { scannedFiles: files.length, constantLookupsSkipped: constantLookups, counts, findings, resolved };
}

export function toMarkdown(r) {
  const out = [];
  out.push("# Multi-instance in-memory state audit (ENG-2949 / ENG-134)", "");
  out.push("Generated by `node backend/scripts/multi-instance-state-audit.mjs`. Static scan of `backend/src` (tests and scripts excluded); line numbers are against the commit this file was generated on.", "");
  out.push(`Scanned ${r.scannedFiles} files. ${r.constantLookupsSkipped} literal-seeded Map/Set lookup tables skipped (identical on every instance).`, "");
  out.push("## Summary", "", "| Category | Count |", "| --- | --- |");
  for (const c of CATEGORIES) out.push(`| ${c} | ${r.counts[c]} |`);
  out.push("", "## Already off per-process memory (not re-flagged)", "", "| Concern | Issue | Evidence | Status | Note |", "| --- | --- | --- | --- | --- |");
  for (const x of r.resolved) out.push(`| ${x.concern} | ${x.issue} | \`${x.file}${x.line ? ":" + x.line : ""}\` | ${x.status} | ${x.note} |`);
  for (const c of CATEGORIES) {
    const rows = r.findings.filter((f) => f.category === c);
    if (!rows.length) continue;
    out.push("", `## ${c} (${rows.length})`, "", "| Location | Name | Kind |", "| --- | --- | --- |");
    for (const f of rows) out.push(`| \`${f.file}:${f.line}\` | ${f.name} | ${f.kind}${f.note ? " — " + f.note : ""} |`);
  }
  return out.join("\n") + "\n";
}

function main(argv) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const src = path.resolve(arg("--src") ?? path.join(here, "..", "src"));
  const report = scan(src);
  const json = arg("--json"), md = arg("--md");
  if (json) fs.writeFileSync(json, JSON.stringify(report, null, 2) + "\n");
  if (md) fs.writeFileSync(md, toMarkdown(report));
  if (!json && !md) process.stdout.write(toMarkdown(report));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
