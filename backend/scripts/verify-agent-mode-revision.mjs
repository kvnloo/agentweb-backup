#!/usr/bin/env node
// ENG-2396: post-merge verifier for the Agent Mode image-revision path (ENG-936 / PR #2358).
//
// Drives the real revisionService image revision end to end through the batch-review
// entry point, using ONLY a verifier-owned fixture:
//   - the QA account (qa-*@agentweb.pro), never a customer org;
//   - an Agent Mode session owned by that account (VERIFY_SESSION_ID);
//   - a disposable source image (VERIFY_SOURCE_IMAGE_URL) the QA account generated;
//   - an internal QA Slack channel (VERIFY_SLACK_CHANNEL) — never a customer channel.
//
// Flow (one image-provider call per run):
//   1. POST /api/auth/login as the QA user.
//   2. POST /api/batch-review/create with one asset, executionId `<session>-images`.
//   3. POST /batch-review/:id/review decision=needs_changes -> triggerAutoRevision.
//   4. Poll GET /batch-review/:id until a NEW asset URL appears (bounded timeout), then
//      assert the source approval moved to revision_submitted and the new asset reports
//      approval status pending. Approval states are retried until the deadline because
//      revisionService appends the new asset before it updates the source approval.
//      Note: GET /batch-review defaults a missing approval row to pending, so this
//      endpoint cannot prove the new asset's approval row was persisted.
//
// The negative case (an unconfirmed image edit is classified "Agent Mode Revision:
// Blocked on Image-Edit Confirmation") is a pure classification and is asserted
// offline by backend/src/__tests__/revisionService.confirmGate.test.ts plus the
// `classifyOutcome` check below, which reports a parked run as BLOCKED_ON_CONFIRMATION
// rather than a generic timeout. No new persisted fields are introduced.
//
// Env: VERIFY_BASE_URL (default https://api.agentweb.pro), QA_USER_EMAIL
// (default qa-user@agentweb.pro), QA_USER_PASSWORD, VERIFY_SESSION_ID,
// VERIFY_SOURCE_IMAGE_URL, VERIFY_SLACK_CHANNEL (all required),
// VERIFY_TIMEOUT_MS (default 300000), VERIFY_POLL_MS (default 10000).

export const CONFIRMATION_BLOCKED = "Agent Mode Revision: Blocked on Image-Edit Confirmation";

/** Classify a polled batch snapshot. Pure; exported for the offline test. */
export function classifyOutcome(batch, sourceUrl) {
  const assets = batch?.assets || [];
  const source = assets.find((a) => a.assetUrl === sourceUrl);
  const fresh = assets.filter((a) => a.assetUrl !== sourceUrl);
  if (fresh.length > 0) return { state: "REVISED", newAsset: fresh[fresh.length - 1], source };
  return { state: "PENDING", source };
}

export async function run({
  fetchImpl = fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
  env = process.env,
  log = console.log,
} = {}) {
  const base = (env.VERIFY_BASE_URL || "https://api.agentweb.pro").replace(/\/$/, "");
  const email = env.QA_USER_EMAIL || "qa-user@agentweb.pro";
  const { QA_USER_PASSWORD: password, VERIFY_SESSION_ID: sessionId,
    VERIFY_SOURCE_IMAGE_URL: sourceUrl, VERIFY_SLACK_CHANNEL: channel } = env;
  const timeoutMs = Number(env.VERIFY_TIMEOUT_MS || 300000);
  const pollMs = Number(env.VERIFY_POLL_MS || 10000);

  if (!/^qa-[a-z]+@agentweb\.pro$/.test(email)) throw new Error(`refusing non-QA account ${email}`);
  for (const [k, v] of Object.entries({ QA_USER_PASSWORD: password, VERIFY_SESSION_ID: sessionId,
    VERIFY_SOURCE_IMAGE_URL: sourceUrl, VERIFY_SLACK_CHANNEL: channel })) {
    if (!v) throw new Error(`${k} is required`);
  }

  const call = async (method, path, token, body) => {
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(token && { Authorization: `Bearer ${token}` }) },
      ...(body && { body: JSON.stringify(body) }),
    });
    let json = null;
    try { json = await res.json(); } catch { /* empty body */ }
    return { status: res.status, json };
  };

  const login = await call("POST", "/api/auth/login", null, { email, password });
  if (login.status !== 200 || !login.json?.token) throw new Error(`login failed: ${login.status}`);
  if (login.json.user?.email !== email) throw new Error("login did not return the QA user");
  const token = login.json.token;

  const filename = `eng2396-probe-${now()}.png`;
  const create = await call("POST", "/api/batch-review/create", token, {
    channel,
    channelName: "qa-verifier",
    note: "[qa-probe ENG-2396] disposable revision fixture",
    assets: [{ assetUrl: sourceUrl, filename, assetType: "image", executionId: `${sessionId}-images` }],
  });
  if (create.status !== 200 || !create.json?.batchId) throw new Error(`batch create failed: ${create.status}`);
  const batchId = create.json.batchId;
  log(`batch ${batchId} created`);

  const review = await call("POST", `/batch-review/${batchId}/review`, null, {
    assetUrl: sourceUrl,
    decision: "needs_changes",
    reviewerName: "qa-verifier ENG-2396",
    feedback: "Make the background a flat light grey. Keep everything else identical.",
  });
  if (review.status !== 200) throw new Error(`review submit failed: ${review.status}`);

  const deadline = now() + timeoutMs;
  let last = null;
  let pendingFailures = null;
  while (now() < deadline) {
    await sleep(pollMs);
    const r = await call("GET", `/batch-review/${batchId}`, null);
    if (r.status !== 200) throw new Error(`batch read failed: ${r.status}`);
    last = classifyOutcome(r.json, sourceUrl);
    if (last.state === "REVISED") {
      const fixed = [];
      if (!/^https:\/\//.test(last.newAsset.assetUrl)) fixed.push("new asset URL is not https");
      if (last.newAsset.assetType !== "image") fixed.push(`new asset type ${last.newAsset.assetType}`);
      if (fixed.length) throw new Error(`FAIL: ${fixed.join("; ")}`);
      const mutable = [];
      if (last.source?.approval?.status !== "revision_submitted") {
        mutable.push(`source approval ${last.source?.approval?.status ?? "missing"}, expected revision_submitted`);
      }
      if (last.newAsset.approval?.status !== "pending") {
        mutable.push(`new asset approval ${last.newAsset.approval?.status ?? "missing"}, expected pending`);
      }
      if (mutable.length) { pendingFailures = mutable; continue; }
      log(`PASS: batch ${batchId} revised -> ${last.newAsset.assetUrl}`);
      return { batchId, newAssetUrl: last.newAsset.assetUrl };
    }
  }
  if (pendingFailures) throw new Error(`FAIL: ${pendingFailures.join("; ")}`);
  // No asset: the service alerted oncall with its classified reason; the verifier cannot
  // read that channel, so name the likely classes instead of a bare timeout.
  throw new Error(`FAIL: no revised asset within ${timeoutMs}ms for batch ${batchId} ` +
    `(check oncall for "${CONFIRMATION_BLOCKED}" / Tool Call Failed / Failed to Extract Asset URL)`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => { console.error(e.message); process.exit(1); });
}
