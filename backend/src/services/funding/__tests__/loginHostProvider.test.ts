/**
 * ENG-2110 PR 3: the production backend's way to find and authenticate to the login worker. Everything AWS is injected; the last test
 * runs the REAL mutual-TLS client against an in-process host with the test-only certificates. These protect: only a private address is
 * ever dialled, a bad or missing configuration fails CLOSED (and a bad update keeps the last good one), the certificate material is
 * never logged or put in an error, and the client is rebuilt only when something it depends on changes.
 */
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { startHostServer, type HostServerHandle } from "../../../loginHost/server";
import { makeRig, type Rig } from "../../../loginHost/__tests__/helpers";
import { LoginHostClient } from "../loginHostClient";
import {
  isPrivateIPv4, LoginHostProvider, LOGIN_HOST_SETTING_NAME, parseClientMaterial, parseLoginHostSetting, REFRESH_INTERVAL_MS, RETRY_AFTER_FAILURE_MS, SECRET_TTL_MS,
  type LoginHostProviderDeps,
} from "../loginHostProvider";

const PEM = (kind: string, body: string) => `-----BEGIN ${kind}-----\n${body.padEnd(40, "A")}\n-----END ${kind}-----\n`;
const MATERIAL = { cert: PEM("CERTIFICATE", "CLIENTCERT-SENTINEL"), key: PEM("PRIVATE KEY", "CLIENTKEY-SENTINEL-DO-NOT-LOG"), ca: PEM("CERTIFICATE", "CA-SENTINEL") };
const SETTING = { workers: [{ id: "w1", host: "172.31.30.50", port: 8443 }], defaultWorker: "w1" };
const row = (v: unknown) => ({ settingValue: typeof v === "string" ? v : JSON.stringify(v) });
const secret = (v: unknown = MATERIAL) => JSON.stringify(v);

describe("setting validation", () => {
  it("accepts the documented shape", () => expect(parseLoginHostSetting(JSON.stringify(SETTING))).toEqual(SETTING));

  it.each([
    ["a public address", { host: "8.8.8.8" }],
    ["the metadata address", { host: "169.254.169.254" }],
    ["loopback", { host: "127.0.0.1" }],
    ["link-local", { host: "169.254.10.10" }],
    ["a hostname", { host: "worker.internal" }],
    ["172.32.x (just outside 172.16/12)", { host: "172.32.0.1" }],
    ["172.15.x (just outside 172.16/12)", { host: "172.15.0.1" }],
    ["a non-canonical address", { host: "010.0.0.1" }],
    ["an address with a trailing dot", { host: "10.0.0.1." }],
    ["a CIDR", { host: "10.0.0.0/8" }],
    ["a port below 1024", { port: 443 }],
    ["a port above 65535", { port: 70000 }],
    ["a fractional port", { port: 8443.5 }],
    ["a string port", { port: "8443" }],
    ["an odd worker id", { id: "W 1" }],
  ])("rejects %s", (_n, over) => {
    const v = { workers: [{ ...SETTING.workers[0], ...over }], defaultWorker: (over as { id?: string }).id ?? "w1" };
    expect(parseLoginHostSetting(JSON.stringify(v))).toBeNull();
  });

  it("rejects unknown keys at both levels, a missing default worker, 0 or 9 workers, duplicate ids, junk", () => {
    expect(parseLoginHostSetting(JSON.stringify({ ...SETTING, extra: 1 }))).toBeNull();
    expect(parseLoginHostSetting(JSON.stringify({ workers: [{ ...SETTING.workers[0], tls: false }], defaultWorker: "w1" }))).toBeNull();
    expect(parseLoginHostSetting(JSON.stringify({ ...SETTING, defaultWorker: "w2" }))).toBeNull();
    expect(parseLoginHostSetting(JSON.stringify({ workers: [], defaultWorker: "w1" }))).toBeNull();
    const nine = Array.from({ length: 9 }, (_, i) => ({ id: `w${i + 1}`, host: `10.0.0.${i + 1}`, port: 8443 }));
    expect(parseLoginHostSetting(JSON.stringify({ workers: nine, defaultWorker: "w1" }))).toBeNull();
    expect(parseLoginHostSetting(JSON.stringify({ workers: nine.slice(0, 8), defaultWorker: "w1" }))).not.toBeNull();
    expect(parseLoginHostSetting(JSON.stringify({ workers: [SETTING.workers[0], SETTING.workers[0]], defaultWorker: "w1" }))).toBeNull();
    for (const junk of ["", "null", "[]", "42", "{", '"w1"']) expect(parseLoginHostSetting(junk)).toBeNull();
  });

  it("private ranges: 10/8, 172.16/12, 192.168/16 only", () => {
    for (const ok of ["10.0.0.1", "10.255.255.255", "172.16.0.1", "172.31.255.255", "192.168.1.1"]) expect(isPrivateIPv4(ok)).toBe(true);
    for (const no of ["11.0.0.1", "172.32.0.1", "192.169.0.1", "100.64.0.1", "0.0.0.0", "256.1.1.1", "1.2.3", ""]) expect(isPrivateIPv4(no)).toBe(false);
  });
});

describe("client material validation", () => {
  it("accepts {cert,key,ca} PEM and rejects everything else", () => {
    expect(parseClientMaterial(secret())).toEqual(MATERIAL);
    expect(parseClientMaterial(secret({ ...MATERIAL, extra: "x" }))).toBeNull();
    expect(parseClientMaterial(secret({ cert: MATERIAL.cert, key: MATERIAL.key }))).toBeNull();
    expect(parseClientMaterial(secret({ ...MATERIAL, key: "not a key" }))).toBeNull();
    expect(parseClientMaterial(secret({ ...MATERIAL, cert: 5 }))).toBeNull();
    expect(parseClientMaterial("{")).toBeNull();
  });
});

describe("LoginHostProvider", () => {
  let now: number;
  let setting: jest.Mock;
  let sec: jest.Mock;
  let built: Array<{ host: string; port: number }>;
  let logged: string[];

  const make = (over: Partial<LoginHostProviderDeps> = {}) =>
    new LoginHostProvider({
      getSetting: setting,
      getSecret: sec,
      now: () => now,
      buildClient: (w) => (built.push(w), new LoginHostClient({ json: async () => ({ status: 200, json: {} }), stream: async () => { throw new Error("n/a"); } })),
      ...over,
    });

  beforeEach(() => {
    now = 1_000_000;
    built = [];
    logged = [];
    setting = jest.fn(async () => row(SETTING));
    sec = jest.fn(async () => secret());
    for (const level of ["log", "info", "warn", "error"] as const) {
      jest.spyOn(console, level).mockImplementation((...a: unknown[]) => void logged.push(a.map((x) => (typeof x === "string" ? x : x instanceof Error ? `${x.message} ${x.stack}` : JSON.stringify(x))).join(" ")));
    }
  });
  afterEach(() => jest.restoreAllMocks());
  const flush = () => new Promise((r) => setImmediate(r));

  it("is undefined before anything is loaded (fail closed); the first call starts a refresh in the background", async () => {
    const p = make();
    expect(p.client()).toBeUndefined();
    await flush();
    expect(p.client()).toBeInstanceOf(LoginHostClient);
    expect(setting).toHaveBeenCalledWith(LOGIN_HOST_SETTING_NAME);
    expect(built).toEqual([{ host: "172.31.30.50", port: 8443 }]);
  });

  it("builds the client once and keeps returning the same one until the setting or the material changes", async () => {
    const p = make();
    await p.refresh();
    const first = p.client();
    for (let i = 0; i < 5; i++) {
      expect(p.client()).toBe(first);
      await p.refresh();
    }
    expect(built).toHaveLength(1);
    setting.mockResolvedValue(row({ workers: [{ id: "w1", host: "172.31.30.51", port: 8443 }], defaultWorker: "w1" }));
    await p.refresh();
    expect(p.client()).not.toBe(first);
    expect(built).toHaveLength(2);
    expect(built[1]).toEqual({ host: "172.31.30.51", port: 8443 });
    const second = p.client();
    now += SECRET_TTL_MS + 1;
    sec.mockResolvedValue(secret({ ...MATERIAL, cert: PEM("CERTIFICATE", "ROTATED-CERT") }));
    await p.refresh();
    expect(p.client()).not.toBe(second); // rotated certificate -> a new client
    expect(built).toHaveLength(3);
  });

  it("reads the secret only when missing or older than the TTL, the setting on every refresh", async () => {
    const p = make();
    await p.refresh();
    await p.refresh();
    expect(sec).toHaveBeenCalledTimes(1);
    expect(setting).toHaveBeenCalledTimes(2);
    now += SECRET_TTL_MS - 1;
    await p.refresh();
    expect(sec).toHaveBeenCalledTimes(1);
    now += 2;
    await p.refresh();
    expect(sec).toHaveBeenCalledTimes(2);
  });

  it("a malformed setting update keeps the last good client; a missing row switches the worker off", async () => {
    const p = make();
    await p.refresh();
    const good = p.client();
    for (const bad of ["{", JSON.stringify({ ...SETTING, workers: [{ id: "w1", host: "8.8.8.8", port: 8443 }] }), JSON.stringify({ ...SETTING, extra: 1 })]) {
      setting.mockResolvedValue(row(bad));
      await p.refresh();
      expect(p.client()).toBe(good);
    }
    setting.mockResolvedValue(null);
    await p.refresh();
    expect(p.client()).toBeUndefined();
  });

  it("a failed setting or secret read keeps the last good client and never throws", async () => {
    const p = make();
    await p.refresh();
    const good = p.client();
    setting.mockRejectedValueOnce(Object.assign(new Error("boom CLIENTKEY-SENTINEL"), { code: "Throttled" }));
    await expect(p.refresh()).resolves.toBeUndefined();
    expect(p.client()).toBe(good);
    now += SECRET_TTL_MS + 1;
    sec.mockRejectedValueOnce(Object.assign(new Error("denied"), { code: "AccessDeniedException" }));
    await expect(p.refresh()).resolves.toBeUndefined();
    expect(p.client()).toBe(good);
    sec.mockResolvedValueOnce(secret({ ...MATERIAL, key: "garbage" }));
    now += SECRET_TTL_MS + 1;
    await p.refresh();
    expect(p.client()).toBe(good); // a malformed secret does not replace working material
  });

  it("the last good certificate material keeps serving a later address change while the secret stays unreadable or malformed", async () => {
    const p = make();
    await p.refresh();
    now += SECRET_TTL_MS + 1;
    sec.mockResolvedValue(secret({ ...MATERIAL, key: "garbage" }));
    setting.mockResolvedValue(row({ workers: [{ id: "w1", host: "172.31.30.99", port: 8443 }], defaultWorker: "w1" }));
    await p.refresh();
    expect(built).toEqual([{ host: "172.31.30.50", port: 8443 }, { host: "172.31.30.99", port: 8443 }]);
    expect(p.client()).toBeInstanceOf(LoginHostClient);
  });

  it("stays closed when the first load fails or the secret is bad, and does not hammer on every call", async () => {
    sec.mockRejectedValue(Object.assign(new Error("nope"), { code: "AccessDeniedException" }));
    const p = make();
    expect(p.client()).toBeUndefined();
    await flush();
    expect(p.client()).toBeUndefined();
    const calls = setting.mock.calls.length;
    for (let i = 0; i < 20; i++) {
      p.client();
      await flush(); // each call is a separate moment: still no new attempt inside the back-off window
    }
    expect(setting.mock.calls.length).toBe(calls); // within RETRY_AFTER_FAILURE_MS: no new attempt
    now += RETRY_AFTER_FAILURE_MS;
    p.client();
    await flush();
    expect(setting.mock.calls.length).toBe(calls + 1);
  });

  it("never puts the certificate material (or an error message) in a log line", async () => {
    const p = make();
    await p.refresh();
    setting.mockRejectedValueOnce(new Error(`leak ${MATERIAL.key}`));
    await p.refresh();
    now += SECRET_TTL_MS + 1;
    sec.mockRejectedValueOnce(new Error(`leak ${MATERIAL.key}`));
    await p.refresh();
    sec.mockResolvedValueOnce(secret({ ...MATERIAL, ca: "bad" }));
    now += SECRET_TTL_MS + 1;
    await p.refresh();
    setting.mockResolvedValueOnce(row("{ bad CLIENTKEY-SENTINEL"));
    await p.refresh();
    const all = logged.join("\n");
    expect(all.length).toBeGreaterThan(0);
    for (const needle of ["SENTINEL", "PRIVATE KEY", "BEGIN CERT", "172.31.30.50"]) expect(all).not.toContain(needle);
  });

  it("an exception while BUILDING the client is logged by code only and never thrown or leaked", async () => {
    const p = make({ buildClient: () => { throw Object.assign(new Error(`leak ${MATERIAL.key}`), { code: "BuildFailed" }); } });
    await expect(p.refresh()).resolves.toBeUndefined();
    expect(p.client()).toBeUndefined();
    const all = logged.join("\n");
    expect(all).toContain("BuildFailed");
    expect(all).not.toContain("SENTINEL");
  });

  it("start() refreshes on a timer and stop() clears it; the timer is unref'd", () => {
    const handle = { unref: jest.fn() };
    const set = jest.fn<unknown, [() => void, number]>(() => handle);
    const clear = jest.fn();
    const p = make({ setInterval: set, clearInterval: clear });
    p.start();
    p.start(); // idempotent
    expect(set).toHaveBeenCalledTimes(1);
    expect(set.mock.calls[0][1]).toBe(REFRESH_INTERVAL_MS);
    expect(handle.unref).toHaveBeenCalled();
    set.mock.calls[0][0]();
    expect(setting).toHaveBeenCalled();
    p.stop();
    expect(clear).toHaveBeenCalledWith(handle);
    p.stop(); // harmless twice
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it("uses the dev/ secret outside production and prod/ in production", () => {
    const env = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = "production";
      const pr = make({ secretName: undefined });
      void pr.refresh();
      process.env.NODE_ENV = "development";
      const dv = make({ secretName: undefined });
      void dv.refresh();
    } finally {
      process.env.NODE_ENV = env;
    }
    return flush().then(() => {
      expect(sec.mock.calls.map((c) => c[0])).toEqual(expect.arrayContaining(["prod/AgentWeb/LoginHost/client", "dev/AgentWeb/LoginHost/client"]));
    });
  });
});

describe("provider + REAL mutual TLS", () => {
  const F = join(__dirname, "../../../loginHost/__tests__/fixtures/tls");
  const pem = (n: string) => readFileSync(join(F, n), "utf8");
  let rig: Rig;
  let dir: string;
  let handle: HostServerHandle;

  afterEach(async () => {
    await handle?.close();
    rig?.cleanup();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("builds a working client from the setting row and the secret: a real call over TLS completes", async () => {
    rig = makeRig();
    dir = mkdtempSync(join(tmpdir(), "lh-prov-"));
    handle = await startHostServer(rig.mgr, {
      socketPath: join(dir, "host.sock"), tickMs: 3_600_000, sweepMs: 3_600_000,
      tls: { host: "127.0.0.1", port: 0, cert: pem("server.pem"), key: pem("server.key.pem"), ca: pem("ca.pem"), clientCommonNames: ["agentweb-backend-test"] },
    });
    // The address check is the PRODUCTION rule (private ranges only), so the test dials through a setting that names a private address
    // and a build hook that redirects to the in-process listener: the real transport, certificates and host handler are all exercised.
    const { MutualTlsTransport } = await import("../loginHostClient");
    const provider = new LoginHostProvider({
      getSetting: async () => row({ workers: [{ id: "w1", host: "10.0.0.7", port: 8443 }], defaultWorker: "w1" }),
      getSecret: async () => secret({ cert: pem("client.pem"), key: pem("client.key.pem"), ca: pem("ca.pem") }),
      buildClient: (_w, m) => new LoginHostClient(new MutualTlsTransport({ host: "127.0.0.1", port: handle.tlsPort!, cert: m.cert, key: m.key, ca: m.ca })),
    });
    await provider.refresh();
    const c = provider.client();
    expect(c).toBeDefined();
    await expect(c!.connectionStatus({ connectionId: "nope" })).rejects.toMatchObject({ code: "ENOTFOUND" }); // answered by the host's handler, over mutual TLS
  });
});
