/**
 * ENG-2110 PR 1b-ii part 2: the host's configuration. A CLOSED schema (unknown keys are errors), every path
 * absolute and free of characters systemd treats specially, numeric ranges sane. The config file is root-owned
 * and read once at start-up; nothing in it is ever taken from a request.
 */
import { z } from "zod";
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
    env: z.string().regex(/^[a-z0-9]{1,16}$/),
    /** One constant on purpose: environments configured with different shared parents could read each other's homes. */
    sharedParent: z.literal("/var/lib/aw-login-host").default("/var/lib/aw-login-host"),
    /** Reserved numeric uid range of THIS environment: must not overlap another environment's range nor /etc/subuid. */
    uidMin: z.number().int().min(100_000),
    uidMax: z.number().int(),
    socket: z.object({ dir: absPath, gid: z.number().int().min(1), mode: z.number().int().min(0o600).max(0o660).default(0o660) }).strict(),
    limits: z
      .object({
        memoryMax: size.default("1G"),
        tasksMax: z.number().int().min(1).max(100_000).default(256),
        tmpSize: size.default("128M"),
        shmSize: size.default("64M"),
        runtimeMaxSec: z.number().int().min(10).max(7 * 24 * 3600).default(2 * 3600),
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
        toolCallTimeoutMs: z.number().int().min(1000).optional(),
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
        /** The Emma tool bridge's MCP endpoint as seen from a customer process. */
        bridgeUrl: z.string().url().refine((u) => /^https?:\/\//.test(u), "http(s) only"),
        models: z.array(z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/)).min(1).max(20).optional(),
        basePath: z.string().regex(/^[A-Za-z0-9._/:-]{1,200}$/).optional(),
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

export type HostConfig = z.infer<typeof schema> & { stateRoot: string; socketPath: string };

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
  const stateRoot = `${c.sharedParent}/${c.env}`;
  try {
    assertAbsPath(stateRoot);
    assertAbsPath(`${c.socket.dir}/host.sock`);
  } catch (e) {
    throw new HostConfigError(e instanceof LayoutError ? e.reason : "path invalid");
  }
  return { ...c, stateRoot, socketPath: `${c.socket.dir}/host.sock` };
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
