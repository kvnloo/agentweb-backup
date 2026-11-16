/**
 * ENG-2110 PR 1b-i: the runner's hosting seams (process, scratch, binary, env, stdin MCP delivery).
 * Real `child_process` and `fs` are NOT mocked here: a seam that did not take effect would try to run
 * a real binary or write a real file, and fail loudly.
 */
import { EventEmitter } from "events";
import { PassThrough, Readable } from "stream";
import { existsSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { ClaudeCliRunner, type ClaudeCliSpawnSpec, type RunnerChild } from "../claudeCliRunner";

class FakeChild extends EventEmitter implements RunnerChild {
  stdin = new PassThrough();
  stdout = new Readable({ read() {} });
  stderr = new Readable({ read() {} });
  exitCode: number | null = null;
  signalCode: string | null = null;
  written: string[] = [];
  killed = 0;
  constructor() {
    super();
    this.stdin.on("data", (b: Buffer) => this.written.push(b.toString("utf8")));
  }
  kill(): boolean {
    this.killed++;
    this.signalCode = "SIGKILL";
    this.emit("exit", null, "SIGKILL");
    return true;
  }
  result(text = "OK"): void {
    this.stdout.push(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: text }) + "\n");
  }
}
const flush = () => new Promise<void>((r) => setImmediate(r));

describe("ClaudeCliRunner ports", () => {
  const runners: ClaudeCliRunner[] = [];
  afterEach(() => runners.forEach((r) => r.closeAll()));
  function make(extra: Partial<NonNullable<ConstructorParameters<typeof ClaudeCliRunner>[0]>["ports"]> = {}) {
    const children: FakeChild[] = [];
    const specs: ClaudeCliSpawnSpec[] = [];
    const scratch = { created: [] as string[], removed: [] as string[] };
    const runner = new ClaudeCliRunner({
      ports: {
        spawnProcess: (spec) => {
          specs.push(spec);
          const c = new FakeChild();
          children.push(c);
          return c;
        },
        scratch: { create: () => (scratch.created.push("/tmp/aw-home"), "/tmp/aw-home"), remove: (d) => void scratch.removed.push(d) },
        binaryPath: "/opt/aw-claude/2.1.294/claude",
        buildEnv: (configDir, home) => ({ PATH: "/usr/bin", HOME: home, CLAUDE_CONFIG_DIR: configDir, TMPDIR: "/tmp" }),
        ...extra,
      },
    });
    runners.push(runner);
    return { runner, children, specs, scratch };
  }

  it("starts the CLI through the supplied process port with the supplied binary, env, cwd and scratch HOME", async () => {
    const { runner, children, specs, scratch } = make();
    await runner.spawn("c1/t1", "/home/cfg", "/opt/aw/prompt.txt", { cwd: "/work" });
    expect(specs).toHaveLength(1);
    expect(specs[0].file).toBe("/opt/aw-claude/2.1.294/claude");
    expect(specs[0].cwd).toBe("/work");
    expect(specs[0].env).toEqual({ PATH: "/usr/bin", HOME: "/tmp/aw-home", CLAUDE_CONFIG_DIR: "/home/cfg", TMPDIR: "/tmp" });
    expect(specs[0].args).toEqual(expect.arrayContaining(["--no-session-persistence", "--include-hook-events", "--strict-mcp-config"]));
    expect(scratch.created).toEqual(["/tmp/aw-home"]);
    const turn = runner.send({ conversationId: "c1/t1" }, "hello");
    await flush();
    children[0].result("hi");
    await expect(turn).resolves.toMatchObject({ isError: false, resultText: "hi" });
    runner.close({ conversationId: "c1/t1" });
    expect(scratch.removed).toContain("/tmp/aw-home"); // removed through the port, not rmSync
    expect(children[0].killed).toBeGreaterThan(0);
  });

  it("delivers the MCP config as the FIRST stdin line and never in argv, env or a file", async () => {
    const { runner, children, specs } = make();
    const before = new Set(existsSync(tmpdir()) ? readdirSync(tmpdir()) : []);
    await runner.spawn("c1/t2", "/home/cfg", "/opt/aw/prompt.txt", {
      cwd: "/work",
      mcpServer: { name: "emma", url: "https://bridge.test/mcp", bearerToken: "SECRET-TOKEN-0123456789" },
      mcpDelivery: { via: "stdin", path: "/tmp/aw-mcp.json" },
    });
    const turn = runner.send({ conversationId: "c1/t2" }, "go");
    await flush();
    children[0].result();
    await turn;
    const lines = children[0].written.join("").split("\n").filter(Boolean);
    expect(JSON.parse(lines[0])).toEqual({ mcpServers: { emma: { type: "http", url: "https://bridge.test/mcp", headers: { Authorization: "Bearer SECRET-TOKEN-0123456789" } } } });
    expect(lines[1]).toContain("go"); // the conversation starts after the config line
    const idx = specs[0].args.indexOf("--mcp-config");
    expect(specs[0].args[idx + 1]).toBe("/tmp/aw-mcp.json");
    expect(JSON.stringify(specs[0].args)).not.toContain("SECRET-TOKEN");
    expect(JSON.stringify(specs[0].env)).not.toContain("SECRET-TOKEN");
    const after = readdirSync(tmpdir()).filter((n) => !before.has(n));
    expect(after.filter((n) => n.startsWith("claude-cli"))).toEqual([]); // nothing was written locally
  });

  it("a custom spawn port without a cwd is refused (there is no local default directory to fall back to), and its scratch is cleaned", async () => {
    const { runner, specs, scratch } = make();
    await expect(runner.spawn("c1/t3", "/home/cfg", "/opt/aw/prompt.txt", {})).rejects.toThrow(/needs opts.cwd/);
    expect(specs).toHaveLength(0);
    expect(scratch.removed).toEqual(["/tmp/aw-home"]);
  });

  it("a spawn that throws cleans its scratch dir and frees the slot", async () => {
    const { runner, scratch } = make({
      spawnProcess: () => {
        throw new Error("no such unit");
      },
    });
    await expect(runner.spawn("c1/t4", "/home/cfg", "/opt/aw/prompt.txt", { cwd: "/work" })).rejects.toThrow("no such unit");
    expect(scratch.removed).toEqual(["/tmp/aw-home"]);
    expect(runner.activeProcessCount).toBe(0);
  });

  it("the default delivery still writes mcp.json and defaults are unchanged without ports", () => {
    // (covered end to end by claudeCliRunner.test.ts; here only that constructing without ports is valid)
    expect(() => new ClaudeCliRunner()).not.toThrow();
  });
});
