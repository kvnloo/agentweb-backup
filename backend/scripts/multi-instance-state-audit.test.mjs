// ENG-2949: offline test of the multi-instance state audit (node --test).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scan, toMarkdown, classify } from "./multi-instance-state-audit.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "mi-audit-"));
  const w = (p, s) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), s); };
  w("routes/acmeAuth.ts", "const tokenSessions = new Map<string, S>();\n");
  w("routes/twitterAuth.ts", "const pkceSessions = new Map<string, P>();\n");
  w("routes/gen.ts", "const generationRateLimitMap = new Map<string, number[]>();\nconst KEYS = new Set(['a', 'b']);\n");
  w("services/x.ts", "const metaCache = new Map();\nfunction f() {\n  const local = new Map();\n}\nexport const activeSessions = new Map<string, E>();\nconst consumedPreviews = new Set<string>();\n");
  w("server.ts", "import { Server } from 'socket.io';\nconst io = new Server(server, {});\n");
  w("__tests__/t.ts", "const tokenSessions = new Map();\n");
  w("services/y.test.ts", "const tokenSessions = new Map();\n");
  w("controllers/auth.ts", "const token = jwt.sign({});\nresetPasswordToken: t,\n");
  w("routes/gmailAuth.ts", "import { storeTokenSession } from '../services/oauthTokenSessionStore';\n");
  return root;
}

test("classifies module-level stores and skips literal lookups, locals and tests", () => {
  const r = scan(fixture());
  const by = Object.fromEntries(r.findings.map((f) => [f.name, f]));
  assert.equal(by.tokenSessions.category, "oauth-state");
  assert.equal(by.tokenSessions.file, "routes/acmeAuth.ts");
  assert.equal(by.pkceSessions.category, "oauth-state");
  assert.equal(by.generationRateLimitMap.category, "rate-limit");
  assert.equal(by.metaCache.category, "cache-safe");
  assert.equal(by.activeSessions.category, "auth/session");
  assert.equal(by.consumedPreviews.category, "token single-use");
  assert.equal(by["io (Socket.IO server)"].line, 2);
  assert.equal(by.local, undefined);
  assert.equal(r.constantLookupsSkipped, 1);
  assert.equal(r.findings.filter((f) => f.name === "tokenSessions").length, 1, "tests excluded");
});

test("resolved items are proven from the tree, not re-flagged", () => {
  const r = scan(fixture());
  const st = Object.fromEntries(r.resolved.map((x) => [x.concern, x.status]));
  assert.equal(st["Login session"], "resolved");
  assert.equal(st["Password-reset tokens"], "resolved");
  assert.equal(st["Gmail OAuth connect tokens"], "resolved");
  assert.equal(st["MCP sessions"], "unverified");
});

test("socket.io with an adapter is not flagged", () => {
  const root = fixture();
  fs.writeFileSync(path.join(root, "server.ts"), "import { Server } from 'socket.io';\nconst io = new Server(s);\nio.adapter(createAdapter(p, s));\n");
  assert.ok(!scan(root).findings.some((f) => f.kind === "Socket.IO"));
});

test("deterministic: same tree, same output", () => {
  const root = fixture();
  assert.equal(toMarkdown(scan(root)), toMarkdown(scan(root)));
  assert.equal(JSON.stringify(scan(root)), JSON.stringify(scan(root)));
});

test("classify falls back to unclassified", () => {
  assert.equal(classify("services/z.ts", "pending"), "unclassified");
});
