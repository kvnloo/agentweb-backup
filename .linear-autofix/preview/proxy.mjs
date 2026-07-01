#!/usr/bin/env node
// .linear-autofix/preview/proxy.mjs
// Host-based reverse proxy for per-bug previews (no nginx, no sudo).
// Routes <key>.<ip>.nip.io:<PROXY_PORT>  ->  127.0.0.1:<port from routes.json>,
// rewriting the Host header to localhost so Vite's allowedHosts accepts it.
// Leave this running once: `node .linear-autofix/preview/proxy.mjs`

import http from 'node:http';
import net from 'node:net';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { config } from '../config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROUTES = path.join(__dirname, 'routes.json');
const PORT = Number(process.env.PREVIEW_PROXY_PORT || config.proxyPort || 8791);
const HEALTH = '/__preview_health__';

// Re-read routes.json when its mtime changes — robust even if it doesn't exist at startup.
let routes = {};
let routesMtime = -1;
function getRoutes() {
  try {
    const m = statSync(ROUTES).mtimeMs;
    if (m !== routesMtime) { routes = JSON.parse(readFileSync(ROUTES, 'utf8')); routesMtime = m; }
  } catch { routes = {}; routesMtime = -1; }
  return routes;
}

// "lin-123-api.192.168.29.76.nip.io:8080" -> "lin-123-api"
function keyOf(host) { return (host || '').split(':')[0].split('.')[0]; }

const server = http.createServer((req, res) => {
  if (req.url === HEALTH) { res.writeHead(200, { 'content-type': 'text/plain' }).end('preview-proxy-ok'); return; }
  const key = keyOf(req.headers.host);
  const port = getRoutes()[key];
  if (!port) { res.writeHead(502, { 'content-type': 'text/plain' }).end(`no preview route for "${key}"`); return; }
  const up = http.request(
    { host: '127.0.0.1', port, method: req.method, path: req.url, headers: { ...req.headers, host: `localhost:${port}` } },
    (r) => { res.writeHead(r.statusCode || 502, r.headers); r.pipe(res); },
  );
  up.on('error', (e) => { res.writeHead(502).end(`preview upstream error: ${e.message}`); });
  req.pipe(up);
});

// Proxy websockets (Vite HMR) as well.
server.on('upgrade', (req, socket, head) => {
  const port = getRoutes()[keyOf(req.headers.host)];
  if (!port) { socket.destroy(); return; }
  const up = net.connect(port, '127.0.0.1', () => {
    const headers = { ...req.headers, host: `localhost:${port}` };
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
    up.write(lines.join('\r\n') + '\r\n\r\n');
    if (head && head.length) up.write(head);
    socket.pipe(up); up.pipe(socket);
  });
  up.on('error', () => socket.destroy());
});

server.listen(PORT, () => console.log(`[preview-proxy] listening on :${PORT} — routes: ${ROUTES}`));
