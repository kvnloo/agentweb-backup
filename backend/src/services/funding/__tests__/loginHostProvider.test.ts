/**
 * ENG-2110 PR 3: the production backend's way to find and authenticate to the login worker. Everything AWS is injected; the last test
 * runs the REAL mutual-TLS client against an in-process host with the test-only certificates. These protect: only a private address is
 * ever dialled, a bad or missing configuration fails CLOSED (and a bad update keeps the last good one), the certificate material is
 * never logged or put in an error, and the client is rebuilt only when something it depends on changes.
 */
// The test-only TLS keys and certificates are generated on first use (they are not committed): this import must come first.
import "../../../loginHost/__tests__/fixtures/tls/ensureFixtures";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { startHostServer, type HostServerHandle } from "../../../loginHost/server";
import { makeRig, type Rig } from "../../../loginHost/__tests__/helpers";
import { PROTOCOL_VERSION } from "../../../loginHost/protocol";
import { LoginHostClient, LoginHostError } from "../loginHostClient";
import {
  CERT_WARN_DAYS, CERT_WARN_EVERY_MS, clientCertNotAfterMs, daysUntil, defaultBuild, defaultSecretName, isPrivateIPv4, LoginHostProvider, LOGIN_HOST_SETTING_NAME, parseClientMaterial, parseLoginHostSetting,
  parseLoginHostSettingDetailed, PROTOCOL_RECHECK_MS, REFRESH_INTERVAL_MS, RETRY_AFTER_FAILURE_MS, SECRET_TTL_MS,
  type LoginHostProviderDeps,
  INVALIDATE_COOLDOWN_MS,
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

  it("ignores unknown keys (a newer row must not darken older instances), but still refuses a bad shape", () => {
    expect(parseLoginHostSetting(JSON.stringify({ ...SETTING, extra: 1 }))).toEqual(SETTING);
    expect(parseLoginHostSetting(JSON.stringify({ workers: [{ ...SETTING.workers[0], tls: false }], defaultWorker: "w1" }))).toEqual(SETTING);
    expect(parseLoginHostSetting(JSON.stringify({ ...SETTING, defaultWorker: "w2" }))).toBeNull();
    expect(parseLoginHostSetting(JSON.stringify({ workers: [], defaultWorker: "w1" }))).toBeNull();
    for (const junk of ["", "null", "[]", "42", "{", '"w1"']) expect(parseLoginHostSetting(junk)).toBeNull();
  });

  it("exactly ONE worker: connection records do not say which worker holds a login, so a second entry (or a changed one) would orphan logins", () => {
    const two = [SETTING.workers[0], { id: "w2", host: "172.31.30.51", port: 8443 }];
    expect(parseLoginHostSetting(JSON.stringify({ workers: two, defaultWorker: "w1" }))).toBeNull();
    expect(parseLoginHostSetting(JSON.stringify({ workers: [SETTING.workers[0], SETTING.workers[0]], defaultWorker: "w1" }))).toBeNull();
    expect(parseLoginHostSetting(JSON.stringify({ workers: Array.from({ length: 9 }, (_, i) => ({ id: `w${i + 1}`, host: `10.0.0.${i + 1}`, port: 8443 })), defaultWorker: "w1" }))).toBeNull();
  });

  it("a row version this build does not understand fails closed with its own reason; v:1 is fine", () => {
    expect(parseLoginHostSetting(JSON.stringify({ ...SETTING, v: 1 }))).toEqual({ ...SETTING, v: 1 });
    for (const bad of [2, 0, "1", null, 1.5]) {
      const r = parseLoginHostSettingDetailed(JSON.stringify({ ...SETTING, v: bad }));
      expect(r).toEqual({ ok: false, reason: "version" });
    }
    expect(parseLoginHostSettingDetailed("{")).toEqual({ ok: false, reason: "json" });
    expect(parseLoginHostSettingDetailed(JSON.stringify({ workers: [] }))).toEqual({ ok: false, reason: "shape" });
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

  it("uses the dev/ secret outside production and the prod/ secret in production (each exactly, asserted separately)", async () => {
    const env = process.env.NODE_ENV;
    const read = async (nodeEnv: string) => {
      const calls = jest.fn(async () => secret());
      try {
        process.env.NODE_ENV = nodeEnv;
        const p = new LoginHostProvider({ getSetting: setting, getSecret: calls, now: () => now, buildClient: () => new LoginHostClient({ json: async () => ({ status: 200, json: {} }), stream: async () => { throw new Error("n/a"); } }) });
        await p.refresh();
      } finally {
        process.env.NODE_ENV = env;
      }
      return calls.mock.calls.map((c) => (c as unknown as [string])[0]);
    };
    expect(await read("production")).toEqual(["prod/AgentWeb/LoginHost/client"]);
    expect(await read("development")).toEqual(["dev/AgentWeb/LoginHost/client"]);
    expect(await read("test")).toEqual(["dev/AgentWeb/LoginHost/client"]);
    expect(defaultSecretName()).toMatch(/^(dev|prod)\/AgentWeb\/LoginHost\/client$/);
  });
});

describe("worker protocol check (host.info)", () => {
  let now: number;
  let logged: string[];
  const mk = (hostInfo: () => Promise<{ protocol: number; node: string; uptimeSec: number }>) => {
    const client = Object.assign(new LoginHostClient({ json: async () => ({ status: 200, json: {} }), stream: async () => { throw new Error("n/a"); } }), { hostInfo });
    return new LoginHostProvider({ getSetting: async () => row(SETTING), getSecret: async () => secret(), now: () => now, buildClient: () => client });
  };
  beforeEach(() => {
    now = 1_000_000;
    logged = [];
    for (const level of ["log", "info", "warn", "error"] as const) jest.spyOn(console, level).mockImplementation((...a: unknown[]) => void logged.push(a.map(String).join(" ")));
  });
  afterEach(() => jest.restoreAllMocks());
  const settle = async (p: LoginHostProvider) => {
    await p.refresh();
    await new Promise((r) => setImmediate(r));
  };

  it("is unknown until the worker answers, then 'match' when the versions agree", async () => {
    const p = mk(async () => ({ protocol: PROTOCOL_VERSION, node: "v22", uptimeSec: 1 }));
    expect(p.protocolStatus()).toBe("unknown");
    await settle(p);
    expect(p.protocolStatus()).toBe("match");
    expect(p.workerProtocol()).toBe(PROTOCOL_VERSION);
  });

  it("invalidateProtocol (the worker contradicted the cache: a rollback) forgets 'match / 4' at once and asks host.info again", async () => {
    let answer = 4;
    let asked = 0;
    const p = mk(async () => (asked++, { protocol: answer, node: "v22", uptimeSec: 1 }));
    await settle(p);
    expect([p.protocolStatus(), p.workerProtocol()]).toEqual(["match", 4]);
    answer = 3; // the worker was rolled back
    now += 1_000; // far inside the 10 minute recheck window: without the invalidation the cache would still say 4
    await settle(p);
    expect(p.workerProtocol()).toBe(4);
    const before = asked;
    p.invalidateProtocol();
    expect(p.protocolStatus()).toBe("unknown"); // fail closed until the answer arrives
    await new Promise((r) => setImmediate(r));
    expect(asked).toBe(before + 1);
    expect([p.protocolStatus(), p.workerProtocol()]).toEqual(["match", 3]);
  });

  it("a check that started BEFORE the invalidation cannot write its stale 'match / 4' back over the invalidation; the fresh check decides", async () => {
    const waiting: Array<(v: { protocol: number; node: string; uptimeSec: number }) => void> = [];
    let first = true;
    const p = mk(async () => {
      if (first) {
        first = false;
        return { protocol: 4, node: "v22", uptimeSec: 1 };
      }
      return new Promise((resolve) => waiting.push(resolve));
    });
    await settle(p);
    now += 11 * 60_000; // past the recheck window: the next refresh starts a check (stale-able)
    void p.refresh();
    await new Promise((r) => setImmediate(r));
    expect(waiting).toHaveLength(1); // the old check is in flight
    p.invalidateProtocol();
    expect(p.protocolStatus()).toBe("unknown");
    await new Promise((r) => setImmediate(r));
    expect(waiting).toHaveLength(2); // and a fresh one was started, not blocked behind it
    waiting[0]({ protocol: 4, node: "v22", uptimeSec: 1 }); // the stale answer arrives first
    await new Promise((r) => setImmediate(r));
    expect(p.protocolStatus()).toBe("unknown"); // ignored
    waiting[1]({ protocol: 3, node: "v22", uptimeSec: 1 });
    await new Promise((r) => setImmediate(r));
    expect([p.protocolStatus(), p.workerProtocol()]).toEqual(["match", 3]);
  });

  it("S7: a flood of invalidations costs one host.info per cool-down (a compromised worker cannot flap the fleet or make the backend hammer it)", async () => {
    let asked = 0;
    const p = mk(async () => (asked++, { protocol: 4, node: "v22", uptimeSec: 1 }));
    await settle(p);
    const base = asked;
    for (let i = 0; i < 1000; i++) p.invalidateProtocol();
    await new Promise((r) => setImmediate(r));
    expect(asked - base).toBe(1);
    expect(p.protocolStatus()).toBe("match"); // the one recheck answered 4: relaying goes on, no long unknown window
    now += INVALIDATE_COOLDOWN_MS - 1;
    for (let i = 0; i < 50; i++) p.invalidateProtocol();
    expect(asked - base).toBe(1);
    now += 2;
    p.invalidateProtocol();
    await new Promise((r) => setImmediate(r));
    expect(asked - base).toBe(2);
  });

  it("a version outside the accepted set is a logged 'mismatch' (never fatal: the client is still returned)", async () => {
    const p = mk(async () => ({ protocol: 5, node: "v22", uptimeSec: 1 }));
    await settle(p);
    expect(p.protocolStatus()).toBe("mismatch");
    expect(p.workerProtocol()).toBe(5);
    expect(p.client()).toBeInstanceOf(LoginHostClient);
    expect(logged.filter((l) => l.includes("login_host_protocol_mismatch"))).toHaveLength(1);
    await settle(p);
    await settle(p);
    expect(logged.filter((l) => l.includes("login_host_protocol_mismatch"))).toHaveLength(1); // once, not every minute
  });

  it("workers at protocol 2, 3 and 4 (the relay, deployed ahead of the backend that speaks it) are accepted, and workerProtocol() says which one it is", async () => {
    for (const v of [2, 3, 4]) {
      logged.length = 0;
      const p = mk(async () => ({ protocol: v, node: "v22", uptimeSec: 1 }));
      await settle(p);
      expect(p.protocolStatus()).toBe("match");
      expect(p.workerProtocol()).toBe(v);
      expect(logged.filter((l) => l.includes("login_host_protocol_mismatch"))).toHaveLength(0);
    }
  });

  it("an older worker (1) is a mismatch (it refuses fields this backend sends)", async () => {
    const p = mk(async () => ({ protocol: 1, node: "v22", uptimeSec: 1 }));
    await settle(p);
    expect(p.protocolStatus()).toBe("mismatch");
  });

  it("an older worker (unknown route) stays 'unknown' with a logged cause, retried on each refresh until it answers, then flips to match without a restart", async () => {
    let answer: "old" | "new" = "old";
    const hostInfo = jest.fn(async () => {
      if (answer === "old") throw new LoginHostError("EINVALID", "route");
      return { protocol: PROTOCOL_VERSION, node: "v22", uptimeSec: 1 };
    });
    const p = mk(hostInfo);
    await settle(p);
    await settle(p);
    expect(p.protocolStatus()).toBe("unknown");
    expect(hostInfo.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(logged.filter((l) => l.includes("login_host_protocol_unknown cause=EINVALID/route"))).toHaveLength(1);
    answer = "new";
    await settle(p);
    expect(p.protocolStatus()).toBe("match");
  });

  it("re-verifies a matching worker after PROTOCOL_RECHECK_MS (a redeployed worker is noticed)", async () => {
    let protocol = PROTOCOL_VERSION;
    const p = mk(async () => ({ protocol, node: "v22", uptimeSec: 1 }));
    await settle(p);
    expect(p.protocolStatus()).toBe("match");
    protocol = 5;
    now += PROTOCOL_RECHECK_MS - 1;
    await settle(p);
    expect(p.protocolStatus()).toBe("match"); // not yet
    now += 2;
    await settle(p);
    expect(p.protocolStatus()).toBe("mismatch");
  });
});

describe("client certificate expiry visibility", () => {
  const F = join(__dirname, "../../../loginHost/__tests__/fixtures/tls");
  const realMaterial = { cert: readFileSync(join(F, "client.pem"), "utf8"), key: readFileSync(join(F, "client.key.pem"), "utf8"), ca: readFileSync(join(F, "ca.pem"), "utf8") };
  const DAY = 24 * 60 * 60 * 1000;
  let logged: string[];
  beforeEach(() => {
    logged = [];
    for (const level of ["log", "info", "warn", "error"] as const) jest.spyOn(console, level).mockImplementation((...a: unknown[]) => void logged.push(a.map(String).join(" ")));
  });
  afterEach(() => jest.restoreAllMocks());

  const providerAt = (nowFn: () => number) =>
    new LoginHostProvider({
      getSetting: async () => row(SETTING),
      getSecret: async () => JSON.stringify(realMaterial),
      now: nowFn,
      buildClient: () => new LoginHostClient({ json: async () => ({ status: 200, json: {} }), stream: async () => { throw new Error("n/a"); } }),
    });

  it("the pure date math: whole days left, negative once expired", () => {
    expect(daysUntil(10 * DAY, 0)).toBe(10);
    expect(daysUntil(10 * DAY, 0.5 * DAY)).toBe(9);
    expect(daysUntil(10 * DAY, 10 * DAY)).toBe(0);
    expect(daysUntil(10 * DAY, 11 * DAY)).toBe(-1);
    expect(clientCertNotAfterMs("not a certificate")).toBeUndefined();
    expect(clientCertNotAfterMs(realMaterial.cert)).toBeGreaterThan(Date.parse("2100-01-01"));
  });

  it("a far-off expiry logs nothing; fewer than 30 days logs a warning with a day count; expired logs an error", async () => {
    const notAfter = clientCertNotAfterMs(realMaterial.cert)!;
    let now = notAfter - 400 * DAY;
    const p = providerAt(() => now);
    await p.refresh();
    expect(p.clientCertDaysLeft()).toBe(400);
    expect(logged.filter((l) => l.includes("login_host_client_cert"))).toEqual([]);
    now = notAfter - (CERT_WARN_DAYS - 1) * DAY - 1000;
    await p.refresh();
    expect(logged.filter((l) => l.includes("login_host_client_cert_expires_soon daysLeft=29"))).toHaveLength(1);
    now = notAfter + 2 * DAY + 1000;
    await p.refresh();
    expect(p.clientCertDaysLeft()).toBe(-3);
    expect(logged.filter((l) => l.includes("login_host_client_cert_expired daysAgo=3"))).toHaveLength(1);
  });

  it("the warning is rate limited to once per CERT_WARN_EVERY_MS however often the provider refreshes", async () => {
    const notAfter = clientCertNotAfterMs(realMaterial.cert)!;
    let now = notAfter - 5 * DAY;
    const p = providerAt(() => now);
    for (let i = 0; i < 10; i++) {
      await p.refresh();
      now += 60_000;
    }
    expect(logged.filter((l) => l.includes("login_host_client_cert_expires_soon"))).toHaveLength(1);
    now += CERT_WARN_EVERY_MS;
    await p.refresh();
    expect(logged.filter((l) => l.includes("login_host_client_cert_expires_soon"))).toHaveLength(2);
  });

  it("logs only a day count: never the certificate, the key or the secret", async () => {
    const notAfter = clientCertNotAfterMs(realMaterial.cert)!;
    const p = providerAt(() => notAfter - 3 * DAY);
    await p.refresh();
    const all = logged.join("\n");
    expect(all).toContain("login_host_client_cert_expires_soon daysLeft=3");
    expect(all).not.toMatch(/BEGIN|PRIVATE|MII[A-Za-z0-9]/);
  });

  it("an unparseable certificate gives no day count and no crash", async () => {
    const p = new LoginHostProvider({ getSetting: async () => row(SETTING), getSecret: async () => secret(), now: () => 1_000_000, buildClient: () => new LoginHostClient({ json: async () => ({ status: 200, json: {} }), stream: async () => { throw new Error("n/a"); } }) });
    await p.refresh();
    expect(p.clientCertDaysLeft()).toBeUndefined();
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

  it("the PRODUCTION build function (defaultBuild) dials with the right identity and trust anchor: swapping cert and ca would fail this", async () => {
    rig = makeRig();
    dir = mkdtempSync(join(tmpdir(), "lh-prov-"));
    handle = await startHostServer(rig.mgr, {
      socketPath: join(dir, "host.sock"), tickMs: 3_600_000, sweepMs: 3_600_000,
      tls: { host: "127.0.0.1", port: 0, cert: pem("server.pem"), key: pem("server.key.pem"), ca: pem("ca.pem"), clientCommonNames: ["agentweb-backend-test"] },
    });
    const m = { cert: pem("client.pem"), key: pem("client.key.pem"), ca: pem("ca.pem") };
    const good = defaultBuild({ host: "127.0.0.1", port: handle.tlsPort! }, m);
    await expect(good.connectionStatus({ connectionId: "nope" })).rejects.toMatchObject({ code: "ENOTFOUND" });
    // the wrong trust anchor, or the wrong identity, must not get an answer
    const wrongCa = defaultBuild({ host: "127.0.0.1", port: handle.tlsPort! }, { ...m, ca: pem("rogue-ca.pem") });
    await expect(wrongCa.connectionStatus({ connectionId: "nope" })).rejects.toMatchObject({ code: "UNREACHABLE" });
    const swapped = defaultBuild({ host: "127.0.0.1", port: handle.tlsPort! }, { cert: m.ca, key: m.key, ca: m.cert });
    await expect(swapped.connectionStatus({ connectionId: "nope" })).rejects.toMatchObject({ code: "UNREACHABLE" });
  });
});
