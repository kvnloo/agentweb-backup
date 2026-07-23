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
import { atConcurrentPreviewCap, runningPreviewIds } from './policy.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const agentRoot = path.resolve(__dirname, '../..'); // the agentweb (main) repo root
const ROUTES = path.join(__dirname, 'routes.json');
const STATE = path.join(__dirname, 'preview-state.json');
const LOGS = path.join(__dirname, 'logs');

// Loopback by default: the verify browser + preview run on the same machine, and 127.0.0.1
// avoids LAN/sandbox firewall issues. Set PREVIEW_IP to the LAN IP to reach it from another
// device (e.g. a real phone for mobile testing).
const IP = process.env.PREVIEW_IP || '127.0.0.1';
// Dash-separated IP for nip.io: a dotted <bug>.<ip>.nip.io is mis-parsed when the bug id ends
// in digits (e.g. eng-138.44.250.109.186 → nip.io reads "138.44.250.109"). Dashes are unambiguous.
const IPDASH = IP.replace(/\./g, '-');
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

// Resolves once nothing is listening on `port` (i.e. the old service released it), or after timeout.
function waitPortFree(port, timeoutMs = 10000) {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      const c = net.connect(port, '127.0.0.1');
      c.once('connect', () => { c.destroy(); if (Date.now() - t0 > timeoutMs) resolve(false); else setTimeout(tick, 250); });
      c.once('error', () => { c.destroy(); resolve(true); }); // refused = free
    };
    tick();
  });
}

// Teardown-before-start: if a full stack is ALREADY running for this bug, stop it and wait for its
// process groups to actually release their ports before we build a new one. Every bring-up funnels
// through up(), so enforcing it here — not in any single caller — is what guarantees a ticket never
// ends up with two live stacks: the chat "refresh" path stops-first, but the manual "up" button, the
// pipeline auto-keep, and a direct `preview.mjs up` from Bash do not, and none coordinate across
// processes. down() SIGTERMs the groups; we then wait, and SIGKILL any straggler so RAM is reclaimed.
// A bare `starting: true` placeholder (a concurrent in-flight bring-up, no procs yet) is left alone.
async function stopExistingStack(bug) {
  const prior = readJson(STATE)[bug];
  if (!prior?.procs || !Object.keys(prior.procs).length) return false;
  console.log(`[preview] ${bug}: a stack is already running (started ${prior.at || '?'}) — stopping it before starting a new one`);
  const ports = Object.values(prior.procs).map((p) => p.port).filter(Boolean);
  const pids = Object.values(prior.procs).map((p) => p.pid).filter(Boolean);
  down(bug); // SIGTERM the process groups; clears this bug's routes + state entry
  const freed = await Promise.all(ports.map((p) => waitPortFree(p)));
  if (freed.some((f) => !f)) {
    for (const pid of pids) { try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } }
    await Promise.all(ports.map((p) => waitPortFree(p, 4000)));
  }
  return true;
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

const urlFor = (bug, role) => `http://${bug}.${IPDASH}.nip.io:${ROLE_PORT[role]}/`;

async function up(bugRaw, worktreeRaw) {
  const bug = bugRaw.toLowerCase();
  const worktree = path.resolve(worktreeRaw);
  if (!existsSync(worktree)) { console.error(`worktree not found: ${worktree}`); process.exit(1); }
  mkdirSync(LOGS, { recursive: true });

  // Bug 2 leak fix: an existing live stack for this same bug is overwritten below (routes + state +
  // freshly-allocated ports), orphaning its old process groups forever (two full stacks resident for
  // one ticket → the OOM). Stop-and-await any prior stack FIRST so we never leak one.
  await stopExistingStack(bug);

  // #14: register a placeholder entry BEFORE the cap check + build so a CONCURRENT bring-up of another
  // bug counts this in-flight preview (otherwise two both read the same pre-write count and both slip
  // past the cap). Overwritten with the full entry at the end; torn down by down() / the cap-refuse
  // below on failure. The cap check excludes this bug, so its own placeholder never blocks it.
  { const st0 = readJson(STATE); if (!st0[bug]) { st0[bug] = { worktree, at: new Date().toISOString(), starting: true }; writeJson(STATE, st0); } }

  // Hard concurrent-preview cap (config.maxConcurrentPreviews): never run more than N full stacks at
  // once — the memory guard. REFUSE, don't evict: if N OTHER previews are already up, drop our
  // placeholder and bail non-zero so the caller reports "close one first" instead of silently killing
  // someone else's preview. Every bring-up funnels through up(), so this one ceiling covers the chat
  // button, the pipeline verify, AND a direct `preview.mjs up` from Bash.
  const cap = config.maxConcurrentPreviews ?? 0;
  if (atConcurrentPreviewCap(bug, cap)) {
    const others = runningPreviewIds(bug).map((b) => b.toUpperCase());
    console.log(`[preview] ${bug}: ${others.length} preview(s) already running (${others.join(', ')}) — at the concurrent cap of ${cap}. NOT starting a new one; close one first.`);
    { const st = readJson(STATE); if (st[bug]?.starting) { delete st[bug]; writeJson(STATE, st); } }
    process.exit(3);
  }

  const urls = { api: urlFor(bug, 'api'), customer: urlFor(bug, ''), partner: urlFor(bug, 'admin') };
  const ports = {};
  const procs = {};
  const PORT_KEY = { backend: 'api', 'customer-portal': 'customer', 'partner-portal': 'partner' };
  const PORT_BASE = { api: 31100, customer: 52100, partner: 51100 };

  // WATCHER-FREE by design: dev servers (ts-node-dev + Vite HMR) each hold thousands of inotify
  // watches, and kept previews accumulate until the kernel limit is hit and everything 502s
  // (exactly how ENG-123's verify died). A preview of a COMMITTED fix never changes, so the
  // portals are built once and served static, and the backend runs plain transpile-only ts-node.
  for (const svc of SERVICES) {
    const cwd = path.join(worktree, svc.dir);
    if (!existsSync(cwd)) { console.error(`[preview] missing ${svc.dir} in worktree — skipping`); continue; }
    ensureDeps(worktree, svc);
    const env = { ...process.env };
    const pkey = PORT_KEY[svc.name];
    const out = openSync(path.join(LOGS, `${bug}-${svc.name}.log`), 'a');
    let cmd, args;
    if (svc.kind === 'backend') {
      // No build → allocate right before spawn (tiny reservation window).
      ports.api = await freePort(PORT_BASE.api);
      env.PORT = String(ports.api);
      env.NODE_ENV = env.NODE_ENV || 'development';
      env.BACKEND_URL = stripSlash(urls.api);
      env.CUSTOMER_FRONTEND_URL = stripSlash(urls.customer);
      env.FRONTEND_URL = stripSlash(urls.partner);
      cmd = 'npx'; args = ['ts-node', '--transpile-only', 'src/server.ts'];
    } else {
      env.VITE_API_URL = stripSlash(urls.api);
      // `npx vite build` (not `npm run build`) so a portal build script's `tsc &&` prefix can't
      // block the preview; the deterministic tsc check in autofix.mjs covers type errors.
      // flock serializes heavy builds MACHINE-WIDE (same lock as autofix's checks): concurrent
      // vite builds + a verify browser saturated the 4-vCPU runner to the point sshd starved.
      console.log(`[preview] building ${svc.name} (one-time, no watchers; queued on the build lock)...`);
      const b = spawnSync('flock', ['/tmp/aw-heavy-build.lock', 'npx', 'vite', 'build'], { cwd, env, stdio: ['ignore', out, out] });
      if (b.status !== 0) console.log(`[preview] WARNING: ${svc.name} build failed — check ${LOGS}/${bug}-${svc.name}.log`);
      // #13: allocate the port AFTER the (minutes-long) build, immediately before spawning — not
      // up-front — so it isn't reserved-then-released across the whole build, the window during which
      // a concurrent bring-up would grab the same port and lose the `--strictPort` race.
      ports[pkey] = await freePort(PORT_BASE[pkey]);
      cmd = 'npx'; args = ['vite', 'preview', '--port', String(ports[pkey]), '--strictPort'];
    }
    const child = spawn(cmd, args, { cwd, env, detached: true, stdio: ['ignore', out, out] });
    child.unref();
    procs[svc.name] = { pid: child.pid, port: ports[pkey] };
    console.log(`[preview] ${bug}: started ${svc.name} (pid ${child.pid}) on :${ports[pkey]}`);
  }

  const routes = readJson(ROUTES);
  if (ports.customer != null) routes[bug] = ports.customer;
  if (ports.api != null) routes[`${bug}-api`] = ports.api;
  if (ports.partner != null) routes[`${bug}-admin`] = ports.partner;
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
  // If the preview is fundamentally broken (backend or the main customer portal never bound — e.g. a
  // failed build), tear it down instead of leaving a dead entry that holds a live-cap slot and serves
  // 502s forever. A lone partner-portal miss leaves a still-usable customer+api preview standing.
  if (!ok.api || !ok.customer) {
    console.log(`  Preview for ${bug} did not come up (api:${ok.api ? 'up' : 'down'}, customer:${ok.customer ? 'up' : 'down'}) — tearing it down so it doesn't hold a cap slot or serve 502s. Check ${LOGS}/${bug}-*.log`);
    down(bug);
  } else if (!ok.partner) {
    console.log(`  Partner portal isn't up — leaving the usable customer+api preview; check ${LOGS}/${bug}-partner-portal.log`);
  }
}

function down(bugRaw) {
  const bug = bugRaw.toLowerCase();
  const state = readJson(STATE);
  const entry = state[bug];
  const procs = entry?.procs ? Object.entries(entry.procs) : [];
  for (const [name, p] of procs) {
    try { process.kill(-p.pid, 'SIGTERM'); }
    catch { try { process.kill(p.pid, 'SIGTERM'); } catch { /* already gone */ } }
    console.log(`[preview] stopped ${name} (pid ${p.pid})`);
  }
  const routes = readJson(ROUTES);
  delete routes[bug]; delete routes[`${bug}-api`]; delete routes[`${bug}-admin`];
  writeJson(ROUTES, routes);
  delete state[bug]; writeJson(STATE, state);
  console.log(`[preview] ${bug} torn down`);
  // The agentweb backend's graceful SIGTERM shutdown can hold ~0.5GB (plus its --max-old-space worker)
  // for up to a minute — but a user hits Disable (or the cap evicts) specifically to FREE memory. State
  // and routes are already cleared above, so the UI/cap see the slot freed instantly; this just makes the
  // OS actually reclaim the RAM promptly by SIGKILLing any group still alive after a short grace.
  if (procs.length) {
    setTimeout(() => {
      for (const [, p] of procs) {
        try { process.kill(-p.pid, 'SIGKILL'); }
        catch { try { process.kill(p.pid, 'SIGKILL'); } catch { /* already exited on SIGTERM */ } }
      }
    }, 2500);
  }
}

function list() {
  const state = readJson(STATE);
  const keys = Object.keys(state);
  if (!keys.length) { console.log('[preview] no active previews'); return; }
  for (const b of keys) console.log(`${b}  ${state[b].urls?.customer || (state[b].starting ? '(starting…)' : '(no url)')}  (worktree: ${state[b].worktree})`);
}

const [cmd, bug, wt] = process.argv.slice(2);
if (cmd === 'up' && bug && wt) up(bug, wt);
else if (cmd === 'down' && bug) down(bug);
else if (cmd === 'list') list();
else { console.error('Usage:\n  preview.mjs up <bug-id> <worktree>\n  preview.mjs down <bug-id>\n  preview.mjs list'); process.exit(2); }
