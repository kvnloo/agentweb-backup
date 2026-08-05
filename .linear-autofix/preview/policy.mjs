#!/usr/bin/env node
// .linear-autofix/preview/policy.mjs — live-preview cap + idle eviction, shared by the pipeline
// (autofix.mjs, non-forced keep) and the chat server (user-forced bring-up).
//
// Caps (config): normal keep ≤ maxLivePreviews (5); a user-forced bring-up may reach
// maxForcedPreviews (7). To make room past the cap we evict the LONGEST-IDLE preview first — idle
// meaning ALL of {brought-up time, last time its URL was opened, last agent-chat activity on the
// issue} are old. So an actively-used preview (recent URL hit or recent chat) is never the longest
// idle and survives; only genuinely-abandoned ones get reclaimed.

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { config } from '../config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CGROUP_ROOT = '/sys/fs/cgroup';
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
