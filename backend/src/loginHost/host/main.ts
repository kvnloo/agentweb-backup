/**
 * ENG-2110 PR 1b-ii part 2: the login host's start-up and shutdown. `buildHost`/`startHost` take every operating
 * system seam as a parameter (so the whole host is tested against an in-memory system); `runMain` is the thin
 * root-only entry that reads the real config and the real machine.
 *
 * Start-up order matters: (1) everything this environment ran before is stopped (customer units are separate
 * transient units: they outlive a host crash), (2) the single-writer state lock is taken, (3) the core recovers (kills every
 * allocated uid, parks swaps that were interrupted), (4) only then the socket is created.
 */
import { randomBytes } from "crypto";
import { chmodSync, chownSync, existsSync, mkdirSync, readFileSync } from "fs";
import { ClaudeAdapter } from "../adapters/claudeAdapter";
import type { SubscriptionProviderAdapter } from "../adapter";
import { ConnectionManager, DEFAULT_CONFIG, type ManagerConfig } from "../connectionManager";
import type { IdGen, Logger } from "../ports";
import { systemClock } from "../ports";
import { Layout } from "../ports/layout";
import { nodeCommandPort, nodeRootFs, type CommandPort, type RootFs } from "../ports/system";
import { SystemdUserFs, type SystemdPortConfig } from "../ports/systemdUserFs";
import { startHostServer, type HostServerHandle } from "../server";
import { StateStore } from "../stateStore";
import { assertTrustedPath, verifyBinary, type VerifiedBinary } from "./binary";
import { assertNoSubuidOverlap, HostConfigError, parseHostConfig, type HostConfig } from "./hostConfig";
import { registerRange } from "./ranges";
import { assertHomesMount, assertRoot, parseMounts } from "./startupChecks";

export interface HostDeps {
  cmd: CommandPort;
  root: RootFs;
  log: Logger;
  ids?: IdGen;
  /** Tests: where the state file lives (production: `<stateRoot>/state`). */
  stateDir?: string;
  /** Tests: adapters instead of the verified Claude adapter. */
  adapters?: ReadonlyMap<string, SubscriptionProviderAdapter>;
  /** Tests run unprivileged: socket ownership/mode changes are skipped. */
  chownSocket?: boolean;
  managerOverrides?: Partial<ManagerConfig>;
}

export const realIds: IdGen = { next: (prefix) => `${prefix}-${randomBytes(12).toString("hex")}` };

/** Structured, secret-free log lines on stdout (callers pass codes and ids only). */
export function jsonLogger(write: (line: string) => void = (l) => process.stdout.write(l + "\n")): Logger {
  const emit = (level: string, event: string, fields?: Record<string, string | number | boolean>) => write(JSON.stringify({ ts: new Date().toISOString(), level, event, ...(fields ?? {}) }));
  return { info: (e, f) => emit("info", e, f), warn: (e, f) => emit("warn", e, f) };
}

export function layoutFor(cfg: HostConfig): Layout {
  return new Layout({ env: cfg.env, stateRoot: cfg.stateRoot, sharedParent: cfg.sharedParent, uidMin: cfg.uidMin, uidMax: cfg.uidMax });
}

export function portConfigFor(cfg: HostConfig): SystemdPortConfig {
  return {
    limits: cfg.limits,
    paths: { ...cfg.tools, inaccessible: [cfg.socket.dir] },
    killTimeoutMs: 15_000,
    killPollMs: 100,
    commandTimeoutMs: 30_000,
    ...(cfg.quota ? { quota: cfg.quota } : {}),
  };
}

export interface BuiltHost {
  layout: Layout;
  port: SystemdUserFs;
  store: StateStore;
  manager: ConnectionManager;
}

export function buildHost(cfg: HostConfig, binary: VerifiedBinary, deps: HostDeps): BuiltHost {
  const layout = layoutFor(cfg);
  const port = new SystemdUserFs({ layout, cmd: deps.cmd, root: deps.root, config: portConfigFor(cfg) });
  const store = new StateStore(deps.stateDir ?? `${cfg.stateRoot}/state`);
  const adapters =
    deps.adapters ??
    new Map<string, SubscriptionProviderAdapter>([
      [
        "claude",
        new ClaudeAdapter({
          binary,
          systemPromptFile: cfg.claude.systemPromptFile,
          turnWrapperPath: cfg.claude.turnWrapperPath,
          bridgeUrl: cfg.claude.bridgeUrl,
          ...(cfg.claude.models ? { models: cfg.claude.models } : {}),
          ...(cfg.claude.basePath ? { basePath: cfg.claude.basePath } : {}),
        }),
      ],
    ]);
  const manager = new ConnectionManager({
    store,
    clock: systemClock,
    fs: port,
    ids: deps.ids ?? realIds,
    adapters,
    log: deps.log,
    config: { ...DEFAULT_CONFIG, ...cfg.manager, uidMin: cfg.uidMin, uidMax: cfg.uidMax, ...(deps.managerOverrides ?? {}) },
  });
  return { layout, port, store, manager };
}

/**
 * Stops every unit of this environment and waits until none (and no queued start job) is left. Customer units are
 * separate transient units, so they survive a crash of the host: this runs before the host serves anything.
 */
export async function stopEnvironment(cmd: CommandPort, cfg: HostConfig, layout: Layout, budgetMs = 30_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    await cmd.run(cfg.tools.systemctl, ["stop", layout.envSliceName], { timeoutMs: 30_000 });
    const units = await cmd.run(cfg.tools.systemctl, ["list-units", "--all", "--no-legend", "--plain", layout.envUnitPattern], { timeoutMs: 30_000 });
    const jobs = await cmd.run(cfg.tools.systemctl, ["list-jobs", "--no-legend", "--plain"], { timeoutMs: 30_000 });
    if (units.timedOut || units.code !== 0 || jobs.timedOut || jobs.code !== 0) throw new HostConfigError("could not list this environment's units");
    const alive = units.stdout.split("\n").filter((l) => {
      const t = l.trim().split(/\s+/);
      if (t[0] === "●" || t[0] === "*") t.shift();
      return !!t[0] && layout.isEnvUnit(t[0]) && ["active", "activating", "deactivating", "reloading", "refreshing"].includes(t[2] ?? "");
    });
    const queued = jobs.stdout.split("\n").filter((l) => {
      const t = l.trim().split(/\s+/);
      return !!t[1] && layout.isEnvUnit(t[1]) && t[2] === "start";
    });
    if (alive.length === 0 && queued.length === 0) return;
    for (const l of alive) {
      const t = l.trim().split(/\s+/);
      if (t[0] === "●" || t[0] === "*") t.shift();
      await cmd.run(cfg.tools.systemctl, ["kill", "-s", "SIGKILL", t[0]], { timeoutMs: 30_000 });
    }
    if (Date.now() > deadline) throw new HostConfigError("this environment's units would not stop: refusing to serve");
    await new Promise((r) => setTimeout(r, 100));
  }
}

export interface RunningHost {
  built: BuiltHost;
  handle: HostServerHandle;
  shutdown(): Promise<void>;
}

export async function startHost(cfg: HostConfig, binary: VerifiedBinary, deps: HostDeps): Promise<RunningHost> {
  const built = buildHost(cfg, binary, deps);
  const stateDir = deps.stateDir ?? `${cfg.stateRoot}/state`;
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  await stopEnvironment(deps.cmd, cfg, built.layout);
  built.store.open(); // the single-writer lock: throws if another host of this environment is alive
  try {
    if (!existsSync(cfg.socket.dir)) mkdirSync(cfg.socket.dir, { recursive: true, mode: 0o750 });
    if (deps.chownSocket !== false) {
      chownSync(cfg.socket.dir, 0, cfg.socket.gid);
      chmodSync(cfg.socket.dir, 0o750);
    }
    const handle = await startHostServer(built.manager, { socketPath: cfg.socketPath, socketMode: cfg.socket.mode });
    if (deps.chownSocket !== false) {
      chownSync(cfg.socketPath, 0, cfg.socket.gid);
      chmodSync(cfg.socketPath, cfg.socket.mode);
    }
    deps.log.info("host_started", { env: cfg.env });
    let down = false;
    return {
      built,
      handle,
      shutdown: async () => {
        if (down) return;
        down = true;
        await handle.close();
        await stopEnvironment(deps.cmd, cfg, built.layout).catch(() => undefined); // best effort: the next start repeats it
        built.store.close();
        deps.log.info("host_stopped", { env: cfg.env });
      },
    };
  } catch (e) {
    built.store.close();
    throw e;
  }
}

/** The root-only entry: reads the config, checks the machine, starts, handles signals. */
export async function runMain(argv: string[] = process.argv): Promise<void> {
  const log = jsonLogger();
  try {
    assertRoot(process.getuid?.());
    const configPath = argv[2] ?? process.env.AW_LOGIN_HOST_CONFIG;
    if (!configPath) throw new HostConfigError("usage: main.js <config.json>");
    assertTrustedPath(configPath); // the config is root-owned and not writable by anyone else, like everything it points to
    const cfg = parseHostConfig(JSON.parse(readFileSync(configPath, "utf8")));
    if (existsSync("/etc/subuid")) assertNoSubuidOverlap(readFileSync("/etc/subuid", "utf8"), cfg.uidMin, cfg.uidMax);
    registerRange(`${cfg.sharedParent}/ranges`, { env: cfg.env, uidMin: cfg.uidMin, uidMax: cfg.uidMax });
    assertHomesMount(parseMounts(readFileSync("/proc/mounts", "utf8")), `${cfg.stateRoot}/u`, !!cfg.quota);
    const binary = await verifyBinary(cfg.claude.binaryPath, cfg.claude.expectedSha256, cfg.claude.version);
    const running = await startHost(cfg, binary, { cmd: nodeCommandPort, root: nodeRootFs, log });
    const stop = () => void running.shutdown().then(() => process.exit(0));
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
  } catch (e) {
    log.warn("host_start_failed", { reason: e instanceof Error ? e.message.slice(0, 200) : "unknown" });
    process.exit(1);
  }
}

if (require.main === module) void runMain();
