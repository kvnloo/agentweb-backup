/**
 * ENG-2110 PR 2: the ONLY egress path of a customer sandbox.
 *
 * Every sandbox unit runs with PrivateNetwork=yes (its own netns: loopback only, own abstract sockets, no route anywhere) and reaches
 * this proxy through a unix socket that is bind-mounted into the unit (a `socat` inside the unit turns 127.0.0.1:3128 into that socket).
 * The proxy is deliberately tiny and closed:
 *
 *   - CONNECT host:port only, to an exact allowlist (the provider/auth endpoints from host config) or the one explicit tool-bridge target.
 *   - The plain-http absolute-form request is accepted ONLY for the bridge target (rewritten to origin-form, Connection: close), because
 *     the CLI speaks http to the bridge in test environments.
 *   - Literal IPs and odd hostnames are refused. The name is resolved HERE and every address must be public: a name that resolves to a
 *     private/loopback/link-local/metadata address is refused (DNS-rebinding / SSRF defence), and the connection goes to the address that
 *     was checked, never to the name again. The bridge target is exempt from the address rule because it may legitimately be private.
 *   - Bounded: header size, handshake time, idle time, lifetime, concurrent connections.
 *   - It never logs or keeps a URL, a header or a body: a denial logs `host:port` and a reason, nothing else.
 */
import { promises as dnsPromises } from "dns";
import { chmodSync, chownSync, existsSync, mkdirSync, rmSync } from "fs";
import { connect as netConnect, createServer, isIP, type Server, type Socket } from "net";

export interface EgressProxyOptions {
  /** A shared listener. Production units do NOT use it (see `perUid`): they each get their own socket, so omit it there. */
  socketPath?: string;
  /**
   * Per-customer sockets: `listenFor(uid)` creates `<dir>/<uid>/proxy.sock`, owned by that uid with mode 0600, so a customer can reach only
   * its own socket (and the directory is the only thing its unit sees). Each customer then has its own connection cap and cannot
   * exhaust anyone else's share of the proxy. `ownByUid: false` (tests, unprivileged) leaves the socket world-connectable instead.
   */
  perUid?: { dir: string; max?: number; ownByUid?: boolean };
  /** Unix mode of the socket file. Sandboxes run as arbitrary customer uids, so the default is world-connectable; the directory and the allowlist are the gates. */
  socketMode?: number;
  /** Exact `host:port` entries, hostnames lowercase, e.g. `api.anthropic.com:443`. */
  allow: string[];
  /** The one extra target the proxy may reach even when private or loopback (the Emma tool bridge). */
  bridge?: { host: string; port: number };
  resolve?: (host: string) => Promise<string[]>;
  connect?: (port: number, ip: string) => Socket;
  maxConnections?: number;
  /** From accept until the tunnel is established (header read + DNS + upstream connect). */
  handshakeMs?: number;
  idleMs?: number;
  maxLifetimeMs?: number;
  maxHeaderBytes?: number;
  /** How long a CONNECT client gets to send its TLS ClientHello after the 200 (SNI pinning). Default 10 s. */
  sniMs?: number;
  /** One upstream connect attempt (each vetted address is tried in turn). Default 3 s. */
  connectAttemptMs?: number;
  /** Positive cache of a vetted answer for ALLOWLISTED names only. Default 30 s, at most 64 names. */
  dnsCacheTtlMs?: number;
  now?: () => number;
  logger?: { warn(event: string, fields: Record<string, unknown>): void };
}

export interface EgressProxyHandle {
  /** Creates (or returns) the listener of one customer uid and gives back the directory to bind into its units. Synchronous: it must exist before the unit starts. Needs `perUid`. */
  listenFor(uid: number): string;
  /** Stops one customer's listener and its tunnels, and removes its directory. */
  forgetFor(uid: number): void;
  close(): Promise<void>;
  stats(): { allowed: number; denied: number; active: number; perUid: Record<number, number> };
}

export class EgressSocketInUseError extends Error {
  constructor() {
    super("another egress proxy is listening on this socket");
    this.name = "EgressSocketInUseError";
  }
}

const HOST_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
const TARGET_RE = /^([A-Za-z0-9.-]{1,253}):([0-9]{1,5})$/;
const REQUEST_LINE_RE = /^([A-Z]{3,7}) (\S{1,2048}) HTTP\/1\.[01]$/;
const HEADER_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+:[ \t]*[^\r\n]*$/;
const PLAIN_METHODS = new Set(["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"]);
const DROPPED_HEADERS = new Set(["connection", "proxy-connection", "proxy-authorization", "keep-alive"]);

// ───────────────────────────── address rules ─────────────────────────────

function ipv4Forbidden(a: number, b: number, c: number): boolean {
  if (a === 0 || a === 10 || a === 127 || a >= 224) return true; // this-network, private, loopback, multicast/reserved/broadcast
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 169 && b === 254) return true; // link-local incl. the metadata service
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // IETF protocol assignments, TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  return false;
}

function parseIPv6(ip: string): number[] | null {
  let text = ip.toLowerCase();
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone);
  // An embedded dotted IPv4 tail becomes two hextets.
  const dotted = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (dotted) {
    const o = dotted.slice(1, 5).map(Number);
    if (o.some((n) => n > 255)) return null;
    text = text.slice(0, dotted.index) + ((o[0] << 8) | o[1]).toString(16) + ":" + ((o[2] << 8) | o[3]).toString(16);
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = 8 - head.length - tail.length;
  if ((halves.length === 1 && fill !== 0) || fill < 0 || (halves.length === 2 && fill < 1)) return null;
  const parts = [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill("0"), ...tail];
  if (parts.length !== 8) return null;
  const out = parts.map((p) => (/^[0-9a-f]{1,4}$/.test(p) ? parseInt(p, 16) : NaN));
  return out.some(Number.isNaN) ? null : out;
}

/** True unless the address is a publicly routable unicast address. Anything unparseable is forbidden. */
export function isForbiddenAddress(ip: string): boolean {
  const kind = isIP(ip.includes("%") ? ip.slice(0, ip.indexOf("%")) : ip);
  if (kind === 4) {
    const [a, b, c] = ip.split(".").map(Number);
    return ipv4Forbidden(a, b, c);
  }
  if (kind !== 6) return true;
  const h = parseIPv6(ip);
  if (!h) return true;
  // IPv4-mapped (::ffff:a.b.c.d) and the deprecated IPv4-compatible (::a.b.c.d) forms are judged as the IPv4 address they carry.
  const mapped = h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff;
  const compat = h.slice(0, 6).every((x) => x === 0);
  if (mapped || compat) return ipv4Forbidden(h[6] >> 8, h[6] & 0xff, h[7] >> 8);
  if ((h[0] & 0xe000) !== 0x2000) return true; // only global unicast 2000::/3 (excludes ::, ::1, fc00::/7, fe80::/10, ff00::/8)
  if (h[0] === 0x2002) return true; // 6to4 embeds an IPv4 address
  if (h[0] === 0x2001 && (h[1] === 0 || h[1] === 0x0db8)) return true; // Teredo, documentation
  if (h[0] === 0x64 || (h[0] === 0x2001 && h[1] === 2 && h[2] === 0)) return true; // benchmarking
  return false;
}

/** Link-local (incl. the cloud metadata address): never reachable, not even for the tool bridge. */
export function isLinkLocalAddress(ip: string): boolean {
  const bare = ip.includes("%") ? ip.slice(0, ip.indexOf("%")) : ip;
  const kind = isIP(bare);
  if (kind === 4) {
    const [a, b] = bare.split(".").map(Number);
    return a === 169 && b === 254;
  }
  if (kind !== 6) return false;
  const h = parseIPv6(bare);
  if (!h) return false;
  if (h.slice(0, 6).every((x) => x === 0) || (h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff)) return h[6] >> 8 === 169 && (h[6] & 0xff) === 254;
  return (h[0] & 0xffc0) === 0xfe80;
}

// ───────────────────────────── TLS ClientHello (SNI pinning) ─────────────────────────────

const MAX_TLS_RECORD = 16384;

export type HelloResult = { s: "more" } | { s: "ok"; sni: string | null } | { s: "bad"; reason: string };
const more: HelloResult = { s: "more" };
const bad = (reason: string): HelloResult => ({ s: "bad", reason });

/**
 * Strict, tiny parser for ONE TLS record that carries a whole ClientHello. Returns the (normalised) server_name, `null` when the hello
 * has none, "more" while the record is incomplete, and "bad" for anything that is not exactly that: a hello spread over several
 * records, trailing bytes, duplicate or non-host_name entries, oversized records, non-TLS bytes.
 */
export function parseClientHelloSni(buf: Buffer): HelloResult {
  if (buf.length >= 1 && buf[0] !== 0x16) return bad("not_tls");
  if (buf.length >= 2 && buf[1] !== 0x03) return bad("not_tls");
  if (buf.length < 5) return more;
  const recLen = buf.readUInt16BE(3);
  if (recLen < 4 || recLen > MAX_TLS_RECORD) return bad("oversize");
  if (buf.length < 5 + recLen) return more;
  const rec = buf.subarray(5, 5 + recLen);
  if (rec[0] !== 0x01) return bad("not_client_hello");
  if (((rec[1] << 16) | (rec[2] << 8) | rec[3]) + 4 !== recLen) return bad("fragmented_hello"); // the hello must fill its record exactly
  let p = 4;
  const need = (n: number) => p + n <= rec.length;
  if (!need(34)) return bad("malformed");
  p += 34; // legacy version + random
  if (!need(1)) return bad("malformed");
  const sid = rec[p++];
  if (sid > 32 || !need(sid)) return bad("malformed");
  p += sid;
  if (!need(2)) return bad("malformed");
  const cs = rec.readUInt16BE(p);
  p += 2;
  if (cs < 2 || cs % 2 !== 0 || !need(cs)) return bad("malformed");
  p += cs;
  if (!need(1)) return bad("malformed");
  const comp = rec[p++];
  if (comp < 1 || !need(comp)) return bad("malformed");
  p += comp;
  if (p === rec.length) return { s: "ok", sni: null }; // no extensions at all
  if (!need(2)) return bad("malformed");
  const extLen = rec.readUInt16BE(p);
  p += 2;
  if (p + extLen !== rec.length) return bad("malformed");
  let sni: string | null = null;
  let seen = false;
  while (p < rec.length) {
    if (!need(4)) return bad("malformed");
    const type = rec.readUInt16BE(p);
    const len = rec.readUInt16BE(p + 2);
    p += 4;
    if (!need(len)) return bad("malformed");
    if (type === 0x0000) {
      if (seen) return bad("duplicate_sni");
      seen = true;
      const d = rec.subarray(p, p + len);
      if (d.length < 2 || d.readUInt16BE(0) !== d.length - 2) return bad("malformed");
      let o = 2;
      while (o < d.length) {
        if (o + 3 > d.length) return bad("malformed");
        const nameType = d[o];
        const nameLen = d.readUInt16BE(o + 1);
        o += 3;
        if (nameType !== 0 || o + nameLen > d.length || nameLen === 0) return bad("malformed");
        if (sni !== null) return bad("multiple_names");
        sni = d.subarray(o, o + nameLen).toString("latin1").toLowerCase().replace(/\.$/, "");
        o += nameLen;
      }
      if (sni === null || !HOST_RE.test(sni) || isIP(sni)) return bad("bad_sni");
    }
    p += len;
  }
  return { s: "ok", sni };
}

// ───────────────────────────── the proxy ─────────────────────────────

interface Parsed {
  method: string;
  target: string;
  headers: string[];
  rest: Buffer;
}

function socketIsLive(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const c = netConnect(path);
    c.once("connect", () => {
      c.destroy();
      resolve(true);
    });
    c.once("error", () => resolve(false));
  });
}

function reply(socket: Socket, status: number, text: string): void {
  if (socket.destroyed) return;
  // Keep reading (and discarding) so the peer's FIN is seen and the socket can close: a paused, answered socket would linger forever.
  socket.resume();
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

export async function startEgressProxy(opts: EgressProxyOptions): Promise<EgressProxyHandle> {
  const maxConnections = opts.maxConnections ?? 256;
  const handshakeMs = opts.handshakeMs ?? 10_000;
  const idleMs = opts.idleMs ?? 300_000;
  const maxLifetimeMs = opts.maxLifetimeMs ?? 3_600_000;
  const maxHeaderBytes = opts.maxHeaderBytes ?? 8192;
  const sniMs = opts.sniMs ?? 10_000;
  const connectAttemptMs = opts.connectAttemptMs ?? 3_000;
  const resolveHost = opts.resolve ?? (async (host: string) => (await dnsPromises.lookup(host, { all: true })).map((a) => a.address));
  const connectTo = opts.connect ?? ((port: number, ip: string) => netConnect({ port, host: ip }));
  const allow = new Set(opts.allow.map((e) => e.toLowerCase()));
  const bridge = opts.bridge ? { host: opts.bridge.host.toLowerCase(), port: opts.bridge.port } : undefined;
  const isBridge = (host: string, port: number) => !!bridge && bridge.host === host && bridge.port === port;
  const counters = { allowed: 0, denied: 0 };
  const clients = new Set<Socket>();

  const deny = (client: Socket, target: string, reason: string): void => {
    counters.denied++;
    opts.logger?.warn("egress_denied", { target, reason });
    reply(client, 403, "Forbidden");
  };

  /** Reads the request head. Resolves null when the client was answered/dropped already. */
  const readHead = (client: Socket): Promise<Parsed | null> =>
    new Promise((resolve) => {
      let buf = Buffer.alloc(0);
      const done = (value: Parsed | null) => {
        client.off("data", onData);
        client.off("close", onClose);
        // A socket that has had a 'data' listener stays FLOWING after it is removed, and bytes arriving while DNS / the upstream connect
        // run would be dropped. Hold them: pipe() (or a reply) resumes the socket.
        if (value) client.pause();
        resolve(value);
      };
      const onClose = () => done(null);
      const onData = (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        const end = buf.indexOf("\r\n\r\n");
        if (end < 0) {
          if (buf.length > maxHeaderBytes) {
            reply(client, 431, "Request Header Fields Too Large");
            done(null);
          }
          return;
        }
        if (end > maxHeaderBytes) {
          reply(client, 431, "Request Header Fields Too Large");
          return done(null);
        }
        const lines = buf.subarray(0, end).toString("latin1").split("\r\n");
        const m = REQUEST_LINE_RE.exec(lines[0]);
        const headers = lines.slice(1);
        if (!m || headers.some((h) => !HEADER_RE.test(h))) {
          reply(client, 400, "Bad Request");
          return done(null);
        }
        done({ method: m[1], target: m[2], headers, rest: buf.subarray(end + 4) });
      };
      client.on("data", onData);
      client.on("close", onClose);
    });

  const now = opts.now ?? Date.now;
  const dnsTtl = opts.dnsCacheTtlMs ?? 30_000;
  const dnsCache = new Map<string, { addrs: string[]; expires: number }>();

  /** Resolves and vets the destination. Returns the vetted addresses (tried in order), or null when the client was answered. */
  const vet = async (client: Socket, host: string, port: number, exempt: boolean): Promise<string[] | null> => {
    const target = `${host}:${port}`;
    if (exempt && isIP(host)) {
      if (isLinkLocalAddress(host)) {
        deny(client, target, "bridge_link_local");
        return null;
      }
      return [host]; // an explicit bridge IP literal
    }
    if (!exempt) {
      const hit = dnsCache.get(host);
      if (hit && hit.expires > now()) return hit.addrs;
    }
    let addrs: string[];
    try {
      addrs = await resolveHost(host);
    } catch {
      reply(client, 502, "Bad Gateway");
      return null;
    }
    if (addrs.length === 0) {
      reply(client, 502, "Bad Gateway");
      return null;
    }
    if (addrs.some(isLinkLocalAddress)) {
      // Not even the bridge may be a name that points at the metadata service.
      deny(client, target, exempt ? "bridge_link_local" : "address_not_public");
      return null;
    }
    if (!exempt && addrs.some(isForbiddenAddress)) {
      deny(client, target, "address_not_public");
      return null;
    }
    if (!exempt && dnsTtl > 0) {
      if (dnsCache.size >= 64) dnsCache.delete(dnsCache.keys().next().value as string);
      dnsCache.set(host, { addrs, expires: now() + dnsTtl });
    }
    return addrs;
  };

  /** Collects the client's first TLS record and checks its server_name equals `host`. Resolves with the bytes to forward on success. */
  const pinSni = (client: Socket, initial: Buffer, host: string): Promise<{ ok: true; bytes: Buffer } | { ok: false; reason: string }> =>
    new Promise((resolve) => {
      let buf = initial;
      let settled = false;
      const finish = (r: { ok: true; bytes: Buffer } | { ok: false; reason: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        client.off("data", onData);
        client.off("close", onClose);
        client.pause();
        resolve(r);
      };
      const check = () => {
        const r = parseClientHelloSni(buf);
        if (r.s === "more") return;
        if (r.s === "bad") return finish({ ok: false, reason: r.reason });
        if (r.sni === null) return finish({ ok: false, reason: "no_sni" });
        if (r.sni !== host) return finish({ ok: false, reason: "sni_mismatch" });
        finish({ ok: true, bytes: buf });
      };
      const onData = (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        check();
      };
      const onClose = () => finish({ ok: false, reason: "closed" });
      const timer = setTimeout(() => finish({ ok: false, reason: "hello_timeout" }), sniMs);
      timer.unref?.();
      client.on("data", onData);
      client.on("close", onClose);
      client.resume();
      check();
    });

  const tunnel = (client: Socket, upstream: Socket, firstBytes: Buffer, established: () => void): void => {
    const end = () => {
      clearTimeout(lifetime);
      client.destroy();
      upstream.destroy();
    };
    const lifetime = setTimeout(end, maxLifetimeMs);
    lifetime.unref?.();
    upstream.on("error", end);
    upstream.once("close", end);
    client.once("close", end);
    client.setTimeout(idleMs, end);
    upstream.setTimeout(idleMs, end);
    established();
    if (firstBytes.length) upstream.write(firstBytes);
    client.pipe(upstream);
    upstream.pipe(client);
  };

  const handle = async (client: Socket): Promise<void> => {
    const handshake = setTimeout(() => client.destroy(), handshakeMs);
    handshake.unref?.();
    try {
      const head = await readHead(client);
      if (!head) return;
      let host: string;
      let port: number;
      let plain = false;
      let path = "";
      if (head.method === "CONNECT") {
        const t = TARGET_RE.exec(head.target);
        if (!t) return reply(client, 400, "Bad Request");
        host = t[1].toLowerCase();
        port = Number(t[2]);
      } else if (PLAIN_METHODS.has(head.method)) {
        let url: URL;
        try {
          url = new URL(head.target);
        } catch {
          return reply(client, 400, "Bad Request");
        }
        if (url.protocol !== "http:" || url.username || url.password) return reply(client, 400, "Bad Request");
        host = url.hostname.toLowerCase();
        port = url.port ? Number(url.port) : 80;
        path = `${url.pathname}${url.search}`;
        plain = true;
      } else {
        return reply(client, 405, "Method Not Allowed");
      }
      if (!Number.isInteger(port) || port < 1 || port > 65535) return reply(client, 400, "Bad Request");
      const target = `${host}:${port}`;
      const viaBridge = isBridge(host, port);
      if (plain && !viaBridge) return deny(client, target, "plain_http_not_bridge");
      if (!viaBridge) {
        if (isIP(host)) return deny(client, target, "literal_ip");
        if (!HOST_RE.test(host)) return reply(client, 400, "Bad Request");
        if (!allow.has(target)) return deny(client, target, "not_allowed");
      }
      const addrs = await vet(client, host, port, viaBridge);
      if (!addrs || client.destroyed) return;

      /** Tries each vetted address in turn; the handshake timer bounds the whole thing. */
      let upstream: Socket | undefined;
      let current = 0;
      const attempt = () => {
        if (client.destroyed) return;
        if (current >= addrs.length) return void reply(client, 502, "Bad Gateway");
        const sock = connectTo(port, addrs[current++]);
        upstream = sock;
        let failed = false;
        const fail = () => {
          if (failed) return;
          failed = true;
          clearTimeout(timer);
          sock.destroy();
          attempt();
        };
        const timer = setTimeout(fail, connectAttemptMs);
        timer.unref?.();
        sock.once("error", fail);
        sock.once("connect", () => {
          if (failed) return sock.destroy();
          clearTimeout(timer);
          sock.off("error", fail);
          sock.on("error", () => sock.destroy());
          onConnected(sock);
        });
      };
      const onConnected = (sock: Socket) => {
        clearTimeout(handshake);
        if (client.destroyed) return sock.destroy();
        if (plain) {
          const kept = head.headers.filter((h) => !DROPPED_HEADERS.has(h.slice(0, h.indexOf(":")).toLowerCase()));
          const rewritten = [`${head.method} ${path || "/"} HTTP/1.1`, ...kept, "Connection: close", "", ""].join("\r\n");
          tunnel(client, sock, Buffer.concat([Buffer.from(rewritten, "latin1"), head.rest]), () => counters.allowed++);
          return;
        }
        client.write("HTTP/1.1 200 Connection established\r\n\r\n");
        if (viaBridge) return tunnel(client, sock, head.rest, () => counters.allowed++);
        // The allowlist pins the CONNECT host, but a shared edge IP serves many sites: the TLS ClientHello must NAME the same host.
        void pinSni(client, head.rest, host).then((r) => {
          if (r.ok) return tunnel(client, sock, r.bytes, () => counters.allowed++);
          counters.denied++;
          opts.logger?.warn("egress_denied", { target, reason: r.reason });
          client.destroy();
          sock.destroy();
        });
      };
      client.once("close", () => upstream?.destroy());
      attempt();
    } catch {
      reply(client, 502, "Bad Gateway");
    } finally {
      // A tunnel that is up no longer needs the handshake timer; one that never came up is cut by it.
      client.once("close", () => clearTimeout(handshake));
    }
  };

  const everyone = new Set<Socket>(); // EVERY accepted socket, over-cap ones too: close() must be able to end them all
  const perUidMax = opts.perUid?.max ?? 32;

  /** One listener (shared, or one customer's). `mine` is that listener's admitted tunnels; `cap` its own limit on top of the global one. */
  const makeServer = (mine: Set<Socket>, cap: number): Server => {
    const server: Server = createServer((client) => {
      client.on("error", () => undefined);
      everyone.add(client);
      client.once("close", () => everyone.delete(client));
      if (clients.size >= maxConnections || mine.size >= cap) {
        // Over a cap: answer, then drop on a short timer. A peer that never reads or closes must not hold a descriptor of the host.
        reply(client, 503, "Service Unavailable");
        const t = setTimeout(() => client.destroy(), 2_000);
        t.unref?.();
        client.once("close", () => clearTimeout(t));
        return;
      }
      clients.add(client);
      mine.add(client);
      client.once("close", () => {
        clients.delete(client);
        mine.delete(client);
      });
      void handle(client);
    });
    // Never more than twice the cap of open descriptors, however the peers behave (the cap itself answers 503 below this ceiling).
    server.maxConnections = Math.min(cap, maxConnections) * 2 + 16;
    // Permanent: an accept error (EMFILE) must be logged, never thrown into the host process.
    server.on("error", (err) => opts.logger?.warn("egress_server_error", { code: (err as { code?: string }).code ?? "error" }));
    return server;
  };

  // The shared listener (tests and tools; production units get per-customer sockets instead).
  let shared: { server: Server; path: string } | undefined;
  if (opts.socketPath) {
    const path = opts.socketPath;
    if (existsSync(path)) {
      if (await socketIsLive(path)) throw new EgressSocketInUseError(); // never hijack another proxy
      rmSync(path, { force: true });
    }
    const server = makeServer(clients, maxConnections);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, () => {
        server.off("error", reject);
        resolve();
      });
    });
    chmodSync(path, opts.socketMode ?? 0o666);
    shared = { server, path };
  }

  // Per-customer listeners.
  const perUid = new Map<number, { server: Server; dir: string; path: string; mine: Set<Socket> }>();
  const listenFor = (uid: number): string => {
    if (!opts.perUid) throw new Error("egress: per-uid sockets are not configured");
    if (!Number.isInteger(uid) || uid < 1) throw new Error("egress: bad uid");
    const known = perUid.get(uid);
    if (known && known.server.listening) return known.dir;
    if (known) forgetFor(uid);
    const dir = `${opts.perUid.dir}/${uid}`;
    const path = `${dir}/proxy.sock`;
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    rmSync(path, { force: true }); // a stale one from a previous run of this host
    const mine = new Set<Socket>();
    const server = makeServer(mine, perUidMax);
    // For a unix socket, bind() and listen() happen inside this call: the file exists, and is connectable, when it returns. The unit that
    // needs it is started only after. Until chown/chmod below the file is root-owned with the umask's mode (not connectable by others).
    server.listen(path);
    // The process umask (the host's service unit sets 0077) must not decide who can traverse the directory: set every mode explicitly.
    if (opts.perUid.ownByUid !== false) {
      chownSync(dir, uid, uid);
      chmodSync(dir, 0o700); // only the customer (and root) can even enter its directory
      chownSync(path, uid, uid);
      chmodSync(path, 0o600);
    } else {
      chmodSync(dir, 0o755);
      chmodSync(path, 0o666);
    }
    perUid.set(uid, { server, dir, path, mine });
    return dir;
  };
  const forgetFor = (uid: number): void => {
    const l = perUid.get(uid);
    if (!l) return;
    perUid.delete(uid);
    for (const c of l.mine) c.destroy();
    l.server.close();
    rmSync(l.dir, { recursive: true, force: true });
  };

  return {
    listenFor,
    forgetFor,
    stats: () => ({
      allowed: counters.allowed,
      denied: counters.denied,
      active: clients.size,
      perUid: Object.fromEntries([...perUid].map(([uid, l]) => [uid, l.mine.size])),
    }),
    close: () =>
      new Promise<void>((resolve) => {
        for (const c of everyone) c.destroy();
        for (const uid of [...perUid.keys()]) forgetFor(uid);
        if (!shared) return resolve();
        const { server, path } = shared;
        server.close(() => {
          rmSync(path, { force: true });
          resolve();
        });
      }),
  };
}
