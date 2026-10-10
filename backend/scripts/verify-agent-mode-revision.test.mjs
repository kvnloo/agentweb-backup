// ENG-2396: offline test of the Agent Mode revision verifier against a mocked API (node --test).
import { test } from "node:test";
import assert from "node:assert/strict";
import { run, classifyOutcome } from "./verify-agent-mode-revision.mjs";

const reply = (status, body = {}) => ({ status, json: async () => body });
const SRC = "https://cdn.example/qa/src.png";
const NEW = "https://cdn.example/qa/rev.png";
const env = {
  QA_USER_PASSWORD: "x", VERIFY_SESSION_ID: "sess-qa", VERIFY_SOURCE_IMAGE_URL: SRC,
  VERIFY_SLACK_CHANNEL: "C_QA", VERIFY_TIMEOUT_MS: "30", VERIFY_POLL_MS: "10",
};

const mk = ({ revise = true, sourceStatus = "revision_submitted", newType = "image" } = {}) => {
  const calls = [];
  let t = 0;
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body) : {};
    calls.push({ path, method: init.method, body });
    if (path === "/api/auth/login") return reply(200, { token: "t", user: { email: body.email } });
    if (path === "/api/batch-review/create") return reply(200, { batchId: "b1" });
    if (path === "/batch-review/b1/review") return reply(200, { success: true });
    if (path === "/batch-review/b1" && init.method === "GET") {
      const assets = [{ assetUrl: SRC, assetType: "image", approval: { status: revise ? sourceStatus : "needs_changes" } }];
      if (revise) assets.push({ assetUrl: NEW, assetType: newType, approval: { status: "pending" } });
      return reply(200, { assets });
    }
    return reply(404);
  };
  return { fetchImpl, calls, opts: { fetchImpl, env, log: () => {}, sleep: async () => { t += 10; }, now: () => t } };
};

test("passes on a revised asset and sends one review (one image-provider call)", async () => {
  const { opts, calls } = mk();
  const out = await run(opts);
  assert.equal(out.newAssetUrl, NEW);
  assert.equal(calls.filter((c) => c.path.endsWith("/review")).length, 1);
  const create = calls.find((c) => c.path === "/api/batch-review/create");
  assert.equal(create.body.assets[0].executionId, "sess-qa-images");
});

test("fails when the source approval is not marked revision_submitted", async () => {
  const { opts } = mk({ sourceStatus: "needs_changes" });
  await assert.rejects(run(opts), /expected revision_submitted/);
});

test("times out naming the confirmation-gate classification", async () => {
  const { opts } = mk({ revise: false });
  await assert.rejects(run(opts), /Blocked on Image-Edit Confirmation/);
});

test("refuses non-QA accounts and missing fixture env", async () => {
  const { opts } = mk();
  await assert.rejects(run({ ...opts, env: { ...env, QA_USER_EMAIL: "ceo@every.to" } }), /refusing non-QA/);
  await assert.rejects(run({ ...opts, env: { ...env, VERIFY_SESSION_ID: "" } }), /VERIFY_SESSION_ID is required/);
});

test("classifyOutcome reports PENDING when only the source exists", () => {
  assert.equal(classifyOutcome({ assets: [{ assetUrl: SRC }] }, SRC).state, "PENDING");
});

test("retries an intermediate state where the source approval has not updated yet", async () => {
  const { opts, fetchImpl } = mk();
  let reads = 0;
  const flaky = async (url, init) => {
    if (new URL(url).pathname === "/batch-review/b1" && init.method === "GET" && reads++ === 0) {
      return reply(200, { assets: [
        { assetUrl: SRC, assetType: "image", approval: { status: "needs_changes" } },
        { assetUrl: NEW, assetType: "image", approval: { status: "pending" } },
      ] });
    }
    return fetchImpl(url, init);
  };
  const out = await run({ ...opts, fetchImpl: flaky });
  assert.equal(out.newAssetUrl, NEW);
  assert.equal(reads, 2);
});

test("fails immediately on a non-image revised asset", async () => {
  const { opts } = mk({ newType: "video" });
  await assert.rejects(run(opts), /new asset type video/);
});
