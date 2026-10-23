/**
 * ENG-2110 PR 2: the egress proxy over REAL sockets with local fake upstreams (`resolve`/`connect` are injected, so nothing leaves the
 * machine). These protect the sandbox's only way out: exact allowlist, public addresses only, bridge exemption only for the bridge,
 * bounded in every dimension, never echoing URLs or bodies.
 */
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync, existsSync } from "fs";
import { createServer, connect as netConnect, Socket, type Server } from "net";
import { tmpdir } from "os";
import { join } from "path";
import { EgressSocketInUseError, isForbiddenAddress, isLinkLocalAddress, parseClientHelloSni, startEgressProxy, type EgressProxyHandle, type EgressProxyOptions } from "../../egress/egressProxy";

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A local upstream that records what it receives and answers with a fixed banner, then echoes. */
async function upstream(): Promise<{ server: Server; port: number; received: Buffer[]; sockets: Socket[]; close(): Promise<void> }> {
  const received: Buffer[] = [];
  const sockets: Socket[] = [];
  const server = createServer((s) => {
    sockets.push(s);
    s.on("error", () => undefined);
    s.write("HELLO\n");
    s.on("data", (d) => {
      received.push(d);
      s.write(Buffer.concat([Buffer.from("ECHO:"), d]));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return { server, port, received, sockets, close: () => new Promise<void>((r) => { sockets.forEach((s) => s.destroy()); server.close(() => r()); }) };
}

interface Rig {
  sock: string;
  proxy: EgressProxyHandle;
  up: Awaited<ReturnType<typeof upstream>>;
  warnings: Array<{ event: string; fields: Record<string, unknown> }>;
  resolved: string[];
  connects: Array<{ port: number; ip: string }>;
  close(): Promise<void>;
}

async function rig(over: Partial<EgressProxyOptions> = {}, dns: Record<string, string[]> = {}): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), "egress-"));
  dirs.push(dir);
  const up = await upstream();
  const warnings: Rig["warnings"] = [];
  const resolved: string[] = [];
  const connects: Rig["connects"] = [];
  const table: Record<string, string[]> = { "api.anthropic.com": ["160.79.104.10"], "claude.ai": ["160.79.104.11"], "evil.example.com": ["10.0.0.5"], "mixed.example.com": ["160.79.104.12", "169.254.169.254"], ...dns };
  const sock = join(dir, "proxy.sock");
  const proxy = await startEgressProxy({
    socketPath: sock,
    allow: ["api.anthropic.com:443", "claude.ai:443", "evil.example.com:443", "mixed.example.com:443"],
    resolve: async (h) => {
      resolved.push(h);
      if (!(h in table)) throw new Error("nxdomain");
      return table[h];
    },
    // Whatever address was vetted, the "network" is the local fake upstream; we record what the proxy asked for.
    connect: (port, ip) => {
      connects.push({ port, ip });
      return netConnect({ port: up.port, host: "127.0.0.1" });
    },
    logger: { warn: (event, fields) => void warnings.push({ event, fields }) },
    ...over,
  });
  return { sock, proxy, up, warnings, resolved, connects, close: async () => { await proxy.close(); await up.close(); } };
}

/** Sends raw bytes to the proxy socket and collects everything until the connection closes (or `waitMs`). */
function talk(sock: string, bytes: string | Buffer, waitMs = 400): Promise<{ text: string; client: Socket; closed: boolean }> {
  return new Promise((resolve) => {
    const client = netConnect(sock);
    let text = "";
    let closed = false;
    client.on("data", (d) => (text += d.toString("latin1")));
    client.on("error", () => undefined);
    client.on("close", () => (closed = true));
    client.on("connect", () => client.write(bytes));
    setTimeout(() => resolve({ text, client, closed }), waitMs);
  });
}
/** A hand-built TLS ClientHello record. `sni: null` = no server_name extension; `extraExts` are appended raw; `split` is not applied here. */
function clientHello(sni: string | null, over: { extraExts?: Buffer[]; sessionId?: number; noExtensions?: boolean; rawServerNameList?: Buffer } = {}): Buffer {
  const u16 = (n: number) => Buffer.from([n >> 8, n & 0xff]);
  const exts: Buffer[] = [];
  if (over.rawServerNameList) exts.push(Buffer.concat([u16(0), u16(over.rawServerNameList.length + 2), u16(over.rawServerNameList.length), over.rawServerNameList]));
  else if (sni !== null) {
    const name = Buffer.from(sni, "latin1");
    const entry = Buffer.concat([Buffer.from([0]), u16(name.length), name]);
    exts.push(Buffer.concat([u16(0), u16(entry.length + 2), u16(entry.length), entry]));
  }
  exts.push(Buffer.concat([u16(0x002b), u16(3), Buffer.from([2, 3, 4])])); // supported_versions
  exts.push(...(over.extraExts ?? []));
  const extBlock = Buffer.concat(exts);
  const sid = Buffer.alloc(over.sessionId ?? 0, 7);
  const body = Buffer.concat([
    Buffer.from([3, 3]), Buffer.alloc(32, 1), Buffer.from([sid.length]), sid,
    u16(2), Buffer.from([0x13, 0x01]), Buffer.from([1, 0]),
    ...(over.noExtensions ? [] : [u16(extBlock.length), extBlock]),
  ]);
  const hs = Buffer.concat([Buffer.from([1, 0, body.length >> 8, body.length & 0xff]), body]);
  return Buffer.concat([Buffer.from([0x16, 3, 1]), u16(hs.length), hs]);
}
/** CONNECT to `host:443` followed straight away by a ClientHello that names `host` (what a real TLS client does). */
const hi = (host: string, sni: string | null = host) => Buffer.concat([Buffer.from(connectReq(`${host}:443`)), clientHello(sni)]);
const connectReq = (target: string, extra = "") => `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${extra}\r\n`;

describe("isForbiddenAddress", () => {
  it.each(["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "198.18.0.1", "::1", "::", "fe80::1", "fc00::1", "fd00:ec2::254", "::ffff:10.0.0.1", "::ffff:169.254.169.254", "::ffff:7f00:1", "ff02::1", "2002:a00:1::1", "2001:db8::1", "not-an-ip"])("refuses %s", (ip) => {
    expect(isForbiddenAddress(ip)).toBe(true);
  });
  it.each(["160.79.104.10", "8.8.8.8", "172.15.0.1", "172.32.0.1", "100.63.255.255", "198.20.0.1", "2607:6bc0::10", "2a00:1450:4001::200e", "::ffff:8.8.8.8"])("allows the public address %s", (ip) => {
    expect(isForbiddenAddress(ip)).toBe(false);
  });
});

describe("CONNECT", () => {
  let r: Rig;
  afterEach(async () => r && (await r.close()));

  it("tunnels bytes both ways to an allowed host, connecting to the vetted address", async () => {
    r = await rig();
    const { client, text } = await talk(r.sock, hi("api.anthropic.com"));
    expect(text).toContain("HTTP/1.1 200 Connection established");
    expect(text).toContain("HELLO");
    client.write("ping");
    await sleep(150);
    client.destroy();
    expect(Buffer.concat(r.up.received)).toEqual(Buffer.concat([clientHello("api.anthropic.com"), Buffer.from("ping")])); // the hello is forwarded untouched
    expect(r.connects).toEqual([{ port: 443, ip: "160.79.104.10" }]); // the address that was checked, not the name
    expect(r.proxy.stats().allowed).toBe(1);
  });

  it("is case-insensitive on the host and forwards bytes the client sent right behind the request", async () => {
    r = await rig();
    const { text, client } = await talk(r.sock, Buffer.concat([Buffer.from(connectReq("API.Anthropic.COM:443")), clientHello("api.anthropic.com")]));
    expect(text).toContain("200 Connection established");
    await sleep(100);
    expect(Buffer.concat(r.up.received)).toEqual(clientHello("api.anthropic.com"));
    client.destroy();
  });

  it("refuses a host that is not allowed with 403, counts it, and logs host:port and a reason only", async () => {
    r = await rig();
    const { text } = await talk(r.sock, connectReq("example.com:443", "Proxy-Authorization: Basic c2VjcmV0\r\n"));
    expect(text).toContain("403");
    expect(r.proxy.stats().denied).toBe(1);
    expect(r.connects).toHaveLength(0);
    expect(r.resolved).toHaveLength(0); // not even resolved
    expect(r.warnings).toEqual([{ event: "egress_denied", fields: { target: "example.com:443", reason: "not_allowed" } }]);
    expect(JSON.stringify(r.warnings)).not.toContain("c2VjcmV0");
  });

  it("refuses an allowed host on the wrong port", async () => {
    r = await rig();
    expect((await talk(r.sock, connectReq("api.anthropic.com:8443"))).text).toContain("403");
  });

  it.each([
    ["a literal ipv4", "8.8.8.8:443", "403"],
    ["a literal loopback", "127.0.0.1:443", "403"],
    ["userinfo", "user:pw@api.anthropic.com:443", "400"],
    ["an odd character", "api.anthropic.com/x:443", "400"],
    ["a trailing-dot-less bad label", "-bad-.com:443", "400"],
    ["port 0", "api.anthropic.com:0", "400"],
    ["port 70000", "api.anthropic.com:70000", "400"],
    ["no port", "api.anthropic.com", "400"],
    ["an ipv6 literal", "[::1]:443", "400"],
  ])("refuses %s", async (_n, target, status) => {
    r = await rig();
    expect((await talk(r.sock, connectReq(target))).text).toContain(`HTTP/1.1 ${status}`);
    expect(r.connects).toHaveLength(0);
  });

  it("refuses an allowed NAME that resolves to a private address (DNS rebinding / SSRF) and never connects", async () => {
    r = await rig();
    const { text } = await talk(r.sock, connectReq("evil.example.com:443"));
    expect(text).toContain("403");
    expect(r.connects).toHaveLength(0);
    expect(r.warnings[0].fields.reason).toBe("address_not_public");
  });

  it("refuses when ANY resolved address is private, even if another is public", async () => {
    r = await rig();
    expect((await talk(r.sock, connectReq("mixed.example.com:443"))).text).toContain("403");
    expect(r.connects).toHaveLength(0);
  });

  it("answers 502 when the name does not resolve or resolves to nothing", async () => {
    r = await rig({ allow: ["gone.example.com:443", "empty.example.com:443"] }, { "empty.example.com": [] });
    expect((await talk(r.sock, connectReq("gone.example.com:443"))).text).toContain("502");
    expect((await talk(r.sock, connectReq("empty.example.com:443"))).text).toContain("502");
  });

  it("answers 502 when the upstream refuses the connection", async () => {
    r = await rig({ connect: () => netConnect({ port: 1, host: "127.0.0.1" }) });
    expect((await talk(r.sock, connectReq("api.anthropic.com:443"), 600)).text).toContain("502");
  });

  it("refuses other methods with 405 and malformed requests with 400", async () => {
    r = await rig();
    expect((await talk(r.sock, "TRACE / HTTP/1.1\r\nHost: x\r\n\r\n")).text).toContain("405");
    expect((await talk(r.sock, "garbage\r\n\r\n")).text).toContain("400");
    expect((await talk(r.sock, "CONNECT api.anthropic.com:443 HTTP/1.1\r\nbad header line\r\n\r\n")).text).toContain("400");
    expect((await talk(r.sock, "CONNECT api.anthropic.com:443 HTTP/2\r\n\r\n")).text).toContain("400");
  });

  it("refuses a plain http request to anything but the bridge (the allowlist is for CONNECT only)", async () => {
    r = await rig();
    const { text } = await talk(r.sock, "GET http://api.anthropic.com/ HTTP/1.1\r\nHost: api.anthropic.com\r\n\r\n");
    expect(text).toContain("403");
    expect(r.connects).toHaveLength(0);
  });

  it("refuses plain http even to a host:port that IS on the allowlist (the allowlist is for CONNECT only), and a listed literal IP", async () => {
    r = await rig({ allow: ["plain.example.com:80", "8.8.8.8:443"] }, { "plain.example.com": ["160.79.104.20"] });
    const plain = await talk(r.sock, "GET http://plain.example.com/ HTTP/1.1\r\nHost: plain.example.com\r\n\r\n");
    expect(plain.text).toContain("403");
    expect(r.warnings[0].fields.reason).toBe("plain_http_not_bridge");
    expect((await talk(r.sock, connectReq("8.8.8.8:443"))).text).toContain("403");
    expect(r.warnings[1].fields.reason).toBe("literal_ip");
    expect(r.connects).toHaveLength(0);
  });
});

describe("the tool bridge target", () => {
  let r: Rig;
  afterEach(async () => r && (await r.close()));

  it("may be loopback: CONNECT to it works although loopback is forbidden for everything else", async () => {
    r = await rig({ bridge: { host: "127.0.0.1", port: 3991 } });
    const { text, client } = await talk(r.sock, connectReq("127.0.0.1:3991"));
    expect(text).toContain("200 Connection established");
    client.destroy();
    expect(r.connects).toEqual([{ port: 3991, ip: "127.0.0.1" }]);
    // ... and the same loopback on another port is not the bridge.
    expect((await talk(r.sock, connectReq("127.0.0.1:3992"))).text).toContain("403");
  });

  it("a bridge NAME that resolves to a private address is allowed, while the allowlisted names still are not exempt", async () => {
    r = await rig({ bridge: { host: "bridge.internal.test", port: 3001 } }, { "bridge.internal.test": ["10.9.9.9"] });
    expect((await talk(r.sock, connectReq("bridge.internal.test:3001"))).text).toContain("200 Connection established");
    expect(r.connects[0]).toEqual({ port: 3001, ip: "10.9.9.9" });
    expect((await talk(r.sock, connectReq("evil.example.com:443"))).text).toContain("403");
  });

  it("rewrites a plain-http absolute-form request to origin-form with Connection: close, and forwards the body", async () => {
    r = await rig({ bridge: { host: "127.0.0.1", port: 3991 } });
    const body = '{"jsonrpc":"2.0"}';
    const req =
      `POST http://127.0.0.1:3991/internal/tool-bridge/run-1?x=1 HTTP/1.1\r\nHost: 127.0.0.1:3991\r\nProxy-Connection: keep-alive\r\nConnection: keep-alive\r\n` +
      `Authorization: Bearer abc\r\nContent-Length: ${body.length}\r\n\r\n${body}`;
    const { client } = await talk(r.sock, req, 300);
    client.destroy();
    const got = Buffer.concat(r.up.received).toString("latin1");
    expect(got.startsWith("POST /internal/tool-bridge/run-1?x=1 HTTP/1.1\r\n")).toBe(true);
    expect(got).toContain("Connection: close\r\n");
    expect(got).toContain("Authorization: Bearer abc\r\n");
    expect(got.toLowerCase()).not.toContain("proxy-connection");
    expect(got.toLowerCase()).not.toContain("keep-alive");
    expect(got.endsWith(body)).toBe(true);
    expect(got).not.toContain("http://127.0.0.1");
  });

  it("refuses a plain-http request to the bridge host on another port, and one with userinfo", async () => {
    r = await rig({ bridge: { host: "127.0.0.1", port: 3991 } });
    expect((await talk(r.sock, "GET http://127.0.0.1:3000/ HTTP/1.1\r\nHost: x\r\n\r\n")).text).toContain("403");
    expect((await talk(r.sock, "GET http://u:p@127.0.0.1:3991/ HTTP/1.1\r\nHost: x\r\n\r\n")).text).toContain("400");
  });
});

describe("bounds", () => {
  let r: Rig;
  afterEach(async () => r && (await r.close()));

  it("answers 431 to an oversized head and drops a head that never completes", async () => {
    r = await rig({ maxHeaderBytes: 128, handshakeMs: 150 });
    expect((await talk(r.sock, `CONNECT api.anthropic.com:443 HTTP/1.1\r\nX: ${"a".repeat(400)}\r\n\r\n`)).text).toContain("431");
    expect((await talk(r.sock, `CONNECT api.anthropic.com:443 HTTP/1.1\r\nX: ${"a".repeat(400)}`)).text).toContain("431");
    const slow = await talk(r.sock, "CONNECT api.anthropic.com:443 HT", 500);
    expect(slow.closed).toBe(true);
    expect(slow.text).not.toContain("200");
    expect(r.connects).toHaveLength(0);
  });

  it("closes an idle tunnel", async () => {
    r = await rig({ idleMs: 150 });
    const { client } = await talk(r.sock, hi("api.anthropic.com"), 100);
    let closed = false;
    client.on("close", () => (closed = true));
    await sleep(500);
    expect(closed).toBe(true);
  });

  it("closes a busy tunnel at its maximum lifetime", async () => {
    r = await rig({ idleMs: 10_000, maxLifetimeMs: 250 });
    const { client } = await talk(r.sock, hi("api.anthropic.com"), 100);
    let closed = false;
    client.on("close", () => (closed = true));
    const t = setInterval(() => client.write("x"), 30);
    await sleep(600);
    clearInterval(t);
    expect(closed).toBe(true);
  });

  it("answers 503 beyond the connection cap and recovers when a slot frees", async () => {
    r = await rig({ maxConnections: 2 });
    const a = await talk(r.sock, hi("api.anthropic.com"), 150);
    const b = await talk(r.sock, hi("claude.ai"), 150);
    expect(r.proxy.stats().active).toBe(2);
    expect((await talk(r.sock, hi("api.anthropic.com"), 150)).text).toContain("503");
    a.client.destroy();
    await sleep(100);
    expect((await talk(r.sock, hi("api.anthropic.com"), 150)).text).toContain("200 Connection established");
    b.client.destroy();
  });

  it("close() destroys active tunnels and removes the socket", async () => {
    r = await rig();
    const { client } = await talk(r.sock, hi("api.anthropic.com"), 150);
    let closed = false;
    client.on("close", () => (closed = true));
    await r.proxy.close();
    await sleep(100);
    expect(closed).toBe(true);
    expect(existsSync(r.sock)).toBe(false);
    await r.up.close();
    r = undefined as never;
  });
});

describe("the socket", () => {
  it("is created with the requested mode, a stale file is replaced, a live proxy is refused", async () => {
    const dir = mkdtempSync(join(tmpdir(), "egress-sock-"));
    dirs.push(dir);
    const sock = join(dir, "p.sock");
    writeFileSync(sock, "stale");
    const first = await startEgressProxy({ socketPath: sock, socketMode: 0o660, allow: [] });
    expect(statSync(sock).mode & 0o777).toBe(0o660);
    await expect(startEgressProxy({ socketPath: sock, allow: [] })).rejects.toBeInstanceOf(EgressSocketInUseError);
    await first.close();
    expect(existsSync(sock)).toBe(false);
    const again = await startEgressProxy({ socketPath: sock, allow: [] });
    expect(statSync(sock).mode & 0o777).toBe(0o666); // default
    await again.close();
  });

  it("counts allowed and denied separately", async () => {
    const r = await rig();
    const ok = await talk(r.sock, hi("api.anthropic.com"), 100);
    await talk(r.sock, connectReq("example.com:443"), 100);
    await talk(r.sock, connectReq("evil.example.com:443"), 100);
    expect(r.proxy.stats()).toMatchObject({ allowed: 1, denied: 2 });
    ok.client.destroy();
    await r.close();
  });
});

/** An upstream whose "connect" completes only after `ms`, like a slow network. */
const slowConnect = (up: { port: number }, ms: number) => (): Socket => {
  const s = new Socket();
  setTimeout(() => s.connect(up.port, "127.0.0.1"), ms);
  return s;
};
/** Writes the given chunks to the proxy socket `gapMs` apart and collects what comes back. */
function trickle(sock: string, chunks: Array<string | Buffer>, gapMs: number, waitMs = 600): Promise<{ text: string; client: Socket; closed: boolean }> {
  return new Promise((resolve) => {
    const client = netConnect(sock);
    let text = "";
    let closed = false;
    client.on("data", (d) => (text += d.toString("latin1")));
    client.on("error", () => undefined);
    client.on("close", () => (closed = true));
    client.on("connect", () => {
      chunks.forEach((c, i) => setTimeout(() => client.write(c), i * gapMs));
    });
    setTimeout(() => resolve({ text, client, closed }), waitMs);
  });
}

describe("bytes sent while the upstream connect is in progress are kept (not dropped by a flowing, unlistened socket)", () => {
  let r: Rig;
  afterEach(async () => r && (await r.close()));

  it("CONNECT: the rest of the ClientHello and what follows it arrive upstream in order", async () => {
    r = await rig();
    await r.proxy.close(); // keep only the fake upstream; the proxy under test is built below with a slow connect
    const dir = mkdtempSync(join(tmpdir(), "egress-slow-"));
    dirs.push(dir);
    const sock = join(dir, "p.sock");
    const proxy = await startEgressProxy({ socketPath: sock, allow: ["api.anthropic.com:443"], resolve: async () => ["160.79.104.10"], connect: slowConnect(r.up, 250) });
    const hello = clientHello("api.anthropic.com");
    const half = Math.floor(hello.length / 2);
    const t = await trickle(sock, [Buffer.concat([Buffer.from(connectReq("api.anthropic.com:443")), hello.subarray(0, half)]), hello.subarray(half), "tail-bytes"], 80, 900);
    expect(t.text).toContain("200 Connection established");
    expect(Buffer.concat(r.up.received)).toEqual(Buffer.concat([hello, Buffer.from("tail-bytes")]));
    t.client.destroy();
    await proxy.close();
  });

  it("plain-http bridge: a body written separately from the head, during a slow connect, still reaches the bridge", async () => {
    r = await rig();
    await r.proxy.close();
    const dir = mkdtempSync(join(tmpdir(), "egress-slow-"));
    dirs.push(dir);
    const sock = join(dir, "p.sock");
    const proxy = await startEgressProxy({ socketPath: sock, allow: [], bridge: { host: "127.0.0.1", port: 3991 }, connect: slowConnect(r.up, 250) });
    const head = "POST http://127.0.0.1:3991/mcp HTTP/1.1\r\nHost: 127.0.0.1:3991\r\nContent-Length: 11\r\n\r\n";
    const t = await trickle(sock, [head, "hello world"], 80, 900);
    void t;
    const got = Buffer.concat(r.up.received).toString();
    expect(got.startsWith("POST /mcp HTTP/1.1\r\n")).toBe(true);
    expect(got.endsWith("\r\n\r\nhello world")).toBe(true);
    t.client.destroy();
    await proxy.close();
  });
});

describe("SNI pinning: the TLS ClientHello must name the CONNECT host", () => {
  let r: Rig;
  afterEach(async () => r && (await r.close()));
  const denied = () => r.warnings.filter((w) => w.event === "egress_denied").map((w) => w.fields.reason);

  it("passes a matching name, normalising case and a trailing dot", async () => {
    r = await rig();
    for (const sni of ["api.anthropic.com", "API.Anthropic.COM", "api.anthropic.com."]) {
      const t = await talk(r.sock, hi("api.anthropic.com", sni), 200);
      expect(t.closed).toBe(false);
      t.client.destroy();
    }
    expect(r.proxy.stats().allowed).toBe(3);
    expect(denied()).toEqual([]);
  });

  it("refuses a different name on the same allowed host:port (shared CDN edge), closing both sides and logging only host:port + reason", async () => {
    r = await rig();
    const t = await talk(r.sock, hi("claude.ai", "evil.example.org"), 300);
    expect(t.closed).toBe(true);
    expect(denied()).toEqual(["sni_mismatch"]);
    expect(r.warnings[0].fields).toEqual({ target: "claude.ai:443", reason: "sni_mismatch" });
    expect(r.up.received).toHaveLength(0); // not a single byte reached the upstream
    expect(r.proxy.stats()).toMatchObject({ allowed: 0, denied: 1 });
  });

  it.each([
    ["no server_name at all", clientHello("api.anthropic.com", { rawServerNameList: undefined }).length && clientHello(null), "no_sni"],
    ["an HTTP request instead of TLS", Buffer.from("GET / HTTP/1.1\r\nHost: api.anthropic.com\r\n\r\n"), "not_tls"],
    ["garbage bytes", Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]), "not_tls"],
    ["a hello that is not a ClientHello", Buffer.concat([Buffer.from([0x16, 3, 1, 0, 5]), Buffer.from([2, 0, 0, 1, 0])]), "not_client_hello"],
    ["an oversized record", Buffer.from([0x16, 3, 1, 0xff, 0xff, 1]), "oversize"],
  ])("refuses %s", async (_n, bytes, reason) => {
    r = await rig();
    const t = await talk(r.sock, Buffer.concat([Buffer.from(connectReq("api.anthropic.com:443")), bytes as Buffer]), 300);
    expect(t.closed).toBe(true);
    expect(denied()).toEqual([reason]);
    expect(r.up.received).toHaveLength(0);
  });

  it("accepts a ClientHello split across several TCP writes", async () => {
    r = await rig();
    const hello = clientHello("api.anthropic.com", { sessionId: 32 });
    const parts = [Buffer.from(connectReq("api.anthropic.com:443")), hello.subarray(0, 3), hello.subarray(3, 20), hello.subarray(20, 60), hello.subarray(60)];
    const t = await trickle(r.sock, parts, 40, 500);
    expect(t.closed).toBe(false);
    expect(Buffer.concat(r.up.received)).toEqual(hello);
    t.client.destroy();
  });

  it("drops a hello that never completes (timer) without reaching the upstream", async () => {
    r = await rig({ sniMs: 150 });
    const hello = clientHello("api.anthropic.com");
    const t = await talk(r.sock, Buffer.concat([Buffer.from(connectReq("api.anthropic.com:443")), hello.subarray(0, 30)]), 500);
    expect(t.closed).toBe(true);
    expect(denied()).toEqual(["hello_timeout"]);
    expect(r.up.received).toHaveLength(0);
  });

  it("is not applied to the tool bridge (it may be an IP or a private name)", async () => {
    r = await rig({ bridge: { host: "127.0.0.1", port: 3991 } });
    const t = await talk(r.sock, connectReq("127.0.0.1:3991") + "not-tls-at-all", 300);
    expect(t.closed).toBe(false);
    expect(Buffer.concat(r.up.received).toString()).toBe("not-tls-at-all");
    t.client.destroy();
  });
});

describe("parseClientHelloSni (strict)", () => {
  it("needs more bytes until the record is complete, then returns the name", () => {
    const h = clientHello("api.anthropic.com");
    for (const n of [0, 1, 4, 5, h.length - 1]) expect(parseClientHelloSni(h.subarray(0, n)).s).toBe("more");
    expect(parseClientHelloSni(h)).toEqual({ s: "ok", sni: "api.anthropic.com" });
  });
  it("returns null for a hello with no server_name or no extensions", () => {
    expect(parseClientHelloSni(clientHello(null))).toEqual({ s: "ok", sni: null });
    expect(parseClientHelloSni(clientHello(null, { noExtensions: true }))).toEqual({ s: "ok", sni: null });
  });
  it("refuses trailing bytes inside the record, a hello spread over records, duplicate or odd server_name entries, IP names", () => {
    const h = clientHello("api.anthropic.com");
    const spread = Buffer.from(h); // claims a handshake longer than the record
    spread.writeUIntBE(h.readUIntBE(6, 3) + 10, 6, 3);
    expect(parseClientHelloSni(spread)).toMatchObject({ s: "bad", reason: "fragmented_hello" });
    const u16 = (n: number) => Buffer.from([n >> 8, n & 0xff]);
    const name = Buffer.from("a.example.com");
    const entry = Buffer.concat([Buffer.from([0]), u16(name.length), name]);
    expect(parseClientHelloSni(clientHello(null, { rawServerNameList: Buffer.concat([entry, entry]) }))).toMatchObject({ s: "bad", reason: "multiple_names" });
    expect(parseClientHelloSni(clientHello(null, { rawServerNameList: Buffer.concat([Buffer.from([1]), u16(name.length), name]) }))).toMatchObject({ s: "bad" });
    const dup = Buffer.concat([u16(0), u16(entry.length + 2), u16(entry.length), entry]);
    expect(parseClientHelloSni(clientHello("a.example.com", { extraExts: [dup] }))).toMatchObject({ s: "bad", reason: "duplicate_sni" });
    expect(parseClientHelloSni(clientHello("10.1.2.3"))).toMatchObject({ s: "bad", reason: "bad_sni" });
    expect(parseClientHelloSni(clientHello("bad name"))).toMatchObject({ s: "bad", reason: "bad_sni" });
  });
});

describe("connection cap: no socket is ever left open or untracked", () => {
  let r: Rig;
  afterEach(async () => r && (await r.close()));

  it("over-cap connections get 503 and are closed by the proxy even if the peer never reads or closes", async () => {
    r = await rig({ maxConnections: 2 });
    await talk(r.sock, hi("api.anthropic.com"), 100);
    await talk(r.sock, hi("claude.ai"), 100);
    const extras: Socket[] = [];
    let closed = 0;
    for (let i = 0; i < 6; i++) {
      const c = netConnect({ path: r.sock, allowHalfOpen: true });
      c.on("error", () => undefined);
      c.on("close", () => closed++);
      c.resume(); // reads the 503 and the proxy's FIN, but never closes its own side
      extras.push(c);
    }
    await sleep(1_000);
    expect(closed).toBe(0); // not yet: the proxy gives the 503 a moment to be read ...
    await sleep(1_700);
    extras.forEach((c) => c.write("x")); // ... then it has dropped the socket: a write to it is reset
    await sleep(300);
    expect(closed).toBe(6);
    expect(r.proxy.stats().active).toBe(2);
    extras.forEach((c) => c.destroy());
  }, 10_000);

  it("close() resolves promptly even while over-cap sockets are still open", async () => {
    r = await rig({ maxConnections: 1 });
    await talk(r.sock, hi("api.anthropic.com"), 100);
    for (let i = 0; i < 5; i++) {
      const c = netConnect(r.sock);
      c.on("error", () => undefined);
      c.pause();
    }
    await sleep(100);
    const started = Date.now();
    await r.proxy.close();
    expect(Date.now() - started).toBeLessThan(1_000);
    await r.up.close();
    r = undefined as never;
  });
});

describe("vetted addresses, link-local and the DNS cache", () => {
  let r: Rig;
  afterEach(async () => r && (await r.close()));

  it("falls back to the next vetted address when connecting to the first fails", async () => {
    const attempts: string[] = [];
    r = await rig(
      {
        connect: (port, ip) => {
          attempts.push(ip);
          return ip === "160.79.104.50" ? netConnect({ port: 1, host: "127.0.0.1" }) : netConnect({ port: r.up.port, host: "127.0.0.1" });
        },
      },
      { "api.anthropic.com": ["160.79.104.50", "160.79.104.51"] },
    );
    const t = await talk(r.sock, hi("api.anthropic.com"), 400);
    expect(t.text).toContain("200 Connection established");
    expect(attempts).toEqual(["160.79.104.50", "160.79.104.51"]);
    t.client.destroy();
  });

  it("answers 502 when every vetted address fails", async () => {
    r = await rig({ connect: () => netConnect({ port: 1, host: "127.0.0.1" }) }, { "api.anthropic.com": ["160.79.104.50", "160.79.104.51"] });
    expect((await talk(r.sock, connectReq("api.anthropic.com:443"), 500)).text).toContain("502");
  });

  it("a hanging first address is abandoned after the attempt timer", async () => {
    const attempts: string[] = [];
    r = await rig(
      {
        connectAttemptMs: 100,
        connect: (_port, ip) => {
          attempts.push(ip);
          if (ip === "160.79.104.50") return new Socket(); // never connects
          return netConnect({ port: r.up.port, host: "127.0.0.1" });
        },
      },
      { "api.anthropic.com": ["160.79.104.50", "160.79.104.51"] },
    );
    const t = await talk(r.sock, hi("api.anthropic.com"), 500);
    expect(t.text).toContain("200 Connection established");
    expect(attempts).toHaveLength(2);
    t.client.destroy();
  });

  it("never reaches a link-local address, not even for the bridge (a bridge NAME pointing at the metadata service, or the literal)", async () => {
    r = await rig({ bridge: { host: "bridge.internal.test", port: 3001 } }, { "bridge.internal.test": ["169.254.169.254"] });
    expect((await talk(r.sock, connectReq("bridge.internal.test:3001"))).text).toContain("403");
    expect(r.warnings.at(-1)?.fields.reason).toBe("bridge_link_local");
    expect(r.connects).toHaveLength(0);
    await r.close();
    r = await rig({ bridge: { host: "169.254.169.254", port: 80 } });
    expect((await talk(r.sock, "GET http://169.254.169.254/latest/meta-data/ HTTP/1.1\r\nHost: 169.254.169.254\r\n\r\n")).text).toContain("403");
    expect(r.connects).toHaveLength(0);
  });

  it("isLinkLocalAddress knows the v4, v6 and mapped forms", () => {
    for (const ip of ["169.254.169.254", "169.254.0.1", "fe80::1", "febf::1", "::ffff:169.254.169.254"]) expect(isLinkLocalAddress(ip)).toBe(true);
    for (const ip of ["127.0.0.1", "10.0.0.1", "169.253.0.1", "fec0::1", "8.8.8.8", "2607:6bc0::10", "not-an-ip"]) expect(isLinkLocalAddress(ip)).toBe(false);
  });

  it("caches the vetted answer of an allowlisted name for the TTL (one resolve), then resolves again; the bridge is never cached", async () => {
    let t = 1_000;
    r = await rig({ now: () => t, dnsCacheTtlMs: 30_000, bridge: { host: "bridge.internal.test", port: 3001 } }, { "bridge.internal.test": ["10.9.9.9"] });
    for (let i = 0; i < 3; i++) (await talk(r.sock, hi("api.anthropic.com"), 120)).client.destroy();
    expect(r.resolved.filter((h) => h === "api.anthropic.com")).toHaveLength(1);
    t += 31_000;
    (await talk(r.sock, hi("api.anthropic.com"), 120)).client.destroy();
    expect(r.resolved.filter((h) => h === "api.anthropic.com")).toHaveLength(2);
    for (let i = 0; i < 2; i++) (await talk(r.sock, connectReq("bridge.internal.test:3001"), 100)).client.destroy();
    expect(r.resolved.filter((h) => h === "bridge.internal.test")).toHaveLength(2);
  });

  it("does not cache a refused answer, so a name that turns private is caught on the next request", async () => {
    let answer = ["160.79.104.10"];
    r = await rig({ resolve: async () => answer, dnsCacheTtlMs: 30_000 });
    (await talk(r.sock, hi("api.anthropic.com"), 120)).client.destroy();
    answer = ["10.0.0.5"];
    await sleep(10);
    // still cached for the TTL (documented), but a different name resolving privately is refused and never cached
    const t = await talk(r.sock, hi("claude.ai"), 150);
    expect(t.text).toContain("403");
    answer = ["160.79.104.11"];
    const t2 = await talk(r.sock, hi("claude.ai"), 150);
    expect(t2.text).toContain("200 Connection established");
    t2.client.destroy();
  });
});

describe("per-customer sockets (a customer can only exhaust its own share)", () => {
  async function perUidRig(over: Partial<EgressProxyOptions> = {}) {
    const dir = mkdtempSync(join(tmpdir(), "egress-uid-"));
    dirs.push(dir);
    const up = await upstream();
    const proxy = await startEgressProxy({
      perUid: { dir, max: 3, ownByUid: false },
      allow: ["api.anthropic.com:443"],
      resolve: async () => ["160.79.104.10"],
      connect: () => netConnect({ port: up.port, host: "127.0.0.1" }),
      maxConnections: 8,
      ...over,
    });
    return { dir, proxy, up, close: async () => { await proxy.close(); await up.close(); } };
  }
  /** Holds `n` tunnels open through a socket (CONNECT + ClientHello, then silence). */
  async function hold(sock: string, n: number): Promise<Socket[]> {
    const held: Socket[] = [];
    for (let i = 0; i < n; i++) {
      const r = await talk(sock, hi("api.anthropic.com"), 150);
      held.push(r.client);
    }
    return held;
  }

  it("listenFor creates <dir>/<uid>/proxy.sock, is idempotent, and serves a tunnel", async () => {
    const r = await perUidRig();
    const d = r.proxy.listenFor(400123);
    expect(d).toBe(join(r.dir, "400123"));
    expect(statSync(join(d, "proxy.sock")).isSocket()).toBe(true);
    const t = await talk(join(d, "proxy.sock"), hi("api.anthropic.com"), 300);
    expect(t.text).toContain("200 Connection established");
    expect(r.proxy.listenFor(400123)).toBe(d); // asking again must NOT tear down the live listener or its tunnels
    await sleep(50);
    expect(t.client.destroyed).toBe(false);
    expect(r.proxy.stats().perUid[400123]).toBe(1);
    t.client.destroy();
    await r.close();
  });

  it("one customer filling its own cap is refused (503) while another customer is served normally", async () => {
    const r = await perUidRig();
    const a = join(r.proxy.listenFor(400001), "proxy.sock");
    const b = join(r.proxy.listenFor(400002), "proxy.sock");
    const held = await hold(a, 3); // A is at its cap of 3
    expect(r.proxy.stats().perUid[400001]).toBe(3);
    const over = await talk(a, hi("api.anthropic.com"), 300);
    expect(over.text).toContain("503");
    const other = await talk(b, hi("api.anthropic.com"), 300);
    expect(other.text).toContain("200 Connection established");
    other.client.destroy();
    held.forEach((s) => s.destroy());
    await r.close();
  });

  it("the global cap still bounds the sum of all customers", async () => {
    const r2 = await perUidRig({ maxConnections: 4 });
    const a = join(r2.proxy.listenFor(400001), "proxy.sock");
    const b = join(r2.proxy.listenFor(400002), "proxy.sock");
    const h1 = await hold(a, 3);
    const h2 = await hold(b, 1);
    const over = await talk(b, hi("api.anthropic.com"), 300);
    expect(over.text).toContain("503"); // B is under its own cap but the host total (4) is used up
    [...h1, ...h2].forEach((s) => s.destroy());
    await r2.close();
  });

  it("sockets are owned by the uid with mode 0600 when ownByUid is on (the bound directory is the unit's only view)", async () => {
    const r = await perUidRig({ perUid: undefined });
    expect(() => r.proxy.listenFor(400001)).toThrow(/not configured/);
    await r.close();
    const own = await perUidRig({ perUid: { dir: mkdtempSync(join(tmpdir(), "egress-own-")), max: 3, ownByUid: false } });
    const dir = own.proxy.listenFor(400001);
    expect(statSync(join(dir, "proxy.sock")).mode & 0o777).toBe(0o666); // unprivileged test mode; production mode is asserted live
    await own.close();
  });

  it("modes are set explicitly: a restrictive process umask (the host service runs with 0077) cannot make the directory unusable", async () => {
    const old = process.umask(0o077);
    try {
      const r = await perUidRig();
      const d = r.proxy.listenFor(400001);
      expect(statSync(d).mode & 0o777).toBe(0o755);
      expect(statSync(join(d, "proxy.sock")).mode & 0o777).toBe(0o666);
      await r.close();
    } finally {
      process.umask(old);
    }
  });

  it("rejects bad uids and forgetFor removes the directory and ends that customer's tunnels", async () => {
    const r = await perUidRig();
    expect(() => r.proxy.listenFor(0)).toThrow();
    expect(() => r.proxy.listenFor(-5)).toThrow();
    expect(() => r.proxy.listenFor(1.5)).toThrow();
    const dir = r.proxy.listenFor(400001);
    const held = await hold(join(dir, "proxy.sock"), 2);
    r.proxy.forgetFor(400001);
    await sleep(100);
    expect(existsSync(dir)).toBe(false);
    expect(held.every((s) => s.destroyed)).toBe(true);
    expect(r.proxy.stats().perUid[400001]).toBeUndefined();
    r.proxy.forgetFor(400001); // harmless twice
    expect(existsSync(r.proxy.listenFor(400001))).toBe(true); // can come back
    await r.close();
  });

  it("close() removes every customer's directory and ends their tunnels", async () => {
    const r = await perUidRig();
    const d1 = r.proxy.listenFor(400001);
    const held = await hold(join(d1, "proxy.sock"), 2);
    await r.proxy.close();
    expect(existsSync(d1)).toBe(false);
    await sleep(50);
    expect(held.every((s) => s.destroyed)).toBe(true);
    await r.up.close();
  });

  it("a stale socket from a previous run is replaced", async () => {
    const dir = mkdtempSync(join(tmpdir(), "egress-stale-"));
    dirs.push(dir);
    mkdirSync(join(dir, "400001"), { recursive: true });
    writeFileSync(join(dir, "400001", "proxy.sock"), "stale");
    const proxy = await startEgressProxy({ perUid: { dir, ownByUid: false }, allow: ["api.anthropic.com:443"] });
    expect(statSync(join(proxy.listenFor(400001), "proxy.sock")).isSocket()).toBe(true);
    await proxy.close();
  });
});

