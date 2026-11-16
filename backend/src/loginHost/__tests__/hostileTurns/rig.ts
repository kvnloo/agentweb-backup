import { spawn } from "child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import type { AdapterContext, ChildLike, ProviderEvent, SpawnSpec } from "../../adapter";
import { ClaudeAdapter } from "../../adapters/claudeAdapter";
import { Layout } from "../../ports/layout";
import { RelayHost } from "../../relay/relayServer";
import type { ToolDef } from "../../protocol";

export const HOSTILE = join(__dirname, "hostileClaude.js");
export const WRAPPER = join(__dirname, "..", "..", "deploy", "claude-turn.sh");
export const SHIM = join(__dirname, "..", "..", "deploy", "aw-relay-shim.js");
const NODE_DIR = dirname(process.execPath);
export const roots: string[] = [];
export const TOOLS: ToolDef[] = [
  { name: "search", description: "Search", inputSchema: { type: "object", properties: { q: { type: "string" } } } },
  { name: "write_note", description: "Write a note", inputSchema: { type: "object", properties: {} } },
];

export interface Rig {
  adapter: ClaudeAdapter;
  ctx: AdapterContext;
  host: RelayHost;
  layout: Layout;
  relayRoot: string;
  homeDir: string;
  unitTmp: string;
  logs: Array<{ event: string; fields?: Record<string, unknown> }>;
  spawns: SpawnSpec[];
  pids: number[];
  killCalls: number;
  script(js: string): void;
}

export function makeRig(over: { messageIdWaitMs?: number; killWaitMs?: number; maxQueuedBytes?: number; plainKill?: boolean } = {}): Rig {
  const root = mkdtempSync(join(tmpdir(), "rvh13-"));
  roots.push(root);
  const homeDir = join(root, "home");
  const workDir = join(root, "work");
  const tmpDir = join(root, "tmp");
  const unitTmp = join(root, "unit-tmp");
  for (const d of [homeDir, workDir, tmpDir, unitTmp]) mkdirSync(d, { recursive: true });
  const relayRoot = join(root, "relay");
  const layout = new Layout({ env: "t1", stateRoot: "/var/lib/aw-login-host/t1", sharedParent: "/var/lib/aw-login-host", uidMin: 400_000, uidMax: 400_100, relayRoot });
  const logs: Rig["logs"] = [];
  const host = new RelayHost({ layout, ownByUid: false, log: { warn: (event, fields) => void logs.push({ event, fields }) } });
  host.init();
  const spawns: SpawnSpec[] = [];
  const pids: number[] = [];
  const rig: Partial<Rig> = { killCalls: 0 };
  const spawnAs = (spec: SpawnSpec): ChildLike => {
    spawns.push(spec);
    const env = { ...spec.env, ...(spec.relayDir ? { AW_FAKE_RELAY_MOUNT: spec.relayDir } : {}) };
    const c = spawn(spec.file, spec.args, { env, cwd: spec.cwd, stdio: ["pipe", "pipe", "pipe"] });
    if (c.pid) pids.push(c.pid);
    return {
      stdin: c.stdin,
      stdout: c.stdout,
      stderr: c.stderr,
      // production: `systemctl stop` = SIGTERM then a 10 s grace. The hostile CLI ignores SIGTERM, so the test kills it for real 1.5 s later (a stand-in for the grace).
      kill: () => {
        rig.killCalls!++;
        if (over.plainKill) {
          setTimeout(() => void c.kill("SIGKILL"), 1500).unref();
          c.kill("SIGTERM");
        } else void c.kill("SIGKILL");
      },
      onExit: (cb) => void c.on("exit", (code, sig) => cb(code, sig)),
      onError: (cb) => void c.on("error", (err) => (c.pid === undefined ? cb(err) : undefined)),
    };
  };
  const ctx: AdapterContext = { connectionId: "conn1", uid: 400_001, homeDir, workDir, tmpDir, spawnAs };
  const adapter = new ClaudeAdapter({
    binary: { path: HOSTILE, version: "2.1.294", digest: "sha256:fake" },
    systemPromptFile: "/opt/aw/prompt.txt",
    turnWrapperPath: WRAPPER,
    bridgeUrl: "http://127.0.0.1:3001/x",
    basePath: `${NODE_DIR}:/usr/bin:/bin`,
    unitTmp,
    killWaitMs: over.killWaitMs ?? 4000,
    relay: { host, shimPath: SHIM, nodePath: process.execPath },
    ...(over.messageIdWaitMs !== undefined ? { messageIdWaitMs: over.messageIdWaitMs } : {}),
    ...(over.maxQueuedBytes !== undefined ? { maxQueuedBytes: over.maxQueuedBytes } : {}),
    log: { warn: (event, fields) => void logs.push({ event, fields: fields as Record<string, unknown> }) },
  });
  Object.assign(rig, { adapter, ctx, host, layout, relayRoot, homeDir, unitTmp, logs, spawns, pids, script: (js: string) => writeFileSync(join(homeDir, ".hostile.js"), js) });
  return rig as Rig;
}

export async function drainTurn(rig: Rig, opts: { tools?: ToolDef[]; maxMs?: number; onEvent?: (e: ProviderEvent) => void; answer?: boolean } = {}): Promise<ProviderEvent[]> {
  const session = await rig.adapter.openSession(rig.ctx, { connectionId: "conn1", epoch: 1 });
  const events: ProviderEvent[] = [];
  const timer = setTimeout(() => void session.close(), opts.maxMs ?? 20_000);
  try {
    for await (const ev of session.turn({ turnId: "t" + Math.floor(Math.random() * 1e9), prompt: "go", model: "sonnet", relay: { tools: opts.tools ?? TOOLS, callTimeoutMs: () => 20_000 } })) {
      events.push(ev);
      opts.onEvent?.(ev);
      if (ev.type === "tool-call" && opts.answer !== false) session.answer(ev.operationId, { kind: "tool-result", ok: true, content: "ok" });
    }
  } finally {
    clearTimeout(timer);
    await session.close();
  }
  return events;
}

export function relayDirs(rig: Rig): string[] {
  try {
    return readdirSync(rig.relayRoot).flatMap((u) => readdirSync(join(rig.relayRoot, u)).map((d) => `${u}/${d}`));
  } catch {
    return [];
  }
}
export const cleanup = () => roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true }));
