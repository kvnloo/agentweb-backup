/**
 * ENG-2110 PR 1c: MANUAL live check of the HOSTED SUBSCRIPTION SERVICE (sign-in, reconnect, disconnect, sweeper) against the REAL login
 * host (real systemd units, real pinned `claude`) AND the REAL Dev-AW-LlmConnections table, on the test instance. The HTTP layer is
 * covered by route tests; this is service + DynamoDB + host for real, with a REAL sign-in typed by the owner in their own terminal.
 *
 *   sudo NODE_ENV=development node hostedServiceLive.js [--reconnect]
 *
 * Rows use the owner `zz-live-owner` and ids starting `zz-live-`; they are deleted at the end (and on failure the connection is
 * disconnected through the service first, so no login stays on the host). The code is read HIDDEN, goes only to the host API, is
 * never printed or written. The "Open this URL" line must not be pasted anywhere. Output is redacted.
 */
import { randomBytes } from "crypto";
import { readdirSync } from "fs";
import AWS from "aws-sdk";
import { HostedSubscriptionError, HostedSubscriptionService, type HostedProvider } from "../../../services/funding/hostedSubscriptionService";
import { LLM_CONNECTIONS_TABLE, LlmConnectionDb } from "../../../services/funding/llmConnectionDb";
import { LoginHostClient, UnixSocketTransport } from "../../../services/funding/loginHostClient";

const SOCK = process.env.AW_HOST_SOCK ?? "/run/aw-login-host-test1/host.sock";
const HOME_ROOT = process.env.AW_HOME_ROOT ?? "/var/lib/aw-login-host/test1/u";
const WITH_RECONNECT = process.argv.includes("--reconnect");
const OWNER = "zz-live-owner";
const results: Array<{ name: string; ok: boolean }> = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  | " + detail : ""}`);
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const codeOf = (p: Promise<unknown>) => p.then(() => "resolved", (e) => (e instanceof HostedSubscriptionError ? e.code : `other:${(e as Error)?.name}`));

function readHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) return reject(new Error("a terminal is required: the code is entered hidden"));
    process.stdout.write(prompt);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    let buf = "";
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off("data", onData);
          process.stdout.write("\n");
          // eslint-disable-next-line no-control-regex
          return resolve(buf.replace(/\x1b\[20[01]~/g, "").replace(/[^\x21-\x7e]/g, ""));
        }
        if (ch === "\u0003") process.exit(130);
        if (ch === "\u007f") buf = buf.slice(0, -1);
        else buf += ch;
      }
    };
    process.stdin.on("data", onData);
  });
}

const db = new LlmConnectionDb();
const dc = new AWS.DynamoDB.DocumentClient({ region: process.env.AWS_REGION || "us-west-2" });
const provider: HostedProvider = { route: "claude", kind: "claude_subscription", recordProvider: "anthropic", hostProvider: "claude", isEnabledFor: async (u) => u === OWNER };
const svc = new HostedSubscriptionService({
  db,
  client: () => new LoginHostClient(new UnixSocketTransport(SOCK)),
  providers: { claude: provider },
  now: () => Date.now(),
  newId: () => `zz-live-${randomBytes(5).toString("hex")}`,
});
const user = { userId: OWNER };
const counter = async () => ((await dc.get({ TableName: LLM_CONNECTIONS_TABLE, Key: { connectionId: `limit#${OWNER}` } }).promise()).Item?.activeCount as number | undefined) ?? 0;
const homesLeft = () => {
  try {
    return readdirSync(HOME_ROOT).filter((n) => /^\d+$/.test(n)).reduce((n, uid) => n + readdirSync(`${HOME_ROOT}/${uid}/homes`).length, 0);
  } catch {
    return -1;
  }
};
const touched = new Set<string>();

async function signIn(label: string, reconnectConnectionId?: string) {
  const started = await svc.startLogin(user, "claude", reconnectConnectionId ? { reconnectConnectionId } : {});
  console.log(`\n[${label}] Open this URL in a browser (do NOT paste it anywhere), sign in, and copy the code shown:\n${started.authorizeUrl}\n`);
  const code = await readHidden("Paste the code (hidden): ");
  return svc.completeLogin(user, started.loginId, code);
}

async function main() {
  if (!LLM_CONNECTIONS_TABLE.startsWith("Dev-")) throw new Error("refusing: not the Dev table");
  check("unsupported-provider", (await codeOf(svc.startLogin(user, "nope"))) === "unsupported_provider");
  check("unflagged-user-disabled", (await codeOf(svc.startLogin({ userId: "zz-someone-else" }, "claude"))) === "disabled");
  check("delegated-admin-refused", (await codeOf(svc.startLogin({ userId: OWNER, adminId: "zz-admin" }, "claude"))) === "forbidden");
  const cancelled = await svc.startLogin(user, "claude");
  await svc.cancelLogin(user, cancelled.loginId);
  check("start-then-cancel", svc.pendingCount() === 0 && (await codeOf(svc.completeLogin(user, cancelled.loginId, "AAAAAAAA#BBBBBBBB"))) === "login_not_found");

  const view = await signIn("sign-in");
  touched.add(view.connectionId);
  const row = (await db.get(view.connectionId))!;
  check("sign-in-active", view.status === "active" && view.subscription?.plan !== undefined, `plan=${view.subscription?.plan}`);
  check("record-reference-only", row.subHosted === true && row.subHostEpoch === 1 && row.sealed === undefined && row.subVersion === undefined);
  check("slot-taken", (await counter()) === 1, `count=${await counter()}`);
  check("home-exists-on-host", homesLeft() === 1, `homes=${homesLeft()}`);

  let id = view.connectionId;
  if (WITH_RECONNECT) {
    const again = await signIn("reconnect", id);
    const r2 = (await db.get(id))!;
    check("reconnect-active-epoch-2", again.status === "active" && r2.subHostEpoch === 2 && r2.subNeedsReconnect === false, `epoch=${r2.subHostEpoch}`);
    check("reconnect-keeps-one-slot", (await counter()) === 1);
    // The host wipes the replaced home in its background sweep (every 60 s), not inside the promote: wait for it.
    const waitStart = Date.now();
    while (homesLeft() !== 1 && Date.now() - waitStart < 90_000) await sleep(5_000);
    check("old-home-wiped-after-reconnect", homesLeft() === 1, `homes=${homesLeft()} after ${Math.round((Date.now() - waitStart) / 1000)}s`);
  }

  const outcome = await svc.revokeRecord(user, id);
  check("disconnect-revoked-only-after-host", outcome === "revoked", `outcome=${outcome}`);
  const after = (await db.get(id))!;
  check("record-revoked", after.status === "revoked" && !!after.revokedAt && after.subSlotReleased === true);
  check("slot-released", (await counter()) === 0, `count=${await counter()}`);
  await sleep(4_000);
  check("home-wiped", homesLeft() === 0, `homes=${homesLeft()}`);
  check("disconnect-idempotent", (await svc.revokeRecord(user, id)) === "revoked" && (await counter()) === 0);
  const sweep = await svc.sweepOnce();
  check("sweep-finds-nothing-to-do", sweep.revoking === 0 && !sweep.hostUnavailable, JSON.stringify(sweep));
  id = "";
}

main()
  .catch((e) => check("runner", false, e instanceof HostedSubscriptionError ? e.code : String((e as { code?: string }).code ?? (e as Error).message).slice(0, 120)))
  .finally(async () => {
    // Whatever happened: disconnect anything this run created (so no login stays on the host), then delete our rows.
    for (const id of touched) {
      try {
        const r = await db.get(id);
        if (r && r.status !== "revoked") {
          const out = await svc.revokeRecord(user, id);
          console.log(`cleanup: disconnect ${out}`);
        }
      } catch {
        console.log("cleanup FAILED: disconnect by hand (see runbook)");
      }
    }
    await svc.shutdown();
    for (const id of [...touched, `limit#${OWNER}`]) await dc.delete({ TableName: LLM_CONNECTIONS_TABLE, Key: { connectionId: id } }).promise().catch(() => undefined);
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? "; FAILED: " + failed.map((f) => f.name).join(", ") : ""}`);
    process.exit(failed.length ? 1 : 0);
  });
