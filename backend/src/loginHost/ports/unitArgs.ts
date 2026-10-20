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
  /** Extra paths made inaccessible inside every unit (e.g. the host's own socket directory). */
  inaccessible: string[];
}

const SIZE = /^[1-9][0-9]{0,6}[KMG]$/;

/** The sandbox properties, in a fixed order (one `-p` each). */
export function unitProperties(layout: Layout, spec: UnitSpec, limits: UnitLimits, paths: UnitPaths): string[] {
  if (!SIZE.test(limits.memoryMax) || !SIZE.test(limits.tmpSize) || !SIZE.test(limits.shmSize)) throw new Error("unit limits invalid");
  if (!Number.isInteger(limits.tasksMax) || limits.tasksMax < 1 || limits.tasksMax > 100_000) throw new Error("unit limits invalid");
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
    `TemporaryFileSystem=${layout.stateRoot}`,
    `BindPaths=${ref}`,
    `ReadWritePaths=${ref}`,
    "RestrictNamespaces=yes",
    "RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX",
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
    `MemoryMax=${limits.memoryMax}`,
    `TasksMax=${limits.tasksMax}`,
  ];
}

/** The full argv for `systemd-run` (without the executable itself). */
export function systemRunArgs(layout: Layout, spec: UnitSpec, limits: UnitLimits, paths: UnitPaths): string[] {
  if (spec.unitName !== spec.unitName.trim() || !layout.isUnitOf(spec.uid, spec.unitName)) throw new Error("unit name invalid");
  assertAbsPath(spec.file);
  assertAbsPath(spec.cwd);
  if (!spec.cwd.startsWith(spec.refDir + "/")) throw new Error("cwd must be inside the reference directory");
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
    `--working-directory=${spec.cwd}`,
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
    spec.file,
    ...spec.args,
  ];
}
