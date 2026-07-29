/**
 * ENG-204 — behavioral Emma harness. Drives a real agent-mode turn against the
 * running backend (default localhost:31101, dev-backed) via REST, and prints the
 * response text + the tool calls Emma made — so we can behaviorally verify
 * hardened skills (caps enforced, completion ledger, tool availability) without
 * the browser/CORS constraints of the preview.
 *
 *   NODE_ENV=development npx ts-node src/scripts/agentModeHarness.ts "<message>" [--model <id>]
 *
 * Env: HARNESS_API (base URL), HARNESS_EMAIL, HARNESS_PASSWORD (default test admin).
 */
const API = process.env.HARNESS_API || "http://localhost:31101";
const EMAIL = process.env.HARNESS_EMAIL || "test@example.com";
const PASSWORD = process.env.HARNESS_PASSWORD || "Test123!";

async function j(res: Response): Promise<any> {
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${res.url}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

async function login(): Promise<string> {
  const d = await j(await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  }));
  return d.token;
}

async function createSession(token: string, title: string): Promise<string> {
  const d = await j(await fetch(`${API}/api/agent-mode/sessions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  }));
  return d.sessionId || d.id;
}

async function generate(token: string, sessionId: string, userMessage: string, model?: string): Promise<any> {
  const body: any = { sessionId, userMessage };
  if (model) body.llmModel = model;
  return j(await fetch(`${API}/api/agent-mode/generate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
}

async function main() {
  const message = process.argv[2];
  const modelIdx = process.argv.indexOf("--model");
  const model = modelIdx > -1 ? process.argv[modelIdx + 1] : undefined;
  if (!message) {
    console.error('Usage: agentModeHarness.ts "<message>" [--model <id>]');
    process.exit(2);
  }
  const token = await login();
  console.log("logged in ✅");
  const sessionId = await createSession(token, "ENG-204 harness");
  console.log("session:", sessionId);
  console.log("→ sending:", message);
  const res = await generate(token, sessionId, message, model);
  console.log("\n=== CONTENT ===\n" + (res.content || "(empty)"));
  const tools = (res.toolCalls || []).map((t: any) => t.toolName || t.name);
  console.log("\n=== TOOL CALLS (" + tools.length + ") ===\n" + (tools.join(", ") || "(none)"));
  process.exit(0);
}

main().catch((e) => { console.error("HARNESS ERROR:", e.message || e); process.exit(1); });
