/**
 * ENG-2113: which paths the host (and the installer, before it switches to a release) must find root-controlled. A light module on purpose: the stand-alone
 * config checker bundles it without the rest of the host.
 */
import { lstatSync } from "fs";
import { dirname } from "path";
import { assertTrustedPath } from "./binary";
import type { HostConfig } from "./hostConfig";

/**
 * Everything the host or a customer unit executes or reads as policy must be root-controlled: root-owned, not group/other-writable, and NO SYMLINK anywhere
 * on the path (assertTrustedPath). So a configured path must be the REAL path: /usr/bin/node on the prod worker is a symlink (install.sh), which is why the
 * prod config names /opt/aw-node/v<version>/bin/node. Shared by runMain and the tests; `check` is a seam for tests (a temp tree owned by the current uid).
 */
export function hostTrustedPaths(cfg: HostConfig): string[] {
  return [
    ...(cfg.tls ? [cfg.tls.certPath, cfg.tls.keyPath, cfg.tls.caPath] : []),
    cfg.claude.turnWrapperPath,
    cfg.claude.relayShimPath,
    cfg.claude.nodePath,
    cfg.egress.launcherPath,
    cfg.egress.socat,
    cfg.claude.systemPromptFile,
    cfg.tools.writeFileHelper,
    cfg.tools.systemRun,
    cfg.tools.systemctl,
    cfg.tools.setpriv,
    cfg.tools.env,
    cfg.tools.rm,
    cfg.tools.find,
    ...(cfg.quota ? [cfg.tools.setquota] : []),
  ];
}
export function assertHostTrustedPaths(cfg: HostConfig, check: (p: string) => void = (p) => assertTrustedPath(p)): void {
  for (const p of hostTrustedPaths(cfg)) check(p);
}

/**
 * The other half of "the host can start": a CUSTOMER uid (not root, not the owner) must be able to reach and use what its unit is given. Every directory on the
 * path must be traversable by others, and the file itself executable (the pinned node) or readable (the shim, which node reads) by others. Walks the real path
 * (assertTrustedPath has already refused symlinks); `boundary` stops the walk (tests).
 */
export function assertCustomerCanUse(path: string, need: "execute" | "read", boundary?: string): void {
  let p = path;
  for (;;) {
    const mode = lstatSync(p).mode;
    const isFile = p === path;
    const bit = isFile ? (need === "execute" ? 0o001 : 0o004) : 0o001;
    if (!(mode & bit)) throw new Error(`${p} is not ${isFile ? (need === "execute" ? "executable" : "readable") : "traversable"} by other users: a customer unit could not use it`);
    if (p === (boundary ?? "/")) return;
    const parent = dirname(p);
    if (parent === p) return;
    p = parent;
  }
}
