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
import { runUnderBuildLock, BuildLockTimeoutError } from '../build-lock.mjs';
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
// HEAD sha of a git repo/worktree — the source revision the preview is (or would be) serving. null on error.
const currentHead = (repoPath) => { const r = spawnSync('git', ['-C', repoPath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : null; };

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

  // Provenance + refresh visibility: capture the prior entry BEFORE teardown. `manual` (the user
  // explicitly started this preview) is carried across refreshes so eviction keeps respecting it; and a
  // refresh of an already-up stack stays VISIBLE in the monitor during its ~30-60s rebuild (old urls +
  // `refreshing`) instead of a bare `starting` placeholder that listPreviews hides (the "vanishes then
  // reappears" flicker).
  const prior = readJson(STATE)[bug];
  const wasUp = !!(prior && prior.procs && prior.urls);
  const manual = process.argv.includes('--manual') || !!prior?.manual;

  // Bug 2 leak fix: an existing live stack for this same bug is overwritten below (routes + state +
  // freshly-allocated ports), orphaning its old process groups forever (two full stacks resident for
  // one ticket → the OOM). Stop-and-await any prior stack FIRST so we never leak one.
  await stopExistingStack(bug);

  // #14: register a placeholder entry BEFORE the cap check + build so a CONCURRENT bring-up of another
  // bug counts this in-flight preview (otherwise two both read the same pre-write count and both slip
  // past the cap). Overwritten with the full entry at the end; torn down by down() / the cap-refuse
  // below on failure. The cap check excludes this bug, so its own placeholder never blocks it.
  { const st0 = readJson(STATE); if (!st0[bug]) {
      st0[bug] = wasUp
        ? { worktree, urls: prior.urls, at: prior.at || new Date().toISOString(), refreshing: true, ...(manual ? { manual: true } : {}) }
        : { worktree, at: new Date().toISOString(), starting: true, ...(manual ? { manual: true } : {}) };
      writeJson(STATE, st0);
  } }

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
      // Serializes heavy builds MACHINE-WIDE (same lock as autofix's checks): concurrent vite builds +
      // a verify browser saturated the 4-vCPU runner to the point sshd starved. Reentrant (ENG-1016):
      // if THIS call is itself already running under an outer `flock /tmp/aw-heavy-build.lock …`
      // (e.g. an agent wrapped the whole `preview.mjs up` invocation), runUnderBuildLock detects that
      // ancestor and runs the build directly instead of re-locking — a second flock here would block
      // forever on a lock its own parent holds. Bounded: a real, unrelated 15-minute wait fails loudly
      // with a named timeout instead of hanging the box forever.
      console.log(`[preview] building ${svc.name} (one-time, no watchers; queued on the build lock)...`);
      let b;
      try { b = runUnderBuildLock('npx', ['vite', 'build'], { cwd, env, stdio: ['ignore', out, out] }); }
      catch (e) {
        if (e instanceof BuildLockTimeoutError) { console.log(`[preview] WARNING: ${svc.name} build lock timed out — ${e.message}`); b = { status: 1 }; }
        else throw e;
      }
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

    // Persist what is running RIGHT NOW, before the next service's (minutes-long) build. The full entry
    // used to be written only after this whole loop finished, which meant every service started so far
    // was untracked for the duration — and the gap is not small: each portal build queues on the
    // machine-wide flock, so bring-ups here have taken 15-25 minutes under contention. Anything that
    // ended the run inside that window (a kill, a crash, an exit) left live servers with NO state entry
    // and nothing that could ever find them again. That is how eng-803 and eng-873 both ended up serving
    // on 31100/52100 with no record on 2026-08-05, and how ENG-845 accumulated 2498MB of forgotten
    // processes. Keeping `starting` set marks the bring-up as still in flight, so the gc sweeps leave it
    // alone while it works; the final write below drops the flag.
    { const st = readJson(STATE);
      st[bug] = { ...(st[bug] || {}), worktree, ports: { ...ports }, procs: { ...procs }, starting: true, ...(manual ? { manual: true } : {}) };
      writeJson(STATE, st);
    }
  }

  const routes = readJson(ROUTES);
  if (ports.customer != null) routes[bug] = ports.customer;
  if (ports.api != null) routes[`${bug}-api`] = ports.api;
  if (ports.partner != null) routes[`${bug}-admin`] = ports.partner;
  writeJson(ROUTES, routes);

  const state = readJson(STATE);
  // Record the commit this stack was brought up from, so gc / the chat dropdown can tell when the branch
  // has advanced past it (→ stale, needs a refresh). This is the main agentweb worktree HEAD (backend +
  // partner-portal live here; the customer-portal repo isn't tracked for staleness yet).
  state[bug] = { worktree, ports, procs, urls, commit: currentHead(worktree), at: new Date().toISOString(), ...(manual ? { manual: true } : {}) };
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

// Restart ONLY the backend on its EXISTING port, re-reading the worktree source (ts-node --transpile-only
// → new code, no build). Reuses the recorded ports/urls and the same env construction as up(), so the
// proxy routes stay valid. Returns whether the backend came back up. Cheap path for a backend-only change.
async function restartBackend(bug, entry, newHead) {
  const worktree = entry.worktree;
  const cwd = path.join(worktree, 'backend');
  const port = entry.ports?.api;
  const oldPid = entry.procs?.backend?.pid;
  if (!existsSync(cwd) || !port) { console.log(`[preview] ${bug}: can't backend-restart (missing backend dir/port)`); return false; }
  if (oldPid) { try { process.kill(-oldPid, 'SIGTERM'); } catch { try { process.kill(oldPid, 'SIGTERM'); } catch { /* gone */ } } }
  let freed = await waitPortFree(port);
  if (!freed && oldPid) { try { process.kill(-oldPid, 'SIGKILL'); } catch { try { process.kill(oldPid, 'SIGKILL'); } catch { /* gone */ } } freed = await waitPortFree(port, 5000); }
  const env = { ...process.env, PORT: String(port), NODE_ENV: process.env.NODE_ENV || 'development',
    BACKEND_URL: stripSlash(entry.urls.api), CUSTOMER_FRONTEND_URL: stripSlash(entry.urls.customer), FRONTEND_URL: stripSlash(entry.urls.partner) };
  mkdirSync(LOGS, { recursive: true });
  const out = openSync(path.join(LOGS, `${bug}-backend.log`), 'a');
  const child = spawn('npx', ['ts-node', '--transpile-only', 'src/server.ts'], { cwd, env, detached: true, stdio: ['ignore', out, out] });
  child.unref();
  // Persist the new pid + the commit we just moved to (so staleness resets). RMW so we don't clobber
  // a concurrent write for another bug.
  const st = readJson(STATE);
  if (st[bug]?.procs?.backend) { st[bug].procs.backend.pid = child.pid; st[bug].commit = newHead; st[bug].at = new Date().toISOString(); writeJson(STATE, st); }
  const ok = await waitPort(port);
  console.log(`[preview] ${bug}: backend restarted (pid ${child.pid}) on :${port} at ${newHead ? newHead.slice(0, 9) : '?'} — ${ok ? 'up' : 'NOT UP'}`);
  return ok;
}

// Bring a running preview up to its branch HEAD if it has drifted (new commits landed after bring-up).
// Backend-only change → cheap ts-node restart (keeps the built portals serving). Anything touching a
// portal (or no recorded baseline) → full down+up so the static builds are regenerated too.
async function refresh(bugRaw) {
  const bug = bugRaw.toLowerCase();
  const entry = readJson(STATE)[bug];
  if (!entry || entry.starting || !entry.procs) { console.log(`[preview] ${bug}: not running — nothing to refresh`); return; }
  const worktree = entry.worktree;
  const head = currentHead(worktree);
  if (!head) { console.log(`[preview] ${bug}: can't read worktree HEAD — skipping refresh`); return; }
  if (entry.commit === head) { console.log(`[preview] ${bug}: already at ${head.slice(0, 9)} — fresh`); return; }
  let changed = null;
  if (entry.commit) { const d = spawnSync('git', ['-C', worktree, 'diff', '--name-only', entry.commit, head], { encoding: 'utf8' }); if (d.status === 0) changed = d.stdout.split('\n').filter(Boolean); }
  const portalTouched = !changed || changed.some((f) => f.startsWith('partner-portal/') || f.startsWith('customer-portal/'));
  console.log(`[preview] ${bug}: ${entry.commit ? entry.commit.slice(0, 9) : '(no baseline)'} → ${head.slice(0, 9)}${changed ? ` (${changed.length} file(s) changed)` : ''}`);
  if (portalTouched) { console.log(`[preview] ${bug}: a portal changed (or no baseline) — full rebuild`); await up(bug, worktree); }
  else { console.log(`[preview] ${bug}: backend-only change — restarting ts-node (no build)`); await restartBackend(bug, entry, head); }
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
else if (cmd === 'refresh' && bug) refresh(bug);
else if (cmd === 'list') list();
else { console.error('Usage:\n  preview.mjs up <bug-id> <worktree>\n  preview.mjs down <bug-id>\n  preview.mjs refresh <bug-id>\n  preview.mjs list'); process.exit(2); }
