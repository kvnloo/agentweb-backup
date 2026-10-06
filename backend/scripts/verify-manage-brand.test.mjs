// ENG-2095: offline test of the manage_brand verifier against a mocked API (node --test).
import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "./verify-manage-brand.mjs";

const reply = (status, body = {}) => ({ status, json: async () => body });
// In-memory brand store emulating POST /api/brand/guidelines merge semantics.
const mk = ({ dropFounders = false, ignoreField = null, failRestore = false } = {}) => {
  const store = { brandData: { brandName: "QA", founders: [{ name: "F" }], keyMessages: ["k"] }, attachments: [{ key: "logo" }] };
  let posts = 0;
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body) : {};
    if (path === "/api/auth/login") return reply(200, { token: "t", user: { email: body.email } });
    if (path === "/api/brand/guidelines" && init.method === "GET") return reply(200, structuredClone(store));
    if (path === "/api/brand/guidelines" && init.method === "POST") {
      posts++;
      if (failRestore && posts === 2) return reply(500);
      for (const [k, v] of Object.entries(body)) if (k !== ignoreField) store.brandData[k] = v;
      if (dropFounders) store.brandData.founders = [];
      return reply(200, {});
    }
    return reply(404);
  };
  return { fetchImpl, store };
};
const opts = (fetchImpl) => ({ fetchImpl, password: "x", log: () => {} });

test("passes and restores the snapshot", async () => {
  const { fetchImpl, store } = mk();
  await run(opts(fetchImpl));
  assert.equal(store.brandData.brandName, "QA");
  assert.deepEqual(store.brandData.keyMessages, ["k"]);
});

test("fails when a field is not written", async () => {
  const { fetchImpl } = mk({ ignoreField: "toneOfVoice" });
  await assert.rejects(run(opts(fetchImpl)), /toneOfVoice not written/);
});

test("fails when founders are dropped", async () => {
  const { fetchImpl } = mk({ dropFounders: true });
  await assert.rejects(run(opts(fetchImpl)), /founders not preserved/);
});

test("fails when restore fails", async () => {
  const { fetchImpl } = mk({ failRestore: true });
  await assert.rejects(run(opts(fetchImpl)), /restore failed/);
});

test("refuses a non-QA account without any request", async () => {
  let calls = 0;
  await assert.rejects(run({ fetchImpl: async () => { calls++; }, email: "ceo@customer.com", password: "x", log: () => {} }), /non-QA/);
  assert.equal(calls, 0);
});
