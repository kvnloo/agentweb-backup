/**
 * ENG-2110 PR 1b-ii: the `systemd-run` argument list for ONE customer process. Pure and exhaustively tested:
 * this is the sandbox. Every property below was probed on the real test instance (AL2023, systemd 252):
 * see brain `evidence/experiments/2026-10-19-systemd-run-hardening-probe-test-instance.md`.
 *
 * A numeric uid with no passwd entry cannot be used with `systemd-run --uid` (exit 217), so the unit runs as
 * root for the instant before `setpriv` drops to the uid with zero capabilities and no-new-privs.
 * No secret is ever placed in this list: the environment carries paths and fixed flags only; the bridge token
 * and the sign-in code travel on stdin.
 */
import { assertAbsPath, assertArg, assertEnvName, assertEnvValue, Layout } from "./layout";

export interface UnitLimits {
  /** systemd size string, e.g. "1G". */
  memoryMax: string;
  tasksMax: number;
  /** Size of the private /tmp and /var/tmp tmpfs (counts against MemoryMax). */
  tmpSize: string;
  /** Size of the private /dev/shm. */
  shmSize: string;
  /** Hard ceiling on a unit's lifetime: a unit that outlives its turn (a lost client, a hung CLI) is ended by systemd itself. */
  runtimeMaxSec: number;
}

export interface UnitSpec {
  uid: number;
  unitName: string;
  /** The root-created reference directory (the ONLY writable, visible path of the customer's data). */
  refDir: string;
  file: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
}

export interface UnitPaths {
  systemRun: string;
  setpriv: string;
  /** coreutils `env`: changes into the working directory AFTER the privilege drop (see systemRunArgs). */
  env: string;
  /** Extra paths made inaccessible inside every unit (e.g. the host's own socket directory). */
  inaccessible: string[];
  /**
   * Network isolation (PR 2). When set, the unit gets its OWN network namespace (loopback only: no route anywhere, its own abstract
   * unix sockets) and the host's egress-proxy socket directory read-only at /run/aw-egress; the process is started through `launcher`,
   * which runs `socat` (a loopback TCP port -> the proxy socket) and exports the proxy environment. Absent = the shared host
   * network (only for unit tests of the older shape; the host's config makes it mandatory).
   */
  net?: { dir: string; launcher: string; socat: string };
}

const SIZE = /^[1-9][0-9]{0,6}[KMG]$/;

/** The sandbox properties, in a fixed order (one `-p` each). */
export function unitProperties(layout: Layout, spec: UnitSpec, limits: UnitLimits, paths: UnitPaths): string[] {
  if (!SIZE.test(limits.memoryMax) || !SIZE.test(limits.tmpSize) || !SIZE.test(limits.shmSize)) throw new Error("unit limits invalid");
  if (!Number.isInteger(limits.tasksMax) || limits.tasksMax < 1 || limits.tasksMax > 100_000) throw new Error("unit limits invalid");
  if (!Number.isInteger(limits.runtimeMaxSec) || limits.runtimeMaxSec < 10 || limits.runtimeMaxSec > 7 * 24 * 3600) throw new Error("unit limits invalid");
  const ref = assertAbsPath(spec.refDir);
  return [
    "ProtectSystem=strict",
    "ProtectHome=yes",
    "ProtectProc=invisible",
    "NoNewPrivileges=yes",
    "PrivateIPC=yes",
    // Writable scratch is a bounded tmpfs, never the root volume (PrivateTmp's /var/tmp was verified unbounded).
    `TemporaryFileSystem=/tmp:mode=1777,nosuid,nodev,size=${limits.tmpSize}`,
    `TemporaryFileSystem=/var/tmp:mode=1777,nosuid,nodev,size=${limits.tmpSize}`,
    `TemporaryFileSystem=/dev/shm:mode=1777,nosuid,nodev,noexec,size=${limits.shmSize}`,
    // The unit sees ONLY its own reference directory under the state root (verified: state/ and sibling uids are invisible).
    // ALL environments' state roots live under one shared parent; masking the parent hides every other environment's homes too.
    `TemporaryFileSystem=${layout.sharedParent}`,
    `BindPaths=${ref}`,
    `ReadWritePaths=${ref}`,
    "RestrictNamespaces=yes",
    "RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX",
    "RestrictRealtime=yes",
    "SystemCallArchitectures=native",
    // The kernel attack surface a zero-capability process does not need. (`@privileged` stays allowed: setpriv, the first
    // thing in the unit, needs setresuid/capset; it runs before any customer code and the caps are gone afterwards.)
    "SystemCallFilter=@system-service",
    "SystemCallFilter=~io_uring_setup io_uring_enter io_uring_register userfaultfd perf_event_open bpf keyctl add_key request_key",
    // A denied syscall returns EPERM instead of killing the process (the default is SIGSYS): a runtime that probes for io_uring falls back.
    "SystemCallErrorNumber=EPERM",
    "RestrictSUIDSGID=yes",
    "LockPersonality=yes",
    "ProtectControlGroups=yes",
    "ProtectKernelTunables=yes",
    "ProtectKernelModules=yes",
    "ProtectKernelLogs=yes",
    "UMask=0077",
    // A leading "-" makes a missing path a no-op instead of failing the unit (other hosts have no docker or containerd).
    "InaccessiblePaths=-/run/dbus",
    "InaccessiblePaths=-/run/containerd",
    "InaccessiblePaths=-/run/systemd/private",
    "InaccessiblePaths=-/var/run/docker.sock",
    ...paths.inaccessible.map((p) => `InaccessiblePaths=-${assertAbsPath(p)}`),
    "IPAddressDeny=169.254.169.254 fd00:ec2::254",
    ...(paths.net
      ? [
          // Own network namespace: loopback only, no route out, no shared abstract unix sockets with other customers.
          "PrivateNetwork=yes",
          // /run is replaced by an empty read-only tmpfs so no host socket is even visible; only the egress proxy socket directory is bound in.
          "TemporaryFileSystem=/run:ro",
          `BindReadOnlyPaths=${assertAbsPath(paths.net.dir)}:/run/aw-egress`,
        ]
      : []),
    `MemoryMax=${limits.memoryMax}`,
    `TasksMax=${limits.tasksMax}`,
    `RuntimeMaxSec=${limits.runtimeMaxSec}`,
    "OOMScoreAdjust=500", // under memory pressure the kernel picks customers, never the host service
  ];
}

/** The full argv for `systemd-run` (without the executable itself). */
export function systemRunArgs(layout: Layout, spec: UnitSpec, limits: UnitLimits, paths: UnitPaths): string[] {
  if (spec.unitName !== spec.unitName.trim() || !layout.isUnitOf(spec.uid, spec.unitName)) throw new Error("unit name invalid");
  assertAbsPath(spec.file);
  assertAbsPath(spec.cwd);
  if (!spec.cwd.startsWith(spec.refDir + "/")) throw new Error("cwd must be inside the reference directory");
  assertAbsPath(paths.env);
  for (const a of spec.args) assertArg(a);
  const env: string[] = [];
  for (const [k, v] of Object.entries(spec.env)) env.push(`--setenv=${assertEnvName(k)}=${assertEnvValue(v)}`);
  return [
    "--quiet",
    "--wait",
    "--collect",
    "--pipe",
    `--unit=${spec.unitName}`,
    `--slice=${layout.sliceName(spec.uid)}`,
    // The unit's working directory is set by PID 1 AS ROOT, following symlinks: it must therefore be the root-created
    // reference directory itself (all of its parents are root-owned), never anything the customer can swap (verified on
    // the instance: `work -> /proc/1/root/tmp` put a customer process in the HOST's /tmp). The change into `work` happens
    // below, after the privilege drop, as the customer.
    `--working-directory=${spec.refDir}`,
    ...env,
    ...unitProperties(layout, spec, limits, paths).flatMap((p) => ["-p", p]),
    "--",
    paths.setpriv,
    `--reuid=${spec.uid}`,
    `--regid=${spec.uid}`,
    "--clear-groups",
    "--inh-caps=-all",
    "--bounding-set=-all",
    "--no-new-privs",
    "--",
    paths.env,
    `--chdir=${spec.cwd}`,
    ...(paths.net ? [assertAbsPath(paths.net.launcher), assertAbsPath(paths.net.socat)] : []),
    spec.file,
    ...spec.args,
  ];
}
