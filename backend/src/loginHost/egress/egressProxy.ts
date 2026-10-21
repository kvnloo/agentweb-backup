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
import { chmodSync, existsSync, rmSync } from "fs";
import { connect as netConnect, createServer, isIP, type Server, type Socket } from "net";

export interface EgressProxyOptions {
  socketPath: string;
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
  logger?: { warn(event: string, fields: Record<string, unknown>): void };
}

export interface EgressProxyHandle {
  close(): Promise<void>;
  stats(): { allowed: number; denied: number; active: number };
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

  /** Resolves and vets the destination. Returns the address to connect to, or null when the client was answered. */
  const vet = async (client: Socket, host: string, port: number, exempt: boolean): Promise<string | null> => {
    const target = `${host}:${port}`;
    if (exempt && isIP(host)) return host; // an explicit bridge IP literal
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
    if (!exempt && addrs.some(isForbiddenAddress)) {
      deny(client, target, "address_not_public");
      return null;
    }
    return addrs[0];
  };

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
      const ip = await vet(client, host, port, viaBridge);
      if (!ip || client.destroyed) return;
      const upstream = connectTo(port, ip);
      upstream.on("error", () => {
        if (!client.destroyed && !upstream.readyState.startsWith("open")) reply(client, 502, "Bad Gateway");
        upstream.destroy();
      });
      upstream.once("connect", () => {
        clearTimeout(handshake);
        if (client.destroyed) return upstream.destroy();
        if (plain) {
          const kept = head.headers.filter((h) => !DROPPED_HEADERS.has(h.slice(0, h.indexOf(":")).toLowerCase()));
          const rewritten = [`${head.method} ${path || "/"} HTTP/1.1`, ...kept, "Connection: close", "", ""].join("\r\n");
          tunnel(client, upstream, Buffer.concat([Buffer.from(rewritten, "latin1"), head.rest]), () => counters.allowed++);
        } else {
          tunnel(client, upstream, head.rest, () => {
            counters.allowed++;
            client.write("HTTP/1.1 200 Connection established\r\n\r\n");
          });
        }
      });
      client.once("close", () => upstream.destroy());
    } catch {
      reply(client, 502, "Bad Gateway");
    } finally {
      // A tunnel that is up no longer needs the handshake timer; one that never came up is cut by it.
      client.once("close", () => clearTimeout(handshake));
    }
  };

  if (existsSync(opts.socketPath)) {
    if (await socketIsLive(opts.socketPath)) throw new EgressSocketInUseError(); // never hijack another proxy
    rmSync(opts.socketPath, { force: true });
  }

  const server: Server = createServer((client) => {
    client.on("error", () => undefined);
    if (clients.size >= maxConnections) return reply(client, 503, "Service Unavailable");
    clients.add(client);
    client.once("close", () => clients.delete(client));
    void handle(client);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  chmodSync(opts.socketPath, opts.socketMode ?? 0o666);

  return {
    stats: () => ({ allowed: counters.allowed, denied: counters.denied, active: clients.size }),
    close: () =>
      new Promise<void>((resolve) => {
        for (const c of clients) c.destroy();
        server.close(() => {
          rmSync(opts.socketPath, { force: true });
          resolve();
        });
      }),
  };
}
