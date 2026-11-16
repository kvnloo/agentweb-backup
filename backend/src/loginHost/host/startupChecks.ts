/**
 * ENG-2110 PR 1b-ii part 2: pure checks of the machine the host starts on.
 */
import { HostConfigError } from "./hostConfig";

export interface MountEntry {
  mountPoint: string;
  fsType: string;
  options: string[];
}

/** Parses /proc/mounts. Octal escapes in the mount point (`\040` for a space) are decoded. */
export function parseMounts(text: string): MountEntry[] {
  const out: MountEntry[] = [];
  for (const line of text.split("\n")) {
    const f = line.trim().split(/\s+/);
    if (f.length < 4) continue;
    out.push({ mountPoint: f[1].replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8))), fsType: f[2], options: f[3].split(",") });
  }
  return out;
}

/**
 * The homes root must be its OWN filesystem (a sized loop image or volume), mounted nosuid,nodev, with user quota
 * enabled when a quota is configured: otherwise one customer can fill the root volume and break everyone's state saves.
 */
export function assertHomesMount(mounts: MountEntry[], homesRoot: string, needQuota: boolean): void {
  const m = mounts.filter((e) => e.mountPoint === homesRoot).pop();
  if (!m) throw new HostConfigError(`${homesRoot} is not a mount point: the homes live on their own sized filesystem`);
  if (!m.options.includes("nosuid") || !m.options.includes("nodev")) throw new HostConfigError(`${homesRoot} must be mounted nosuid,nodev`);
  if (needQuota && !m.options.some((o) => o === "usrquota" || o === "usrjquota" || o.startsWith("usrjquota="))) throw new HostConfigError(`${homesRoot} is mounted without user quota`);
}

export function assertRoot(uid: number | undefined): void {
  if (uid !== 0) throw new HostConfigError("the login host must run as root (it starts per-customer units)");
}
