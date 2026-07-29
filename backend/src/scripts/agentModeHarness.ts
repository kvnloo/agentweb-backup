/**
 * ENG-204 — behavioral Emma harness. Drives real agent-mode turns against the
 * running backend (default localhost:31101, dev-backed) via REST so we can
 * behaviorally verify hardened skills (caps enforced, queue-on-overflow,
 * completion ledger) without the preview browser/CORS constraints.
 *
 *   NODE_ENV=development npx ts-node src/scripts/agentModeHarness.ts \
 *     --install <skillId[,skillId]> "<msg1>" ["<msg2>" ...] [--model <id>]
 *
 * With --install, the harness installs the skill(s) directly via
 * agentModeService.installSkills (the reliable path — requiredFunctions over
 * REST does NOT install), temporarily granting the test user wildcard skill
 * access for the run and RESTORING its subscription in a finally block.
 *
 * Env: HARNESS_API, HARNESS_EMAIL, HARNESS_PASSWORD (default test admin).
 */
import AWS from "aws-sdk";
import { agentModeService } from "../services/agentModeService";

const API = process.env.HARNESS_API || "http://localhost:31101";
const EMAIL = process.env.HARNESS_EMAIL || "test@example.com";
const PASSWORD = process.env.HARNESS_PASSWORD || "Test123!";
const USERS_TABLE = (process.env.NODE_ENV === "development" ? "Dev-" : "") + "AW-Users";
const ddb = new AWS.DynamoDB.DocumentClient({ region: process.env.AWS_REGION || "us-west-2" });

async function j(res: Response): Promise<any> {
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${res.url}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}
const post = (path: string, token: string | null, body: any) =>
  fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }).then(j);

async function getSubscription(email: string): Promise<string | undefined> {
  const r = await ddb.get({ TableName: USERS_TABLE, Key: { email } }).promise();
  return r.Item?.subscriptionType;
}
async function setSubscription(email: string, value: string): Promise<void> {
  await ddb.update({
    TableName: USERS_TABLE, Key: { email },
    UpdateExpression: "SET subscriptionType = :v",
    ExpressionAttributeValues: { ":v": value },
  }).promise();
}
async function removeSubscription(email: string): Promise<void> {
  await ddb.update({
    TableName: USERS_TABLE, Key: { email },
    UpdateExpression: "REMOVE subscriptionType",
  }).promise();
}
const isLocalApi = /(^|\/\/)(localhost|127\.0\.0\.1)(:|\/|$)/.test(API);

async function main() {
  const argv = process.argv.slice(2);
  const flagVal = (n: string) => { const i = argv.indexOf(n); return i > -1 ? argv[i + 1] : undefined; };
  const model = flagVal("--model");
  const installList = flagVal("--install");
  const skillIds = installList ? installList.split(",").map((s) => s.trim()) : [];
  const flagKeys = new Set(["--model", "--install"]);
  const messages = argv.filter((a, i) => !a.startsWith("--") && !flagKeys.has(argv[i - 1]));
  if (messages.length === 0) {
    console.error('Usage: agentModeHarness.ts [--install <skillId,...>] "<msg1>" ["<msg2>" ...] [--model <id>]');
    process.exit(2);
  }
  // --install installs skills and toggles the subscription IN-PROCESS against the
  // local NODE_ENV DB, while turns hit HARNESS_API. Those must be the same env, so
  // refuse --install against a non-local API (would mutate the wrong environment).
  if (skillIds.length && !isLocalApi) {
    console.error(`--install mutates the local NODE_ENV data in-process; it only works against the local backend, but HARNESS_API=${API}. Refusing.`);
    process.exit(2);
  }

  const login = await post("/api/auth/login", null, { email: EMAIL, password: PASSWORD });
  const token = login.token;
  const userId = login.user.userId;
  console.log("logged in ✅");

  // Grant wildcard skill access for the run so gated dev skills can install;
  // restored in finally. (A hard crash would leave it set — restore manually.)
  const hadSub = skillIds.length ? await getSubscription(EMAIL) : undefined;
  try {
    if (skillIds.length) {
      await setSubscription(EMAIL, "ENG204-harness-wildcard");
      const sessionId = await post("/api/agent-mode/sessions", token, { title: "ENG-204 harness" }).then((s) => s.sessionId || s.id);
      const inst = await agentModeService.installSkills(skillIds, userId, sessionId);
      console.log("installed:", JSON.stringify(inst.installedSkills || inst.message));
      console.log("session:", sessionId, "\n");
      await runTurns(token, sessionId, messages, model);
    } else {
      const sessionId = await post("/api/agent-mode/sessions", token, { title: "ENG-204 harness" }).then((s) => s.sessionId || s.id);
      console.log("session:", sessionId, "\n");
      await runTurns(token, sessionId, messages, model);
    }
  } finally {
    // Always undo the wildcard we set: restore the prior value, or REMOVE the
    // attribute if the user had none (else the account stays elevated).
    if (skillIds.length) {
      if (hadSub !== undefined) { await setSubscription(EMAIL, hadSub); console.log(`\n(subscription restored: ${hadSub})`); }
      else { await removeSubscription(EMAIL); console.log(`\n(subscription attribute removed — was absent before the run)`); }
    }
  }
  process.exit(0);
}

async function runTurns(token: string, sessionId: string, messages: string[], model?: string) {
  for (let i = 0; i < messages.length; i++) {
    console.log(`──────── TURN ${i + 1} ────────`);
    console.log("→ " + messages[i]);
    const body: any = { sessionId, userMessage: messages[i] };
    if (model) body.llmModel = model;
    const res = await post("/api/agent-mode/generate", token, body);
    console.log("\nCONTENT:\n" + (res.content || "(empty)"));
    const tools = (res.toolCalls || []).map((t: any) => t.toolName || t.name);
    console.log("TOOL CALLS (" + tools.length + "): " + (tools.join(", ") || "(none)") + "\n");
  }
}

main().catch((e) => { console.error("HARNESS ERROR:", e.message || e); process.exit(1); });
