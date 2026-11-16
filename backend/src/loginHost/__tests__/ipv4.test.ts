/**
 * ENG-2110 PR 3: the ONE IPv4 validator the host config and the backend's settings provider share. The corpus below is run through both
 * real consumers, so the two sides cannot drift: a literal either accepts is canonical, and the only difference is the policy on top
 * (the worker may bind any network address of its own; the backend may only dial RFC 1918).
 */
import { isCanonicalIPv4, isRfc1918, parseIPv4, unusableAddressReason } from "../ipv4";
import { HostConfigError, parseHostConfig } from "../host/hostConfig";
import { parseLoginHostSetting } from "../../services/funding/loginHostProvider";

const NOT_CANONICAL = [
  "000.0.0.0", "0127.0.0.1", "010.1.1.1", "10.01.1.1", "10.1.1.01", "999.1.1.1", "256.1.1.1", "1.2.3", "1.2.3.4.5", " 10.0.0.1", "10.0.0.1 ", "10.0.0.1\n",
  "0x7f.0.0.1", "0x0a000001", "2130706433", "167772161", "::1", "::ffff:10.0.0.1", "10.0.0.1:8443", "10.0.0.1.", ".10.0.0.1", "10.0.0.0/8", "10.0.0.-1", "a.b.c.d", "", "10..0.1",
];
//        literal            rfc1918  unusable-to-bind (host config refuses)
const CANONICAL: Array<[string, boolean, string | null]> = [
  ["10.0.0.1", true, null],
  ["10.255.255.255", true, null],
  ["172.16.0.1", true, null],
  ["172.31.255.255", true, null],
  ["172.31.30.50", true, null],
  ["192.168.1.1", true, null],
  ["172.15.255.255", false, null],
  ["172.32.0.1", false, null],
  ["192.169.0.1", false, null],
  ["8.8.8.8", false, null],
  ["100.64.0.1", false, null],
  ["0.0.0.0", false, "unspecified"],
  ["0.1.2.3", false, "unspecified"],
  ["127.0.0.1", false, "loopback"],
  ["127.255.255.254", false, "loopback"],
  ["169.254.169.254", false, "link-local"],
  ["169.254.0.1", false, "link-local"],
  ["224.0.0.1", false, "multicast"],
  ["239.255.255.255", false, "multicast"],
  ["240.0.0.1", false, "reserved"],
  ["255.255.255.255", false, "reserved"],
];

const hostCfg = (host: string) => ({
  env: "test1", uidMin: 400_000, uidMax: 410_000, socket: { dir: "/run/aw-login-host-test1", gid: 990 }, egress: { allow: ["api.anthropic.com:443"] },
  tls: { host, port: 8443, certPath: "/etc/a/server.crt", keyPath: "/etc/a/server.key", caPath: "/etc/a/ca.crt", clientCommonNames: ["agentweb-backend-prod"] },
  claude: { binaryPath: "/opt/a/claude", expectedSha256: "a".repeat(64), version: "1", systemPromptFile: "/opt/p", nodePath: "/opt/aw-node/v22.23.3/bin/node", bridgeUrl: "http://127.0.0.1:1/mcp" },
});
const hostAccepts = (host: string) => {
  try {
    parseHostConfig(hostCfg(host));
    return true;
  } catch (e) {
    if (e instanceof HostConfigError) return false;
    throw e;
  }
};
const providerAccepts = (host: string) => parseLoginHostSetting(JSON.stringify({ workers: [{ id: "w1", host, port: 8443 }], defaultWorker: "w1" })) !== null;

describe("the shared IPv4 validator", () => {
  it.each(NOT_CANONICAL)("%j is not a canonical IPv4 literal", (text) => {
    expect(parseIPv4(text)).toBeNull();
    expect(isCanonicalIPv4(text)).toBe(false);
    expect(isRfc1918(text)).toBe(false);
    expect(unusableAddressReason(text)).toBeNull(); // not an address at all: the format check owns that
  });

  it.each(CANONICAL)("%s: rfc1918=%s, unusable=%s", (text, private_, unusable) => {
    expect(isCanonicalIPv4(text)).toBe(true);
    expect(parseIPv4(text)).toHaveLength(4);
    expect(isRfc1918(text)).toBe(private_);
    expect(unusableAddressReason(text)).toBe(unusable);
  });
});

describe("both consumers apply the same format rule (they cannot drift)", () => {
  it.each(NOT_CANONICAL)("%j: refused by the host config AND the backend's settings", (text) => {
    expect(hostAccepts(text)).toBe(false);
    expect(providerAccepts(text)).toBe(false);
  });

  it.each(CANONICAL)("%s: host accepts iff usable (%s); backend accepts iff RFC 1918", (text, private_, unusable) => {
    expect(hostAccepts(text)).toBe(unusable === null);
    expect(providerAccepts(text)).toBe(private_);
  });
});
