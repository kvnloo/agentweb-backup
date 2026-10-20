/**
 * ENG-2110 PR 1b-ii part 2: the pinned vendor binary is verified before the host serves anything: an absolute
 * path whose every component is root-owned and not writable by group/other, a regular file (not a symlink), and
 * an exact sha256. The binary is never executed here (no root-run vendor code at start-up); its version string
 * comes from the pinned config and the install path.
 */
import { createHash } from "crypto";
import { createReadStream, lstatSync } from "fs";
import { dirname } from "path";
import { HostConfigError } from "./hostConfig";

export interface VerifiedBinary {
  path: string;
  version: string;
  digest: string;
}

export interface BinaryCheckOptions {
  /** Production: 0 (every component owned by root). Tests run unprivileged and pass the current uid. */
  expectedOwnerUid?: number;
  /** The walk up from the file stops after checking this directory (default "/": every ancestor is checked). Tests use a temp dir. */
  boundary?: string;
}

export function assertTrustedPath(path: string, opts: BinaryCheckOptions = {}): void {
  const owner = opts.expectedOwnerUid ?? 0;
  let p = path;
  for (;;) {
    const st = lstatSync(p);
    if (st.isSymbolicLink()) throw new HostConfigError(`${p} is a symlink`);
    if (st.uid !== owner) throw new HostConfigError(`${p} is not owned by uid ${owner}`);
    if (st.mode & 0o022) throw new HostConfigError(`${p} is writable by group or others`);
    if (p === (opts.boundary ?? "/")) return;
    const parent = dirname(p);
    if (parent === p) return;
    p = parent;
  }
}

export async function verifyBinary(path: string, expectedSha256: string, version: string, opts: BinaryCheckOptions = {}): Promise<VerifiedBinary> {
  assertTrustedPath(path, opts);
  if (!lstatSync(path).isFile()) throw new HostConfigError(`${path} is not a regular file`);
  const h = createHash("sha256");
  await new Promise<void>((resolve, reject) => createReadStream(path).on("data", (d) => h.update(d)).on("end", () => resolve()).on("error", reject));
  const hex = h.digest("hex");
  if (hex !== expectedSha256) throw new HostConfigError(`binary digest mismatch: ${path} is ${hex.slice(0, 12)}…, expected ${expectedSha256.slice(0, 12)}…`);
  return { path, version, digest: `sha256:${hex}` };
}
