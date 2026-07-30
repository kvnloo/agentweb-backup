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

// The wildcard grant is a sentinel written into subscriptionType (any value that
// isn't a recognized tier resolves to ["*"] wildcard skill access — see
// getAllowedSkills). The sentinel ENCODES the real prior tier and is unique per
// acquire, which is what makes the grant crash-safe:
//   ENG204-harness-wildcard::prev=<urlenc real tier | empty>::<pid>-<rand>
// Because the real tier is carried inside the sentinel, a run that is hard-killed
// before cleanup never LOSES it — the next run reclaims the stranded grant, reads
// the encoded tier, and restores it. No manual repair, no data loss, no lock.
const WILDCARD_PREFIX = "ENG204-harness-wildcard";
const isHarnessGrant = (v: string | undefined): v is string =>
  typeof v === "string" && v.startsWith(WILDCARD_PREFIX + "::");
function encodeGrant(realPrev: string | undefined): string {
  const uniq = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  return `${WILDCARD_PREFIX}::prev=${encodeURIComponent(realPrev ?? "")}::${uniq}`;
}
// encodeURIComponent escapes ':' so the encoded tier can't contain the delimiter.
function decodeRealPrev(sentinel: string): string | undefined {
  const m = /::prev=([^:]*)::/.exec(sentinel);
  const raw = m ? decodeURIComponent(m[1]) : "";
  return raw === "" ? undefined : raw;
}

/**
 * Acquire the wildcard grant with an optimistic lock, reclaiming any grant already
 * present (a stranded one from a hard-killed run, or a concurrent run's):
 *  - read the current value; the REAL prior tier is the decoded tier if it's
 *    already a harness grant (carry it forward), else the value itself (or none);
 *  - conditionally write our sentinel ONLY if the field is still exactly what we
 *    read (so a concurrent webhook/run change is never silently overwritten);
 *  - on a conditional miss, retry from the fresh value. Because the real tier is
 *    always carried forward into the new sentinel, no interleaving can lose it.
 * Returns { acquired: false } only if persistent contention exhausts retries.
 */
async function acquireWildcard(email: string): Promise<{ acquired: boolean; sentinel: string; prev?: string }> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const cur = (await ddb.get({ TableName: USERS_TABLE, Key: { email } }).promise())
      .Item?.subscriptionType as string | undefined;
    const realPrev = isHarnessGrant(cur) ? decodeRealPrev(cur) : cur;
    const sentinel = encodeGrant(realPrev);
    try {
      await ddb.update({
        TableName: USERS_TABLE, Key: { email },
        ConditionExpression:
          cur === undefined ? "attribute_not_exists(subscriptionType)" : "subscriptionType = :cur",
        UpdateExpression: "SET subscriptionType = :s",
        ExpressionAttributeValues:
          cur === undefined ? { ":s": sentinel } : { ":s": sentinel, ":cur": cur },
      }).promise();
      if (isHarnessGrant(cur)) console.log("(reclaimed a stranded harness grant)");
      return { acquired: true, sentinel, prev: realPrev };
    } catch (e: any) {
      if (e.code === "ConditionalCheckFailedException") {
        await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
        continue;
      }
      throw e;
    }
  }
  return { acquired: false, sentinel: "" };
}

/**
 * The grant is written to the base table by `email`, but installSkills resolves
 * the tier by `userId` through the UserIdIndex GSI, which is eventually consistent.
 * Wait for OUR sentinel to become visible on that index before installing —
 * otherwise a stale tier read could reject a gated skill and make the read-back
 * falsely abort a valid run. Bounded (~5s); proceeds anyway if it doesn't converge.
 */
async function waitForWildcardVisible(userId: string, sentinel: string): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const r = await ddb.query({
      TableName: USERS_TABLE, IndexName: "UserIdIndex",
      KeyConditionExpression: "userId = :u",
      ExpressionAttributeValues: { ":u": userId },
    }).promise();
    if (r.Items?.[0]?.subscriptionType === sentinel) return;
    await new Promise((res) => setTimeout(res, 250));
  }
  console.warn("(wildcard not yet visible on UserIdIndex after ~5s — proceeding)");
}
/**
 * Restore the real prior tier, guarded so we only ever act on OUR OWN grant:
 * - Condition `subscriptionType = <our sentinel>`: a change during the run
 *   (webhook/admin) or another run that reclaimed our grant leaves us out
 *   (ConditionalCheckFailed → skip; that reclaimer now carries the real tier).
 * - `prev` is the REAL prior tier decoded at acquire time, so restoring it can
 *   never persist a sentinel or erase a paid tier.
 * - Transient failures are retried; if they exhaust, flag LOUDLY and mark the run
 *   failed (exit != 0). Even then the grant self-heals on the next run (the tier
 *   is encoded in the sentinel), so no data is lost.
 */
async function restoreSubscription(email: string, sentinel: string, prev: string | undefined): Promise<void> {
  const req: any = {
    TableName: USERS_TABLE, Key: { email },
    ConditionExpression: "subscriptionType = :w",
    ExpressionAttributeValues: { ":w": sentinel } as any,
  };
  if (prev !== undefined) {
    req.UpdateExpression = "SET subscriptionType = :v";
    req.ExpressionAttributeValues[":v"] = prev;
  } else {
    req.UpdateExpression = "REMOVE subscriptionType";
  }

  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      await ddb.update(req).promise();
      console.log(
        prev !== undefined
          ? `\n(subscription restored: ${prev})`
          : `\n(subscription attribute removed)`,
      );
      return;
    } catch (e: any) {
      if (e.code === "ConditionalCheckFailedException") {
        console.log(`\n(subscription is no longer our grant — left as-is, not restoring)`);
        return;
      }
      if (attempt < 4) {
        await new Promise((r) => setTimeout(r, 250 * attempt));
        continue;
      }
      // Retries exhausted on a transient error — do NOT leave this silent. (The
      // real tier is still encoded in the sentinel, so the next run self-heals it.)
      console.error(
        `\n⚠️  FAILED to restore subscription for ${email} after ${attempt} attempts: ${e.message || e}. ` +
          `The next harness run will reclaim and heal the grant; or repair manually.`,
      );
      process.exitCode = 1;
      return;
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
  // restored in finally. acquireWildcard encodes the real prior tier into a unique
  // sentinel and reclaims any stranded grant, so overlapping runs never corrupt
  // each other and a hard-killed run self-heals on the next run (no data loss).
  let grant: { acquired: boolean; sentinel: string; prev?: string } | null = null;
  try {
    if (skillIds.length) {
      grant = await acquireWildcard(EMAIL);
      if (!grant.acquired) {
        throw new Error(
          `Could not acquire the harness grant on ${EMAIL} after retries (persistent concurrent ` +
            `contention on the test account). Run harness invocations sequentially and retry.`,
        );
      }
      await waitForWildcardVisible(userId, grant.sentinel);
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
    // Restore only if WE acquired the grant. Restore is a compare-and-swap on our
    // own sentinel, so it never clobbers a change made during the run or another
    // run that reclaimed our grant (that reclaimer carries the real tier forward).
    if (grant?.acquired) {
      await restoreSubscription(EMAIL, grant.sentinel, grant.prev);
    }
  }
  // Respect a non-zero exitCode set by a failed subscription restore (leaves the
  // run visibly failed rather than a silent success with the account elevated).
  process.exit(process.exitCode ?? 0);
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
