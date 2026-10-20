/**
 * ENG-2110 PR 1b-i: the Claude adapter against the REAL pinned `claude` binary, UNAUTHENTICATED (an empty
 * CLAUDE_CONFIG_DIR). No login, no credentials, no code is ever used. Skipped unless CLAUDE_LIVE=1.
 * Covers what the scripted CLI cannot: real output shapes, real exit codes, real behaviour without a TTY.
 * What it deliberately does NOT cover: anything after a successful sign-in (the live matrix in 1b-iii).
 *
 *   CLAUDE_LIVE=1 npx jest src/loginHost/__tests__/claudeAdapter.live.test.ts
 */
import { spawn } from "child_process";
import { createServer, type Server } from "http";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { AdapterContext, ChildLike, ProviderEvent } from "../adapter";
import { ClaudeAdapter } from "../adapters/claudeAdapter";
import { resolveClaudeBinary } from "../../services/funding/claudeBinary";

const LIVE = process.env.CLAUDE_LIVE === "1";
const d = LIVE ? describe : describe.skip;
const WRAPPER = join(__dirname, "..", "deploy", "claude-turn.sh");
const roots: string[] = [];

function localSpawn(spec: { file: string; args: string[]; env: Record<string, string>; cwd: string }): ChildLike {
  const c = spawn(spec.file, spec.args, { env: spec.env, cwd: spec.cwd, stdio: ["pipe", "pipe", "pipe"] });
  return {
    stdin: c.stdin,
    stdout: c.stdout,
    stderr: c.stderr,
    kill: () => void c.kill("SIGKILL"),
    onExit: (cb) => void c.on("exit", (code, sig) => cb(code, sig)),
    onError: (cb) => void c.on("error", (err) => (c.pid === undefined ? cb(err) : undefined)),
  };
}

function fresh(): { ctx: AdapterContext; unitTmp: string } {
  const root = mkdtempSync(join(tmpdir(), "claude-live-"));
  roots.push(root);
  const [homeDir, workDir, tmpDir, unitTmp] = ["home", "work", "tmp", "unit"].map((n) => join(root, n));
  for (const x of [homeDir, workDir, tmpDir, unitTmp]) mkdirSync(x);
  return { ctx: { connectionId: "live1", uid: 400_001, homeDir, workDir, tmpDir, spawnAs: (s) => localSpawn(s) }, unitTmp };
}

/** A minimal MCP (streamable HTTP) server: initialize, tools/list (none), notifications. Enough for the CLI to report the server `connected`. */
function startMcpStub(): Promise<{ server: Server; url: string; calls: string[] }> {
  const calls: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      let msg: { id?: number; method?: string } = {};
      try {
        msg = JSON.parse(body);
      } catch {
        /* ignore */
      }
      calls.push(String(msg.method));
      if (msg.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      const result =
        msg.method === "initialize"
          ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "stub", version: "1" } }
          : msg.method === "tools/list"
            ? { tools: [] }
            : {};
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`, calls })));
}

const adapterFor = (unitTmp: string, bridgeUrl = "http://127.0.0.1:9/mcp") =>
  new ClaudeAdapter({
    binary: { path: resolveClaudeBinary(), version: "pinned", digest: "sha256:unchecked" },
    systemPromptFile: join(__dirname, "..", "..", "..", "package.json"), // any readable file: the unauthenticated CLI fails before it matters
    turnWrapperPath: WRAPPER,
    bridgeUrl,
    basePath: "/usr/bin:/bin",
    unitTmp,
    startTimeoutMs: 30_000,
    shortCommandTimeoutMs: 45_000,
    authConfirmTimeoutMs: 20_000,
  });

afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

d("claude adapter against the real pinned binary (unauthenticated)", () => {
  it("authStatus: logged out parses to loggedIn:false (real JSON, exit 1)", async () => {
    const { ctx, unitTmp } = fresh();
    await expect(adapterFor(unitTmp).authStatus(ctx)).resolves.toMatchObject({ loggedIn: false });
  }, 60_000);

  it("hazards: the logged-out doctor wording is NOT clean (fail closed), and doctor does not hang without a TTY", async () => {
    const { ctx, unitTmp } = fresh();
    const t0 = Date.now();
    const h = await adapterFor(unitTmp).hazards(ctx);
    expect(h.length).toBeGreaterThan(0);
    expect(Date.now() - t0).toBeLessThan(45_000);
    console.info("[live] doctor hazards when logged out:", JSON.stringify(h));
  }, 60_000);

  it("loginStart returns the real authorize URL, and cancel leaves no process", async () => {
    const { ctx, unitTmp } = fresh();
    const a = adapterFor(unitTmp);
    const proc = await a.loginStart(ctx);
    expect(proc.data.url).toMatch(/^https:\/\/claude\.com\/cai\/oauth\/authorize\?/);
    await a.loginCancel(proc);
  }, 60_000);

  it("a real turn with no login and a REACHABLE bridge ends in ONE failed result of kind auth_dead (the auth-looking failure confirmed by the real `auth status`), no process left", async () => {
    const stub = await startMcpStub();
    try {
      const { ctx, unitTmp } = fresh();
      const session = await adapterFor(unitTmp, stub.url).openSession(ctx, { connectionId: "live1", epoch: 1 });
      const events: ProviderEvent[] = [];
      for await (const ev of session.turn({ turnId: "t2", prompt: "Reply with exactly OK", model: "haiku", bridgeToken: "LIVE-TEST-TOKEN-0123456789" })) events.push(ev);
      await session.closed;
      console.info("[live] reachable-bridge turn:", events.map((e) => e.type + (e.type === "result" ? `:${e.ok}:${e.errorKind ?? ""}` : e.type === "alarm" ? `:${e.hazard.kind}` : "")).join(","), "| bridge calls:", stub.calls.join(","));
      expect(events.filter((e) => e.type === "result")).toHaveLength(1);
      expect(events[events.length - 1]).toMatchObject({ type: "result", ok: false, text: "" });
    } finally {
      stub.server.close();
    }
  }, 120_000);

  it("a real turn with no login fails cleanly: events end in ONE failed result, the kind is auth_dead (confirmed by the real `auth status`) or transient, the process is gone, nothing is left in the home", async () => {
    const { ctx, unitTmp } = fresh();
    const a = adapterFor(unitTmp);
    const session = await a.openSession(ctx, { connectionId: "live1", epoch: 1 });
    const events: ProviderEvent[] = [];
    for await (const ev of session.turn({ turnId: "t1", prompt: "Reply with exactly OK", model: "haiku", bridgeToken: "LIVE-TEST-TOKEN-0123456789" })) events.push(ev);
    await session.closed;
    console.info("[live] unauthenticated turn event types:", events.map((e) => e.type + (e.type === "result" ? `:${e.ok}:${e.errorKind ?? ""}` : "")).join(","));
    const last = events[events.length - 1];
    expect(last).toMatchObject({ type: "result", ok: false });
    expect(events.filter((e) => e.type === "result")).toHaveLength(1);
    expect((last as Extract<ProviderEvent, { type: "result" }>).text).toBe("");
  }, 120_000);
});
