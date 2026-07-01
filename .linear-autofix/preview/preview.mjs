#!/usr/bin/env node
// .linear-autofix/preview/preview.mjs
// Start/stop a FULL app copy per bug (backend + customer-portal + partner-portal) from a
// fix's worktree, exposed via the proxy at <bug>.<ip>.nip.io:<port-per-portal> (5173/5174/3001).
//
// Usage:
//   node preview.mjs up   <bug-id> <worktree-path>
//   node preview.mjs down <bug-id>
//   node preview.mjs list
//
// The proxy (proxy.mjs) must be running. node_modules and .env files are linked/copied from
// your local repos into the worktree, so each copy boots fast and uses your dev config.

import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, symlinkSync, copyFileSync, openSync, statSync } from 'node:fs';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { config } from '../config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const agentRoot = path.resolve(__dirname, '../..'); // the agentweb (main) repo root
const ROUTES = path.join(__dirname, 'routes.json');
const STATE = path.join(__dirname, 'preview-state.json');
const LOGS = path.join(__dirname, 'logs');

// Loopback by default: the verify browser + preview run on the same machine, and 127.0.0.1
// avoids LAN/sandbox firewall issues. Set PREVIEW_IP to the LAN IP to reach it from another
// device (e.g. a real phone for mobile testing).
const IP = process.env.PREVIEW_IP || '127.0.0.1';
// One fixed port per portal (the bug-id host picks the bug, the port picks the portal).
const PP = config.previewPorts || { partner: 5173, customer: 5174, api: 3001 };
const ROLE_PORT = { '': PP.customer, admin: PP.partner, api: PP.api };

// Each service: package dir (in the worktree), source repo (for node_modules/.env), and proxy role.
const SERVICES = [
  { name: 'backend',         dir: 'backend',         src: 'backend',         role: 'api',   kind: 'backend' },
  { name: 'customer-portal', dir: 'customer-portal', src: 'customer-portal', role: '',      kind: 'vite' },
  { name: 'partner-portal',  dir: 'partner-portal',  src: 'partner-portal',  role: 'admin', kind: 'vite' },
];

const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return {}; } };
const writeJson = (p, o) => writeFileSync(p, JSON.stringify(o, null, 2));
const stripSlash = (u) => u.replace(/\/$/, '');

function freePort(start) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(freePort(start + 1)));
    s.listen(start, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

function waitPort(port, timeoutMs = 120000) {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      const c = net.connect(port, '127.0.0.1');
      c.once('connect', () => { c.destroy(); resolve(true); });
      c.once('error', () => { c.destroy(); if (Date.now() - t0 > timeoutMs) resolve(false); else setTimeout(tick, 1000); });
    };
    tick();
  });
}

const mtime = (p) => { try { return statSync(p).mtimeMs; } catch { return -1; } };
// node_modules is fresh if npm's post-install marker is newer than package.json.
const depsFresh = (pkgDir) => mtime(path.join(pkgDir, 'node_modules', '.package-lock.json')) >= mtime(path.join(pkgDir, 'package.json'));
const sameDeps = (a, b) => { try { return readFileSync(path.join(a, 'package.json'), 'utf8') === readFileSync(path.join(b, 'package.json'), 'utf8'); } catch { return false; } };
function installDeps(pkgDir, name) {
  console.log(`[preview] installing deps for ${name} (source missing/stale — can take a minute)...`);
  const r = spawnSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: pkgDir, stdio: 'inherit' });
  if (r.status !== 0) console.log(`[preview] WARNING: npm install failed for ${name}`);
}

// Make the worktree package runnable: link fresh source deps (fast) or install isolated deps,
// and copy .env files. Never installs into an existing node_modules (could be a symlink to source).
function ensureDeps(worktree, svc) {
  const wtPkg = path.join(worktree, svc.dir);
  const srcPkg = path.resolve(agentRoot, svc.src);
  const wtNm = path.join(wtPkg, 'node_modules');
  if (!existsSync(wtNm)) {
    if (existsSync(path.join(srcPkg, 'node_modules')) && sameDeps(wtPkg, srcPkg) && depsFresh(srcPkg)) {
      try { symlinkSync(path.join(srcPkg, 'node_modules'), wtNm, 'dir'); console.log(`[preview] linked ${svc.dir} deps from source`); }
      catch { installDeps(wtPkg, svc.dir); }
    } else {
      installDeps(wtPkg, svc.dir); // source deps missing, mismatched, or stale → isolated install
    }
  }
  for (const f of ['.env', '.env.local', '.env.development']) {
    const s = path.join(srcPkg, f), d = path.join(wtPkg, f);
    if (existsSync(s) && !existsSync(d)) { try { copyFileSync(s, d); } catch { /* best effort */ } }
  }
}

const urlFor = (bug, role) => `http://${bug}.${IP}.nip.io:${ROLE_PORT[role]}/`;

async function up(bugRaw, worktreeRaw) {
  const bug = bugRaw.toLowerCase();
  const worktree = path.resolve(worktreeRaw);
  if (!existsSync(worktree)) { console.error(`worktree not found: ${worktree}`); process.exit(1); }
  mkdirSync(LOGS, { recursive: true });

  const urls = { api: urlFor(bug, 'api'), customer: urlFor(bug, ''), partner: urlFor(bug, 'admin') };
  const ports = { api: await freePort(31100), customer: await freePort(52100), partner: await freePort(51100) };
  const procs = {};

  for (const svc of SERVICES) {
    const cwd = path.join(worktree, svc.dir);
    if (!existsSync(cwd)) { console.error(`[preview] missing ${svc.dir} in worktree — skipping`); continue; }
    ensureDeps(worktree, svc);
    const env = { ...process.env };
    let args;
    if (svc.kind === 'backend') {
      env.PORT = String(ports.api);
      env.NODE_ENV = env.NODE_ENV || 'development';
      env.BACKEND_URL = stripSlash(urls.api);
      env.CUSTOMER_FRONTEND_URL = stripSlash(urls.customer);
      env.FRONTEND_URL = stripSlash(urls.partner);
      args = ['run', 'dev'];
    } else {
      const port = svc.name === 'customer-portal' ? ports.customer : ports.partner;
      env.VITE_API_URL = stripSlash(urls.api);
      args = ['run', 'dev', '--', '--port', String(port)];
    }
    const out = openSync(path.join(LOGS, `${bug}-${svc.name}.log`), 'a');
    const child = spawn('npm', args, { cwd, env, detached: true, stdio: ['ignore', out, out] });
    child.unref();
    const port = svc.kind === 'backend' ? ports.api : (svc.name === 'customer-portal' ? ports.customer : ports.partner);
    procs[svc.name] = { pid: child.pid, port };
    console.log(`[preview] ${bug}: started ${svc.name} (pid ${child.pid}) on :${port}`);
  }

  const routes = readJson(ROUTES);
  routes[bug] = ports.customer;
  routes[`${bug}-api`] = ports.api;
  routes[`${bug}-admin`] = ports.partner;
  writeJson(ROUTES, routes);

  const state = readJson(STATE);
  state[bug] = { worktree, ports, procs, urls, at: new Date().toISOString() };
  writeJson(STATE, state);

  console.log('[preview] waiting for services to come up (first boot of backend can take ~30s)...');
  const ok = {
    api: await waitPort(ports.api),
    customer: await waitPort(ports.customer),
    partner: await waitPort(ports.partner),
  };
  console.log('');
  console.log(`  Customer portal: ${urls.customer}   (${ok.customer ? 'up' : 'NOT UP'})`);
  console.log(`  Partner portal:  ${urls.partner}   (${ok.partner ? 'up' : 'NOT UP'})`);
  console.log(`  Backend API:     ${urls.api}   (${ok.api ? 'up' : 'NOT UP'})`);
  console.log('');
  if (!ok.api || !ok.customer || !ok.partner) console.log(`  Some service isn't up — check ${LOGS}/${bug}-*.log`);
}

function down(bugRaw) {
  const bug = bugRaw.toLowerCase();
  const state = readJson(STATE);
  const entry = state[bug];
  if (entry?.procs) {
    for (const [name, p] of Object.entries(entry.procs)) {
      try { process.kill(-p.pid, 'SIGTERM'); }
      catch { try { process.kill(p.pid, 'SIGTERM'); } catch { /* already gone */ } }
      console.log(`[preview] stopped ${name} (pid ${p.pid})`);
    }
  }
  const routes = readJson(ROUTES);
  delete routes[bug]; delete routes[`${bug}-api`]; delete routes[`${bug}-admin`];
  writeJson(ROUTES, routes);
  delete state[bug]; writeJson(STATE, state);
  console.log(`[preview] ${bug} torn down`);
}

function list() {
  const state = readJson(STATE);
  const keys = Object.keys(state);
  if (!keys.length) { console.log('[preview] no active previews'); return; }
  for (const b of keys) console.log(`${b}  ${state[b].urls.customer}  (worktree: ${state[b].worktree})`);
}

const [cmd, bug, wt] = process.argv.slice(2);
if (cmd === 'up' && bug && wt) up(bug, wt);
else if (cmd === 'down' && bug) down(bug);
else if (cmd === 'list') list();
else { console.error('Usage:\n  preview.mjs up <bug-id> <worktree>\n  preview.mjs down <bug-id>\n  preview.mjs list'); process.exit(2); }
