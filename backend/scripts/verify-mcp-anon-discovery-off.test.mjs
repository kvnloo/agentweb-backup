// ENG-2521: offline test of the anonymous-discovery-OFF smoke (node --test).
import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, run } from "./verify-mcp-anon-discovery-off.mjs";

const BASE = "https://api.example.test";
const CHALLENGE = `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp", scope="mcp:tools"`;

const resp = (status, body, www) => ({ status, text: async () => JSON.stringify(body), headers: { get: () => www ?? null } });
const fetchFor = (handler) => async (url, init) => {
  if (url.endsWith("/health")) return { json: async () => ({ version: "backend-test" }) };
  return handler(JSON.parse(init.body).method);
};
const quiet = { base: BASE, log: () => {} };

test("classify: 401 with OAuth challenge passes", () => {
  assert.equal(classify({ status: 401, wwwAuthenticate: CHALLENGE, body: { error: "Unauthorized" } }, BASE).ok, true);
});

test("classify: anonymous tools list fails even if 200", () => {
  const r = classify({ status: 200, wwwAuthenticate: null, body: { result: { tools: [{ name: "x" }] } } }, BASE);
  assert.equal(r.ok, false);
  assert.match(r.reason, /anonymous/);
});

test("classify: anonymous initialize (serverInfo) fails", () => {
  assert.equal(classify({ status: 200, body: { result: { serverInfo: { name: "emma" } } } }, BASE).ok, false);
});

test("classify: 401 without challenge header fails", () => {
  assert.equal(classify({ status: 401, wwwAuthenticate: null, body: {} }, BASE).ok, false);
});

test("classify: challenge pointing elsewhere fails", () => {
  assert.equal(classify({ status: 401, wwwAuthenticate: 'Bearer realm="x"', body: {} }, BASE).ok, false);
});

test("run: all three methods challenged -> ok", async () => {
  const r = await run({ ...quiet, fetchImpl: fetchFor(() => resp(401, { error: "Unauthorized" }, CHALLENGE)) });
  assert.deepEqual(r, { ok: true, version: "backend-test" });
});

test("run: flag-on shape (anonymous list, 401 only on tools/call) -> not ok", async () => {
  const r = await run({
    ...quiet,
    fetchImpl: fetchFor((m) =>
      m === "tools/call" ? resp(401, {}, CHALLENGE) : resp(200, { result: m === "tools/list" ? { tools: [] } : { serverInfo: {} } })),
  });
  assert.equal(r.ok, false);
});
