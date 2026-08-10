// Tests for the chat-state read cache + write-behind persistence. server.mjs parses a tens-of-MB
// chat-state.json, so it caches the parsed object keyed on the file's mtime, and it persists writes
// asynchronously (coalesced) instead of blocking the event loop ~0.5s per message. server.mjs has no
// exports, so (per this repo's convention) we keep a FAITHFUL COPY of the cache + flush machinery here.
// Verify: read cache hit / mtime invalidation / {}-on-missing; write-behind makes in-process reads see
// the change immediately; the async flush persists to disk; a burst coalesces into fewer disk writes
// than calls; and flushChatStateSync persists synchronously (the shutdown path).
// Run: node test/chat-state-cache.test.mjs
import { mkdtempSync, writeFileSync, readFileSync, renameSync, statSync, rmSync, existsSync } from 'node:fs';
import { writeFile as writeFileAsync, rename as renameAsync } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✅ ${m}`); } else { fail++; console.log(`  ❌ ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dir = mkdtempSync(path.join(tmpdir(), 'chatcache-'));
const chatStatePath = path.join(dir, 'chat-state.json');

// ── Faithful copy of chat/server.mjs cache + write-behind + incremental serialize (keep in sync) ──
let chatStateCache = { mtimeMs: -1, data: null };
let parseCount = 0;      // test-only: prove we skip the parse on a cache hit
let diskWrites = 0;      // test-only: prove a burst coalesces
let entryStringifies = 0; // test-only: how many per-issue JSON.stringify a flush actually ran
const serializedEntries = new Map();
const dirtyEntries = new Set();
const loadChatState = () => {
  try {
    const mtimeMs = statSync(chatStatePath).mtimeMs;
    if (chatStateCache.data && chatStateCache.mtimeMs === mtimeMs) return chatStateCache.data;
    const data = JSON.parse(readFileSync(chatStatePath, 'utf8'));
    parseCount++;
    chatStateCache = { mtimeMs, data };
    serializedEntries.clear(); dirtyEntries.clear();
    return data;
  } catch { return chatStateCache.data || {}; }
};
function serializeChatState(state) {
  const keys = Object.keys(state);
  const parts = [];
  for (const key of keys) {
    let s = serializedEntries.get(key);
    if (s === undefined || dirtyEntries.has(key)) { s = JSON.stringify(state[key]); entryStringifies++; serializedEntries.set(key, s); }
    parts.push(JSON.stringify(key) + ':' + s);
  }
  dirtyEntries.clear();
  if (serializedEntries.size > keys.length) for (const k of serializedEntries.keys()) if (!(k in state)) serializedEntries.delete(k);
  return '{' + parts.join(',') + '}';
}
let flushDirty = false, flushTimer = null, flushing = false;
function scheduleFlush() {
  flushDirty = true;
  if (flushTimer || flushing) return;
  flushTimer = setTimeout(() => { flushTimer = null; flushChatStateAsync(); }, 120);
}
async function flushChatStateAsync() {
  if (flushing || !flushDirty || !chatStateCache.data) return;
  flushing = true; flushDirty = false;
  const tmp = `${chatStatePath}.tmp.${process.pid}`;
  try {
    const str = serializeChatState(chatStateCache.data);
    await writeFileAsync(tmp, str);
    await renameAsync(tmp, chatStatePath);
    diskWrites++;
    try { chatStateCache.mtimeMs = statSync(chatStatePath).mtimeMs; } catch {}
  } catch (e) { flushDirty = true; }
  finally { flushing = false; if (flushDirty) scheduleFlush(); }
}
function flushChatStateSync() {
  if (!flushDirty || !chatStateCache.data) return;
  flushDirty = false;
  try {
    const tmp = `${chatStatePath}.tmp.${process.pid}`;
    writeFileSync(tmp, serializeChatState(chatStateCache.data));
    renameSync(tmp, chatStatePath);
    diskWrites++;
    try { chatStateCache.mtimeMs = statSync(chatStatePath).mtimeMs; } catch {}
  } catch {}
}
function writeChatState(obj, dirtyId) {
  chatStateCache = { mtimeMs: chatStateCache.mtimeMs, data: obj };
  if (dirtyId) dirtyEntries.add(dirtyId); else serializedEntries.clear();
  scheduleFlush();
}
const settle = () => sleep(200); // > debounce(120) + flush

console.log('chat-state read cache + write-behind');
try {
  // error path: no file yet → {} (matches original fallback)
  ok(JSON.stringify(loadChatState()) === '{}', 'missing file → {}');

  // write-behind: in-process read reflects the write IMMEDIATELY (before any disk flush)
  writeChatState({ 'ENG-1': { messages: [1, 2, 3] } });
  ok(!existsSync(chatStatePath), 'write-behind does not touch disk synchronously');
  parseCount = 0;
  ok(loadChatState()['ENG-1'].messages.length === 3, 'in-process read sees the write at once');
  ok(parseCount === 0, 'in-process read is served from cache (0 parses, no disk needed)');

  // the async flush persists to disk shortly after
  await settle();
  ok(existsSync(chatStatePath), 'async flush wrote the file');
  ok(JSON.parse(readFileSync(chatStatePath, 'utf8'))['ENG-1'].messages.length === 3, 'disk matches what was written');
  ok(diskWrites === 1, 'a single write produced a single disk flush');

  // cache hit: repeated same-mtime reads never re-parse
  parseCount = 0; loadChatState(); loadChatState();
  ok(parseCount === 0, 'repeated same-mtime reads never re-parse');

  // coalescing: a burst of rapid writes collapses into fewer disk flushes than calls
  diskWrites = 0;
  for (let i = 0; i < 5; i++) writeChatState({ 'ENG-1': { messages: Array(i + 1).fill(i) } });
  ok(loadChatState()['ENG-1'].messages.length === 5, 'reads see the latest write during a burst');
  await settle();
  ok(diskWrites < 5 && diskWrites >= 1, `burst of 5 writes coalesced into ${diskWrites} disk flush(es)`);
  ok(JSON.parse(readFileSync(chatStatePath, 'utf8'))['ENG-1'].messages.length === 5, 'disk reflects the FINAL write of the burst');

  // out-of-band write (different mtime) invalidates the read cache and forces a fresh parse
  const before = statSync(chatStatePath).mtimeMs;
  writeFileSync(chatStatePath, JSON.stringify({ 'ENG-3': { messages: [7, 7] } }));
  const { utimesSync } = await import('node:fs');
  const future = (before / 1000) + 5;
  utimesSync(chatStatePath, future, future);
  parseCount = 0;
  const c = loadChatState();
  ok(c['ENG-3'] && !c['ENG-1'], 'out-of-band write is picked up (fresh content)');
  ok(parseCount === 1, 'out-of-band mtime change forces exactly one re-parse');

  // flushChatStateSync persists pending write-behind state synchronously (the shutdown path)
  writeChatState({ 'ENG-9': { messages: [42] } });
  flushChatStateSync(); // no await
  ok(JSON.parse(readFileSync(chatStatePath, 'utf8'))['ENG-9'].messages[0] === 42, 'sync flush persists immediately (shutdown durability)');
  ok(flushDirty === false, 'sync flush clears the dirty flag');

  // ── incremental serialization: a flush re-stringifies only the DIRTY issue, reusing cached strings ──
  console.log('incremental serialize');
  // seed a multi-issue state and flush once to populate the per-entry string cache
  serializedEntries.clear(); dirtyEntries.clear();
  const state = { 'ENG-1': { messages: [1] }, 'ENG-2': { messages: [2] }, 'ENG-3': { messages: [3] } };
  writeChatState(state); // no dirtyId → full rebuild
  entryStringifies = 0; flushDirty = true;
  let out = serializeChatState(chatStateCache.data);
  ok(entryStringifies === 3, 'first flush stringifies every issue (cold cache)');
  ok(out === JSON.stringify(state), 'incremental output is byte-identical to JSON.stringify(state)');

  // mutate ONE issue in place and mark just it dirty (mirrors updateChatState's writeChatState(s, id))
  chatStateCache.data['ENG-2'].messages.push(22);
  writeChatState(chatStateCache.data, 'ENG-2');
  entryStringifies = 0;
  out = serializeChatState(chatStateCache.data);
  ok(entryStringifies === 1, 'a scoped write re-stringifies only the dirty issue (1, not 3)');
  ok(JSON.parse(out)['ENG-2'].messages.length === 2, 'the dirty issue reflects its mutation on disk');
  ok(JSON.parse(out)['ENG-1'].messages[0] === 1 && JSON.parse(out)['ENG-3'].messages[0] === 3, 'untouched issues are preserved via cached strings');

  // deleting an issue drops it from the output and evicts its cached string
  delete chatStateCache.data['ENG-3'];
  writeChatState(chatStateCache.data, 'ENG-3');
  entryStringifies = 0;
  out = serializeChatState(chatStateCache.data);
  ok(!('ENG-3' in JSON.parse(out)), 'deleted issue no longer serialized');
  ok(entryStringifies === 0, 'delete needs no re-stringify (survivors served from cache)');
  ok(!serializedEntries.has('ENG-3'), 'deleted issue evicted from the string cache (no unbounded growth)');

  // a re-parse from disk (mtime change) invalidates the serialize cache so stale strings never leak
  serializedEntries.set('ENG-STALE', '{"messages":[999]}');
  const t = statSync(chatStatePath).mtimeMs; utimesSync(chatStatePath, (t / 1000) + 9, (t / 1000) + 9);
  loadChatState();
  ok(serializedEntries.size === 0, 're-parse from disk clears the per-entry string cache');
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(fail ? `\n❌ ${fail} FAILED — ${pass} passed, ${fail} failed` : `\n✅ ALL PASSED — ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
