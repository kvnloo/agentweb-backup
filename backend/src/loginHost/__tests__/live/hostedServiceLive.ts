/**
 * ENG-2110 PR 1c: MANUAL live check of the HOSTED SUBSCRIPTION SERVICE (sign-in, reconnect, disconnect, sweeper) against the REAL login
 * host (real systemd units, real pinned `claude`) AND the REAL Dev-AW-LlmConnections table, on the test instance. The HTTP layer is
 * covered by route tests; this is service + DynamoDB + host for real, with a REAL sign-in typed by the owner in their own terminal.
 *
 *   sudo NODE_ENV=development node hostedServiceLive.js [--reconnect] [--swap]
 *   sudo NODE_ENV=development node hostedServiceLive.js --hardening     (ONE code) protocol-3 behaviours on a ready login: nonce reported, a loser whose reply is lost stands down
 *                                                                       without cancelling, a stray user cancel leaves the ready login, then promote + revoke by hand
 *   sudo NODE_ENV=development node hostedServiceLive.js --ready-ttl    (ONE code) a ready login that is never promoted is discarded by the host and the connection is free again
 *                                                                       (needs "manager": {"readyAttemptTtlMs": 10000} in the test host config; takes up to ~3 minutes)
 *
 * --swap (ENG-2110, sealed sign-in token): the sign-in is STARTED by one service object and COMPLETED by two other, freshly built ones at the
 * same moment with the same code (what a deploy swap plus a double submit look like). Expected: exactly one succeeds, the other answers
 * login_not_found, the first service (which never sees the complete) knows nothing of it, and the login on the host is intact. Needs the host
 * to include the "refuse a second complete for a ready attempt" guard.
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
const makeSvc = (wrapClient?: (c: LoginHostClient) => LoginHostClient) =>
  new HostedSubscriptionService({
    db,
    client: () => {
      const c = new LoginHostClient(new UnixSocketTransport(SOCK));
      return wrapClient ? wrapClient(c) : c;
    },
    providers: { claude: provider },
    now: () => Date.now(),
    newId: () => `zz-live-${randomBytes(5).toString("hex")}`,
  });
const svc = makeSvc();
const WITH_SWAP = process.argv.includes("--swap");
const HARDENING = process.argv.includes("--hardening");
const READY_TTL = process.argv.includes("--ready-ttl");
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
const touchedHost = new Map<string, string>(); // connectionId -> loginRef of attempts made by hand in the --hardening / --ready-ttl scenarios
let BASE_HOMES = 0;

/** Started here, completed by two OTHER service objects at once (a deploy swap plus a double submit). */
async function signInSwap(label: string) {
  const started = await svc.startLogin(user, "claude");
  console.log(`\n[${label}] Open this URL in a browser (do NOT paste it anywhere), sign in, and copy the code shown:\n${started.authorizeUrl}\n`);
  const code = await readHidden("Paste the code (hidden): ");
  const b = makeSvc();
  const c = makeSvc();
  const outcomes = await Promise.all([b.completeLogin(user, started.loginId, code).then((v) => v, (e) => e), c.completeLogin(user, started.loginId, code).then((v) => v, (e) => e)]);
  const winners = outcomes.filter((o) => !(o instanceof Error));
  const losers = outcomes.filter((o): o is HostedSubscriptionError => o instanceof HostedSubscriptionError);
  check("swap-exactly-one-completes", winners.length === 1 && losers.length === 1, `winners=${winners.length} losers=${losers.map((l) => l.code).join(",")}`);
  check("swap-loser-is-login_not_found", losers.length === 1 && losers[0].code === "login_not_found");
  check("swap-origin-instance-knew-nothing", svc.pendingCount() === 1); // its own pending entry is still there: it never saw the complete
  await b.shutdown();
  await c.shutdown();
  return winners[0] as Awaited<ReturnType<typeof svc.completeLogin>>;
}

async function signIn(label: string, reconnectConnectionId?: string) {
  const started = await svc.startLogin(user, "claude", reconnectConnectionId ? { reconnectConnectionId } : {});
  console.log(`\n[${label}] Open this URL in a browser (do NOT paste it anywhere), sign in, and copy the code shown:\n${started.authorizeUrl}\n`);
  const code = await readHidden("Paste the code (hidden): ");
  return svc.completeLogin(user, started.loginId, code);
}

/** Protocol-3 behaviours on a ready login, with the real CLI. One sign-in code. The "other instances" are fresh service objects; the "winner" is a raw host call. */
async function hardening() {
  const started = await svc.startLogin(user, "claude");
  const { connectionId, loginRef } = (svc as unknown as { lookup(id: string): { pending: { connectionId: string; loginRef: string } } }).lookup(started.loginId).pending;
  touchedHost.set(connectionId, loginRef);
  console.log(`\n[hardening] Open this URL in a browser (do NOT paste it anywhere), sign in, and copy the code shown:\n${started.authorizeUrl}\n`);
  const code = await readHidden("Paste the code (hidden): ");
  const raw = new LoginHostClient(new UnixSocketTransport(SOCK));
  const ready = await raw.loginComplete({ connectionId, loginRef, code, completionNonce: "live-winner-0001" });
  check("hardening-ready-reports-the-nonce", ready.status === "ready" && ready.completionNonce === "live-winner-0001");
  const st = await raw.loginStatus({ connectionId, loginRef });
  check("hardening-status-reports-the-same-nonce", st.status === "ready" && "completionNonce" in st && st.completionNonce === "live-winner-0001");
  // a second complete (any nonce) is refused and does not change whose nonce is on the attempt
  const second = await raw.loginComplete({ connectionId, loginRef, code: "AAAAAAAA#BBBBBBBB", completionNonce: "live-loser-0002" }).then(() => "no-error", (e) => `${(e as { code?: string }).code}/${(e as { detail?: string }).detail}`);
  check("hardening-second-complete-refused", second === "ESTATE/login_not_pending", second);
  // the loser: its own complete never reaches the host (lost), so it asks the status, sees another request's nonce and stands down WITHOUT cancelling
  const loser = makeSvc((c) => {
    c.loginComplete = async () => {
      throw new (await import("../../../services/funding/loginHostClient")).LoginHostError("UNREACHABLE");
    };
    return c;
  });
  const outcome = await codeOf(loser.completeLogin(user, started.loginId, "AAAAAAAA#BBBBBBBB"));
  check("hardening-loser-stands-down", outcome === "login_not_found", outcome);
  const st2 = await raw.loginStatus({ connectionId, loginRef });
  check("hardening-loser-did-not-cancel-the-winner", st2.status === "ready" && "completionNonce" in st2 && st2.completionNonce === "live-winner-0001");
  // a stray user cancel at yet another instance (onlyIfPending) leaves the ready login
  const other = makeSvc();
  await other.cancelLogin(user, started.loginId);
  const st3 = await raw.loginStatus({ connectionId, loginRef });
  check("hardening-stray-cancel-leaves-the-ready-login", st3.status === "ready", st3.status);
  await other.shutdown();
  await loser.shutdown();
  // the winner finishes: promote works, then the login is disconnected by hand (there is no backend record in this scenario)
  const promoted = await raw.loginPromote({ connectionId, loginRef, epoch: 1 });
  check("hardening-winner-promotes", promoted.state === "active" && promoted.epoch === 1, JSON.stringify(promoted));
  const revoked = await raw.connectionRevoke({ connectionId, epoch: 1 });
  check("hardening-revoked-by-hand", revoked.state === "revoked", JSON.stringify(revoked));
  await sleep(4_000);
  check("hardening-home-wiped", homesLeft() === BASE_HOMES, `homes=${homesLeft()} (base ${BASE_HOMES})`);
}

/** A ready login that is never promoted is discarded by the host after readyAttemptTtlMs and the connection is free again. One sign-in code. */
async function readyTtl() {
  const raw = new LoginHostClient(new UnixSocketTransport(SOCK));
  const connectionId = `zz-live-ttl-${randomBytes(4).toString("hex")}`;
  const started = await raw.loginStart({ connectionId, provider: "claude" });
  touchedHost.set(connectionId, started.loginRef);
  console.log(`\n[ready-ttl] Open this URL in a browser (do NOT paste it anywhere), sign in, and copy the code shown:\n${started.url}\n`);
  const code = await readHidden("Paste the code (hidden): ");
  const ready = await raw.loginComplete({ connectionId, loginRef: started.loginRef, code, completionNonce: "live-ttl-000001" });
  check("ttl-ready", ready.status === "ready");
  const busy = await raw.loginStart({ connectionId, provider: "claude", reconnect: true }).then(() => "no-error", (e) => `${(e as { code?: string }).code}/${(e as { detail?: string }).detail}`);
  check("ttl-start-is-busy-while-ready", /ESTATE/.test(busy), busy);
  const t0 = Date.now();
  let gone = false;
  while (Date.now() - t0 < 240_000) {
    const r = await raw.loginStatus({ connectionId, loginRef: started.loginRef }).then(() => "ready", (e) => (e as { code?: string }).code ?? "error");
    if (r === "ENOTFOUND") { gone = true; break; }
    await sleep(10_000);
  }
  const secs = Math.round((Date.now() - t0) / 1000);
  check("ttl-unpromoted-attempt-discarded", gone, `after ${secs}s`);
  const again = await raw.loginStart({ connectionId, provider: "claude" }).then((r) => r, () => undefined);
  check("ttl-connection-is-free-again", !!again, again ? "started" : "still busy");
  if (again) await raw.loginCancel({ connectionId, loginRef: again.loginRef }).catch(() => undefined);
  await sleep(4_000);
  check("ttl-home-wiped", homesLeft() === BASE_HOMES, `homes=${homesLeft()} (base ${BASE_HOMES})`);
}

async function main() {
  BASE_HOMES = homesLeft();
  if (HARDENING) return hardening();
  if (READY_TTL) return readyTtl();
  const BASE = homesLeft(); // homes already on the host (e.g. the kept test login): the checks below count relative to this
  if (!LLM_CONNECTIONS_TABLE.startsWith("Dev-")) throw new Error("refusing: not the Dev table");
  check("unsupported-provider", (await codeOf(svc.startLogin(user, "nope"))) === "unsupported_provider");
  check("unflagged-user-disabled", (await codeOf(svc.startLogin({ userId: "zz-someone-else" }, "claude"))) === "disabled");
  check("delegated-admin-refused", (await codeOf(svc.startLogin({ userId: OWNER, adminId: "zz-admin" }, "claude"))) === "forbidden");
  const cancelled = await svc.startLogin(user, "claude");
  await svc.cancelLogin(user, cancelled.loginId);
  check("start-then-cancel", svc.pendingCount() === 0 && (await codeOf(svc.completeLogin(user, cancelled.loginId, "AAAAAAAA#BBBBBBBB"))) === "login_not_found");

  const view = WITH_SWAP ? await signInSwap("sign-in (swap)") : await signIn("sign-in");
  touched.add(view.connectionId);
  const row = (await db.get(view.connectionId))!;
  check("sign-in-active", view.status === "active" && view.subscription?.plan !== undefined, `plan=${view.subscription?.plan}`);
  check("record-reference-only", row.subHosted === true && row.subHostEpoch === 1 && row.sealed === undefined && row.subVersion === undefined);
  check("slot-taken", (await counter()) === 1, `count=${await counter()}`);
  check("home-exists-on-host", homesLeft() === BASE + 1, `homes=${homesLeft()} (base ${BASE})`);

  let id = view.connectionId;
  if (WITH_RECONNECT) {
    const again = await signIn("reconnect", id);
    const r2 = (await db.get(id))!;
    check("reconnect-active-epoch-2", again.status === "active" && r2.subHostEpoch === 2 && r2.subNeedsReconnect === false, `epoch=${r2.subHostEpoch}`);
    check("reconnect-keeps-one-slot", (await counter()) === 1);
    // The host wipes the replaced home in its background sweep (every 60 s), not inside the promote: wait for it.
    const waitStart = Date.now();
    while (homesLeft() !== BASE + 1 && Date.now() - waitStart < 90_000) await sleep(5_000);
    check("old-home-wiped-after-reconnect", homesLeft() === BASE + 1, `homes=${homesLeft()} (base ${BASE}) after ${Math.round((Date.now() - waitStart) / 1000)}s`);
  }

  const outcome = await svc.revokeRecord(user, id);
  check("disconnect-revoked-only-after-host", outcome === "revoked", `outcome=${outcome}`);
  const after = (await db.get(id))!;
  check("record-revoked", after.status === "revoked" && !!after.revokedAt && after.subSlotReleased === true);
  check("slot-released", (await counter()) === 0, `count=${await counter()}`);
  await sleep(4_000);
  check("home-wiped", homesLeft() === BASE, `homes=${homesLeft()} (base ${BASE})`);
  check("disconnect-idempotent", (await svc.revokeRecord(user, id)) === "revoked" && (await counter()) === 0);
  const sweep = await svc.sweepOnce();
  check("sweep-finds-nothing-to-do", sweep.revoking === 0 && !sweep.hostUnavailable, JSON.stringify(sweep));
  id = "";
}

main()
  .catch((e) => check("runner", false, e instanceof HostedSubscriptionError ? e.code : String((e as { code?: string }).code ?? (e as Error).message).slice(0, 120)))
  .finally(async () => {
    // Whatever happened: disconnect anything this run created (so no login stays on the host), then delete our rows.
    // Attempts made by hand (--hardening / --ready-ttl): cancel the attempt, then disconnect the connection if one exists, so nothing is left on the host.
    for (const [connectionId, loginRef] of touchedHost) {
      const raw = new LoginHostClient(new UnixSocketTransport(SOCK));
      await raw.loginCancel({ connectionId, loginRef }).catch(() => undefined);
      const st = await raw.connectionStatus({ connectionId }).catch(() => undefined);
      if (st && st.state !== "revoked") await raw.connectionRevoke({ connectionId, epoch: st.epoch }).catch(() => undefined);
    }
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
    // Delete a row only once its disconnect is CONFIRMED: an unconfirmed row is the sweeper's only retry record for a login that may still be on the host.
    for (const id of touched) {
      const r = await db.get(id).catch(() => null);
      if (r && r.status !== "revoked") {
        console.log(`cleanup: ${id} is ${r.status}, NOT deleted (the sweeper still needs it; remove it by hand after the host confirms)`);
        continue;
      }
      await dc.delete({ TableName: LLM_CONNECTIONS_TABLE, Key: { connectionId: id } }).promise().catch(() => undefined);
    }
    await dc.delete({ TableName: LLM_CONNECTIONS_TABLE, Key: { connectionId: `limit#${OWNER}` } }).promise().catch(() => undefined);
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? "; FAILED: " + failed.map((f) => f.name).join(", ") : ""}`);
    process.exit(failed.length ? 1 : 0);
  });
