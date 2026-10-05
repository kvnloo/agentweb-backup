#!/usr/bin/env node
// ENG-2302: post-merge verifier for ENG-1390 (conditional skill writes → 409).
//
// Runs ONLY against a verifier-owned fixture: logs in as the QA user, creates a
// private test skill it owns, races concurrent writes against it, then deletes
// it. It never reads, writes, or deletes any skill it did not just create, and
// it fails closed if the fixture's owner is not the logged-in QA user.
//
// The public API takes no client-supplied `updatedAt`; the stale-`updatedAt`
// window is the server's read→conditional-write gap. Two requests fired
// together both read the same `updatedAt`; the loser must get 409 (or, if it
// read after the winner committed, a deterministic precondition 4xx) — never
// a second 2xx and never a 5xx. We repeat until a 409 is observed.
//
// Env: VERIFY_BASE_URL (default https://api.agentweb.pro), QA_USER_EMAIL
// (default qa-user@agentweb.pro), QA_USER_PASSWORD (required),
// VERIFY_ATTEMPTS (default 15).

const BASE = (process.env.VERIFY_BASE_URL || "https://api.agentweb.pro").replace(/\/$/, "");
const EMAIL = process.env.QA_USER_EMAIL || "qa-user@agentweb.pro";
const FIXTURE_PREFIX = "[qa-fixture] ENG-2302 conflict probe";

export function classifyPair(a, b) {
  const ok = [a, b].filter((s) => s >= 200 && s < 300).length;
  if ([a, b].some((s) => s >= 500)) return "server_error";
  // Two 2xx is inconclusive, not a double write: submit may finish before DELETE
  // reads the row, and the owner may legitimately delete a pending_review skill.
  if (ok !== 1) return ok === 0 ? "no_winner" : "inconclusive";
  const loser = a >= 200 && a < 300 ? b : a;
  if (loser === 409) return "conflict";
  if (loser >= 400 && loser < 500) return "precondition";
  return "unexpected";
}

export async function run({ fetchImpl = fetch, password = process.env.QA_USER_PASSWORD, attempts = Number(process.env.VERIFY_ATTEMPTS || 15), log = console.log } = {}) {
  if (!/^qa-[a-z]+@agentweb\.pro$/.test(EMAIL)) throw new Error(`refusing non-QA account ${EMAIL}`);
  if (!password) throw new Error("QA_USER_PASSWORD is required");
  const call = async (method, path, token, body) => {
    const res = await fetchImpl(`${BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(token && { Authorization: `Bearer ${token}` }) },
      ...(body && { body: JSON.stringify(body) }),
    });
    let json = null;
    try { json = await res.json(); } catch { /* empty body */ }
    return { status: res.status, json };
  };

  const login = await call("POST", "/api/auth/login", null, { email: EMAIL, password });
  if (login.status !== 200 || !login.json?.token) throw new Error(`login failed: ${login.status}`);
  const token = login.json.token;
  const qaUserId = login.json.user?.userId;
  if (login.json.user?.email !== EMAIL || !qaUserId) throw new Error("login did not return the QA user");

  const results = { conflict: 0, precondition: 0, inconclusive: 0, attempts: 0 };
  const created = [];
  const fixture = async () => {
    const r = await call("POST", "/api/user-skills", token, { name: `${FIXTURE_PREFIX} ${Date.now()}`, description: "Verifier-owned fixture; safe to delete." });
    if (r.status !== 201 || !r.json?.skillId) throw new Error(`fixture create failed: ${r.status}`);
    // Ownership check BEFORE scheduling cleanup: never DELETE a skill we do not own.
    if (r.json.ownerId !== qaUserId) throw new Error("fail closed: fixture owner is not the QA user");
    created.push(r.json.skillId);
    return r.json.skillId;
  };

  try {
    for (let i = 0; i < attempts && results.conflict === 0; i++) {
      const id = await fixture();
      // Race: submit-for-review vs delete on the same private row.
      const [a, b] = await Promise.all([
        call("POST", `/api/user-skills/${id}/submit-for-review`, token),
        call("DELETE", `/api/user-skills/${id}`, token),
      ]);
      const verdict = classifyPair(a.status, b.status);
      results.attempts++;
      log(`attempt ${i + 1}: submit=${a.status} delete=${b.status} → ${verdict}`);
      if (!(verdict in results)) throw new Error(`FAIL: ${verdict} (submit=${a.status}, delete=${b.status})`);
      results[verdict]++;
    }
  } finally {
    const leaked = [];
    for (const id of created) {
      let r;
      for (let t = 0; t < 3; t++) {
        r = await call("DELETE", `/api/user-skills/${id}`, token);
        if ([200, 204, 404].includes(r.status)) break;
      }
      if (![200, 204, 404].includes(r.status)) { leaked.push(`${id}:${r.status}`); log(`cleanup failed: ${id} → ${r.status}`); }
    }
    if (leaked.length) throw new Error(`FAIL: fixture cleanup failed (${leaked.join(", ")})`);
  }
  if (results.conflict === 0) throw new Error(`no 409 observed in ${results.attempts} races (no double-write or 5xx either)`);
  log(`PASS: ${JSON.stringify(results)}`);
  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => { console.error(e.message); process.exit(1); });
}
