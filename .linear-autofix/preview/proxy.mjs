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
import { readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { config } from '../config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Resolve the CANONICAL main-repo preview dir, NOT this script's own dir. routes.json is written by
// preview.mjs running in the MAIN checkout; if the proxy is launched from a git-worktree copy of the
// repo it would read that worktree's stale routes.json and 502 every preview registered afterwards — a
// real incident (proxy started from autofix-worktrees/ENG-200/.linear-autofix served only eng-200).
// git's common dir points at the main checkout from any worktree; fall back to __dirname when we're not
// in a worktree or git is unavailable.
function canonicalPreviewDir() {
  try {
    const r = spawnSync('git', ['-C', __dirname, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' });
    if (r.status === 0) {
      const mainRoot = path.dirname(r.stdout.trim());        // <main-repo>/.git -> <main-repo>
      const dir = path.join(mainRoot, '.linear-autofix', 'preview');
      if (dir !== __dirname && existsSync(path.join(dir, 'proxy.mjs'))) {
        console.log(`[preview-proxy] launched from a worktree — using canonical routes at ${dir}`);
        return dir;
      }
    }
  } catch { /* git missing / not a repo — fall back below */ }
  return __dirname;
}
const PREVIEW_DIR = canonicalPreviewDir();
const ROUTES = path.join(PREVIEW_DIR, 'routes.json');
const ACCESS = path.join(PREVIEW_DIR, 'preview-access.json'); // bug -> last-opened ISO; the cap policy reads this
const HEALTH = '/__preview_health__';

// Record when a preview's URL was last actually opened, so the eviction policy can tell a live-but-
// abandoned preview from one in use. Throttled per bug (a page load fires many requests) and flushed
// to disk since the chat server / pipeline read it from a different process.
let access = {}; try { access = JSON.parse(readFileSync(ACCESS, 'utf8')); } catch { /* none yet */ }
const lastFlush = {};
function noteAccess(bug) {
  const now = Date.now();
  if (now - (lastFlush[bug] || 0) < 20000) return; // at most once / 20s per bug
  lastFlush[bug] = now;
  access[bug] = new Date(now).toISOString();
  try { writeFileSync(ACCESS, JSON.stringify(access, null, 2)); } catch { /* best effort */ }
}

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
    // A client that resets the connection mid-request must not crash the proxy.
    req.on('error', () => {});
    res.on('error', () => {});
    if (req.url === HEALTH) { res.writeHead(200, { 'content-type': 'text/plain' }).end('preview-proxy-ok'); return; }
    noteAccess(keyOf(req.headers.host)); // stamp "URL opened" for the eviction policy (throttled)
    const key = keyOf(req.headers.host) + suffix;
    const port = getRoutes()[key];
    if (!port) { res.writeHead(502, { 'content-type': 'text/plain' }).end(`no preview route for "${key}"`); return; }
    const up = http.request(
      { host: '127.0.0.1', port, method: req.method, path: req.url, headers: { ...req.headers, host: `localhost:${port}` } },
      (r) => { res.writeHead(r.statusCode || 502, r.headers); r.pipe(res); },
    );
    up.on('error', (e) => { try { if (!res.headersSent) res.writeHead(502); res.end(`preview upstream error: ${e.message}`); } catch { /* already closed */ } });
    req.pipe(up);
  };
}

// Proxy websockets (Vite HMR) as well.
function makeUpgradeHandler(suffix) {
  return (req, socket, head) => {
    socket.on('error', () => socket.destroy());   // client socket reset must not crash the proxy
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

// Last-resort guard: a stray socket error (e.g. ECONNRESET from an internet scanner when the
// ports are public) must never take the proxy down — it's a long-running, stateless router.
process.on('uncaughtException', (e) => console.error(`[preview-proxy] uncaught (ignored): ${e && e.message}`));

for (const [port, suffix] of PORT_SUFFIX) {
  const role = suffix === '' ? 'customer' : suffix === '-admin' ? 'partner' : 'api';
  const server = http.createServer(makeRequestHandler(suffix));
  server.on('upgrade', makeUpgradeHandler(suffix));
  // Malformed request from a scanner/bot: drop it, don't crash.
  server.on('clientError', (_e, socket) => { try { socket.destroy(); } catch { /* already gone */ } });
  // One bad port (e.g. already in use) must not take down the others.
  server.on('error', (e) => console.error(`[preview-proxy] :${port} (${role}) error: ${e.message}`));
  server.listen(port, () => console.log(`[preview-proxy] listening on :${port} (${role})`));
}
