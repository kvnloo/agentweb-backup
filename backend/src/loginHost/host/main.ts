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
import { chmodSync, chownSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "fs";
import { ClaudeAdapter } from "../adapters/claudeAdapter";
import type { SubscriptionProviderAdapter } from "../adapter";
import { ConnectionManager, DEFAULT_CONFIG, type ManagerConfig } from "../connectionManager";
import type { IdGen, Logger } from "../ports";
import { systemClock } from "../ports";
import { Layout } from "../ports/layout";
import { nodeCommandPort, nodeRootFs, type CommandPort, type RootFs } from "../ports/system";
import { SystemdUserFs, type SystemdPortConfig } from "../ports/systemdUserFs";
import { startEgressProxy, type EgressProxyHandle } from "../egress/egressProxy";
import { RelayHost } from "../relay/relayServer";
import { startHostServer, type HostServerHandle } from "../server";
import { StateStore } from "../stateStore";
import { CERT_WARN_DAYS, certNotAfterMs, daysUntil } from "../certExpiry";
import { assertTrustedPath, verifyBinary, type VerifiedBinary } from "./binary";
import { assertHostTrustedPaths } from "./trustedPaths";
import { assertNoSubuidOverlap, HostConfigError, parseHostConfig, type HostConfig } from "./hostConfig";
import { registerRange } from "./ranges";
import { assertHomesMount, assertRoot, parseMounts } from "./startupChecks";

export { assertHostTrustedPaths, hostTrustedPaths } from "./trustedPaths";

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
  /** Tests run unprivileged: a temp directory instead of /run/aw-login-host-<env>. */
  socketDir?: string;
  /** Tests run unprivileged: a temp directory instead of /run/aw-egress-<env> for the egress proxy socket. */
  egressDir?: string;
  /** Tests run unprivileged: a temp directory instead of /run/aw-relay-<env> for the per-turn relay sockets. */
  relayRoot?: string;
  /** Tests: bind the mutual-TLS listener to this address/port (port 0 = any) instead of the configured private address. */
  tlsHost?: string;
  tlsPort?: number;
  /** Tests: the egress proxy's name resolution and upstream connect (no real network). */
  egressResolve?: (host: string) => Promise<string[]>;
  managerOverrides?: Partial<ManagerConfig>;
}

/**
 * The TLS private key must not be readable by anyone but root. `assertTrustedPath` only rules out WRITE access by group/others, so this
 * is checked separately; `mode` is the file's st_mode.
 */
export function assertKeyFileMode(path: string, mode: number): void {
  if (mode & 0o077) throw new HostConfigError(`${path} must be mode 0600 (it is ${(mode & 0o777).toString(8)})`);
}

/** Logs the server certificate's remaining life at start-up (day count only), warning under CERT_WARN_DAYS. Returns the days, or undefined if unparseable. */
export function reportTlsCertExpiry(log: Logger, certPem: string | Buffer, now: number = Date.now()): number | undefined {
  const notAfter = certNotAfterMs(certPem);
  if (notAfter === undefined) {
    log.warn("host_tls_cert_unparseable");
    return undefined;
  }
  const daysLeft = daysUntil(notAfter, now);
  log.info("host_tls_cert_expiry", { daysLeft });
  if (daysLeft < CERT_WARN_DAYS) log.warn("host_tls_cert_expires_soon", { daysLeft });
  return daysLeft;
}

export const realIds: IdGen = { next: (prefix) => `${prefix}-${randomBytes(12).toString("hex")}` };

/** Structured, secret-free log lines on stdout (callers pass codes and ids only). */
export function jsonLogger(write: (line: string) => void = (l) => process.stdout.write(l + "\n")): Logger {
  const emit = (level: string, event: string, fields?: Record<string, string | number | boolean>) => write(JSON.stringify({ ts: new Date().toISOString(), level, event, ...(fields ?? {}) }));
  return { info: (e, f) => emit("info", e, f), warn: (e, f) => emit("warn", e, f) };
}

export function layoutFor(cfg: HostConfig, relayRoot: string = cfg.relayRoot): Layout {
  return new Layout({ env: cfg.env, stateRoot: cfg.stateRoot, sharedParent: cfg.sharedParent, uidMin: cfg.uidMin, uidMax: cfg.uidMax, relayRoot });
}

/** The proxy is created after the port (start-up order), so the port reaches it through this holder; before it is set no unit can start. */
export interface EgressRef {
  current?: EgressProxyHandle;
}

export function portConfigFor(cfg: HostConfig, egressRef?: EgressRef): SystemdPortConfig {
  return {
    // Every unit gets ITS OWN proxy socket (created now, synchronously, before the unit starts): fail closed if the proxy is not up.
    egressFor: (uid) => {
      if (!egressRef?.current) throw new Error("egress_not_ready");
      return egressRef.current.listenFor(uid);
    },
    limits: cfg.limits,
    paths: { ...cfg.tools, inaccessible: [cfg.socket.dir], net: { dir: cfg.egressDir, launcher: cfg.egress.launcherPath, socat: cfg.egress.socat } },
    // A graceful stop (stopGraceSec) happens inside every kill: the budget must cover it, or a normal stop would read as a stuck unit.
    killTimeoutMs: 15_000 + cfg.limits.stopGraceSec * 1000,
    killPollMs: 100,
    // One `systemctl stop` blocks for up to the grace (SIGTERM phase) plus the same again if the final SIGKILL phase is slow: the
    // client timeout must outlast both, or the port would SIGKILL inside the grace period it is supposed to give.
    commandTimeoutMs: 30_000,
    ...(cfg.quota ? { quota: cfg.quota } : {}),
  };
}

/** The mutual-TLS listener's options from the config: the files are read here, once, at start-up (a renewed certificate needs a restart). */
function tlsListenerOptions(tls: NonNullable<HostConfig["tls"]>, deps: Pick<HostDeps, "tlsHost" | "tlsPort">, log: Logger) {
  const cert = readFileSync(tls.certPath);
  reportTlsCertExpiry(log, cert);
  return { host: deps.tlsHost ?? tls.host, port: deps.tlsPort ?? tls.port, cert, key: readFileSync(tls.keyPath), ca: readFileSync(tls.caPath), clientCommonNames: tls.clientCommonNames };
}

export interface BuiltHost {
  layout: Layout;
  port: SystemdUserFs;
  store: StateStore;
  manager: ConnectionManager;
  egressRef: EgressRef;
  relay: RelayHost;
}

/** How long the Claude adapter waits for a stopping turn process: the unit's stop grace plus a margin. */
export function adapterKillWaitMs(cfg: HostConfig): number {
  return cfg.limits.stopGraceSec * 1000 + 5_000;
}

/** The connection manager's config: defaults, then the host config's overrides, then the values derived from the unit stop grace. */
export function managerConfigFor(cfg: HostConfig, overrides: Partial<ManagerConfig> = {}): ManagerConfig {
  return {
    ...DEFAULT_CONFIG,
    ...cfg.manager,
    // Whatever base is in effect (the default or a configured value), a stopping provider also gets the unit's stop grace.
    abortGraceMs: (cfg.manager?.abortGraceMs ?? DEFAULT_CONFIG.abortGraceMs) + cfg.limits.stopGraceSec * 1000,
    uidMin: cfg.uidMin,
    uidMax: cfg.uidMax,
    ...overrides,
  };
}

export function buildHost(cfg: HostConfig, binary: VerifiedBinary, deps: HostDeps): BuiltHost {
  const layout = layoutFor(cfg, deps.relayRoot);
  const egressRef: EgressRef = {};
  // The per-turn relay sockets: owned by the customer uid in production, created by the host process (root) before the unit starts.
  const relay = new RelayHost({
    layout,
    ownByUid: deps.chownSocket !== false,
    log: { warn: (event, fields) => deps.log.warn(event, Object.fromEntries(Object.entries(fields ?? {}).map(([k, v]) => [k, typeof v === "number" || typeof v === "boolean" ? v : String(v)]))) },
  });
  const port = new SystemdUserFs({ layout, cmd: deps.cmd, root: deps.root, config: portConfigFor(cfg, egressRef) });
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
          relay: { host: relay, shimPath: cfg.claude.relayShimPath, nodePath: cfg.claude.nodePath },
          log: { warn: (event, fields) => deps.log.warn(event, fields) },
          ...(cfg.claude.models ? { models: cfg.claude.models } : {}),
          ...(cfg.claude.basePath ? { basePath: cfg.claude.basePath } : {}),
          // A stopping turn process gets the unit's grace period: waits for it (and the auth check that follows) must outlast it.
          killWaitMs: adapterKillWaitMs(cfg),
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
    config: managerConfigFor(cfg, deps.managerOverrides),
  });
  return { layout, port, store, manager, egressRef, relay };
}

/**
 * Stops every unit of this environment and waits until none (and no queued start job) is left. Customer units are
 * separate transient units, so they survive a crash of the host: this runs before the host serves anything.
 */
export async function stopEnvironment(cmd: CommandPort, cfg: HostConfig, layout: Layout, budgetMs = 30_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  let final = false;
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
    if (Date.now() > deadline) {
      if (final) throw new HostConfigError("this environment's units would not stop: refusing to serve");
      final = true; // one more look after the last kill before giving up
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** The tool bridge's host:port as the proxy must allow it (it may be loopback/private, unlike every allowlist entry). */
export function bridgeTarget(bridgeUrl: string): { host: string; port: number } {
  const u = new URL(bridgeUrl);
  return { host: u.hostname.replace(/^\[|\]$/g, "").toLowerCase(), port: u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80 };
}

export interface RunningHost {
  built: BuiltHost;
  handle: HostServerHandle;
  egress: EgressProxyHandle;
  shutdown(): Promise<void>;
}

export async function startHost(cfg: HostConfig, binary: VerifiedBinary, deps: HostDeps): Promise<RunningHost> {
  const built = buildHost(cfg, binary, deps);
  const stateDir = deps.stateDir ?? `${cfg.stateRoot}/state`;
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  let egress: EgressProxyHandle | undefined;
  built.store.open(); // the single-writer lock FIRST: a second instance must fail here, before it can stop the live host's units
  try {
    await stopEnvironment(deps.cmd, cfg, built.layout);
    // The egress proxy comes up BEFORE the API socket: no customer process can run until the host serves, and none may ever run without it.
    const egressDir = deps.egressDir ?? cfg.egressDir;
    rmSync(egressDir, { recursive: true, force: true }); // sockets of a previous run are stale; every customer's is created again on demand
    mkdirSync(egressDir, { recursive: true, mode: 0o755 });
    if (deps.chownSocket !== false) {
      chownSync(egressDir, 0, 0);
      chmodSync(egressDir, 0o755); // customer uids must be able to reach the socket inside; the allowlist is the gate, not the directory
    }
    egress = await startEgressProxy({
      perUid: { dir: egressDir, ownByUid: deps.chownSocket !== false },
      allow: cfg.egress.allow,
      bridge: bridgeTarget(cfg.claude.bridgeUrl),
      ...(deps.egressResolve ? { resolve: deps.egressResolve } : {}),
      logger: { warn: (event, fields) => deps.log.warn(event, Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, typeof v === "number" || typeof v === "boolean" ? v : String(v)]))) },
    });
    built.egressRef.current = egress;
    built.relay.init(); // sockets of a previous run are dead: the root is emptied before any unit can ask for one
    const sockDir = deps.socketDir ?? cfg.socket.dir;
    const sockPath = `${sockDir}/host.sock`;
    if (!existsSync(sockDir)) mkdirSync(sockDir, { recursive: true, mode: 0o750 });
    if (deps.chownSocket !== false) {
      chownSync(sockDir, 0, cfg.socket.gid);
      chmodSync(sockDir, 0o750);
    }
    const tlsOptions = cfg.tls ? tlsListenerOptions(cfg.tls, deps, deps.log) : undefined;
    const handle = await startHostServer(built.manager, {
      socketPath: sockPath,
      socketMode: cfg.socket.mode,
      log: deps.log,
      ...(tlsOptions ? { tls: tlsOptions } : {}),
    });
    if (deps.chownSocket !== false) {
      chownSync(sockPath, 0, cfg.socket.gid);
      chmodSync(sockPath, cfg.socket.mode);
    }
    deps.log.info("host_started", { env: cfg.env });
    let down = false;
    return {
      built,
      handle,
      egress,
      shutdown: async () => {
        if (down) return;
        down = true;
        await handle.close();
        built.egressRef.current = undefined; // from now on no unit can start (fail closed)
        try {
          // Units stop gracefully first and may still need the network while they finish (a refreshed login): the egress proxy outlives them.
          await stopEnvironment(deps.cmd, cfg, built.layout);
        } finally {
          await egress?.close().catch(() => undefined);
          built.store.close(); // a failed stop is reported to the caller (non-zero exit); the next start repeats it
        }
        deps.log.info("host_stopped", { env: cfg.env });
      },
    };
  } catch (e) {
    await egress?.close().catch(() => undefined);
    built.store.close();
    throw e;
  }
}

/**
 * LAST RESORT, not a feature: whatever slips past the guards on shim-, CLI- and request-controlled data (relay/bounds.ts, the try/catch around every handler) must
 * not leave the host running in an unknown state. Node's own default is the same exit (code 1 for an uncaught exception, and an unhandled rejection is thrown as
 * one since Node 15), so this does not change WHEN the host stops, only WHAT it says: one fixed-code log line instead of the error's message and stack, which can
 * quote customer-controlled input (a JSON.parse error names the text it choked on). Exit code 1 keeps `Restart=on-failure` restarting it. It never swallows an
 * error and keeps nothing running: the exit is immediate and synchronous (customer units are separate transient units; the next start stops them all).
 */
export function installLastResortHandlers(log: Logger, exit: (code: number) => void = (c) => process.exit(c), proc: Pick<NodeJS.Process, "on"> = process): void {
  let dying = false;
  const die = (code: "host_uncaught_exception" | "host_unhandled_rejection") => {
    if (dying) return; // a second failure while exiting: the first exit is already on its way
    dying = true;
    try {
      log.warn(code);
    } catch {
      /* the exit below is what matters */
    }
    exit(1);
  };
  proc.on("uncaughtException", () => die("host_uncaught_exception"));
  proc.on("unhandledRejection", () => die("host_unhandled_rejection"));
}

/** The root-only entry: reads the config, checks the machine, starts, handles signals. */
export async function runMain(argv: string[] = process.argv): Promise<void> {
  const log = jsonLogger();
  installLastResortHandlers(log);
  try {
    assertRoot(process.getuid?.());
    const configPath = argv[2] ?? process.env.AW_LOGIN_HOST_CONFIG;
    if (!configPath) throw new HostConfigError("usage: main.js <config.json>");
    assertTrustedPath(configPath); // the config is root-owned and not writable by anyone else, like everything it points to
    const cfg = parseHostConfig(JSON.parse(readFileSync(configPath, "utf8")));
    // Everything the host or a customer unit executes or reads as policy must be root-controlled too.
    assertHostTrustedPaths(cfg);
    if (cfg.tls) assertKeyFileMode(cfg.tls.keyPath, statSync(cfg.tls.keyPath).mode);
    if (existsSync("/etc/subuid")) assertNoSubuidOverlap(readFileSync("/etc/subuid", "utf8"), cfg.uidMin, cfg.uidMax);
    registerRange(`${cfg.sharedParent}/ranges`, { env: cfg.env, uidMin: cfg.uidMin, uidMax: cfg.uidMax });
    assertHomesMount(parseMounts(readFileSync("/proc/mounts", "utf8")), `${cfg.stateRoot}/u`, !!cfg.quota);
    const binary = await verifyBinary(cfg.claude.binaryPath, cfg.claude.expectedSha256, cfg.claude.version);
    const running = await startHost(cfg, binary, { cmd: nodeCommandPort, root: nodeRootFs, log });
    const stop = () =>
      void running.shutdown().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
  } catch (e) {
    log.warn("host_start_failed", { reason: e instanceof Error ? e.message.slice(0, 200) : "unknown" });
    process.exit(1);
  }
}

