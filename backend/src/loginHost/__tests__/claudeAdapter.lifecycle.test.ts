/**
 * Randomized lifecycle test for the Claude session: random scripted CLI behaviour (normal, slow, hang,
 * dies early, never connects its MCP server) combined with random interrupt()/close() timing, including
 * calls before the process exists and during its start. Invariants, checked for every seed:
 *  L1 `closed` always resolves, and when it does the process is really gone (no orphan, ever)
 *  L2 the turn's event stream always ends, with at most one `result`, and a result is always last
 *  L3 close()/interrupt() never throw, and calling close() again is harmless
 *  L4 nothing the session did leaves a file in the credential home (only the test's own files)
 * Deterministic per seed; a failure prints the seed and the sequence. INVARIANT_SEEDS scales it.
 */
import { spawn } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import type { AdapterContext, ChildLike, ProviderEvent } from "../adapter";
import { ClaudeAdapter } from "../adapters/claudeAdapter";

const FAKE = join(__dirname, "fakeClaude.js");
const WRAPPER = join(__dirname, "..", "deploy", "claude-turn.sh");
const NODE_DIR = dirname(process.execPath);
const SEEDS = Number(process.env.INVARIANT_SEEDS ?? 40);

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Resolves with the promise's outcome, or `"timeout"`; the timer never outlives the call (no stray handles after the test). */
function within<T>(p: Promise<T>, ms: number): Promise<T | "timeout"> {
  let timer: NodeJS.Timeout;
  return Promise.race([p, new Promise<"timeout">((r) => (timer = setTimeout(() => r("timeout"), ms)))]).finally(() => clearTimeout(timer));
}
const gone = (pid: number) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
};

const SCENARIOS: Array<[string, Record<string, unknown>]> = [
  ["normal", {}],
  ["slow", { turn: [{ wait: 150 }, { type: "result", subtype: "success", is_error: false, result: "late" }] }],
  ["hang", { turn: [{ hang: true }] }],
  ["dies", { turn: [{ type: "assistant", message: { content: [{ type: "text", text: "p" }] } }, { exit: 1 }] }],
  ["mcp-down", { mcpStatus: "failed" }],
];

async function runSeed(seed: number): Promise<void> {
  const rand = rng(seed);
  const root = mkdtempSync(join(tmpdir(), "claude-lifecycle-"));
  const trace: string[] = [];
  const fail = (m: string) => {
    throw new Error(`seed ${seed}: ${m}\n  trace: ${trace.join(" | ")}`);
  };
  try {
    const dirs = ["home", "work", "tmp", "unit"].map((d) => join(root, d));
    dirs.forEach((d) => mkdirSync(d));
    const [homeDir, workDir, tmpDir, unitTmp] = dirs;
    const [name, scenario] = SCENARIOS[Math.floor(rand() * SCENARIOS.length)];
    writeFileSync(join(homeDir, ".fake-scenario"), JSON.stringify(scenario));
    trace.push(`scenario=${name}`);
    const ctx: AdapterContext = {
      connectionId: "c",
      uid: 400_001,
      homeDir,
      workDir,
      tmpDir,
      spawnAs: (spec) => {
        const c = spawn(spec.file, spec.args, { env: spec.env, cwd: spec.cwd, stdio: ["pipe", "pipe", "pipe"] });
        return { stdin: c.stdin, stdout: c.stdout, stderr: c.stderr, kill: () => void c.kill("SIGKILL"), onExit: (cb) => void c.on("exit", (code, sig) => cb(code, sig)), onError: (cb) => void c.on("error", cb) } as ChildLike;
      },
    };
    const adapter = new ClaudeAdapter({ binary: { path: FAKE, version: "x", digest: "x" }, systemPromptFile: "/p", turnWrapperPath: WRAPPER, bridgeUrl: "http://127.0.0.1:1/mcp", basePath: `${NODE_DIR}:/usr/bin:/bin`, unitTmp, killWaitMs: 1500 });
    const session = await adapter.openSession(ctx, { connectionId: "c", epoch: 1 });

    const events: ProviderEvent[] = [];
    const turnDone = (async () => {
      for await (const ev of session.turn({ turnId: "t", prompt: "go", model: "sonnet", bridgeToken: "TOK-0123456789abcdef" })) events.push(ev);
    })().catch((e) => fail(`turn threw: ${(e as Error).message}`));

    // random interrupt / close timing, including "before the process exists"
    const actions: Array<Promise<void>> = [];
    const plan = Math.floor(rand() * 5); // 0 none, 1 interrupt, 2 close, 3 interrupt+close, 4 close twice
    const at = () => Math.floor(rand() * 220);
    const act = (label: string, ms: number, fn: () => Promise<void>) => {
      trace.push(`${label}@${ms}`);
      actions.push(
        sleep(ms)
          .then(fn)
          .catch((e) => fail(`${label} threw: ${(e as Error).message}`)),
      );
    };
    if (plan === 1 || plan === 3) act("interrupt", at(), () => session.interrupt("t"));
    if (plan === 2 || plan === 3 || plan === 4) act("close", at(), () => session.close());
    if (plan === 4) act("close2", at(), () => session.close());
    // a scenario that never ends on its own must be ended by the harness, like the host's deadline would
    if (name === "hang" || name === "slow") act("deadline-close", 600, () => session.close());

    if ((await within(session.closed, 8000)) === "timeout") fail("L1: `closed` did not resolve in 8s");
    if ((await within(turnDone, 3000)) === "timeout") fail("L2: the turn's event stream did not end within 3s of the session closing");
    await Promise.all(actions);
    if (plan === 0 && (name === "normal" || name === "slow") && !events.some((e) => e.type === "result")) fail("L5: an uninterrupted normal run produced no result");

    const turnRec = join(homeDir, ".fake-last-turn.json");
    if (existsSync(turnRec)) {
      const pid = (JSON.parse(readFileSync(turnRec, "utf8")) as { pid: number }).pid;
      if (!gone(pid)) fail(`L1: process ${pid} still alive after closed`);
    }
    const results = events.filter((e) => e.type === "result");
    if (results.length > 1) fail("L2: more than one result");
    if (results.length === 1 && events[events.length - 1].type !== "result") fail("L2: result is not last");
    trace.push(`events=${events.map((e) => e.type).join(",")}`);
    await session.close();
    const stray = readdirSync(homeDir).filter((n) => !n.startsWith(".fake"));
    if (stray.length) fail(`L4: files left in the credential home: ${stray.join(",")}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("claude session lifecycle under random interrupt/close/exit", () => {
  it.each(Array.from({ length: SEEDS }, (_, i) => i + 1))("seed %d", async (seed) => {
    await runSeed(seed);
  }, 30_000);
});
