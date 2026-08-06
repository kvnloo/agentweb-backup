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

// ── Faithful copy of chat/server.mjs cache + write-behind (keep in sync) ──
let chatStateCache = { mtimeMs: -1, data: null };
let parseCount = 0;      // test-only: prove we skip the parse on a cache hit
let diskWrites = 0;      // test-only: prove a burst coalesces
const loadChatState = () => {
  try {
    const mtimeMs = statSync(chatStatePath).mtimeMs;
    if (chatStateCache.data && chatStateCache.mtimeMs === mtimeMs) return chatStateCache.data;
    const data = JSON.parse(readFileSync(chatStatePath, 'utf8'));
    parseCount++;
    chatStateCache = { mtimeMs, data };
    return data;
  } catch { return chatStateCache.data || {}; }
};
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
    const str = JSON.stringify(chatStateCache.data);
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
    writeFileSync(tmp, JSON.stringify(chatStateCache.data));
    renameSync(tmp, chatStatePath);
    diskWrites++;
    try { chatStateCache.mtimeMs = statSync(chatStatePath).mtimeMs; } catch {}
  } catch {}
}
function writeChatState(obj) {
  chatStateCache = { mtimeMs: chatStateCache.mtimeMs, data: obj };
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
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(fail ? `\n❌ ${fail} FAILED — ${pass} passed, ${fail} failed` : `\n✅ ALL PASSED — ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
