/**
 * ENG-2113 (security review): how the host wires the relay in PRODUCTION, which unprivileged unit tests cannot see by running it:
 * sockets and directories belong to the customer uid unless a test turns it off, the relay root is emptied at start-up, and the host's logger reaches the adapter.
 */
import "../fixtures/tls/ensureFixtures";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createFakeAdapter, newScript } from "../../adapters/fakeAdapter";
import { parseHostConfig } from "../../host/hostConfig";
import { buildHost, startHost } from "../../host/main";
import type { VerifiedBinary } from "../../host/binary";
import { noopLogger } from "../../ports";
import { FakeSystem } from "../ports/fakeSystem";

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const cfg = () =>
  parseHostConfig({
    env: "test1",
    uidMin: 400_000,
    uidMax: 410_000,
    socket: { dir: "/run/aw-login-host-test1", gid: 990 },
    egress: { allow: ["api.anthropic.com:443"] },
    claude: { binaryPath: "/opt/aw-claude/2.1.294/claude", expectedSha256: "a".repeat(64), version: "2.1.294", systemPromptFile: "/opt/aw-login-host/system-prompt.txt", nodePath: "/opt/aw-node/v22.23.3/bin/node", bridgeUrl: "http://127.0.0.1:3001/mcp" },
  });
const binary = (c: ReturnType<typeof cfg>): VerifiedBinary => ({ path: c.claude.binaryPath, version: "2.1.294", digest: "sha256:" + "a".repeat(64) });

describe("relay wiring in the host", () => {
  it("MUTATION TARGET: a host config without claude.nodePath does not parse (the relay needs the real node path)", () => {
    const c = JSON.parse(JSON.stringify(cfg()));
    delete c.claude.nodePath;
    expect(() => parseHostConfig(c)).toThrow(/nodePath/);
  });

  it("MUTATION TARGET: in production (no test override) the relay hands sockets and directories to the customer uid; only a test turns that off", () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-wire-"));
    dirs.push(dir);
    const c = cfg();
    const sys = new FakeSystem();
    const prod = buildHost(c, binary(c), { cmd: sys, root: sys, log: noopLogger, stateDir: join(dir, "state") });
    expect(prod.relay.ownByUid).toBe(true);
    const test = buildHost(c, binary(c), { cmd: sys, root: sys, log: noopLogger, stateDir: join(dir, "state2"), chownSocket: false });
    expect(test.relay.ownByUid).toBe(false);
    // the relay root of production is the per-environment directory under /run
    expect(prod.layout.relayRoot).toBe("/run/aw-relay-test1");
  });

  it("MUTATION TARGET: start-up empties the relay root (sockets and directories of a previous run are dead), and the root exists afterwards", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-wire-"));
    dirs.push(dir);
    const relayRoot = join(dir, "relay");
    const stale = join(relayRoot, "400001", "feedfacefeedfacefeedfacefeedface");
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, "relay.sock"), "stale");
    writeFileSync(join(relayRoot, "stray-file"), "x");
    const c = cfg();
    const sys = new FakeSystem();
    const host = await startHost(c, binary(c), {
      cmd: sys,
      root: sys,
      log: noopLogger,
      stateDir: join(dir, "state"),
      adapters: new Map([["fake", createFakeAdapter(newScript(), { singleUse: true })]]),
      chownSocket: false,
      socketDir: join(dir, "run"),
      egressDir: join(dir, "egress"),
      relayRoot,
    });
    try {
      expect(existsSync(relayRoot)).toBe(true);
      expect(existsSync(stale)).toBe(false);
      expect(existsSync(join(relayRoot, "stray-file"))).toBe(false);
    } finally {
      await host.shutdown();
    }
  });
});
