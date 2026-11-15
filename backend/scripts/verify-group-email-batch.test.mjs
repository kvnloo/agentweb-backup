// ENG-2951: offline tests for the group-email pending-batch verifier (node --test).
import { test } from "node:test";
import assert from "node:assert/strict";
import { run, configsTable, configId } from "./verify-group-email-batch.mjs";

const T0 = Date.parse("2026-11-12T00:00:00Z");
// Feeds a scripted sequence of records; the clock advances one interval per sleep.
function harness(seq) {
  let i = 0;
  let t = T0;
  const reads = [];
  return {
    reads,
    opts: {
      userId: "u1",
      listId: "L1",
      intervalS: 10,
      timeoutS: 60,
      getItem: async (userId, cid) => {
        reads.push([userId, cid]);
        const r = seq[Math.min(i++, seq.length - 1)];
        return typeof r === "function" ? r(t) : r;
      },
      now: () => t,
      sleep: async (ms) => { t += ms; },
      log: () => {},
    },
  };
}
const rec = (sent, remaining, live, extra = {}) => (t) => ({
  sentSoFar: sent,
  totalOriginal: 300,
  skippedLeadIds: Array.from({ length: remaining }, (_, k) => `lead-${k}`),
  ...(live && { backgroundRunId: "r1", backgroundHeartbeatAt: new Date(t - 1000).toISOString() }),
  ...extra,
});

test("table/key naming matches groupEmailPendingBatchService", () => {
  assert.equal(configsTable({ NODE_ENV: "production" }), "AW-Configs");
  assert.equal(configsTable({}), "Dev-AW-Configs");
  assert.equal(configId("L1"), "groupEmailPendingBatch:L1");
});

test("polls a live run until the record clears -> complete", async () => {
  const h = harness([rec(100, 200, true), rec(250, 50, true), null]);
  const r = await run({ ...h.opts, expectedTotal: 300 });
  assert.equal(r.status, "complete");
  assert.equal(r.sentSoFar, 250);
  assert.equal(h.reads.length, 3);
  assert.deepEqual(h.reads[0], ["u1", "groupEmailPendingBatch:L1"]);
});

test("empty remaining with no live run is terminal", async () => {
  const r = await run(harness([rec(300, 0, false)]).opts);
  assert.equal(r.status, "complete");
  assert.equal(r.sentSoFar, 300);
});

test("leads remaining with stale heartbeat -> stalled", async () => {
  const stale = (t) => ({ ...rec(50, 250, false)(t), backgroundRunId: "r1", backgroundHeartbeatAt: new Date(t - 5 * 60_000).toISOString() });
  const r = await run(harness([stale]).opts);
  assert.equal(r.status, "stalled");
  assert.equal(r.remaining, 250);
});

test("over-send / duplicate signal fails", async () => {
  const r = await run(harness([rec(200, 150, true)]).opts);
  assert.equal(r.status, "fail");
  assert.match(r.errors.join(), /possible duplicate send/);
});

test("sentSoFar decreasing between polls fails", async () => {
  const r = await run(harness([rec(120, 100, true), rec(110, 100, true)]).opts);
  assert.equal(r.status, "fail");
  assert.match(r.errors.join(), /decreased/);
});

test("expected total mismatch fails", async () => {
  const r = await run({ ...harness([rec(10, 10, true)]).opts, expectedTotal: 250 });
  assert.equal(r.status, "fail");
});

test("live run past deadline -> timeout", async () => {
  const r = await run(harness([rec(10, 290, true)]).opts);
  assert.equal(r.status, "timeout");
});

test("missing args throw", async () => {
  await assert.rejects(run({ getItem: async () => null }), /required/);
});
