// auth.session_command: signs the seeded account in through AgentWeb's API and prints the session
// as Opslane expects it. The API takes a JWT bearer token, not a cookie, so the session is headers
// only. Runs in the app container, so the app is on localhost. Logs go to stderr.
const port = process.env.PORT || "3001";
(async () => {
  const res = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "verify@agentweb.local", password: "OpslaneVerify123!" }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || typeof body.token !== "string") {
    console.error(`login failed: HTTP ${res.status}`);
    process.exit(1);
  }
  console.log(JSON.stringify({ cookies: [], headers: { authorization: `Bearer ${body.token}` } }));
})().catch((e) => { console.error(`login failed: ${e.message}`); process.exit(1); });
