// Tests for the chat-state read cache — server.mjs parses chat-state.json (tens of MB) on every
// request, so it caches the parsed object keyed on the file's mtime. server.mjs has no exports, so
// (per this repo's convention) we keep a FAITHFUL COPY of loadChatState + writeChatState here and
// verify: a cold read parses; a same-mtime read is served from cache without re-parsing; an
// out-of-band write (new mtime) invalidates; an in-process write refreshes the cache to the exact
// object written; a bad read falls back to {}. Run: node test/chat-state-cache.test.mjs
import { mkdtempSync, writeFileSync, readFileSync, renameSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✅ ${m}`); } else { fail++; console.log(`  ❌ ${m}`); } };

const dir = mkdtempSync(path.join(tmpdir(), 'chatcache-'));
const chatStatePath = path.join(dir, 'chat-state.json');

// ── Faithful copy of chat/server.mjs loadChatState + writeChatState (keep in sync) ──
let chatStateCache = { mtimeMs: -1, data: null };
let parseCount = 0; // test-only instrumentation to prove we skip the parse on a cache hit
const loadChatState = () => {
  try {
    const mtimeMs = statSync(chatStatePath).mtimeMs;
    if (chatStateCache.data && chatStateCache.mtimeMs === mtimeMs) return chatStateCache.data;
    const data = JSON.parse(readFileSync(chatStatePath, 'utf8'));
    parseCount++;
    chatStateCache = { mtimeMs, data };
    return data;
  } catch { return {}; }
};
function writeChatState(obj) {
  const tmp = `${chatStatePath}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(obj));
  renameSync(tmp, chatStatePath);
  try { chatStateCache = { mtimeMs: statSync(chatStatePath).mtimeMs, data: obj }; }
  catch { chatStateCache = { mtimeMs: -1, data: null }; }
}

console.log('chat-state read cache');
try {
  // error path: no file yet → {} (matches original fallback), nothing cached
  ok(JSON.stringify(loadChatState()) === '{}', 'missing file → {}');

  // cold read: parses once and returns the data
  writeChatState({ 'ENG-1': { messages: [1, 2, 3] } });
  parseCount = 0; // writeChatState primed the cache; a following read should NOT parse
  const a = loadChatState();
  ok(a['ENG-1'].messages.length === 3, 'reads back what was written');
  ok(parseCount === 0, 'read after in-process write is served from cache (0 parses)');

  // cache hit: repeated reads at the same mtime never re-parse
  loadChatState(); loadChatState();
  ok(parseCount === 0, 'repeated same-mtime reads never re-parse');

  // in-process write refreshes cache to the EXACT object written (no parse, identity preserved)
  const written = { 'ENG-1': { messages: [9] }, 'ENG-2': { messages: [] } };
  writeChatState(written);
  parseCount = 0;
  ok(loadChatState() === written, 'in-process write makes next read return the exact written object');
  ok(parseCount === 0, 'in-process write did not force a re-parse');

  // out-of-band write (different process/mtime) invalidates and forces a fresh parse
  // Simulate: write the file directly with a guaranteed-newer mtime, bypassing writeChatState.
  const before = statSync(chatStatePath).mtimeMs;
  writeFileSync(chatStatePath, JSON.stringify({ 'ENG-3': { messages: [7, 7] } }));
  // ensure mtime advanced even if the FS clock is coarse
  const { utimesSync } = await import('node:fs');
  const future = (before / 1000) + 5; // +5s in seconds
  utimesSync(chatStatePath, future, future);
  parseCount = 0;
  const c = loadChatState();
  ok(c['ENG-3'] && !c['ENG-1'], 'out-of-band write is picked up (fresh content)');
  ok(parseCount === 1, 'out-of-band mtime change forces exactly one re-parse');

  // stale-but-valid read after the invalidating parse is cached again
  parseCount = 0;
  loadChatState();
  ok(parseCount === 0, 're-parsed state is re-cached (subsequent read is a hit)');
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(fail ? `\n❌ ${fail} FAILED — ${pass} passed, ${fail} failed` : `\n✅ ALL PASSED — ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
