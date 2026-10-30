/**
 * ENG-2110 PR 1b-ii part 2: the host's configuration. A CLOSED schema (unknown keys are errors), every path
 * absolute and free of characters systemd treats specially, numeric ranges sane. The config file is root-owned
 * and read once at start-up; nothing in it is ever taken from a request.
 */
import { z } from "zod";
import { isCanonicalIPv4, unusableAddressReason } from "../ipv4";
import { assertAbsPath, LayoutError } from "../ports/layout";

const absPath = z.string().refine((p) => {
  try {
    assertAbsPath(p);
    return true;
  } catch {
    return false;
  }
}, "must be an absolute path made of [A-Za-z0-9._/-] only");

const size = z.string().regex(/^[1-9][0-9]{0,6}[KMG]$/, "systemd size such as 512M or 2G");
const hex64 = z.string().regex(/^[a-f0-9]{64}$/, "lowercase sha256 hex");

const schema = z
  .object({
    /** `^[a-z0-9]{1,16}$`: no dash. One host per environment (test1, prod, ...). */
    env: z.string().regex(/^[a-z0-9]{1,16}$/).refine((e) => e !== "ranges", "reserved name"),
    /** One constant on purpose: environments configured with different shared parents could read each other's homes. */
    sharedParent: z.literal("/var/lib/aw-login-host").default("/var/lib/aw-login-host"),
    /** Reserved numeric uid range of THIS environment: must not overlap another environment's range nor /etc/subuid. */
    uidMin: z.number().int().min(100_000),
    uidMax: z.number().int(),
    socket: z.object({ dir: absPath, gid: z.number().int().min(1), mode: z.number().int().min(0o600).max(0o660).refine((m) => (m & 0o117) === 0, "mode must be 0600 or 0660 (write decimal 384/432 in JSON)").default(0o660) }).strict(),
    limits: z
      .object({
        memoryMax: size.default("1G"),
        tasksMax: z.number().int().min(1).max(100_000).default(256),
        tmpSize: size.default("128M"),
        shmSize: size.default("64M"),
        runtimeMaxSec: z.number().int().min(10).max(7 * 24 * 3600).default(2 * 3600),
        /** Grace period a stopping customer unit gets to exit on SIGTERM before SIGKILL (keeps a login that is mid-refresh intact). */
        stopGraceSec: z.number().int().min(2).max(12).default(10),
      })
      .strict()
      .default({}),
    quota: z.object({ blocksKb: z.number().int().min(1024), inodes: z.number().int().min(100) }).strict().optional(),
    /** Overrides for the core's caps and timers (anything omitted keeps the default). */
    manager: z
      .object({
        maxTurnsPerHost: z.number().int().min(1).max(1000).optional(),
        maxSessionsPerHost: z.number().int().min(1).max(2000).optional(),
        scheduledReserve: z.number().int().min(0).max(1000).optional(),
        leaseMs: z.number().int().min(1000).optional(),
        abortGraceMs: z.number().int().min(100).optional(),
        idleSessionMs: z.number().int().min(1000).optional(),
        // at most 2^31-1 ms would overflow setTimeout; 1 h is the longest turn deadline anyway
        toolCallTimeoutMs: z.number().int().min(1000).max(3_600_000).optional(),
        readyAttemptTtlMs: z.number().int().min(10_000).max(30 * 60 * 1000).optional(),
        adapterCallTimeoutMs: z.number().int().min(1000).optional(),
        portCallTimeoutMs: z.number().int().min(1000).optional(),
      })
      .strict()
      .default({}),
    claude: z
      .object({
        /** Pinned binary: absolute, root-owned, not group/other-writable, with this exact sha256 (the host refuses to start otherwise). */
        binaryPath: absPath,
        expectedSha256: hex64,
        version: z.string().regex(/^[0-9][0-9A-Za-z.+-]{0,30}$/),
        systemPromptFile: absPath,
        turnWrapperPath: absPath.default("/opt/aw-login-host/claude-turn.sh"),
        /** ENG-2113 tool relay: the stdio MCP shim the CLI starts inside the unit, and the node binary that runs it (both root-controlled, trusted-path checked). */
        relayShimPath: absPath.default("/opt/aw-login-host/aw-relay-shim.js"),
        /** REQUIRED, and a REAL path, not a symlink (assertTrustedPath refuses links, so the host would not start and the unit would hit its start limit): the prod template names /opt/aw-node/v<ver>/bin/node. There is deliberately no default: /usr/bin/node is a symlink on the worker. */
        nodePath: absPath,
        /** The Emma tool bridge's MCP endpoint as seen from a customer process. */
        bridgeUrl: z
          .string()
          .url()
          .refine((u) => /^https?:\/\//.test(u) && !/[$%\s]/.test(u), "http(s) only, no $ % or whitespace")
          // The egress proxy matches the bridge by plain host and port: an IPv6 literal cannot be expressed there, so it is refused up front.
          .refine((u) => !new URL(u).hostname.startsWith("["), "IPv6 literal hosts are not supported for the tool bridge (use a name or an IPv4 address)"),
        models: z.array(z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/)).min(1).max(20).optional(),
        basePath: z.string().regex(/^[A-Za-z0-9._/:-]{1,200}$/).optional(),
      })
      .strict(),
    /**
     * Mutual-TLS listener for a backend on ANOTHER machine (PR 3). Optional: the unix socket alone is enough on a single box (the test
     * environment). The files are root-owned (the key 0600), written at deploy time from Secrets Manager; they are read once at start-up.
     */
    tls: z
      .object({
        /** The private address to bind (never 0.0.0.0 by accident): an IPv4 literal. */
        host: z.string().refine(isCanonicalIPv4, "a canonical IPv4 address (four decimal octets, no leading zeros)"),
        port: z.number().int().min(1024).max(65535).default(8443),
        certPath: absPath,
        keyPath: absPath,
        caPath: absPath,
        /** The subject CN(s) the backend's client certificate must carry (the CA signing it is necessary, not sufficient). */
        clientCommonNames: z.array(z.string().regex(/^[A-Za-z0-9._-]{1,64}$/)).min(1).max(5),
      })
      .strict()
      .optional(),
    /**
     * Network isolation (PR 2): every customer unit runs with PrivateNetwork=yes (loopback only) and reaches the world ONLY through the
     * host's allowlisting proxy over a unix socket. `allow` is the complete list of `host:port` targets a customer process may reach
     * (the Emma tool bridge from `claude.bridgeUrl` is added automatically). There is no default: a host with no policy does not start.
     */
    egress: z
      .object({
        allow: z.array(z.string().regex(/^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?:[0-9]{1,5}$/, "lowercase host:port")).min(1).max(50),
        launcherPath: absPath.default("/opt/aw-login-host/aw-net.sh"),
        socat: absPath.default("/usr/bin/socat"),
      })
      .strict(),
    tools: z
      .object({
        systemRun: absPath.default("/usr/bin/systemd-run"),
        systemctl: absPath.default("/usr/bin/systemctl"),
        setpriv: absPath.default("/usr/bin/setpriv"),
        env: absPath.default("/usr/bin/env"),
        rm: absPath.default("/usr/bin/rm"),
        find: absPath.default("/usr/bin/find"),
        setquota: absPath.default("/usr/sbin/setquota"),
        writeFileHelper: absPath.default("/opt/aw-login-host/aw-write-file.sh"),
      })
      .strict()
      .default({}),
  })
  .strict();

export type HostConfig = z.infer<typeof schema> & { stateRoot: string; socketPath: string; egressDir: string; egressSocketPath: string; relayRoot: string };

export class HostConfigError extends Error {
  constructor(readonly reason: string) {
    super(`host config: ${reason}`);
    this.name = "HostConfigError";
  }
}

export function parseHostConfig(raw: unknown): HostConfig {
  const r = schema.safeParse(raw);
  if (!r.success) throw new HostConfigError(r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "));
  const c = r.data;
  if (c.uidMax < c.uidMin || c.uidMax - c.uidMin < 10 || c.uidMax > 4_000_000_000) throw new HostConfigError("uid range invalid");
  if (c.socket.dir !== `/run/aw-login-host-${c.env}`) throw new HostConfigError(`socket.dir must be /run/aw-login-host-${c.env}`);
  const stateRoot = `${c.sharedParent}/${c.env}`;
  try {
    assertAbsPath(stateRoot);
    assertAbsPath(`${c.socket.dir}/host.sock`);
  } catch (e) {
    throw new HostConfigError(e instanceof LayoutError ? e.reason : "path invalid");
  }
  for (const t of c.egress.allow) {
    const port = Number(t.slice(t.lastIndexOf(":") + 1));
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HostConfigError(`egress.allow: bad port in ${t}`);
    if (/^[0-9.]+:/.test(t) || t.startsWith("[")) throw new HostConfigError(`egress.allow: literal IP targets are not allowed (${t})`);
  }
  // The worker's own address may be any of its interface addresses (so no private-range requirement here, unlike the backend's side), but
  // never one that cannot be a machine's address on the network: every-interface, loopback, link-local, multicast or reserved.
  const unusable = c.tls ? unusableAddressReason(c.tls.host) : null;
  if (unusable) throw new HostConfigError(`tls.host must be the machine's own network address (${unusable} addresses are refused)`);
  const egressDir = `/run/aw-egress-${c.env}`;
  return { ...c, stateRoot, socketPath: `${c.socket.dir}/host.sock`, egressDir, egressSocketPath: `${egressDir}/proxy.sock`, relayRoot: `/run/aw-relay-${c.env}` };
}

/** Parses /etc/subuid ("name:start:count" lines): the host's uid range must not overlap any of them. */
export function assertNoSubuidOverlap(subuidText: string, uidMin: number, uidMax: number): void {
  for (const line of subuidText.split("\n")) {
    const m = line.trim().match(/^[^:#]+:(\d+):(\d+)$/);
    if (!m) continue;
    const start = Number(m[1]);
    const end = start + Number(m[2]) - 1;
    if (uidMin <= end && uidMax >= start) throw new HostConfigError(`uid range ${uidMin}-${uidMax} overlaps /etc/subuid range ${start}-${end}`);
  }
}
