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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
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

// Before a user-forced bring-up of `identifier`, make sure the total will stay within `cap`: evict
// the longest-idle OTHER previews until at most cap-1 remain (leaving one slot). Never evicts the
// target itself (re-enabling an already-up preview shouldn't kill it). Returns evicted bug ids.
export function evictToMakeRoom(identifier, cap, log = () => {}) {
  const state = readJson(STATE);
  const exc = identifier.toLowerCase();
  const others = Object.keys(state).filter((b) => b !== exc);
  const limit = Math.max(0, cap - 1);
  if (others.length <= limit) return [];
  const access = readJson(ACCESS);
  const chat = readJson(CHAT_STATE);
  const ranked = others
    .map((b) => ({ b, hit: lastHit(b, state, access, chat) }))
    .sort((a, z) => a.hit - z.hit);
  const evicted = [];
  for (const { b, hit } of ranked.slice(0, others.length - limit)) {
    const ago = hit ? `${Math.round((Date.now() - hit) / 60000)}m ago` : 'never';
    log(`forced preview at cap ${cap}: evicting longest-idle ${b} (last hit ${ago}) to make room for ${identifier}`);
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
  const access = readJson(ACCESS);
  const chat = readJson(CHAT_STATE);
  const ranked = bugs
    .map((b) => ({ b, hit: lastHit(b, state, access, chat) }))
    .sort((a, z) => a.hit - z.hit); // oldest (most idle) first
  const evicted = [];
  for (const { b, hit } of ranked.slice(0, bugs.length - cap)) {
    const ago = hit ? `${Math.round((Date.now() - hit) / 60000)}m ago` : 'never';
    log(`preview cap ${cap}: evicting longest-idle preview ${b} (last hit ${ago})`);
    spawnSync('node', [PREVIEW, 'down', b], { stdio: 'inherit' });
    evicted.push(b);
  }
  return evicted;
}
