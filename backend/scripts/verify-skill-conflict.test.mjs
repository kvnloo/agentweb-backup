// ENG-2302: offline test of the verifier against a mocked API (node --test).
import { test } from "node:test";
import assert from "node:assert/strict";
process.env.QA_USER_EMAIL = "qa-user@agentweb.pro";
const { classifyPair, run } = await import("./verify-skill-conflict.mjs");

const mk = (behave) => {
  const calls = []; let n = 0;
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname; calls.push(`${init.method} ${path}`);
    const reply = (status, body) => ({ status, json: async () => body });
    if (path === "/api/auth/login") return reply(200, { token: "t", user: { userId: "qa", email: "qa-user@agentweb.pro" } });
    if (init.method === "POST" && path === "/api/user-skills") return reply(201, { skillId: `s${++n}`, ownerId: behave.owner ?? "qa" });
    return behave.route(init.method, path);
  };
  return { fetchImpl, calls };
};
const reply = (status) => ({ status, json: async () => ({}) });

test("classifyPair", () => {
  assert.equal(classifyPair(200, 409), "conflict");
  assert.equal(classifyPair(400, 200), "precondition");
  assert.equal(classifyPair(200, 200), "double_write");
  assert.equal(classifyPair(200, 500), "server_error");
});

test("passes on a 409 and cleans up its fixture", async () => {
  let deletes = 0;
  const { fetchImpl, calls } = mk({ route: (m) => m === "DELETE" ? reply(++deletes === 1 ? 409 : 404) : reply(200) });
  const r = await run({ fetchImpl, password: "x", attempts: 3, log: () => {} });
  assert.equal(r.conflict, 1);
  assert.ok(calls.filter((c) => c === "DELETE /api/user-skills/s1").length >= 2);
});

test("fails on a double write", async () => {
  const { fetchImpl } = mk({ route: () => reply(200) });
  await assert.rejects(run({ fetchImpl, password: "x", attempts: 3, log: () => {} }), /double_write/);
});

test("fails closed when fixture is not QA-owned and touches nothing else", async () => {
  const { fetchImpl, calls } = mk({ owner: "someone-else", route: () => reply(200) });
  await assert.rejects(run({ fetchImpl, password: "x", attempts: 1, log: () => {} }), /fail closed/);
  assert.ok(!calls.some((c) => c.includes("submit-for-review")));
});

test("requires a password", async () => {
  await assert.rejects(run({ fetchImpl: async () => { throw new Error("no"); }, password: "", log: () => {} }), /PASSWORD/);
});
