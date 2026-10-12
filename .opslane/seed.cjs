// Seeds the test account through AgentWeb's own signup route: starts the built server on a spare
// port, registers verify@agentweb.local, logs in to prove it, stops the server.
const { spawn } = require("node:child_process");
const PORT = "3911";
const server = spawn("node", ["dist/server.js"], { env: { ...process.env, PORT }, stdio: "ignore" });
const base = `http://127.0.0.1:${PORT}`;
const post = (path, body) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
(async () => {
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(base + "/health")).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  const creds = { email: "verify@agentweb.local", password: "OpslaneVerify123!" };
  const reg = await post("/api/auth/register", { ...creds, displayName: "Opslane Verify" });
  if (!reg.ok && reg.status !== 400 && reg.status !== 409) throw new Error(`register: ${reg.status} ${await reg.text()}`);
  const login = await post("/api/auth/login", creds);
  if (!login.ok) throw new Error(`login: ${login.status} ${await login.text()}`);
  console.log("seeded verify@agentweb.local");
})().then(() => { server.kill(); process.exit(0); }, (e) => { console.error(e); server.kill(); process.exit(1); });
