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
const get = (path: string, token: string | null) =>
  fetch(`${API}${path}`, {
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  }).then(j);

const WILDCARD_SUB = "ENG204-harness-wildcard";

/**
 * Atomically set the wildcard AND return the value it overwrote (ReturnValues:
 * ALL_OLD). Capturing the prior value in the SAME write as the overwrite closes
 * the read-then-write window a concurrent webhook/admin change could slip
 * through — the returned value is exactly what was present at the instant we
 * replaced it, which is the only safe basis for the cleanup restore.
 */
async function setWildcardCapturingPrev(email: string): Promise<string | undefined> {
  const r = await ddb.update({
    TableName: USERS_TABLE, Key: { email },
    UpdateExpression: "SET subscriptionType = :v",
    ExpressionAttributeValues: { ":v": WILDCARD_SUB },
    ReturnValues: "ALL_OLD",
  }).promise();
  return r.Attributes?.subscriptionType;
}
/**
 * Best-effort restore, guarded so we never clobber a change made DURING the run:
 * only write back if subscriptionType is still the wildcard we set. If a
 * webhook/admin changed it meanwhile, leave the newer value in place.
 */
async function restoreSubscription(email: string, prev: string | undefined): Promise<void> {
  const guard = {
    TableName: USERS_TABLE, Key: { email },
    ConditionExpression: "subscriptionType = :w",
  };
  try {
    if (prev !== undefined) {
      await ddb.update({
        ...guard,
        UpdateExpression: "SET subscriptionType = :v",
        ExpressionAttributeValues: { ":w": WILDCARD_SUB, ":v": prev },
      }).promise();
      console.log(`\n(subscription restored: ${prev})`);
    } else {
      await ddb.update({
        ...guard,
        UpdateExpression: "REMOVE subscriptionType",
        ExpressionAttributeValues: { ":w": WILDCARD_SUB },
      }).promise();
      console.log(`\n(subscription attribute removed — was absent before the run)`);
    }
  } catch (e: any) {
    if (e.code === "ConditionalCheckFailedException") {
      console.log(`\n(subscription changed during the run — left as-is, not restoring the stale value)`);
    } else {
      // Cleanup is best-effort: log, don't mask any primary error from the run.
      console.warn(`\n(could not restore subscription: ${e.message || e})`);
    }
  }
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
  // local NODE_ENV DB, while turns hit HARNESS_API. Those must be the same env.
  // A non-local API is refused up front (cheap pre-check); a localhost URL alone
  // does NOT prove same NODE_ENV/AWS account, so the authoritative guard is the
  // post-install read-back below, which verifies the skills actually landed in
  // the session the backend serves.
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
  // hadSub is captured atomically WITH the wildcard write below (ALL_OLD), so no
  // read-then-write window exists for a concurrent change to slip through.
  let hadSub: string | undefined = undefined;
  try {
    if (skillIds.length) {
      hadSub = await setWildcardCapturingPrev(EMAIL);
      const sessionId = await post("/api/agent-mode/sessions", token, { title: "ENG-204 harness" }).then((s) => s.sessionId || s.id);
      const inst = await agentModeService.installSkills(skillIds, userId, sessionId);
      console.log("installed:", JSON.stringify(inst.installedSkills || inst.message));
      console.log("session:", sessionId, "\n");
      // Prove the in-process install actually landed in the session the BACKEND
      // serves. A localhost URL doesn't guarantee the harness process and
      // HARNESS_API share a NODE_ENV / AWS account; this read-back does. It also
      // catches skills that silently failed to install (unpublished / not
      // available to the user), so a turn that ran WITHOUT the skill is never
      // mistaken for a behavioral pass.
      const view = await get(`/api/agent-mode/session/${sessionId}`, token);
      const landed = new Set(
        (view.skills || []).filter((s: any) => s.installed).map((s: any) => s.skillId),
      );
      const missing = skillIds.filter((id) => !landed.has(id));
      if (missing.length) {
        throw new Error(
          `Requested skill(s) not present in the backend's session: ${missing.join(", ")}. ` +
            `Cause is either (a) HARNESS_API=${API} is a different environment than this process ` +
            `(NODE_ENV=${process.env.NODE_ENV}), so the in-process install hit a different data store, ` +
            `or (b) the skill is unavailable to the test user (e.g. unpublished). ` +
            `Aborting before turns so a skill-less run is never read as a behavioral pass.`,
        );
      }
      console.log("install verified in session ✅\n");
      await runTurns(token, sessionId, messages, model);
    } else {
      const sessionId = await post("/api/agent-mode/sessions", token, { title: "ENG-204 harness" }).then((s) => s.sessionId || s.id);
      console.log("session:", sessionId, "\n");
      await runTurns(token, sessionId, messages, model);
    }
  } finally {
    // Undo the wildcard we set — but only if it's still ours (compare-and-swap),
    // so a subscription change made during the run isn't clobbered by a stale value.
    if (skillIds.length) {
      await restoreSubscription(EMAIL, hadSub);
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
