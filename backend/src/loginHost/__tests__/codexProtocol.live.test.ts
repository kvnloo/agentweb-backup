/**
 * ENG-2110 PR 1a: the protocol facts the Codex adapter will rely on, checked against the REAL
 * `codex app-server` with no login. Skipped unless CODEX_BIN points at a Codex binary:
 *
 *   CODEX_BIN=/path/to/codex npm test -- --runTestsByPath src/loginHost/__tests__/codexProtocol.live.test.ts
 *
 * It starts a device-code sign-in (a code request to OpenAI's auth service) and cancels it at
 * once, lists models, opens an ephemeral thread and sends one turn that the unauthenticated
 * model backend refuses. It runs in a throwaway CODEX_HOME with a scrubbed environment and never
 * calls the browser sign-in (fixed port 1455). Nothing it prints contains the code or the URL.
 * Facts recorded in the brain: evidence/experiments/2026-10-16-codex-appserver-unauthenticated-probe.md
 */
import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const bin = process.env.CODEX_BIN;
const describeOrSkip = bin ? describe : describe.skip;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only: dynamic JSON-RPC payloads from the real binary
type Json = any;
type Msg = { id?: number; method?: string; params?: Json; result?: Json; error?: { message?: string } };

class RpcClient {
  private buf = "";
  private id = 0;
  private waiting = new Map<number, (m: Msg) => void>();
  notes: Msg[] = [];
  constructor(private child: ChildProcessWithoutNullStreams) {
    child.stdout.on("data", (d: Buffer) => {
      this.buf += d.toString("utf8");
      let i: number;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        if (!line.trim()) continue;
        const m = JSON.parse(line) as Msg;
        if (m.id !== undefined && (m.result !== undefined || m.error !== undefined) && this.waiting.has(m.id)) {
          this.waiting.get(m.id)!(m);
          this.waiting.delete(m.id);
        } else this.notes.push(m);
      }
    });
    child.stderr.on("data", () => undefined);
  }
  call(method: string, params: unknown, ms = 20_000): Promise<Msg> {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      const t = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`timeout: ${method}`));
      }, ms);
      this.waiting.set(id, (m) => {
        clearTimeout(t);
        resolve(m);
      });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }
  notify(method: string, params: unknown): void {
    this.child.stdin.write(JSON.stringify({ method, params }) + "\n");
  }
  async until(pred: (m: Msg) => boolean, ms: number): Promise<Msg | undefined> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const hit = this.notes.find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 100));
    }
    return undefined;
  }
}

describeOrSkip("Codex app-server protocol (real binary, unauthenticated)", () => {
  let root: string;
  let child: ChildProcessWithoutNullStreams;
  let rpc: RpcClient;

  async function start(experimentalApi: boolean): Promise<void> {
    root = mkdtempSync(join(tmpdir(), "codex-conf-"));
    mkdirSync(join(root, "chome"), { mode: 0o700 });
    mkdirSync(join(root, "home"), { mode: 0o700 });
    child = spawn(bin!, ["app-server"], { cwd: root, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: join(root, "home"), CODEX_HOME: join(root, "chome") }, stdio: ["pipe", "pipe", "pipe"] });
    rpc = new RpcClient(child);
    const init = await rpc.call("initialize", { clientInfo: { name: "agentweb-conformance", title: "AgentWeb conformance", version: "0.0.1" }, capabilities: experimentalApi ? { experimentalApi: true } : {} });
    expect(init.result.codexHome).toContain("chome");
    rpc.notify("initialized", {});
  }
  afterEach(async () => {
    child?.stdin.end();
    await new Promise((r) => setTimeout(r, 300));
    child?.kill();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("reports not signed in without reading any credential: account/read -> account null", async () => {
    await start(false);
    const r = await rpc.call("account/read", { refreshToken: false });
    expect(r.result.account).toBeNull();
    expect(typeof r.result.requiresOpenaiAuth).toBe("boolean");
  }, 40_000);

  it("lists models without a login", async () => {
    await start(false);
    const r = await rpc.call("model/list", {});
    expect(Array.isArray(r.result.data)).toBe(true);
    expect(r.result.data.length).toBeGreaterThan(0);
    expect(typeof r.result.data[0].model).toBe("string");
  }, 40_000);

  it("device-code sign-in returns a URL and a user code, and can be cancelled", async () => {
    await start(false);
    const r = await rpc.call("account/login/start", { type: "chatgptDeviceCode" });
    expect(r.error).toBeUndefined();
    expect(r.result.verificationUrl).toMatch(/^https:\/\//);
    expect(typeof r.result.userCode).toBe("string");
    expect(typeof r.result.loginId).toBe("string");
    const c = await rpc.call("account/login/cancel", { loginId: r.result.loginId });
    expect(typeof c.result.status).toBe("string");
    expect(await rpc.until((m) => m.method === "account/login/completed", 5_000)).toBeDefined();
  }, 60_000);

  it("dynamicTools need the experimentalApi capability at initialize", async () => {
    await start(false);
    const r = await rpc.call("thread/start", { ephemeral: true, baseInstructions: "x", dynamicTools: [{ name: "echo", description: "e", inputSchema: { type: "object", properties: {} } }] });
    expect(r.error?.message).toMatch(/experimentalApi/);
  }, 40_000);

  it("an unauthenticated turn is accepted, then fails as a retried stream error: why preflight must use account/read", async () => {
    await start(true);
    const th = await rpc.call("thread/start", { ephemeral: true, baseInstructions: "x", dynamicTools: [{ name: "echo", description: "e", inputSchema: { type: "object", properties: {} } }] });
    const threadId = th.result.thread.id as string;
    expect(th.result.thread.ephemeral).toBe(true);
    const t = await rpc.call("turn/start", { threadId, input: [{ type: "text", text: "say hi" }] }, 30_000);
    expect(typeof t.result.turn.id).toBe("string"); // accepted before any auth failure is known
    const err = await rpc.until((m) => m.method === "error", 40_000);
    expect(err?.params.error.codexErrorInfo).toBeDefined();
    expect(typeof err?.params.willRetry).toBe("boolean");
    expect(await rpc.until((m) => m.method === "turn/completed", 60_000)).toBeDefined();
    // the cheap, correct check exists and says "not signed in"
    expect((await rpc.call("account/read", { refreshToken: false })).result.account).toBeNull();
    // no approval or tool request was issued, because no model turn ran
    expect(rpc.notes.filter((m) => m.id !== undefined && m.method)).toEqual([]);
  }, 180_000);
});
