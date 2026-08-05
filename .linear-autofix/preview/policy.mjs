#!/usr/bin/env node
// .linear-autofix/preview/policy.mjs — live-preview cap + idle eviction, shared by the pipeline
// (autofix.mjs, non-forced keep) and the chat server (user-forced bring-up).
//
// Caps (config): normal keep ≤ maxLivePreviews (5); a user-forced bring-up may reach
// maxForcedPreviews (7). To make room past the cap we evict the LONGEST-IDLE preview first — idle
// meaning ALL of {brought-up time, last time its URL was opened, last agent-chat activity on the
// issue} are old. So an actively-used preview (recent URL hit or recent chat) is never the longest
// idle and survives; only genuinely-abandoned ones get reclaimed.

import { readFileSync, readlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { config } from '../config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CGROUP_ROOT = '/sys/fs/cgroup';
// Absolute worktree root (config.worktreesDir is relative to the agentweb repo root, one level above
// .linear-autofix). The orphan reaper refuses to touch anything outside it — above all the shared main
// checkout, where a preview-shaped process would be the real running system.
const WORKTREE_ROOT = path.resolve(__dirname, '..', '..', config.worktreesDir || '../autofix-worktrees');
const STATE = path.join(__dirname, 'preview-state.json');       // bug -> { at, urls, ... }   (preview.mjs)
const ACCESS = path.join(__dirname, 'preview-access.json');     // bug -> last URL-open ISO   (proxy.mjs)
const CHAT_STATE = path.join(__dirname, '..', 'chat', 'chat-state.json'); // IDENT -> { messages: [{at}] }
const PREVIEW = path.join(__dirname, 'preview.mjs');

const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return {}; } };
const ms = (iso) => { const t = Date.parse(iso || ''); return Number.isNaN(t) ? 0 : t; };

// Most recent activity touching this preview — the later of: brought-up time, URL last opened, or
// last chat message on the issue. Preview state is keyed lowercase; chat state keyed UPPERCASE.
export function lastHit(bug, state = readJson(STATE), access = readJson(ACCESS), chat = readJson(CHAT_STATE)) {
  const times = [ms(state[bug]?.at), ms(access[bug])];
  const msgs = chat[bug.toUpperCase()]?.messages;
  if (msgs && msgs.length) times.push(ms(msgs[msgs.length - 1]?.at));
  return Math.max(0, ...times);
}

export const livePreviewCount = () => Object.keys(readJson(STATE)).length;

// Ids of previews currently live OTHER than `identifier` — re-enabling an issue's own preview isn't a
// new one, so it never counts against the cap. Includes in-flight `starting` placeholders (they hold a
// slot). Preview state is keyed lowercase.
export const runningPreviewIds = (identifier, state = readJson(STATE)) =>
  Object.keys(state).filter((b) => b !== String(identifier).toLowerCase());

// True if starting a NEW preview for `identifier` would break the hard concurrent cap `cap`: at least
// `cap` OTHER previews are already up. cap<=0 disables the cap. Pure/injectable for tests.
export const atConcurrentPreviewCap = (identifier, cap, state = readJson(STATE)) =>
  cap > 0 && runningPreviewIds(identifier, state).length >= cap;

// Live previews whose recorded bring-up commit no longer matches their worktree's current HEAD — the
// branch advanced after bring-up, so the preview is serving STALE code (the backend runs ts-node from a
// snapshot; the portals are built once). Returns [{ b, worktree, from, to }]. `headOf` is injectable so
// the git probe can be stubbed in tests; entries with no recorded commit / still `starting` are skipped.
const gitHead = (repoPath) => { const r = spawnSync('git', ['-C', repoPath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : null; };
export function stalePreviews(state = readJson(STATE), headOf = gitHead) {
  const out = [];
  for (const [b, e] of Object.entries(state)) {
    if (!e || e.starting || !e.worktree || !e.commit) continue;
    const head = headOf(e.worktree);
    if (head && head !== e.commit) out.push({ b, worktree: e.worktree, from: e.commit, to: head });
  }
  return out;
}

// Before a user-forced bring-up of `identifier`, make sure the total will stay within `cap`: evict
// the longest-idle OTHER previews until at most cap-1 remain (leaving one slot). Never evicts the
// target itself (re-enabling an already-up preview shouldn't kill it). Returns evicted bug ids.
export function evictToMakeRoom(identifier, cap, log = () => {}) {
  const state = readJson(STATE);
  const exc = identifier.toLowerCase();
  const others = Object.keys(state).filter((b) => b !== exc);
  const limit = Math.max(0, cap - 1);
  if (others.length <= limit) return [];
  const need = others.length - limit;
  const access = readJson(ACCESS);
  const chat = readJson(CHAT_STATE);
  // Only agent-created previews are evictable to make room; a user-started (manual) preview is never
  // torn down by the cap path (the OOM backstop is the only thing that may). If there aren't enough
  // agent previews to reach the cap, we evict what we can and let the extra manual ones stand.
  const ranked = others.filter((b) => !state[b]?.manual)
    .map((b) => ({ b, hit: lastHit(b, state, access, chat) }))
    .sort((a, z) => a.hit - z.hit);
  const evicted = [];
  for (const { b, hit } of ranked.slice(0, need)) {
    const ago = hit ? `${Math.round((Date.now() - hit) / 60000)}m ago` : 'never';
    log(`forced preview at cap ${cap}: evicting longest-idle ${b} (last hit ${ago}) to make room for ${identifier}`);
    spawnSync('node', [PREVIEW, 'down', b], { stdio: 'inherit' });
    evicted.push(b);
  }
  return evicted;
}

// Previews whose most-recent activity (lastHit — the SAME signal the cap eviction uses) is at least
// `maxIdleMs` old, oldest-idle first. Pure: no teardown, `now`/state injectable for tests. A preview
// with a recent URL open or chat message has a recent lastHit and is never returned.
export function idlePreviews(maxIdleMs, now = Date.now(), state = readJson(STATE), access = readJson(ACCESS), chat = readJson(CHAT_STATE)) {
  return Object.keys(state)
    .filter((b) => !state[b]?.manual)  // never idle-reap a user-started preview (only the OOM backstop may)
    .map((b) => ({ b, hit: lastHit(b, state, access, chat) }))
    .filter(({ hit }) => now - hit >= maxIdleMs)
    .sort((a, z) => a.hit - z.hit);
}

// Stop every preview untouched for longer than `maxIdleMs` (default 24h via config.previewIdleHours).
// Called from gc.mjs on its 5-minute sweep. Returns the evicted bug ids.
export function evictIdlePreviews(maxIdleMs, log = () => {}) {
  const idle = idlePreviews(maxIdleMs);
  const evicted = [];
  const hrs = Math.round(maxIdleMs / 3600000);
  for (const { b, hit } of idle) {
    const ago = hit ? `${Math.round((Date.now() - hit) / 3600000)}h ago` : 'never';
    log(`preview idle > ${hrs}h: stopping ${b} (last hit ${ago})`);
    spawnSync('node', [PREVIEW, 'down', b], { stdio: 'inherit' });
    evicted.push(b);
  }
  return evicted;
}

// Headroom (MB) left inside one cgroup-v2 memory budget: its effective ceiling minus current usage.
// The ceiling is MemoryHigh when set, else MemoryMax — MemoryHigh is the number that bites first, since
// crossing it makes the kernel throttle and reclaim inside the cgroup rather than hand out more memory.
// "max" (uncapped) or an unreadable/cgroup-v1 path → null = "unknown", so callers never invent pressure.
export function cgroupHeadroomMB(rel, read = (r, f) => readFileSync(path.join(CGROUP_ROOT, r, f), 'utf8')) {
  const num = (f) => {
    try { const v = String(read(rel, f)).trim(); return v === 'max' ? Infinity : (/^\d+$/.test(v) ? +v : null); }
    catch { return null; }
  };
  const current = num('memory.current');
  if (current == null || current === Infinity) return null;
  const ceiling = Math.min(num('memory.high') ?? Infinity, num('memory.max') ?? Infinity);
  if (!Number.isFinite(ceiling)) return null;                 // uncapped cgroup → the host reading governs
  return Math.max(0, Math.round((ceiling - current) / (1024 * 1024)));
}

// Available memory (MB): the TIGHTEST budget we actually live under — the host's MemAvailable AND the
// headroom left in every managed cgroup we run inside (config.memoryCgroups).
//
// The host part is /proc/meminfo's MemAvailable, the kernel's own estimate of what a new workload could
// claim without swapping (accounts for reclaimable cache), so a truer signal than `free`.
//
// The cgroup part was added 2026-08-05, after autofix-chat.service was OOM-killed four times in 56
// minutes while this function cheerfully reported 16-20GB free. It was reading the 31G HOST; the wall we
// were hitting was the unit's 12G MemoryHigh. Every consumer of this number — previewMemFloorMB's reap,
// chat.watch.minMemMB's deferral — was therefore a dead control that could never fire, and the first
// thing to notice the ceiling was systemd killing the unit and 297 processes with it. Previews and heavy
// builds land in EITHER cgroup depending on who started them (chat server → system.slice, cron/SSH →
// user-1000.slice), and both are capped, so we report the minimum across both: either one hitting its
// wall is a real failure, and the reap frees whichever it belongs to.
//
// Returns null only when nothing at all is readable — callers keep treating "unknown" as "no pressure"
// and never evict blindly. Everything injectable for tests.
export function availMemMB({
  meminfo = () => readFileSync('/proc/meminfo', 'utf8'),
  cgroups = config.memoryCgroups ?? [],
  readCgroup = undefined,
} = {}) {
  const readings = [];
  try { const m = meminfo().match(/^MemAvailable:\s+(\d+)\s+kB/m); if (m) readings.push(Math.round(+m[1] / 1024)); }
  catch { /* unreadable /proc → fall through to the cgroup readings */ }
  for (const rel of cgroups) {
    const h = readCgroup ? cgroupHeadroomMB(rel, readCgroup) : cgroupHeadroomMB(rel);
    if (h != null) readings.push(h);
  }
  return readings.length ? Math.min(...readings) : null;
}

// Pure OOM-eviction decision: given the current memory reading and preview state, which bugs should be
// stopped? When available memory is below `floorMB`, pick the longest-idle previews (oldest last-hit
// first) — but NEVER one hit within `minIdleMs` (someone is actively opening its URL or chatting on it)
// and never drop below `keep` total. Returns `{ avail, victims:[{b,hit}] }`. Everything injectable.
//
// The grace period is GRADUATED (added 2026-08-05). A flat `minIdleMs` made this backstop unfireable
// exactly when it was needed: observed live at 1858MB available against a 3500MB floor with three
// previews up, all hit 4-9 minutes ago, so the 10-minute grace protected every one and nobody was
// evicted. That is the normal case, not a coincidence — the previews holding the memory belong to the
// runs being actively chatted, so lastHit is always recent under load. So once available memory falls
// below `criticalMB` the grace shrinks to `criticalMinIdleMs`: the hungrier the box, the shorter the
// benefit of the doubt. It shrinks, never disappears — a preview touched seconds ago is still protected
// at any pressure, and `keep` still holds — and with `criticalMB` unset the behaviour is exactly the
// flat grace it replaced.
export function memoryPressureVictims(floorMB, {
  keep = 1,
  minIdleMs = 10 * 60 * 1000,
  criticalMB = 0,
  criticalMinIdleMs = 2 * 60 * 1000,
  now = Date.now(),
  mem = availMemMB,
  state = readJson(STATE),
  access = readJson(ACCESS),
  chat = readJson(CHAT_STATE),
} = {}) {
  const avail = mem();
  if (avail == null || avail >= floorMB) return { avail, victims: [] }; // unknown or healthy → nothing
  const bugs = Object.keys(state);
  if (bugs.length <= keep) return { avail, victims: [] };
  const critical = criticalMB > 0 && avail < criticalMB;
  const grace = critical ? Math.min(minIdleMs, criticalMinIdleMs) : minIdleMs;
  const ranked = bugs
    .map((b) => ({ b, hit: lastHit(b, state, access, chat) }))
    .filter(({ hit }) => now - hit >= grace)               // protect actively-used previews
    .sort((a, z) => a.hit - z.hit);                        // longest-idle first
  return { avail, victims: ranked.slice(0, Math.max(0, bugs.length - keep)), critical };
}

// Pure liveness decision: which previews are recorded as running but have lost their processes?
//
// Nothing used to check this. A chat-server restart or an OOM kill takes the whole process subtree
// (KillMode=control-group), but preview-state.json and routes.json keep advertising the stack — so its
// URLs 502, and it still counts against maxConcurrentPreviews, until a human notices. On 2026-08-05 that
// happened five times (four oomd kills plus one deliberate restart); after the restart all NINE recorded
// processes across three stacks were dead while all three were still listed.
//
// Skips, in order of how badly getting them wrong would hurt: `starting` entries have no procs recorded
// YET, so judging them would tear down a bring-up that is actively in flight; entries with no procs map
// can't be judged at all; and a locked bug has a run/turn/rebuild mid-flight that may be restarting its
// own stack. Partial death counts as death — a half-alive stack still 502s on whatever died, and the
// teardown reaps the survivors. Everything injectable.
export function deadPreviewIds({
  state = readJson(STATE),
  alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } },
  isLocked = () => false,
  bound = listeningPortChecker(),
} = {}) {
  const dead = [];
  for (const [b, entry] of Object.entries(state)) {
    if (!entry || entry.starting) continue;                       // bring-up in flight — never touch
    const pids = Object.values(entry.procs || {}).map((p) => p?.pid).filter((p) => Number.isInteger(p));
    if (!pids.length) continue;                                   // nothing recorded → nothing to judge
    if (isLocked(b)) continue;                                    // a run/turn/rebuild owns it right now
    if (pids.every(alive)) continue;                              // fully alive → nothing to do
    // Recorded pids are not the last word: a stack can be serving under a LATER generation of processes
    // than state.json remembers (seen live 2026-08-05 — eng-845's three recorded pids dead while seven
    // live node processes for that worktree were still up). Clearing on the pid signal alone would drop
    // the state of something still answering and orphan it. A still-listening port is exactly what makes
    // the difference between 200 and 502 — the symptom this sweep exists to fix — so it vetoes teardown.
    const ports = Object.values(entry.ports || {}).filter((p) => Number.isInteger(p));
    if (ports.some(bound)) continue;
    dead.push(b);
  }
  return dead;
}

// Returns a `bound(port)` predicate over the listening TCP sockets, snapshotted ONCE per call so a sweep
// of N previews costs one read rather than N. Reads /proc/net/tcp{,6} directly (no `ss` dependency):
// column 2 is local_address as HEX_IP:HEX_PORT, column 4 is the socket state, and 0A is TCP_LISTEN.
// An unreadable /proc means "unknown", and unknown must never be read as "nothing is listening" — that
// would remove the veto and let the sweep tear down live stacks — so it reports every port as bound.
export function listeningPortChecker(read = (f) => readFileSync(f, 'utf8')) {
  const ports = new Set();
  let ok = false;
  for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let txt; try { txt = read(f); } catch { continue; }
    ok = true;
    for (const line of txt.split('\n').slice(1)) {
      const col = line.trim().split(/\s+/);
      if (col.length > 3 && col[3] === '0A') {
        const p = parseInt(String(col[1]).split(':')[1], 16);
        if (Number.isInteger(p)) ports.add(p);
      }
    }
  }
  return ok ? (p) => ports.has(p) : () => true;                   // unreadable → veto everything (fail safe)
}

// A preview server is exactly two command shapes. Matching on these — rather than on "runs inside a
// worktree" — is the whole safety story of the reaper below: a worktree also hosts type-checks, jest
// runs, portal BUILDS, claude turns and their MCP servers, and killing one of those mid-flight destroys
// an agent's work. The near-miss that proved it: during the 2026-08-05 cleanup, ENG-845 was locked with
// two active turns, one of which was running `ts-node --transpile-only -O {...}` 76 seconds old — same
// binary, same worktree, different shape. `vite build` is deliberately NOT matched; only `vite preview`.
const PREVIEW_SHAPES = [
  /\bts-node\s+--transpile-only\s+src\/server\.ts\s*$/,       // the preview backend (ts-node from source)
  /\bvite\s+preview\s+--port\s+\d+/,                          // a built portal being served
];

// Which running processes are preview servers that state has FORGOTTEN? A preview can be restarted (or
// half-restarted) leaving an earlier generation alive: still holding RAM, still bound to ports, recorded
// nowhere, so nothing will ever stop it. Live on 2026-08-05, ENG-845 held TEN such processes 3.9 hours
// old at 2498MB (including a 1.7GB worker) serving 31100/52100/51100, while state recorded 31102/52102/
// 51101 and routes.json had dropped the bug entirely — pure dead weight on a box whose failure mode is
// running out of memory.
//
// Four independent guards, because this kills things: the SHAPE must be a preview server; the process
// must live under the worktree root (never the shared main checkout); it must not be a pid the state
// still records (that is the live generation); and it must be older than `minAgeSec`, since a bring-up
// spawns its servers well before it records them — bring-ups were observed taking 15+ minutes here. A
// bug marked `starting` is skipped outright as belt-and-braces on that last point. Everything injectable.
export function orphanPreviewProcs({
  procs = listPreviewCandidates(),
  state = readJson(STATE),
  root = WORKTREE_ROOT,
  minAgeSec = 15 * 60,
} = {}) {
  const recorded = new Set();
  const starting = new Set();
  for (const [b, e] of Object.entries(state)) {
    if (e?.starting) starting.add(b.toLowerCase());
    for (const p of Object.values(e?.procs || {})) if (Number.isInteger(p?.pid)) recorded.add(p.pid);
  }
  // Bugs with a bring-up ACTUALLY RUNNING, read from the process table rather than from state. This is
  // the guard the `starting` flag cannot provide: `preview.mjs up` does teardown-before-start, so mid
  // bring-up there is no state entry at all — no flag to read and no recorded pids. On the first live
  // sweep (2026-08-05 13:40) that window cost an eng-803 bring-up its backend 24 minutes into the run,
  // because with the entry gone a perfectly live server was indistinguishable from an orphan. Absence of
  // state is not evidence of orphanhood; while a bring-up runs, the process table is the authority.
  const bringingUp = new Set();
  for (const p of procs) {
    const m = String(p?.args || '').match(/preview\.mjs\s+(?:up|refresh)\s+(\S+)/);
    if (m) bringingUp.add(m[1].toLowerCase());
  }
  const rootPrefix = root.endsWith('/') ? root : `${root}/`;
  return procs.filter((p) => {
    if (!p || !PREVIEW_SHAPES.some((re) => re.test(p.args))) return false;   // not a preview server
    if (!String(p.cwd || '').startsWith(rootPrefix)) return false;           // outside the worktree root
    if (recorded.has(p.pid)) return false;                                   // the live generation
    if (p.ageSec < minAgeSec) return false;                                  // may be a bring-up in flight
    const bug = String(p.cwd).slice(rootPrefix.length).split('/')[0].toLowerCase();
    if (starting.has(bug)) return false;                                     // bring-up in flight, per state
    if (bringingUp.has(bug)) return false;                                   // bring-up in flight, per ps
    return true;
  });
}

// Effectful wrapper: SIGTERM each orphan (SIGKILL is left to the next sweep — on the live cleanup every
// one of the ten exited on TERM alone, and a wrapper's children go with it). Returns what it signalled.
// `dryRun` logs what it WOULD stop and signals nothing. It defaults ON at the call site (see gc.mjs)
// because this sweep has already been wrong once in production: on its first live pass it killed the
// backend of a bring-up 24 minutes into its run, through a window where no state entry existed at all.
// Worse, bring-ups on this box have been observed dying BEFORE they record state — eng-803 and eng-873
// both did within an hour — which leaves a stack that is genuinely serving (ports listening, requests
// answered) yet indistinguishable from an abandoned one by any signal available here. Until that
// upstream failure is understood, the honest posture for a process-killing sweep is to observe and
// report. The log lines are the evidence needed to decide whether arming it is safe.
export function reapOrphanPreviewProcs(log = () => {}, { dryRun = false, kill = (pid) => process.kill(pid, 'SIGTERM'), ...opts } = {}) {
  const orphans = orphanPreviewProcs(opts);
  const reaped = [];
  for (const p of orphans) {
    const mb = Math.round((p.rssKB || 0) / 1024);
    const what = `orphan preview process ${p.pid} (${Math.round(p.ageSec / 60)}m old${mb ? `, ${mb}MB` : ''}) belongs to no live preview: ${p.args.slice(0, 90)}`;
    if (dryRun) { log(`[dry-run] WOULD stop ${what}`); continue; }
    log(`stopping ${what}`);
    try { kill(p.pid); reaped.push(p.pid); } catch { /* already gone */ }
  }
  return reaped;
}

// Snapshot of running processes as {pid, ageSec, rssKB, args, cwd}. cwd comes from /proc/<pid>/cwd
// because the `npm exec` wrappers carry no worktree path in argv and can only be attributed that way.
export function listPreviewCandidates(spawn = spawnSync, readLink = (p) => readlinkSync(p)) {
  const r = spawn('ps', ['-eo', 'pid=,etimes=,rss=,args='], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (r.status !== 0 || !r.stdout) return [];
  const out = [];
  for (const line of r.stdout.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    let cwd = null;
    try { cwd = readLink(`/proc/${m[1]}/cwd`); } catch { continue; }   // exited, or not ours to inspect
    out.push({ pid: +m[1], ageSec: +m[2], rssKB: +m[3], args: m[4], cwd });
  }
  return out;
}

// Effectful wrapper: clears every dead preview's state + routes via the normal teardown path (which is
// idempotent — it signals pids that are already gone and then drops the entry), so the proxy stops
// advertising a route nobody serves and the live-preview cap counts only real stacks.
//
// It CLEARS rather than revives, deliberately. After an OOM kill every preview is dead at once, so a
// reviving sweep would launch three concurrent portal builds into a box that just ran out of memory —
// re-triggering the exact failure it is meant to clean up after. Clearing is truthful and cheap; whoever
// still needs the preview re-enables it, and that path already exists.
export function reconcileDeadPreviews(log = () => {}, opts = {}) {
  const dead = deadPreviewIds(opts);
  for (const b of dead) {
    log(`preview ${b} is recorded as running but its processes are gone (restart/OOM kill) — clearing stale state + route`);
    spawnSync('node', [PREVIEW, 'down', b], { stdio: 'inherit' });
  }
  return dead;
}

// OOM backstop, independent of Linear status AND of the 24h idle age. Thin effectful wrapper around
// memoryPressureVictims: logs + spawns the teardown. Called from gc.mjs each sweep. Returns evicted ids.
export function evictUnderMemoryPressure(floorMB, opts = {}, log = () => {}) {
  const now = opts.now ?? Date.now();
  const { avail, victims, critical } = memoryPressureVictims(floorMB, { now, ...opts });
  const evicted = [];
  for (const { b, hit } of victims) {
    const ago = hit ? `${Math.round((now - hit) / 60000)}m ago` : 'never';
    const tier = critical ? `CRITICAL <${opts.criticalMB}MB, shortened grace` : `<${floorMB}MB floor`;
    log(`memory pressure (${avail}MB avail, ${tier}): stopping idle ${b} (last hit ${ago})`);
    spawnSync('node', [PREVIEW, 'down', b], { stdio: 'inherit' });
    evicted.push(b);
  }
  return evicted;
}

// Evict longest-idle previews (oldest last-hit first) until at most `cap` remain. Returns the bug ids
// evicted. `log` receives a human line per eviction.
export function evictPreviewsToFit(cap, log = () => {}) {
  const state = readJson(STATE);
  const bugs = Object.keys(state);
  if (bugs.length <= cap) return [];
  const need = bugs.length - cap;
  const access = readJson(ACCESS);
  const chat = readJson(CHAT_STATE);
  // Only agent-created previews are evictable here; user-started (manual) ones are never dropped by the
  // cap path (OOM backstop excepted). Evict as many agent previews as needed/available, oldest first.
  const ranked = bugs.filter((b) => !state[b]?.manual)
    .map((b) => ({ b, hit: lastHit(b, state, access, chat) }))
    .sort((a, z) => a.hit - z.hit); // oldest (most idle) first
  const evicted = [];
  for (const { b, hit } of ranked.slice(0, need)) {
    const ago = hit ? `${Math.round((Date.now() - hit) / 60000)}m ago` : 'never';
    log(`preview cap ${cap}: evicting longest-idle preview ${b} (last hit ${ago})`);
    spawnSync('node', [PREVIEW, 'down', b], { stdio: 'inherit' });
    evicted.push(b);
  }
  return evicted;
}
