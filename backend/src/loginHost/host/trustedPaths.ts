/**
 * ENG-2113: which paths the host (and the installer, before it switches to a release) must find root-controlled. A light module on purpose: the stand-alone
 * config checker bundles it without the rest of the host.
 */
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
