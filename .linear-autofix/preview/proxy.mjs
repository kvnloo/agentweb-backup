#!/usr/bin/env node
// .linear-autofix/preview/proxy.mjs
// Host-based reverse proxy for per-bug previews (no nginx, no sudo).
// Listens on one fixed port PER PORTAL (config.previewPorts): the bug-id host picks the
// bug, the listen port picks the portal. e.g. <bug>.<ip>.nip.io:5173 -> that bug's partner
// portal, :5174 -> customer, :3001 -> API. Forwards to 127.0.0.1:<port from routes.json>,
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
const HEALTH = '/__preview_health__';

// listen port -> routes.json key suffix for that portal ('' = customer/root).
const PP = config.previewPorts || { partner: 5173, customer: 5174, api: 3001 };
const PORT_SUFFIX = [
  [PP.customer, ''],
  [PP.partner, '-admin'],
  [PP.api, '-api'],
];

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

// "lin-123.192.168.29.76.nip.io:5174" -> "lin-123"
function keyOf(host) { return (host || '').split(':')[0].split('.')[0]; }

function makeRequestHandler(suffix) {
  return (req, res) => {
    if (req.url === HEALTH) { res.writeHead(200, { 'content-type': 'text/plain' }).end('preview-proxy-ok'); return; }
    const key = keyOf(req.headers.host) + suffix;
    const port = getRoutes()[key];
    if (!port) { res.writeHead(502, { 'content-type': 'text/plain' }).end(`no preview route for "${key}"`); return; }
    const up = http.request(
      { host: '127.0.0.1', port, method: req.method, path: req.url, headers: { ...req.headers, host: `localhost:${port}` } },
      (r) => { res.writeHead(r.statusCode || 502, r.headers); r.pipe(res); },
    );
    up.on('error', (e) => { res.writeHead(502).end(`preview upstream error: ${e.message}`); });
    req.pipe(up);
  };
}

// Proxy websockets (Vite HMR) as well.
function makeUpgradeHandler(suffix) {
  return (req, socket, head) => {
    const port = getRoutes()[keyOf(req.headers.host) + suffix];
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
  };
}

for (const [port, suffix] of PORT_SUFFIX) {
  const role = suffix === '' ? 'customer' : suffix === '-admin' ? 'partner' : 'api';
  const server = http.createServer(makeRequestHandler(suffix));
  server.on('upgrade', makeUpgradeHandler(suffix));
  // One bad port (e.g. already in use) must not take down the others.
  server.on('error', (e) => console.error(`[preview-proxy] :${port} (${role}) error: ${e.message}`));
  server.listen(port, () => console.log(`[preview-proxy] listening on :${port} (${role})`));
}
