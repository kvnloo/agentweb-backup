#!/usr/bin/env node
// ENG-2521: post-deploy negative-path smoke for ENG-984 (lazy MCP auth, shipped OFF).
//
// With MCP_ANONYMOUS_DISCOVERY unset in prod, every unauthenticated MCP request
// (initialize, tools/list, tools/call) must get the pre-ENG-984 auth challenge:
// 401 + WWW-Authenticate pointing at the OAuth protected-resource metadata. An
// anonymous tool list or a non-401 tools/call means discovery is being served
// while the flag should be off -> exit 1.
//
// Read-only. Sends no credentials, never reads or sets the flag.
// Env: VERIFY_BASE_URL (default https://api.agentweb.pro).

const RPC = {
  initialize: {
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "eng-2521-smoke", version: "1" } },
  },
  "tools/list": { method: "tools/list", params: {} },
  "tools/call": { method: "tools/call", params: { name: "get_account_info", arguments: {} } },
};

/** Classify one unauthenticated response. Pure; unit-tested with fixtures. */
export function classify({ status, wwwAuthenticate, body }, base) {
  const expected = `resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`;
  const text = typeof body === "string" ? body : JSON.stringify(body ?? null);
  if (/"tools"\s*:\s*\[/.test(text) || /"serverInfo"/.test(text)) {
    return { ok: false, reason: `anonymous MCP payload served (status ${status})` };
  }
  if (status !== 401) return { ok: false, reason: `expected 401, got ${status}` };
  if (!wwwAuthenticate || !wwwAuthenticate.includes(expected)) {
    return { ok: false, reason: `WWW-Authenticate missing ${expected}: ${wwwAuthenticate ?? "<none>"}` };
  }
  return { ok: true, reason: "401 + OAuth challenge" };
}

export async function run({
  fetchImpl = fetch,
  base = (process.env.VERIFY_BASE_URL || "https://api.agentweb.pro").replace(/\/$/, ""),
  log = console.log,
} = {}) {
  let version = "unknown";
  try {
    const h = await fetchImpl(`${base}/health`);
    version = (await h.json())?.version || "unknown";
  } catch { /* version is informational */ }
  log(`target=${base} version=${version}`);

  let failed = 0;
  let id = 1;
  for (const [name, rpc] of Object.entries(RPC)) {
    const res = await fetchImpl(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: id++, ...rpc }),
    });
    const body = await res.text();
    const verdict = classify({ status: res.status, wwwAuthenticate: res.headers.get("www-authenticate"), body }, base);
    log(`${verdict.ok ? "PASS" : "FAIL"} ${name}: ${verdict.reason}`);
    if (!verdict.ok) failed++;
  }
  log(failed ? `VERDICT: FAIL (${failed} check(s))` : "VERDICT: PASS anonymous discovery is OFF");
  return { ok: failed === 0, version };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().then((r) => process.exit(r.ok ? 0 : 1), (e) => { console.error(e); process.exit(2); });
}
