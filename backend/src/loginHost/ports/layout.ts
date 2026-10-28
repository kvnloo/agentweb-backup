/**
 * ENG-2110 PR 1b-ii: where everything lives on the worker, and the validators every path component and every
 * name must pass before it reaches a command line. Pure: no I/O. See brain `pr1b-design-v3-amendments.md`.
 *
 *   <sharedParent>/<env> == <stateRoot>      one state root per environment under ONE shared parent, which every unit masks
 *   <stateRoot>/state/…                      host state (never visible inside a customer unit)
 *   <stateRoot>/u/                           the homes filesystem (loop-mounted, quota)
 *   <stateRoot>/u/<uid>/                     root-owned 0711
 *   <stateRoot>/u/<uid>/attempts/<ref>/      sign-in attempt: {home,work,tmp}
 *   <stateRoot>/u/<uid>/homes/<ref>/         promoted home:   {home,work,tmp}
 */
import { posix } from "path";

export interface LayoutConfig {
  /** `^[a-z0-9]{1,16}$`: no dash (a dash in a slice name means a parent slice). */
  env: string;
  /** Absolute, e.g. /var/lib/aw-login-host/<env>. */
  stateRoot: string;
  /** The ONE parent of every environment's state root (e.g. /var/lib/aw-login-host): units mask all of it, so another environment's homes are never visible. */
  sharedParent: string;
  uidMin: number;
  uidMax: number;
  /**
   * ENG-2113: where the per-turn relay sockets live: `<relayRoot>/<uid>/<relayId>/relay.sock`. Absolute, outside the state root, under /run (a unit's /run is an
   * empty tmpfs, so nothing here is visible inside a unit except the one directory bound into it). Absent = the relay is not available.
   */
  relayRoot?: string;
}

export type RefKind = "attempt" | "home";

const ENV = /^[a-z0-9]{1,16}$/;
const SYSTEM_DIRS = ["/", "/var", "/var/lib", "/var/tmp", "/run", "/opt", "/etc", "/usr", "/home", "/tmp", "/srv", "/root", "/boot", "/dev", "/proc", "/sys", "/bin", "/sbin", "/lib", "/lib64", "/mnt", "/media"];
const REF = /^[a-z][a-z0-9]{1,9}-[a-z0-9]{1,64}$/;
const SEGMENT = /^[A-Za-z0-9._-]{1,64}$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;

export class LayoutError extends Error {
  constructor(readonly reason: string) {
    super(`layout: ${reason}`);
    this.name = "LayoutError";
  }
}

export class Layout {
  constructor(private readonly cfg: LayoutConfig) {
    if (!ENV.test(cfg.env)) throw new LayoutError("env_invalid");
    try {
      assertAbsPath(cfg.stateRoot);
    } catch {
      throw new LayoutError("state_root_invalid");
    }
    if (cfg.stateRoot.length < 2 || cfg.stateRoot.endsWith("/")) throw new LayoutError("state_root_invalid");
    try {
      assertAbsPath(cfg.sharedParent);
    } catch {
      throw new LayoutError("shared_parent_invalid");
    }
    // The parent is masked inside every unit: it must be a dedicated directory, never a system one, and the state root must live directly in it.
    if (SYSTEM_DIRS.includes(cfg.sharedParent) || cfg.sharedParent.endsWith("/") || cfg.stateRoot !== `${cfg.sharedParent}/${cfg.env}`) throw new LayoutError("shared_parent_invalid");
    if (cfg.relayRoot !== undefined) {
      try {
        assertAbsPath(cfg.relayRoot);
      } catch {
        throw new LayoutError("relay_root_invalid");
      }
      if (SYSTEM_DIRS.includes(cfg.relayRoot) || cfg.relayRoot.endsWith("/") || cfg.relayRoot === cfg.stateRoot || cfg.relayRoot.startsWith(cfg.sharedParent + "/")) throw new LayoutError("relay_root_invalid");
    }
    if (!Number.isInteger(cfg.uidMin) || !Number.isInteger(cfg.uidMax) || cfg.uidMin < 1000 || cfg.uidMax < cfg.uidMin) throw new LayoutError("uid_range_invalid");
  }

  get env(): string {
    return this.cfg.env;
  }
  get stateRoot(): string {
    return this.cfg.stateRoot;
  }
  get sharedParent(): string {
    return this.cfg.sharedParent;
  }
  /** The filesystem the homes live on (loop-mounted, quota): `attempts` and `homes` are on ONE filesystem so promote is a rename. */
  get homesRoot(): string {
    return `${this.cfg.stateRoot}/u`;
  }

  assertUid(uid: number): number {
    if (!Number.isInteger(uid) || uid < this.cfg.uidMin || uid > this.cfg.uidMax) throw new LayoutError("uid_out_of_range");
    return uid;
  }
  assertRef(ref: string): string {
    if (typeof ref !== "string" || !REF.test(ref)) throw new LayoutError("ref_invalid");
    return ref;
  }

  uidDir(uid: number): string {
    return `${this.homesRoot}/${this.assertUid(uid)}`;
  }
  kindDir(uid: number, kind: RefKind): string {
    return `${this.uidDir(uid)}/${kind === "attempt" ? "attempts" : "homes"}`;
  }
  refDir(uid: number, kind: RefKind, ref: string): string {
    return `${this.kindDir(uid, kind)}/${this.assertRef(ref)}`;
  }
  homeDir(uid: number, kind: RefKind, ref: string): string {
    return `${this.refDir(uid, kind, ref)}/home`;
  }
  workDir(uid: number, kind: RefKind, ref: string): string {
    return `${this.refDir(uid, kind, ref)}/work`;
  }
  tmpDir(uid: number, kind: RefKind, ref: string): string {
    return `${this.refDir(uid, kind, ref)}/tmp`;
  }

  /** The directory that holds every relay directory of this environment (the host creates it at start-up, root-owned 0755). */
  get relayRoot(): string {
    const r = this.cfg.relayRoot;
    if (!r) throw new LayoutError("relay_unavailable");
    return r;
  }
  get hasRelay(): boolean {
    return !!this.cfg.relayRoot;
  }
  /** `relayId`: 128 random bits as lowercase hex, generated by the host per turn (never derived from the backend's turn id: the socket path must stay short enough for sun_path). */
  relayTurnDir(uid: number, relayId: string): string {
    if (typeof relayId !== "string" || !/^[a-f0-9]{32}$/.test(relayId)) throw new LayoutError("relay_id_invalid");
    return `${this.relayUidDir(uid)}/${relayId}`;
  }
  relayUidDir(uid: number): string {
    return `${this.relayRoot}/${this.assertUid(uid)}`;
  }
  /** Whether `dir` is exactly one relay directory of THIS uid (a spawn must never be told to bind anything else). */
  isRelayDirOf(uid: number, dir: string): boolean {
    if (!this.hasRelay || typeof dir !== "string") return false;
    const prefix = `${this.relayUidDir(uid)}/`;
    return dir.startsWith(prefix) && /^[a-f0-9]{32}$/.test(dir.slice(prefix.length));
  }

  sliceName(uid: number): string {
    return `aw-${this.cfg.env}-${this.assertUid(uid)}.slice`;
  }
  /** `suffix` is lowercase hex from a CSPRNG: unit names are unguessable and never contain customer-controlled text. */
  unitName(uid: number, suffix: string): string {
    if (!/^[a-f0-9]{8,32}$/.test(suffix)) throw new LayoutError("unit_suffix_invalid");
    return `aw-${this.cfg.env}-${this.assertUid(uid)}-${suffix}.service`;
  }
  /** systemctl pattern matching every unit of one uid. */
  unitPattern(uid: number): string {
    return `aw-${this.cfg.env}-${this.assertUid(uid)}-*.service`;
  }
  /** Whether `name` is one of THIS env's units of THIS uid (used to trust nothing that `systemctl list-units` prints). */
  isUnitOf(uid: number, name: string): boolean {
    return new RegExp(`^aw-${this.cfg.env}-${this.assertUid(uid)}-[a-f0-9]{8,32}\\.service$`).test(name);
  }
  get envSlicePattern(): string {
    return `aw-${this.cfg.env}-*.slice`;
  }
  /** systemctl pattern matching EVERY unit of this environment (any uid). */
  get envUnitPattern(): string {
    return `aw-${this.cfg.env}-*.service`;
  }
  /** Whether `name` is a unit of THIS environment (any uid). */
  isEnvUnit(name: string): boolean {
    return new RegExp(`^aw-${this.cfg.env}-\\d+-[a-f0-9]{8,32}\\.service$`).test(name);
  }
  /** The slice that parents every customer slice of this env (caps the total). */
  get envSliceName(): string {
    return `aw-${this.cfg.env}.slice`;
  }
}

/**
 * A path relative to a connection's home directory, validated component by component: relative, no `..`,
 * no empty/`.` segment, characters restricted, bounded depth and length. Anything else throws.
 */
export function assertRelPath(rel: string): string[] {
  if (typeof rel !== "string" || rel.length === 0 || rel.length > 200 || rel.includes("\0") || rel.startsWith("/")) throw new LayoutError("rel_invalid");
  const parts = rel.split("/");
  if (parts.length > 4) throw new LayoutError("rel_too_deep");
  for (const p of parts) if (p === "." || p === ".." || !SEGMENT.test(p)) throw new LayoutError("rel_invalid");
  return parts;
}

export function assertEnvName(name: string): string {
  if (!ENV_NAME.test(name)) throw new LayoutError("env_name_invalid");
  return name;
}
/** `%` is a systemd specifier; values here are paths and fixed flags, never free text. No control characters: transient units are written to disk and re-parsed. */
export function assertEnvValue(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (typeof value !== "string" || value.length > 4096 || /[\x00-\x1f\x7f%]/.test(value)) throw new LayoutError("env_value_invalid");
  return value;
}
/**
 * An absolute path that is safe inside a systemd property or command line: only `[A-Za-z0-9._/-]` (no space,
 * colon, quote, `$` or `%`, which systemd treats specially in BindPaths/ExecStart), normalized, no `..`.
 */
export function assertAbsPath(path: string): string {
  if (typeof path !== "string" || path.length > 1024 || !/^\/[A-Za-z0-9._/-]*$/.test(path) || path !== posix.normalize(path) || path.split("/").includes("..")) throw new LayoutError("path_invalid");
  return path;
}
/** A command-line argument for a customer process: `$` and `%` are expanded by the service manager in ExecStart, NUL ends a C string. */
export function assertArg(arg: string): string {
  // eslint-disable-next-line no-control-regex
  if (typeof arg !== "string" || arg.length > 4096 || /[\x00-\x1f\x7f$%]/.test(arg)) throw new LayoutError("arg_invalid");
  return arg;
}
