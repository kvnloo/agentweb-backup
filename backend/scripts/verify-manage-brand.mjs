#!/usr/bin/env node
// ENG-2095: post-merge verifier for manage_brand update (ENG-2094 / PR #3030).
//
// Runs ONLY as the QA account (qa-*@agentweb.pro) — never a customer org. It
// snapshots the QA account's brand guidelines, writes marker values through
// POST /api/brand/guidelines (the path manage_brand "update" calls), reads them
// back, asserts founders + attachments survived untouched, and ALWAYS restores
// the snapshot, failing if the restore readback differs.
//
// Env: VERIFY_BASE_URL (default https://api.agentweb.pro), QA_USER_EMAIL
// (default qa-user@agentweb.pro), QA_USER_PASSWORD (required).

const FIELDS = ["brandName", "valueProposition", "toneOfVoice", "targetAudience", "keyMessages"];
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export async function run({
  fetchImpl = fetch,
  base = (process.env.VERIFY_BASE_URL || "https://api.agentweb.pro").replace(/\/$/, ""),
  email = process.env.QA_USER_EMAIL || "qa-user@agentweb.pro",
  password = process.env.QA_USER_PASSWORD,
  log = console.log,
} = {}) {
  if (!/^qa-[a-z]+@agentweb\.pro$/.test(email)) throw new Error(`refusing non-QA account ${email}`);
  if (!password) throw new Error("QA_USER_PASSWORD is required");
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
  const read = async (token) => {
    const r = await call("GET", "/api/brand/guidelines", token);
    if (r.status !== 200) throw new Error(`read failed: ${r.status}`);
    return { brandData: r.json?.brandData || {}, attachments: r.json?.attachments || [] };
  };

  const login = await call("POST", "/api/auth/login", null, { email, password });
  if (login.status !== 200 || !login.json?.token) throw new Error(`login failed: ${login.status}`);
  if (login.json.user?.email !== email) throw new Error("login did not return the QA user");
  const token = login.json.token;

  const before = await read(token);
  const stamp = `[qa-probe ENG-2095 ${Date.now()}]`;
  const marker = {
    brandName: `${stamp} brand`,
    valueProposition: `${stamp} value`,
    toneOfVoice: `${stamp} tone`,
    targetAudience: `${stamp} audience`,
    keyMessages: [`${stamp} msg-1`, `${stamp} msg-2`],
  };
  const failures = [];
  try {
    const w = await call("POST", "/api/brand/guidelines", token, marker);
    if (w.status < 200 || w.status >= 300) throw new Error(`update failed: ${w.status}`);
    const after = await read(token);
    for (const f of FIELDS) if (!same(after.brandData[f], marker[f])) failures.push(`${f} not written`);
    if (!same(after.brandData.founders, before.brandData.founders)) failures.push("founders not preserved");
    if (!same(after.attachments, before.attachments)) failures.push("attachments not preserved");
  } finally {
    const restore = Object.fromEntries(FIELDS.map((f) => [f, before.brandData[f] ?? (f === "keyMessages" ? [] : "")]));
    let restored = false;
    try {
      const r = await call("POST", "/api/brand/guidelines", token, restore);
      if (r.status >= 200 && r.status < 300) {
        const back = await read(token);
        restored = FIELDS.every((f) => same(back.brandData[f], restore[f]));
      }
    } catch (e) { log(`restore error: ${e?.message ?? e}`); }
    if (!restored) failures.push("restore failed: QA brand guidelines left modified");
  }
  if (failures.length) throw new Error(`FAIL: ${failures.join("; ")}`);
  log("PASS: manage_brand update wrote all fields, preserved founders/attachments, restored snapshot");
  return { ok: true };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => { console.error(e.message); process.exit(1); });
}
