#!/usr/bin/env node
// .linear-autofix/chat/server.mjs — web chat about any issue the machine is handling.
// Ask mode = read-only Q&A (tool allowlist is the guard); Fix mode = interactive revise
// (agent commits -> server auto-pushes to the open PR). The FIRST turn resumes the pipeline's
// own Claude session (per-stage session ids live in state.json), so the agent natively
// remembers investigating and making the fix; a fresh context-injected session is the fallback.
//
// Binds localhost only — no auth layer by design; reach it via an SSH tunnel:
//   ssh -L 8790:localhost:8790 ec2-user@<ip>   ->   http://localhost:8790
// Run: chat/run-chat.sh start   (or directly: node chat/server.mjs)

import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  readFileSync, writeFileSync, existsSync, mkdirSync, statSync, unlinkSync, rmSync, createWriteStream, readdirSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { config } from '../config.mjs';
import { resolveIssue } from '../linear.mjs';
import { gitIdentityEnv, resolveAssigneeGhToken, resolveAssigneeIdentity, applyWorktreeIdentity } from '../git-identity.mjs';
import { acquireLock, releaseLock } from '../lock.mjs';
import { transcriptContextUsed, pickResumeBase } from './context-usage.mjs';
import { usageSnapshot } from './usage.mjs';
import { makeEditableDecision, buildEditableBranch, promotedOutcome } from './editable.mjs';
import { computeMetrics } from './metrics.mjs';
import {
  assembleFromBranch, prepareWorktreeDeps, detectChangedRepos, pushChanged, unpushedRepos, countCommits, ensureProxy,
  headShas, resetTo, ensureOpenPrs, touchedPreviewFiles, commitsDropped, assigneeBranchPrefix, kebab,
} from '../autofix.mjs';
import { atConcurrentPreviewCap, runningPreviewIds } from '../preview/policy.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = path.resolve(__dirname, '..');            // .linear-autofix/
const agentRoot = path.resolve(BASE, '..');            // the agentweb repo root
const statePath = path.join(BASE, 'state.json');
const logsDir = path.join(BASE, 'logs');
const previewScript = path.join(BASE, 'preview', 'preview.mjs');
const previewStatePath = path.join(BASE, 'preview', 'preview-state.json');
const chatStatePath = path.join(__dirname, 'chat-state.json');
const uiPath = path.join(__dirname, 'ui.html');
const worktreesDir = path.resolve(agentRoot, config.worktreesDir);
const CHAT = config.chat || {};
const log = (...a) => console.log('[chat]', ...a);

// Token/cost telemetry. One greppable `STATS` line per turn to the chat log so a Claude session on
// the box can answer "what did this chat/issue cost?" from the logs. Aggregate tokens + total cost
// (across the main model AND any background/subagent models) + turns + duration.
const muTokens = (x) => (x ? (x.inputTokens || 0) + (x.outputTokens || 0) + (x.cacheReadInputTokens || 0) + (x.cacheCreationInputTokens || 0) : 0);
function logTurnStats(kind, identifier, cap, result, sessionCostTotal) {
  if (!result) return;
  const u = result.usage || {};
  const inT = u.input_tokens || 0, outT = u.output_tokens || 0, cr = u.cache_read_input_tokens || 0, cc = u.cache_creation_input_tokens || 0;
  const mu = result.modelUsage || {};
  const model = Object.keys(mu).sort((a, b) => muTokens(mu[b]) - muTokens(mu[a]))[0] || '?'; // primary (most-tokens) model
  const cost = result.total_cost_usd || 0;
  log(`STATS ${kind} ${identifier} cap=${cap} model=${model} in=${inT} out=${outT} cache_read=${cr} cache_creation=${cc} context=${inT + cr + cc} cost=$${cost.toFixed(4)} turns=${result.num_turns ?? '?'} dur=${result.duration_ms ? Math.round(result.duration_ms / 1000) + 's' : '?'}${sessionCostTotal != null ? ` | issue_session_total_cost=$${Number(sessionCostTotal).toFixed(4)}` : ''}`);
}

// Per-turn token totals for the chat bubble footer. Sums the turn's usage the same way the STATS line
// does (across every internal tool-call step), so `in` reflects ALL input the turn processed — fresh +
// cache-read + cache-write — and `out` the generated tokens. The breakdown fields feed the hover tooltip.
// Returns null when there's no usage (nothing to show).
const turnTokens = (u) => {
  if (!u) return null;
  const fresh = u.input_tokens || 0, cacheRead = u.cache_read_input_tokens || 0, cacheWrite = u.cache_creation_input_tokens || 0, out = u.output_tokens || 0;
  return { in: fresh + cacheRead + cacheWrite, out, fresh, cacheRead, cacheWrite };
};

const fixEnabled = () => process.env.AUTOFIX_RUN_ENABLED === '1';
const loadState = () => { try { return JSON.parse(readFileSync(statePath, 'utf8')); } catch { return {}; } };
const loadChatState = () => { try { return JSON.parse(readFileSync(chatStatePath, 'utf8')); } catch { return {}; } };
// Read-modify-write against a fresh read (same discipline as autofix's updateState).
// Give every message a stable, monotonic `mid`. Edit/delete address a message by mid, NOT by array
// position, because the .slice(-500) cap drops messages off the FRONT and would shift every index —
// so a stale index could otherwise cut the conversation at the wrong message. The counter persists on
// cs.midSeq and only ever increases, so dropped mids are never reused (no collisions).
function ensureMids(cs) {
  if (!cs || !Array.isArray(cs.messages)) return cs;
  let seq = cs.midSeq || 0;
  for (const m of cs.messages) if (m && m.mid == null) m.mid = ++seq;
  cs.midSeq = seq;
  return cs;
}

// Resolve the CURRENT array index of the message an edit/delete targets: prefer the stable mid, fall
// back to a raw index for older clients. Returns -1 when the target is gone (e.g. scrolled out of the
// 500-message window) so the caller can reject rather than cut at the wrong place.
function resolveMsgIndex(msgs, body) {
  if (body?.mid != null) return msgs.findIndex((m) => m && m.mid === body.mid);
  const idx = Number.parseInt(body?.index, 10);
  return Number.isInteger(idx) && idx >= 0 && idx < msgs.length ? idx : -1;
}

function updateChatState(identifier, fn) {
  const s = loadChatState();
  s[identifier] = ensureMids(fn(s[identifier] || { identifier, cwd: null, sessions: {}, messages: [] }));
  writeFileSync(chatStatePath, JSON.stringify(s, null, 2));
  return s[identifier];
}

// Read-modify-write state.json against a FRESH read so a concurrent autofix/gc write can't be
// clobbered by a stale in-memory copy (same discipline as autofix's updateState). We only ever
// touch a single field, so we merge into the existing entry rather than replacing it.
function updateIssueEntry(identifier, fn) {
  const s = loadState();
  const hit = Object.entries(s).find(([, e]) => (e.identifier || '').toUpperCase() === identifier.toUpperCase());
  if (!hit) return null;
  const [uuid, entry] = hit;
  s[uuid] = fn({ ...entry });
  writeFileSync(statePath, JSON.stringify(s, null, 2));
  return s[uuid];
}

// Merge freshly-detected PRs into the stored list, keyed by repo, keeping any that still have a URL.
// A repo already present is updated in place; a repo touched for the first time is appended.
function mergePrs(existing, detected) {
  const byRepo = new Map((existing || []).filter((p) => p && p.repo).map((p) => [p.repo, p]));
  for (const d of detected || []) {
    if (!d || !d.repo || !d.url) continue;
    byRepo.set(d.repo, { ...(byRepo.get(d.repo) || {}), repo: d.repo, url: d.url });
  }
  return [...byRepo.values()];
}

// ---------------------------------------------------------------------------
// Issue lookups (state.json is the source of truth for "what is this machine handling")

const ACTIVE_OUTCOMES = ['started', 'recovered', 'blocked'];

function findEntry(identifier) {
  const state = loadState();
  for (const [uuid, e] of Object.entries(state)) {
    if ((e.identifier || '').toUpperCase() === identifier.toUpperCase()) return { uuid, entry: e };
  }
  return null;
}

function listIssues() {
  const chatState = loadChatState();
  return Object.entries(loadState())
    .map(([uuid, e]) => {
      const hasWorktree = existsSync(path.join(worktreesDir, e.identifier || ''));
      const cs = chatState[e.identifier] || {};
      return {
        issueId: uuid,
        identifier: e.identifier,
        standalone: e.standalone || false,
        ownerName: e.ownerName || null,
        assigneeName: e.assignee?.name || null, // Linear assignee — shown in the sidebar so it's clear who owns the issue
        linearState: e.linearState || null,     // Linear workflow state name (e.g. "In Progress") — sidebar status chip
        linearStateType: e.linearStateType || null, // its category (backlog/unstarted/started/completed/canceled/triage) — chip colour
        priority: typeof e.priority === 'number' ? e.priority : null, // Linear priority 0..4 — sidebar priority chip (null = unknown)
        linearTitle: e.linearTitle || null,      // the issue's Linear title — shown as the sidebar row's hover tooltip
        outcome: e.outcome,
        triage: e.triage || null,
        branch: e.branch || null,
        at: e.at || null,
        title: e.title || '',
        summary: e.summary || '',
        prs: e.prs || [],
        hasWorktree,
        active: e.standalone || hasWorktree || ACTIVE_OUTCOMES.includes(e.outcome),
        fixable: !!e.branch || hasWorktree,
        chat: {
          messages: (cs.messages || []).length,
          lastAt: (cs.messages || []).at(-1)?.at || null,
          busy: activeTurns.has(e.identifier),
        },
      };
    })
    .filter((i) => i.identifier)
    .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
}

// ---------------------------------------------------------------------------
// Standalone "scratch" chats — a conversation not tied to any ENG issue (e.g. babysitting a PR that no
// card owns). Modeled as a normal state.json entry flagged `standalone`, so it reuses the ENTIRE chat
// stack: its own branch + worktree (full capability), the sidebar list + breathing dot, turns, /btw.
const repoRootOf = (repo) => path.resolve(agentRoot, repo.root);
const wtPathOf = (WT, repo) => (repo.mount === '.' ? WT : path.join(WT, repo.mount));

// Next free CHAT-<n> id (max existing + 1) — the id doubles as the branch name (lowercased).
function nextChatId() {
  let max = 0;
  for (const e of Object.values(loadState())) {
    const m = /^CHAT-(\d+)$/i.exec(e.identifier || '');
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `CHAT-${max + 1}`;
}

// Concise title inferred from the first user message (single line, trimmed, no trailing punctuation).
function deriveTitle(message) {
  return String(message || '').replace(/\s+/g, ' ').trim().slice(0, 60).replace(/[.,;:!?]+$/, '') || 'New chat';
}

const firstNameOf = (name, email) => (String(name || '').trim().split(/\s+/)[0]) || String(email || '').split('@')[0] || '';
// The configured team members (from config.assigneeGitIdentity) a standalone chat can be owned by — the
// owner decides whose git identity, GitHub PAT, and Linear key the agent acts with.
function chatMembers() {
  return Object.entries(config.assigneeGitIdentity || {}).map(([email, id]) => ({ email, name: id.name, firstName: firstNameOf(id.name, email) }));
}

// Create a standalone chat, OWNED by a configured member (so the agent knows whose credentials to use).
// Just a state entry with its own branch; the worktree is built lazily on the first turn.
function createChat(email) {
  const identifier = nextChatId();
  const member = chatMembers().find((m) => m.email.toLowerCase() === String(email || '').toLowerCase()) || null;
  const identity = member ? resolveAssigneeIdentity({ email: member.email }) : null;
  const s = loadState();
  s[`chat-${randomUUID()}`] = {
    identifier, standalone: true, branch: identifier.toLowerCase(), // e.g. chat-1
    outcome: 'chat', title: 'New chat',
    assigneeEmail: member?.email || null, // drives GH PAT + Linear key (config maps are keyed by email)
    assignee: identity || null,           // git commit identity (attributionFor's fallback reads this)
    ownerName: member?.firstName || null, // shown next to the title so it's clear who's on it
    at: new Date().toISOString(),
  };
  writeFileSync(statePath, JSON.stringify(s, null, 2));
  return { code: 200, body: { identifier } };
}

// Resolve a member by email, first name, or full name (case-insensitive) — used by both the UI owner
// picker and the agent's mid-chat [[OWNER: …]] handoff.
function resolveMember(emailOrName) {
  const q = String(emailOrName || '').trim().toLowerCase();
  if (!q) return null;
  return chatMembers().find((m) => m.email.toLowerCase() === q || m.firstName.toLowerCase() === q || m.name.toLowerCase() === q) || null;
}
// Change who's working on a standalone chat — updates the label AND the credentials used from the NEXT
// turn on (git identity + GitHub PAT + Linear key all follow assigneeEmail).
function setChatOwner(identifier, emailOrName) {
  const member = resolveMember(emailOrName);
  if (!member) return { code: 400, error: `unknown member "${emailOrName}" — pick one of: ${chatMembers().map((m) => m.firstName).join(', ')}` };
  const identity = resolveAssigneeIdentity({ email: member.email });
  const saved = updateIssueEntry(identifier, (e) => ({ ...e, assigneeEmail: member.email, assignee: identity || null, ownerName: member.firstName }));
  if (!saved) return { code: 404, error: `no chat ${identifier}` };
  return { code: 200, body: { ownerName: member.firstName, email: member.email } };
}

function renameChat(identifier, title) {
  const t = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!t) return { code: 400, error: 'title must be non-empty' };
  const saved = updateIssueEntry(identifier, (e) => ({ ...e, title: t }));
  if (!saved) return { code: 404, error: `no chat ${identifier}` };
  return { code: 200, body: { title: saved.title } };
}

// Tear down a standalone chat AND its repo: stop preview, remove each repo's worktree + local branch,
// delete the state + chat-state entries. Only standalone chats can be closed this way (an ENG card's
// workspace is owned by the pipeline/gc). Returns 409 if a turn is mid-flight.
function closeChat(identifier) {
  const found = findEntry(identifier);
  if (!found) return { code: 404, error: `no chat ${identifier}` };
  if (!found.entry.standalone) return { code: 400, error: 'only standalone chats can be closed' };
  if (activeTurns.has(identifier)) return { code: 409, error: 'a turn is running — stop it before closing' };
  const lockPath = acquireFixLock(identifier);
  if (!lockPath) return { code: 409, error: 'busy — an operation holds this chat; try again in a moment' };
  try {
    try { spawnSync('node', [previewScript, 'down', identifier], { stdio: 'ignore' }); } catch { /* best-effort */ }
    const WT = path.join(worktreesDir, identifier);
    const branch = found.entry.branch;
    for (const repo of [...config.repos].reverse()) {
      spawnSync('git', ['-C', repoRootOf(repo), 'worktree', 'remove', '--force', wtPathOf(WT, repo)], { encoding: 'utf8' });
      spawnSync('git', ['-C', repoRootOf(repo), 'worktree', 'prune'], { encoding: 'utf8' });
      if (branch) spawnSync('git', ['-C', repoRootOf(repo), 'branch', '-D', branch], { encoding: 'utf8' });
    }
    try { rmSync(WT, { recursive: true, force: true }); } catch { /* already gone */ }
    const s = loadState();
    for (const [uuid, e] of Object.entries(s)) if ((e.identifier || '').toUpperCase() === identifier.toUpperCase()) delete s[uuid];
    writeFileSync(statePath, JSON.stringify(s, null, 2));
    const cs = loadChatState(); delete cs[identifier]; writeFileSync(chatStatePath, JSON.stringify(cs, null, 2));
    log(`closed standalone chat ${identifier} (removed worktree + branch ${branch})`);
    return { code: 200, body: { closed: true } };
  } finally { releaseLock(lockPath); }
}

// GitHub PR URLs the agent surfaced this turn (from its text + tool inputs). Standalone chats DETECT
// links the agent opened instead of auto-opening PRs — matching a normal Claude Code session.
function detectPrUrls(out) {
  const text = [...(out.texts || []), ...(out.blocks || []).map((b) => b.input || '')].join('\n');
  const byUrl = new Map();
  for (const m of text.matchAll(/https:\/\/github\.com\/[\w.-]+\/([\w.-]+)\/pull\/\d+/g)) byUrl.set(m[0], { repo: m[1], url: m[0] });
  return [...byUrl.values()];
}

// Background-watch markers the agent emits at the end of a turn (see config.chat.watchPrompt):
//   [[WATCH: <reason>]]  → arm/re-arm a wake-up loop; the tick re-invokes the agent every cadence.
//   [[WATCH_DONE]]       → the task is finished; stop waking. done wins over an also-present WATCH.
function parseWatch(text) {
  const t = text || '';
  const done = /\[\[WATCH_DONE\]\]/i.test(t);
  const m = t.match(/\[\[WATCH:\s*([^\]]*)\]\]/i);
  return { done, reason: !done && m ? m[1].trim() : null };
}
// Remove the raw markers from text shown to the developer (the watch state drives the UI instead).
function stripWatchMarkers(text) {
  return (text || '').replace(/\[\[WATCH:\s*[^\]]*\]\]/gi, '').replace(/\[\[WATCH_DONE\]\]/gi, '').replace(/\n{3,}/g, '\n\n').trim();
}
// Is a watch record due to fire? Pure so it's unit-testable. `now`, `mem` (MemAvailable MB), and the
// per-issue lock/active check are injected. Returns 'fire' | 'expired' | 'wait' | 'skip'.
function watchDecision(watch, { now, memMB, minMemMB, busy }) {
  if (!watch) return 'skip';
  if (now >= watch.until) return 'expired';
  if (now < watch.nextAt) return 'wait';
  if (busy) return 'wait';               // a turn/preview op is already running for this issue
  if (memMB != null && memMB < minMemMB) return 'skip'; // low memory — defer this whole tick
  return 'fire';
}

// The system framing for a standalone chat turn (first turn / fresh retry). No autofix pipeline, no
// Linear issue — a plain full-capability coding session in a dedicated worktree.
function standaloneChatPrompt(entry, cwd, message, history = '') {
  return `You are a coding assistant in a STANDALONE chat — not tied to any tracked issue. It's a normal, full-capability session (like Claude Code): read/edit code, run commands, use git and \`gh\`, open and manage PRs — whatever the developer asks.
Chat title: "${entry.title || 'New chat'}".${entry.assignee ? `\nYou are acting on behalf of ${entry.assignee.name} — git commits, GitHub PRs, and Linear actions all use their identity/credentials.` : ''}
If the developer indicates a DIFFERENT person is now working (e.g. "this is Anurag now", "Manan here", "I'm taking over"), acknowledge it and end your reply with a line containing exactly: [[OWNER: <their first name or email>]] — from the next turn on, THEIR GitHub PAT and Linear key are used and the label updates.
You are in a dedicated git worktree at ${cwd} on branch \`${entry.branch}\` (a fresh branch off main); the main repo is at the root and customer-portal is nested. There is NO autofix pipeline here and commits are NOT auto-pushed — push or open PRs yourself when asked (any PR you open is auto-detected and shown to the developer).
To CLOSE this chat and delete its workspace when the developer asks, end your reply with a line containing exactly: [[CLOSE_CHAT]]
${history}
Developer's message: ${message}`;
}

// Fresh-turn system prompt for either flavor of chat: a standalone chat gets the plain full-capability
// framing (no Linear fetch, no pipeline), an ENG chat gets the curated issue context. Everything else
// (session curation, /btw, /context, editing) is identical, so standalone chats inherit it all.
async function freshTurnPrompt(cap, identifier, entry, cwd, message, history = '') {
  if (entry.standalone) return standaloneChatPrompt(entry, cwd, message, history);
  return freshPrompt(cap, identifier, entry, await fetchLinear(identifier), cwd, message, history);
}

// Live Linear data is decoration, never a dependency: 8s cap, null on any failure (including
// no LINEAR_API_KEY at all).
async function fetchLinear(identifier) {
  try {
    const issue = await Promise.race([
      resolveIssue(identifier),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000)),
    ]);
    return {
      title: issue.title,
      description: issue.description || '',
      url: issue.url,
      stateName: issue.state?.name || null,
      stateType: issue.state?.type || null,
      comments: (issue.comments?.nodes || []).map((c) => ({ author: c.user?.name || 'someone', body: c.body, at: c.createdAt })),
    };
  } catch { return null; }
}

// Attribution for a full-mode turn's commits/PRs/merges. Prefer the CURRENT Linear assignee, so a
// reassignment takes effect on the very next turn (history is untouched — only future actions switch).
// Falls back to what the pipeline stored on the state entry if Linear is unreachable.
async function attributionFor(identifier, entry) {
  try {
    const issue = await Promise.race([
      resolveIssue(identifier),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000)),
    ]);
    const a = issue?.assignee;
    if (a?.email) { const identity = resolveAssigneeIdentity(a); return { idEnv: gitIdentityEnv(identity), identity, email: a.email, assignee: { name: a.name || null, email: a.email }, live: true, who: `${a.email} (live)` }; }
  } catch { /* Linear unreachable — fall back to the pipeline-stored assignee below */ }
  return { idEnv: entry?.assignee ? gitIdentityEnv(entry.assignee) : {}, identity: entry?.assignee || null, email: entry?.assigneeEmail || null, assignee: entry?.assignee || null, live: false, who: `${entry?.assigneeEmail || 'none'} (stored)` };
}

// The chat agent must touch Linear as the issue's ASSIGNEE — never via the shared/global LINEAR_API_KEY
// the server itself runs on (that key is one person's, doubling as the poller's, so every agent would
// otherwise act as them). Resolve the assignee's OWN key; if they have none configured, the agent gets
// no Linear key at all rather than silently borrowing the shared one.
const assigneeLinearKey = (email) => {
  const ev = email ? config.assigneeLinearKeyEnv?.[email] : null;
  return (ev && process.env[ev]) || null;
};
// Build the environment a chat-agent subprocess runs with. ALWAYS scopes Linear to the assignee (strips
// the shared global key, substitutes the assignee's own or none). `attr` set (full turns) additionally
// carries the assignee's git identity + GH token so commits/PRs are attributed to them; null (read-only,
// /btw, compact) still gets the Linear scoping. Server-side Linear reads are unaffected — they use the
// server's own env, not this.
function agentEnv(entry, attr) {
  const email = attr?.email || entry?.assigneeEmail || entry?.assignee?.email || null;
  const env = { ...process.env };
  const linKey = assigneeLinearKey(email);
  if (linKey) env.LINEAR_API_KEY = linKey; else delete env.LINEAR_API_KEY;
  if (attr) {
    Object.assign(env, attr.idEnv || {});
    const ghToken = attr.email ? resolveAssigneeGhToken({ email: attr.email }) : null;
    if (ghToken) env.GH_TOKEN = ghToken;
  }
  return env;
}

// One conversation per issue — no user-facing mode. Capability is decided per turn by the
// environment: full access only where a fix run would also be allowed to push.
function capabilityOf(entry) {
  if (!fixEnabled()) return { level: 'readOnly', reason: 'this machine cannot push fixes (AUTOFIX_RUN_ENABLED != 1)' };
  if (['started', 'recovered'].includes(entry.outcome)) return { level: 'readOnly', reason: 'the pipeline is currently working on this issue' };
  if (!entry.branch && !existsSync(path.join(worktreesDir, entry.identifier || ''))) {
    return { level: 'readOnly', reason: 'no fix branch exists for this issue' };
  }
  return { level: 'full', reason: null };
}

// ---------------------------------------------------------------------------
// Pipeline steps — everything the automated run did, shown when the chat opens. Primary
// source: per-stage transcripts in logs/<ID>/<stage>.txt (envelope .result = the agent's
// final report) + stage metadata in the state entry; the structured review/verify/checks
// fields fill the gaps when transcripts are gone.

const STAGE_ORDER = ['fixability', 'fixer', 'fixer-escalation', 'review-correctness', 'review-conventions',
  'review-security', 'review-tests', 'manager', 'refix', 'manager-recheck', 'verify-refix', 'verify', 'revise'];
const STAGE_TITLES = {
  fixability: 'Fixability gate', fixer: 'Fixer (wrote the fix)', 'fixer-escalation': 'Fixer escalation (Opus)',
  'review-correctness': 'Review: correctness', 'review-conventions': 'Review: conventions',
  'review-security': 'Review: security', 'review-tests': 'Review: tests',
  manager: 'Review manager (verdict)', refix: 'Re-fix (applied confirmed findings)',
  'manager-recheck': 'Manager re-check', 'verify-refix': 'Re-fix after failed verify',
  verify: 'Browser verify', revise: 'Revision (human feedback)',
};

function stageReport(identifier, stage) {
  try {
    const raw = readFileSync(path.join(logsDir, identifier, `${stage}.txt`), 'utf8');
    try { const j = JSON.parse(raw); if (typeof j.result === 'string') return j.result.slice(0, 20000); } catch { /* not the envelope (e.g. timed out) */ }
    return raw.slice(-4000);
  } catch { return null; }
}

function buildPipeline(identifier, entry) {
  const steps = [];
  const stagesMeta = entry.stages || {};
  let logStages = [];
  try { logStages = readdirSync(path.join(logsDir, identifier)).filter((f) => f.endsWith('.txt')).map((f) => f.slice(0, -4)); } catch { /* no log dir */ }
  const present = new Set([...Object.keys(stagesMeta), ...logStages]);
  for (const stage of STAGE_ORDER) {
    if (!present.has(stage)) continue;
    const meta = stagesMeta[stage] || {};
    steps.push({
      key: stage, title: STAGE_TITLES[stage] || stage,
      turns: meta.turns ?? null, ms: meta.ms ?? null, timedOut: !!meta.timedOut,
      report: stageReport(identifier, stage),
    });
  }
  const mg = entry.review?.manager;
  if (mg && !present.has('manager')) {
    steps.push({
      key: 'manager', title: STAGE_TITLES.manager,
      report: `Verdict: ${mg.verdict}\n\n${mg.assessment || ''}\n\nConfirmed findings:\n${(mg.confirmed || []).map((c) => `- [${c.severity || '—'}] ${c.issue || JSON.stringify(c)}`).join('\n') || '(none)'}`,
    });
  }
  const rf = entry.review?.refix;
  if (rf && !present.has('refix')) {
    steps.push({ key: 'refix', title: STAGE_TITLES.refix, report: (rf.addressed || []).map((a) => `- ${a}`).join('\n') || `status: ${rf.status}` });
  }
  if (Array.isArray(entry.checks) && entry.checks.length) {
    steps.push({
      key: 'checks', title: 'Deterministic checks (tsc / jest)',
      report: entry.checks.map((c) => `${c.result === 'pass' ? '✅' : '❌'} ${c.cmd}${c.detail ? `\n${c.detail}` : ''}`).join('\n'),
    });
  }
  if (entry.verify && !present.has('verify')) {
    steps.push({ key: 'verify', title: STAGE_TITLES.verify, report: `Verdict: ${entry.verify.verdict}\n\n${entry.verify.summary || ''}` });
  }
  steps.push({
    key: 'outcome', title: 'Outcome',
    report: `${entry.outcome || 'unknown'}${entry.triage ? ` — triage: ${entry.triage}` : ''}${entry.summary ? `\n\n${entry.summary}` : ''}`,
  });
  return steps;
}

// ---------------------------------------------------------------------------
// Preview control — wraps preview/preview.mjs up|down so the UI gets a button and live URLs.
// preview-state.json is the source of truth (preview.mjs maintains it, incl. the urls).

const previewOps = new Set(); // identifiers with an up/down in flight

function previewInfo(identifier) {
  let st = {}; try { st = JSON.parse(readFileSync(previewStatePath, 'utf8')); } catch { /* none */ }
  const entry = st[identifier.toLowerCase()];
  return { running: !!entry, busy: previewOps.has(identifier), urls: entry?.urls || null };
}

// Every currently-running preview (for the sidebar "running previews" dropdown): id (uppercased for
// display), live urls, and bring-up time. preview-state.json is keyed lowercase; skip in-flight
// `starting` placeholders (no urls yet). Oldest first, matching the eviction ordering elsewhere.
const gitHeadOf = (repoPath) => { try { const r = spawnSync('git', ['-C', repoPath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : null; } catch { return null; } };
function listPreviews() {
  let st = {}; try { st = JSON.parse(readFileSync(previewStatePath, 'utf8')); } catch { /* none */ }
  // Owner display name per issue/chat: the Linear assignee for an ENG card, the chat owner for a
  // standalone chat. Built once from state.json (same source the sidebar uses).
  const owners = {};
  for (const e of Object.values(loadState())) if (e?.identifier) owners[e.identifier.toUpperCase()] = e.assignee?.name || e.ownerName || null;
  return Object.entries(st)
    .filter(([, e]) => e && !e.starting)
    .map(([id, e]) => {
      // Stale = the branch moved past the commit this stack was brought up from (see preview.mjs refresh).
      const head = e.commit && e.worktree ? gitHeadOf(e.worktree) : null;
      return { id: id.toUpperCase(), urls: e.urls || null, at: e.at || null, busy: previewOps.has(id.toUpperCase()), owner: owners[id.toUpperCase()] || null, commit: e.commit ? e.commit.slice(0, 9) : null, stale: !!(head && e.commit && head !== e.commit), refreshing: !!e.refreshing, manual: !!e.manual };
    })
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

// Run preview.mjs <args> to completion. Resolves regardless of exit code (caller re-reads state).
function spawnPreview(args, timeoutMs = 15 * 60 * 1000) {
  return new Promise((resolve) => {
    const child = spawn('node', [previewScript, ...args], { env: process.env });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, timeoutMs);
    child.stdout.on('data', (d) => process.stdout.write(d));
    child.stderr.on('data', (d) => process.stderr.write(d));
    child.on('error', () => { clearTimeout(timer); resolve(); });
    child.on('close', () => { clearTimeout(timer); resolve(); });
  });
}

async function runPreviewOp(identifier, entry, action) {
  const emit = (e) => broadcast(identifier, e, { buffer: false });
  try {
    if (action === 'up') {
      const loc = resolveCwd(identifier, entry, emit);
      if (loc.error) { emit({ type: 'error', error: loc.error }); return; }
      if (loc.cwd === agentRoot) { emit({ type: 'error', error: 'no worktree/branch to preview for this issue' }); return; }
      // The concurrent-preview cap is enforced synchronously in startPreviewOp (below) so the user gets
      // an immediate "close one first" rejection; nothing to evict here.
      await ensureProxy();
      emit({ type: 'status', text: 'Starting preview — builds the portals once, can take a few minutes…' });
      // '--manual' marks this preview as user-started, so the agent's idle/cap eviction never tears it
      // down (only the OOM backstop may). The pipeline auto-keep brings previews up WITHOUT this flag.
      await spawnPreview(['up', identifier, loc.cwd, '--manual']);
    } else if (action === 'refresh') {
      await ensureProxy();
      emit({ type: 'status', text: '🔄 Refreshing preview to the branch head…' });
      await spawnPreview(['refresh', identifier]);
    } else {
      await spawnPreview(['down', identifier]);
    }
  } catch (e) {
    emit({ type: 'error', error: `preview ${action} failed: ${String(e.message || e)}` });
  } finally {
    previewOps.delete(identifier);
    emit({ type: 'preview', ...previewInfo(identifier) });
  }
}

// Previews are built-once/static (watcher-free), so after a chat turn edits code the running preview
// is stale. Rebuild it in place (down → up) and drive a "refreshing" loader in the UI meanwhile.
// Fire-and-forget from the turn; guarded so it won't collide with a manual up/down already in flight.
async function refreshPreview(identifier, entry) {
  if (previewOps.has(identifier) || !previewInfo(identifier).running) return;
  previewOps.add(identifier);
  // #11: this background rebuild outlives the chat turn that spawned it (the turn's fix-lock is
  // released before this finishes). Hold a separate `<id>.preview.lock` — acquired SYNCHRONOUSLY here,
  // before the first await, so there's no window where the turn's lock is gone but this isn't yet —
  // so gc won't delete the worktree mid-rebuild. Different file from the fix-lock: no mutual exclusion.
  const previewLock = acquireLock(identifier, { suffix: 'preview' });
  const emit = (e) => broadcast(identifier, e, { buffer: false });
  emit({ type: 'preview', ...previewInfo(identifier), refreshing: true });
  emit({ type: 'status', text: '🔄 You changed code — rebuilding the preview so it isn’t stale (a minute or two)…' });
  try {
    const loc = resolveCwd(identifier, entry, emit);
    if (loc.error || loc.cwd === agentRoot) return;
    await ensureProxy();
    // Preserve user-started provenance across the down→up rebuild (the down clears the entry, so read it
    // first and re-assert --manual on the way back up).
    let wasManual = false;
    try { wasManual = !!JSON.parse(readFileSync(previewStatePath, 'utf8'))[identifier.toLowerCase()]?.manual; } catch { /* none */ }
    await spawnPreview(['down', identifier]);
    await spawnPreview(['up', identifier, loc.cwd, ...(wasManual ? ['--manual'] : [])]);
    emit({ type: 'status', text: '✅ Preview refreshed with your latest changes.' });
  } catch (e) {
    emit({ type: 'error', error: `preview refresh failed: ${String(e.message || e)}` });
  } finally {
    releaseLock(previewLock);
    previewOps.delete(identifier);
    emit({ type: 'preview', ...previewInfo(identifier) });
  }
}

function startPreviewOp(identifier, body) {
  const action = body?.action;
  if (!['up', 'down', 'refresh'].includes(action)) return { code: 400, error: 'action must be up|down|refresh' };
  const found = findEntry(identifier);
  if (!found) return { code: 404, error: `no autofix record for ${identifier}` };
  if (previewOps.has(identifier)) return { code: 409, error: 'a preview operation is already running for this issue' };
  // Hard concurrent-preview cap: enabling a preview when the cap is already reached is REFUSED (we don't
  // evict someone else's) — the UI renders this error as a ⚠ banner. Only gate 'up', and never gate a
  // re-up of an issue whose own preview is already running (that isn't a new stack).
  const cap = config.maxConcurrentPreviews ?? 0;
  if (action === 'up' && !previewInfo(identifier).running && atConcurrentPreviewCap(identifier, cap)) {
    const others = runningPreviewIds(identifier).map((b) => b.toUpperCase());
    return { code: 409, error: `${others.length} previews are already running (${others.join(', ')}) and the limit is ${cap}. Please close one to enable this preview.` };
  }
  previewOps.add(identifier);
  runPreviewOp(identifier, found.entry, action);
  return { code: 202, body: { started: action } };
}

// ---------------------------------------------------------------------------
// SSE — one channel per issue; the current turn's events are buffered and replayed to a
// client that (re)connects mid-turn, so a dropped tunnel or refresh doesn't lose the stream.

const channels = new Map(); // identifier -> { clients:Set<res>, turnBuffer:[] }
const channelOf = (identifier) => {
  if (!channels.has(identifier)) channels.set(identifier, { clients: new Set(), turnBuffer: [] });
  return channels.get(identifier);
};

function broadcast(identifier, event, { buffer = true } = {}) {
  const ch = channelOf(identifier);
  if (buffer) {
    if (event.type === 'turn_start') ch.turnBuffer = [];
    ch.turnBuffer.push(event);
  }
  const frame = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of ch.clients) { try { res.write(frame); } catch { /* dead client */ } }
  if (event.type === 'done') ch.turnBuffer = [];
}

function handleEvents(identifier, req, res) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
  res.write(': connected\n\n');
  const ch = channelOf(identifier);
  for (const event of ch.turnBuffer) res.write(`data: ${JSON.stringify(event)}\n\n`); // mid-turn catch-up
  ch.clients.add(res);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* dead */ } }, 25000);
  req.on('close', () => { clearInterval(ping); ch.clients.delete(res); });
}

// ---------------------------------------------------------------------------
// Claude streaming — clone of autofix's runClaude hardening (detached process group, stdin
// prompt, SIGKILL-the-group on timeout) but parsing `--output-format stream-json` NDJSON
// incrementally instead of buffering one JSON envelope.

function chatArgs(cap, sessionId, modelOverride) {
  const m = CHAT[cap] || {};
  const a = ['-p', '--output-format', 'stream-json', '--verbose', '--model', modelOverride || m.model, '--max-turns', String(m.maxTurns)];
  // Never stamp a "Co-Authored-By: Claude" / "Generated with Claude Code" trailer on commits or PRs the
  // chat agent opens — commits are attributed solely to the issue's assignee (same as the pipeline).
  a.push('--settings', '{"includeCoAuthoredBy":false}');
  if (cap === 'readOnly') a.push('--allowedTools', (m.allowedTools || []).join(','));
  else {
    a.push('--dangerously-skip-permissions');
    // Persistent capabilities + hard safety rules go in the SYSTEM prompt, not the conversation — so no
    // number of /compact passes can summarize them away (verified: --append-system-prompt applies on
    // resumed sessions too). Full-access only: read-only turns can't run curl/git-writes anyway. Constant
    // text → prompt cache stays warm across turns. safetyPrompt keeps the agent inside its worktree (it
    // once escaped into the main checkout and switched the repo's branch).
    const appends = [CHAT.capabilityPrompt, CHAT.safetyPrompt, CHAT.watchPrompt].filter(Boolean);
    if (appends.length) a.push('--append-system-prompt', appends.join('\n\n'));
  }
  // Deny only the reference-heavy skills (config.chat.skillDenylist) so they can't auto-load into a
  // chat session and get re-billed on every resumed turn — the bug that silently defeated /compact on
  // ENG-200 (claude-api ~194k tokens). Per-skill `Skill(<name>)` denials leave every other skill usable,
  // so the agent keeps full capability. Verified: Skill(claude-api) blocks its 194k body while
  // code-review/verify/simplify/… stay available. See the skillDenylist comment in config.mjs.
  const denied = (CHAT.skillDenylist || []).map((s) => `Skill(${s})`);
  if (denied.length) a.push('--disallowedTools', ...denied);
  if (sessionId) a.push('--resume', sessionId);
  return a;
}

function runClaudeStream(args, prompt, cwd, timeoutMs, onEvent, register, env = process.env) {
  return new Promise((resolve) => {
    const child = spawn('claude', args, { cwd, env, detached: true });
    if (register) register(child);
    const out = { timedOut: false, gotInit: false, result: null, texts: [], tools: [], blocks: [], stderr: '' };
    const timer = setTimeout(() => {
      out.timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    }, timeoutMs);
    let buf = '';
    const handleLine = (line) => {
      if (!line.trim()) return;
      let j; try { j = JSON.parse(line); } catch { return; }
      if (j.type === 'system' && j.subtype === 'init') {
        out.gotInit = true;
        onEvent({ type: 'init', sessionId: j.session_id });
      } else if (j.type === 'assistant') {
        // Each assistant message carries the usage for THAT single turn; the last one's input (+cache)
        // ≈ the CURRENT context size. result.usage sums every internal tool-call turn, so with prompt
        // caching it re-counts the cached context per turn and balloons — don't use it for context size.
        if (j.message?.usage) out.lastUsage = j.message.usage;
        if (j.message?.model) out.lastModel = j.message.model; // the model that produced THIS message — sizes the context window (see usage.mjs)
        for (const block of j.message?.content || []) {
          if (block.type === 'text' && block.text) { out.texts.push(block.text); out.blocks.push({ t: 'text', text: block.text }); onEvent({ type: 'text', text: block.text }); }
          if (block.type === 'tool_use') {
            const input = JSON.stringify(block.input || {}).slice(0, 1500); // enough for most Bash cmds/paths to stay valid JSON for the UI formatter
            out.tools.push({ name: block.name, input });
            out.blocks.push({ t: 'tool', id: block.id, name: block.name, input }); // chronological record for the UI accordion
            onEvent({ type: 'tool', id: block.id, name: block.name, input });
          }
        }
      } else if (j.type === 'user') {
        for (const block of j.message?.content || []) {
          if (block.type === 'tool_result') onEvent({ type: 'tool_result', id: block.tool_use_id, ok: !block.is_error });
        }
      } else if (j.type === 'result') {
        out.result = j;
        onEvent({ type: 'result', text: j.result || '', turns: j.num_turns, ms: j.duration_ms, cost: j.total_cost_usd, tokens: turnTokens(j.usage), sessionId: j.session_id, isError: !!j.is_error, subtype: j.subtype });
      }
    };
    child.stdout.on('data', (d) => {
      buf += d;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) handleLine(line);
    });
    child.stderr.on('data', (d) => { out.stderr = (out.stderr + d).slice(-2000); });
    child.stdin.on('error', () => { /* EPIPE when the child never started */ });
    child.on('error', (e) => { clearTimeout(timer); out.stderr += ` spawn failed: ${e.message}`; resolve(out); });
    child.on('close', () => { clearTimeout(timer); if (buf) handleLine(buf); resolve(out); });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

// Voice cleanup runs against the Anthropic API directly with the Claude Code subscription's OAuth
// token (read fresh each call so CLI refreshes are picked up). This is ~1s vs ~7-15s for spawning
// `claude -p`, which cold-starts a whole CLI process every time. The OAuth path requires the Claude
// Code identity as the system prompt, so the actual task goes in the user message.
const credsPath = path.join(process.env.HOME || '', '.claude', '.credentials.json');
function oauthCreds() {
  try { return JSON.parse(readFileSync(credsPath, 'utf8')).claudeAiOauth || {}; } catch { return {}; }
}
function oauthToken() {
  const o = oauthCreds();
  return (o.accessToken && (!o.expiresAt || o.expiresAt > Date.now() + 60000)) ? o.accessToken : null;
}
async function claudeApiText(userMessage, model, timeoutMs, maxTokens = 600) {
  const token = oauthToken();
  if (!token) return { ok: false };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'oauth-2025-04-20',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model, max_tokens: maxTokens,
        system: "You are Claude Code, Anthropic's official CLI for Claude.",
        messages: [{ role: 'user', content: userMessage }],
      }),
      signal: ac.signal,
    });
    if (!r.ok) return { ok: false };
    const j = await r.json();
    const text = Array.isArray(j.content) ? j.content.filter((b) => b.type === 'text').map((b) => b.text).join('') : '';
    return { ok: !!text, text, stopReason: j.stop_reason };
  } catch { return { ok: false }; }
  finally { clearTimeout(timer); }
}

// Account-level usage/rate-limit stats for the logged-in Claude subscription — the same data
// `claude`'s /usage screen shows. GET /api/oauth/usage with the OAuth token. Cached briefly so
// reopening /status doesn't hammer it. Returns { ok, usage } or { ok:false, error }.
let usageCache = { at: 0, data: null };
async function fetchOauthUsage() {
  if (usageCache.data && Date.now() - usageCache.at < 5000) return usageCache.data;
  const token = oauthToken();
  if (!token) return { ok: false, error: 'not logged in (no valid OAuth token)' };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 6000);
  try {
    const r = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: {
        authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'content-type': 'application/json',
      },
      signal: ac.signal,
    });
    if (!r.ok) return { ok: false, error: `usage fetch failed (HTTP ${r.status})` };
    const usage = await r.json();
    const data = { ok: true, usage };
    usageCache = { at: Date.now(), data };
    return data;
  } catch (e) { return { ok: false, error: String(e.name === 'AbortError' ? 'timed out' : (e.message || e)) }; }
  finally { clearTimeout(timer); }
}

// Self-heal fallback: if the direct API fails (usually an expired OAuth token that nothing has
// refreshed yet), run the CLI once. It's slow (~7s) but it refreshes ~/.claude/.credentials.json as
// a side effect, so the very next call goes back to the fast API path. Keeps voice fully dynamic.
function runClaudeCleanup(prompt, timeoutMs) {
  return new Promise((resolve) => {
    const args = ['-p', '--model', 'haiku', '--max-turns', '1', '--output-format', 'json', '--strict-mcp-config'];
    const child = spawn('claude', args, { cwd: __dirname, env: process.env, detached: true });
    let out = '';
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stdin.on('error', () => {});
    child.on('error', () => { clearTimeout(timer); resolve({ ok: false }); });
    child.on('close', () => {
      clearTimeout(timer);
      try { const j = JSON.parse(out); resolve({ ok: !j.is_error && typeof j.result === 'string', text: j.result }); }
      catch { resolve({ ok: false }); }
    });
    child.stdin.write(prompt); child.stdin.end();
  });
}

// Clean up a raw speech-to-text transcript: punctuation, casing, and context-aware mishear fixes.
// Meaning-preserving by instruction; falls back to null (client keeps its instant heuristic) on any
// failure or if the model goes off-script. `text` is only the dictated segment, never the whole box.
async function polishVoice(identifier, body) {
  const text = String(body?.text || '').trim();
  if (!text) return { code: 200, body: { text: null, polished: false } };
  // Very long dictation: skip the LLM pass entirely — the instant heuristic is already fine, and
  // polishing risks a truncated reply silently replacing complete text. ~4000 chars is a big message.
  if (text.length > 4000) return { code: 200, body: { text: null, polished: false } };
  const found = findEntry(identifier);
  const title = String(found?.entry?.title || '').slice(0, 200);
  const summary = String(found?.entry?.summary || '').slice(0, 500);
  const model = CHAT.polish?.model || 'claude-haiku-4-5-20251001';
  // Recent thread turns ground the correction in what's actually being discussed here (so a mishear
  // is fixed toward the terms in play). Last few messages, each trimmed; oldest first.
  const recent = (loadChatState()[identifier]?.messages || [])
    .slice(-5)
    .map((mm) => `${mm.role === 'assistant' ? 'Assistant' : 'You'}: ${String(mm.text || '').replace(/\s+/g, ' ').slice(0, 240)}`)
    .join('\n');
  const instruction = [
    'Clean up this raw speech-to-text dictation typed by a developer into a chat about a software issue.',
    'Fix capitalization, punctuation, and obvious speech-recognition mishears of technical terms, using the context below to correct domain words (for example a spoken "why" that means "UI", or "git hub" that means "GitHub"). Add a question mark when the sentence is clearly a question.',
    'STRICT RULES: do not rephrase, reorder, translate, summarize, or add or remove information — only correct transcription errors, casing, and punctuation. Output ONLY the corrected text: no quotes, no explanation, no preamble.',
    '',
    'Issue — Title: ' + (title || '(none)') + (summary ? '; Summary: ' + summary : ''),
    recent ? '\nRecent conversation (for terminology only):\n' + recent : '',
    '',
    'Raw dictation: ' + text,
  ].filter(Boolean).join('\n');
  // Give the reply enough room to never truncate a legitimate cleanup (output ≈ input length).
  const maxTokens = Math.min(2000, Math.ceil(text.length / 3) + 200);
  let r = await claudeApiText(instruction, model, 8000, maxTokens);
  // Self-heal only when a refresh token exists (expired access token the CLI can refresh). If fully
  // logged out there's nothing to refresh, so skip the CLI and let the client keep its heuristic —
  // no pointless ~15s wait per dictation. Logging back in makes the fast path resume automatically.
  if (!r.ok && oauthCreds().refreshToken) r = await runClaudeCleanup(instruction, 15000);
  let cleaned = (r.ok && typeof r.text === 'string') ? r.text.trim() : '';
  // Strip a wrapping pair of quotes the model may have added.
  if (cleaned.length >= 2 && cleaned[0] === cleaned[cleaned.length - 1] && (cleaned[0] === '"' || cleaned[0] === "'")) cleaned = cleaned.slice(1, -1).trim();
  // Reject anything that isn't a faithful cleanup: empty, hit the token cap (truncated), ballooned,
  // or lost a big chunk of content. On reject the client keeps the complete heuristic version.
  const truncated = r.stopReason === 'max_tokens';
  const ok = !!cleaned && !truncated && cleaned.length <= text.length * 3 + 40 && cleaned.length >= text.length * 0.5;
  return { code: 200, body: ok ? { text: cleaned, polished: true } : { text: null, polished: false } };
}

// ---------------------------------------------------------------------------
// Prompts

function preamble(cap) {
  const base = 'You previously worked on this issue as an automated fixer; this workspace holds your fix. '
    + 'The developer is now chatting with you about it — answer questions from the workspace and the pipeline logs. ';
  const rules = cap === 'full'
    ? 'If the developer asks for changes: apply them on the current branch with a minimal diff, follow the '
      + 'repo conventions (CLAUDE.md), verify your work yourself (run `npx tsc` in the changed packages and '
      + 'targeted tests where they exist), and COMMIT the result — commit everything so the working tree is '
      + "clean. Your commits are pushed to the issue's open PR AUTOMATICALLY the moment this turn ends, so do "
      + 'NOT run `git push` or open PRs yourself. When the developer asks you to "push", that just means: make '
      + 'sure every change is committed — the push then happens on its own. Never re-apply or re-commit changes '
      + 'that are already committed (that would create duplicate commits).'
    : 'This session is READ-ONLY: do not modify, commit, or push anything — read code/logs and answer.';
  return `${base}${rules}\n\nDeveloper's message: `;
}

// First turn with no pipeline session to resume: rebuild the context as text.
// Render retained chat turns as plain text so a fresh (unforkable) edit turn still has the
// conversation up to the edit point. Empty string when there's nothing retained.
function historyBlock(msgs) {
  const kept = (msgs || []).filter((mm) => mm && mm.text);
  if (!kept.length) return '';
  const body = kept.map((mm) => `${mm.role === 'user' ? 'Developer' : 'You'}: ${mm.text}`).join('\n\n');
  return `\nConversation so far (context — continue from here, do not repeat it):\n${body}\n`;
}

// Injected into the first fresh turn after a /compact. The big session was dropped; this concise
// summary stands in for the whole prior conversation so the agent continues seamlessly.
function compactBlock(summary) {
  return `\nSummary of the earlier conversation (it was compacted to save context — treat it as your memory of everything so far and continue from here):\n${summary}\n`;
}

function freshPrompt(cap, identifier, entry, linear, cwd, message, history = '') {
  const stages = Object.keys(entry.stages || {}).join(', ') || '(none recorded)';
  const prs = (entry.prs || []).map((p) => `- ${p.repo || ''} ${p.url || p}`).join('\n') || '(none)';
  const comments = (linear?.comments || []).map((c) => `- ${c.author}: ${c.body}`).join('\n') || '(none)';
  const where = cwd === agentRoot
    ? 'You are in the MAIN repo checkout (no fix branch exists for this issue).'
    : `You are in the issue's fix workspace on branch ${entry.branch || '(unknown)'} (main repo at the root, customer-portal nested).`;
  return `You are helping a developer with Linear issue ${identifier}: ${linear?.title || '(title unavailable)'}.
An automated pipeline previously processed it. Outcome: ${entry.outcome || 'unknown'}${entry.triage ? ` (triage: ${entry.triage})` : ''}.
Pipeline summary: ${entry.summary || '(none)'}
${where}

Issue description:
${linear?.description || '(unavailable — no Linear access right now)'}

Issue comments:
${comments}

Open PRs:
${prs}

Pipeline stages that ran: ${stages}

You have EVERYTHING you need on demand — nothing about the fix is hidden from you:
- The fix itself is the committed change on this branch: run \`git show\`/\`git diff\` (against the base branch) to see exactly what you changed.
- Your full original fix run — every step of your reasoning — is saved at ${path.join(logsDir, identifier)}/fixer.txt (and <stage>.txt for each other stage: each is a JSON envelope whose .result field is that agent's final report). Read fixer.txt if you need to recall precisely WHY you made a change.
- The whole codebase is in this workspace: read any file rather than assuming. Prefer reading the real code/diff/transcript over guessing.
${history}
${preamble(cap)}${message}`;
}

// ---------------------------------------------------------------------------
// Turn engine

const activeTurns = new Map(); // identifier -> { child, mode, turnId, startedAt, lockPath }
let turnSeq = 0;

// Pipeline stage sessions all ran with cwd = the worktree; prefer the most recent code-touching one.
const STAGE_SESSION_PRIORITY = ['revise', 'verify-refix', 'refix', 'fixer-escalation', 'fixer'];
function pipelineSessionId(entry) {
  for (const stage of STAGE_SESSION_PRIORITY) {
    const sid = entry.stages?.[stage]?.sessionId;
    if (sid) return sid;
  }
  return null;
}

// The REAL context the next turn will resume (drives /context). We resolve the same base runTurn
// would pick, then read its actual size from the transcript — so /context reflects what `claude -p`
// truly reloads (e.g. a 397k Opus session), not the optimistic post-compact display value. Also fixes
// "No context data yet" on a live session whose cs.usage was cleared: the number is read from disk,
// not from the last turn's snapshot. Side-effect-free (never rebuilds a worktree) so it's safe in a GET.
function resumeContext(identifier, entry, cs) {
  const WT = path.join(worktreesDir, identifier);
  const cwd = cs.cwd || (existsSync(WT) ? WT : agentRoot);
  const base = pickResumeBase(cs, { cwd, agentRoot, pipelineSid: pipelineSessionId(entry), resumePipeline: CHAT.resumePipelineSession });
  if (base.kind === 'fresh') return null;
  if (base.kind === 'compact') {
    return { contextUsed: base.tokens, contextWindow: cs.usage?.contextWindow || 200000, model: cs.usage?.model || null };
  }
  const t = transcriptContextUsed(sessionFile(cwd, base.sid));
  if (!t) return null;
  // The per-message transcript usage carries no window size; infer the 1M beta when the live context
  // already exceeds the 200k default, else keep whatever the last snapshot recorded (default 200k).
  const win = cs.usage?.contextWindow || (t.contextUsed > 200000 ? 1000000 : 200000);
  return { contextUsed: t.contextUsed, contextWindow: win, model: t.model || cs.usage?.model || null };
}

// ---------------------------------------------------------------------------
// Session transcripts on disk. The Claude CLI stores each session as a JSONL file at
// ~/.claude/projects/<cwd-with-non-alnum-replaced-by-dash>/<sessionId>.jsonl and APPENDS to it
// on every --resume. Editing a past message must rewrite that transcript, not just cs.messages
// (which is display-only). We fork: copy the file truncated to the edit point into a NEW session
// id (rewriting the internal sessionId), then resume the fork — native memory is preserved up to
// the cut and the dropped turns are gone. Validated against CLI 2.1.197.
function projectsDir(cwd) {
  return path.join(process.env.HOME || '', '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
}
function sessionFile(cwd, sid) { return path.join(projectsDir(cwd), `${sid}.jsonl`); }

// Number of JSONL lines currently in a session's transcript (0 if none / unreadable). Snapshotted
// at each turn's start and stored on the user message so a later edit knows exactly where to cut.
function transcriptLines(cwd, sid) {
  if (!sid) return 0;
  try { return readFileSync(sessionFile(cwd, sid), 'utf8').split('\n').filter(Boolean).length; }
  catch { return 0; }
}

// Copy `sid`'s transcript truncated to `lines` lines into a fresh session id, rewriting every
// line's sessionId to the new id. Returns the new sid, or null if it can't be forked (missing
// file, degenerate length) — the caller then falls back to a fresh context-injected turn.
function forkTruncated(cwd, sid, lines) {
  if (!sid || lines <= 0) return null;
  try {
    const all = readFileSync(sessionFile(cwd, sid), 'utf8').split('\n').filter(Boolean);
    if (lines > all.length) return null;
    const newSid = randomUUID();
    const kept = all.slice(0, lines).map((l) => {
      try { const o = JSON.parse(l); if (o.sessionId) o.sessionId = newSid; return JSON.stringify(o); }
      catch { return l; }
    });
    mkdirSync(projectsDir(cwd), { recursive: true });
    writeFileSync(sessionFile(cwd, newSid), kept.join('\n') + '\n');
    return newSid;
  } catch { return null; }
}

// Delete every fork transcript except `keepSid`. Only ever touches ids we minted (cs.forks) — the
// pipeline's own session and the original chat session are never in that list, so never deleted.
function pruneForks(cwd, forks, keepSid) {
  for (const sid of forks || []) {
    if (sid === keepSid) continue;
    try { unlinkSync(sessionFile(cwd, sid)); } catch { /* already gone */ }
  }
}

// Delegates to the shared self-healing lock (lock.mjs) so the chat server, the poller (autofix/
// revise), gc, and preview rebuilds all mutually exclude on the SAME lock, with PID-liveness + stale
// reclaim (a crashed holder never wedges the issue; a healthy long op is never stolen).
function acquireFixLock(identifier) { return acquireLock(identifier); }

// Resolve where the turn runs. Missing worktree + known branch -> rebuild it (bounded, rare —
// accepted as a blocking call; the status event flushes first). No branch at all -> the main
// checkout (capabilityOf already forced readOnly for that case, so nothing can be written).
function resolveCwd(identifier, entry, emit) {
  const WT = path.join(worktreesDir, identifier);
  if (existsSync(WT)) return { cwd: WT };
  if (entry.branch) {
    emit({ type: 'status', text: `Rebuilding workspace from ${entry.branch}…` });
    const asm = assembleFromBranch(WT, entry.branch);
    if (!asm.ok) return { error: `could not rebuild the ${asm.repo} worktree from ${entry.branch}: ${(asm.err || '').slice(0, 500)}` };
    prepareWorktreeDeps(WT);
    return { cwd: WT };
  }
  return { cwd: agentRoot };
}

async function runTurn(identifier, entry, cap, message, turnId, lockPath, edit = null, attachments = [], promptOverride = null) {
  const emit = (e) => broadcast(identifier, { turnId, ...e });
  const m = CHAT[cap] || {};
  let tee = null;
  let closeRequested = false; // a standalone chat can ask to close itself ([[CLOSE_CHAT]]); handled after the finally
  try {
    emit({ type: 'turn_start', cap, message });
    // Warm the account-usage cache now so it's fresh by the time this turn ends and the client
    // re-renders (it drives the ≥90% per-turn limit warning). Fire-and-forget; the turn runs for
    // seconds regardless, so the fetch lands well before 'done'.
    fetchOauthUsage().catch(() => { /* best-effort */ });

    const loc = resolveCwd(identifier, entry, emit);
    if (loc.error) { emit({ type: 'error', error: loc.error }); return; }
    const cwd = loc.cwd;

    // Edit prelude: rewrite history at edit.index. Optionally rewind the code, fork the transcript
    // at the cut point (native memory preserved; null -> fresh fallback), then drop the messages
    // from the edit point down. Mutates `edit` with forkSid + the retained conversation.
    if (edit && (edit.index != null || edit.mid != null) && !edit.prepared) {
      const csE = loadChatState()[identifier] || {};
      const msgsE = csE.messages || [];
      // Resolve the cut point by stable mid (fall back to the raw index) against the CURRENT array,
      // so a .slice(-500) shift between the request and here can't move it to the wrong message.
      const byMid = edit.mid != null ? msgsE.findIndex((m) => m && m.mid === edit.mid) : -1;
      const idx = byMid >= 0 ? byMid : edit.index;
      const em = msgsE[idx] || {};
      edit.retained = msgsE.slice(0, idx);

      if (edit.revert && cap === 'full' && em.headBefore) {
        emit({ type: 'status', text: 'Rewinding the branch to before the dropped turns…' });
        const orig = headShas(cwd); // snapshot so we can undo a partial rewind
        const failed = resetTo(cwd, em.headBefore);
        if (failed.length) {
          // Rewind didn't fully land (e.g. force-push rejected). Don't run the agent on a
          // half-reverted tree — restore the branch and abort WITHOUT rewriting any history.
          const restoreFailed = resetTo(cwd, orig);
          emit({ type: 'error', error: restoreFailed.length
            ? `Could not rewind ${failed.join(', ')} and the restore also failed for ${restoreFailed.join(', ')} — the branch may be inconsistent; resolve it manually. No history was rewritten.`
            : `Could not rewind ${failed.join(', ')} (restore point unavailable); the branch was left as it was and no history was rewritten. Resend without "Revert code".` });
          return; // finally releases the lock and emits 'done'; messages untouched, no fork
        }
        emit({ type: 'status', text: 'Branch rewound and force-pushed.' });
      }

      const forkSid = forkTruncated(cwd, em.sid, em.tLines);
      const prevForks = csE.forks || [];
      edit.forkSid = forkSid;
      edit.prepared = true;
      updateChatState(identifier, (cs) => {
        cs.messages = (cs.messages || []).slice(0, idx);
        pruneForks(cwd, prevForks, forkSid);
        if (forkSid) { cs.forks = [forkSid]; cs.sessions.chat = forkSid; }
        else { cs.forks = []; delete cs.sessions.chat; }
        return cs;
      });
    }

    // Session strategy. Edit turns resume the pre-forked transcript (or, if the fork failed,
    // start fresh with the retained conversation re-injected). Normal turns: our own chat
    // session -> the pipeline's session -> fresh with context.
    const cs0 = loadChatState()[identifier] || {};
    const histText = edit ? historyBlock(edit.retained) : '';
    // Attachments are already saved on disk; tell the agent to open them with its Read tool (which
    // renders images). This rides along in the PROMPT only — the stored/displayed message stays clean.
    const attachNote = attachments.length
      ? `\n\n[The developer attached ${attachments.length} file${attachments.length === 1 ? '' : 's'}. View ${attachments.length === 1 ? 'it' : 'each'} with the Read tool (images render visually):]\n`
        + attachments.map((a) => `- ${a.path}`).join('\n')
      : '';
    // promptOverride lets a turn SHOW the user's own words (turn_start above emits `message`) while the
    // agent actually receives a different instruction — e.g. a typed "merge it" displays as-is but runs
    // the full mergeMsg, so the natural-language trigger and the Merge button have the exact same effect.
    const promptMsg = (promptOverride || message || '(see the attached file(s))') + attachNote;
    let resumeSid;
    let prompt;
    let usedCompact = false;
    if (edit) {
      resumeSid = edit.forkSid || null;
      prompt = resumeSid ? promptMsg : await freshTurnPrompt(cap, identifier, entry, cwd, promptMsg, histText);
    } else {
      const sameCwd = !cs0.cwd || cs0.cwd === cwd;
      resumeSid = (sameCwd && cs0.sessions?.chat) || null;
      if (resumeSid) {
        prompt = promptMsg;
      } else if (cs0.compactSummary) {
        // Post-compact: there's no chat session to resume (compaction dropped it on purpose). Start
        // fresh seeded with the compaction summary instead of the pipeline session — that big
        // transcript is exactly the context we just compacted away.
        usedCompact = true;
        prompt = await freshTurnPrompt(cap, identifier, entry, cwd, promptMsg, compactBlock(cs0.compactSummary));
      } else if (CHAT.resumePipelineSession && cwd !== agentRoot && pipelineSessionId(entry)) {
        // Opt-in legacy path: resume the fixer's own (300-400k-token) transcript for raw native memory.
        resumeSid = pipelineSessionId(entry);
        prompt = preamble(cap) + promptMsg;
      } else {
        // Default: seed a fresh session with a curated context (issue + fix diff + verdicts + on-demand
        // access to the code and the raw stage transcripts) instead of reloading the giant fixer session.
        // (For a standalone chat this is the plain full-capability framing — see freshTurnPrompt.)
        prompt = await freshTurnPrompt(cap, identifier, entry, cwd, promptMsg);
      }
    }

    // Snapshot the cut point for THIS message before the turn appends to the transcript, so a
    // later edit of it knows exactly where to fork. sid is filled in at init for fresh turns.
    const tLines = transcriptLines(cwd, resumeSid);
    const headBefore = cap === 'full' ? headShas(cwd) : null;
    updateChatState(identifier, (cs) => {
      cs.messages.push({
        role: 'user', cap, text: message, at: new Date().toISOString(),
        sid: resumeSid || null, tLines, ...(headBefore ? { headBefore } : {}),
        ...(attachments.length ? { attachments: attachments.map((a) => a.name) } : {}),
      });
      cs.messages = cs.messages.slice(-500);
      if (usedCompact) delete cs.compactSummary; // one-shot: baked into this fresh session's first prompt
      return cs;
    });

    const preCommits = cap === 'full' ? countCommits(detectChangedRepos(cwd)) : 0;
    // Full-mode turns can commit to the open PR, and may open/merge a PR if asked. Attribute both to
    // the issue's assignee, exactly like the pipeline: GIT_* gives commits the assignee's identity,
    // and GH_TOKEN makes any `gh pr create`/`gh pr merge` the agent runs act as the assignee (falling
    // back to the box `gh` account when no token is configured). We resolve the CURRENT Linear assignee
    // so a reassignment takes effect on the next turn, falling back to the pipeline-stored one if Linear
    // is down. Read-only turns never write, so they keep the plain env.
    const attr = cap === 'full' ? await attributionFor(identifier, entry) : null;
    if (attr) log(`turn ${turnId} (${identifier}): attributing commits/PRs to ${attr.who}`);
    // Reassignment: Linear now shows a DIFFERENT assignee than we have stored. Future work already goes to
    // them (agentEnv + applyWorktreeIdentity below both use the LIVE attr), but adopt it onto the entry too
    // so the sidebar, the Linear-down fallback, and any new branch all reflect the new person. The past
    // (existing branch name, already-authored commits/PRs) is immutable — only the future switches.
    if (attr?.live && attr.assignee?.email && attr.assignee.email !== entry.assigneeEmail && !entry.standalone) {
      const saved = updateIssueEntry(identifier, (e) => ({ ...e, assignee: attr.assignee, assigneeEmail: attr.assignee.email }));
      if (saved) { entry.assignee = saved.assignee; entry.assigneeEmail = saved.assigneeEmail; log(`turn ${turnId} (${identifier}): reassigned → ${attr.assignee.name || attr.assignee.email}; all future work attributes to them`); }
    }
    // Persist the CURRENT assignee's identity into each worktree's git config before the agent runs.
    // Doing it every full turn is what makes a reassignment take effect — the new assignee's name/email
    // overwrite the old in config.worktree, so this turn's (and any later manual) commits go by them.
    if (cap === 'full' && cwd !== agentRoot && attr?.identity) applyWorktreeIdentity(cwd, attr.identity, (msg) => log(`turn ${turnId} (${identifier}): ${msg}`));
    // Scope Linear to the assignee for EVERY turn (and, on full turns, attribute commits/PRs to them).
    // attr is the live-resolved assignee on full turns, null on read-only — either way agentEnv strips
    // the shared global LINEAR_API_KEY and substitutes the assignee's own (or none). This is what makes
    // an ENG card's agent act as its assignee (e.g. ENG-200 → Manan), not as the shared key's owner.
    const turnEnv = agentEnv(entry, cap === 'full' ? attr : null);

    mkdirSync(path.join(logsDir, identifier), { recursive: true });
    tee = createWriteStream(path.join(logsDir, identifier, `chat-${Date.now()}.txt`));
    tee.write(`# turn ${turnId} cap=${cap} resume=${resumeSid || 'none'}${edit ? ' (edit)' : ''} cwd=${cwd}\n${prompt}\n---\n`);
    let curSid = resumeSid; // the live session id, so an inline reconcile turn can resume THIS session
    const onEvent = (e) => {
      tee.write(JSON.stringify(e) + '\n');
      if (e.type === 'init') curSid = e.sessionId;
      if (e.type === 'init') updateChatState(identifier, (cs) => {
        cs.cwd = cwd; cs.sessions.chat = e.sessionId;
        const lastUser = [...cs.messages].reverse().find((x) => x.role === 'user');
        if (lastUser && !lastUser.sid) lastUser.sid = e.sessionId; // fresh session: record its id
        return cs;
      });
      if (e.type === 'result' && e.isError) return; // surfaced below as a proper error event
      emit(e);
    };
    const register = (child) => { const t = activeTurns.get(identifier); if (t) t.child = child; };

    let out = await runClaudeStream(chatArgs(cap, resumeSid), prompt, cwd, m.timeoutMs, onEvent, register, turnEnv);

    // A dead --resume target (pruned session file, foreign/forked session id) fails before init.
    // Drop the stored session and retry ONCE as a fresh, context-injected turn (carrying the
    // retained conversation when this is an edit — the fork we tried to resume is abandoned).
    if (resumeSid && !out.gotInit && !out.timedOut && !aborted(identifier, turnId)) {
      emit({ type: 'status', text: 'Previous session unavailable — starting a fresh one with re-injected context…' });
      // #17: this turn's user message was stamped with the now-dead resumeSid + its tLines. The turn
      // actually continues in a FRESH session, so clear those — the fresh session's init repopulates
      // sid (the init handler only fills a falsy sid), and tLines=0 makes a later edit fork from the
      // fresh session's start rather than the abandoned transcript (which never saw this exchange).
      updateChatState(identifier, (cs) => {
        delete cs.sessions.chat;
        const lastUser = [...cs.messages].reverse().find((x) => x.role === 'user');
        if (lastUser) { lastUser.sid = null; lastUser.tLines = 0; }
        return cs;
      });
      prompt = await freshTurnPrompt(cap, identifier, entry, cwd, message, histText);
      tee.write(`# retry fresh\n${prompt}\n---\n`);
      out = await runClaudeStream(chatArgs(cap, null), prompt, cwd, m.timeoutMs, onEvent, register, turnEnv);
    }

    let fix = null;
    let reconcileOut = null; // the inline reconcile turn's stream, so its narration is persisted too (#9)
    // Standalone chats skip the ENG auto-push/PR-open machinery entirely (they're a normal full-capability
    // session — the agent drives its own git/gh). We only DETECT any PR the agent opened, and honor a
    // self-close request. The `&& !entry.standalone` below keeps the whole ENG block off for them.
    if (cap === 'full' && cwd !== agentRoot && entry.standalone) {
      const detected = detectPrUrls(out);
      if (detected.length) {
        const saved = updateIssueEntry(identifier, (e) => ({ ...e, prs: mergePrs(e.prs || [], detected) }));
        if (saved) { entry.prs = saved.prs; emit({ type: 'fix_summary', committed: false, standalone: true, pushedOk: true, failedRepos: [], prs: saved.prs }); }
      }
      const txt = (out.texts || []).join('\n');
      // Mid-chat handoff: the agent emits [[OWNER: <first name or email>]] when a different person takes
      // over. Applied now, so the NEXT turn uses THEIR git identity + GitHub PAT + Linear key.
      const om = txt.match(/\[\[OWNER:\s*([^\]]+)\]\]/i);
      if (om) { const r = setChatOwner(identifier, om[1].trim()); if (r.code === 200) emit({ type: 'owner_changed', ownerName: r.body.ownerName }); }
      if (/\[\[CLOSE_CHAT\]\]/.test(txt)) closeRequested = true;
    }
    if (cap === 'full' && cwd !== agentRoot && !entry.standalone) {
      const changed = detectChangedRepos(cwd);
      const newThisTurn = countCommits(changed) > preCommits;
      // Push whatever is unpushed — commits made THIS turn AND any a prior turn committed but never
      // pushed (e.g. a push that lost a race, or a turn that made no *new* commit and so used to
      // skip the push). The chat server is the ONLY thing that pushes chat commits — nothing picks
      // them up later — so we flush them here instead of stranding them "waiting for the orchestrator".
      const pending = changed.length ? unpushedRepos(changed) : [];
      let failed = [];
      if (pending.length) {
        emit({ type: 'status', text: 'Pushing to the open PR(s)…' });
        failed = pushChanged(pending);
        // Deterministic reconcile (inside pushChanged) already handles the common diverged-remote case
        // losslessly. Anything still failing is a true conflict/dirty tree that needs judgment — hand it
        // to a self-authorized agent turn on THIS session (sequential, same lock: no reentrancy), then
        // retry the push once. The agent typically pushes itself, so the retry is usually a no-op.
        if (failed.length && !aborted(identifier, turnId)) {
          const stuck = pending.filter((c) => failed.includes(c.repo));
          const preHeads = headShas(cwd); // snapshot our commits BEFORE the agent touches the branch (#8)
          emit({ type: 'status', text: `Push to ${failed.join(', ')} hit a diverged remote — reconciling automatically…` });
          const rmsg = RECONCILE_MSG(failed);
          tee.write(`# reconcile turn (repos: ${failed.join(',')})\n${rmsg}\n---\n`);
          try {
            reconcileOut = await runClaudeStream(chatArgs('full', curSid), rmsg, cwd, m.timeoutMs, onEvent, register, turnEnv);
          } catch (e) { log(`turn ${turnId} (${identifier}): reconcile turn errored: ${e.message || e}`); }
          failed = pushChanged(stuck); // agent likely already pushed → no-op; otherwise retry deterministically
          // #8: an agent that adopted the remote tip could have DROPPED our commit, which pushChanged
          // would then report as a no-op "success". Verify our pre-reconcile commits survived on the
          // remote; if any vanished, report the repo failed instead of falsely claiming pushedOk.
          for (const c of stuck) {
            if (failed.includes(c.repo)) continue;
            if (commitsDropped(c.wt, c.base, preHeads[c.repo])) {
              log(`turn ${turnId} (${identifier}): reconcile DROPPED commit(s) in ${c.repo} — reporting push failed`);
              failed.push(c.repo);
            }
          }
          if (!failed.length) log(`turn ${turnId} (${identifier}): agent reconcile cleared the push for ${stuck.map((c) => c.repo).join(', ')}`);
        }
      }
      // Make sure EVERY repo with commits on the branch has an open PR and is recorded in state.
      // A turn can add commits to a repo the pipeline never opened a PR for (e.g. the developer asks
      // for a customer-portal change on a main-only issue) — without this, the branch would be pushed
      // but no PR opened and the UI would keep showing only PR(main). We reconcile on any turn where
      // the branch has commits (not just ones that pushed something), so an issue left in the old
      // broken state self-heals on the next full turn. Best-effort — a create failure just omits that
      // repo's link this turn. The UI re-reads state on `done`, so persisting is what updates it.
      if (changed.length) {
        try {
          const linear = await fetchLinear(identifier);
          const title = linear?.title || entry.title || identifier;
          // Pass the LINEAR email for PR-token lookup (assigneeGhTokenEnv is keyed by Linear email).
          // Never fall back to entry.assignee here: that's the git IDENTITY, whose email may be an
          // overridden commit/noreply email that mis-keys the token map. No Linear email → null →
          // the PR opens as the box account (the safe default), not the wrong person.
          const detected = ensureOpenPrs(changed, title, `Auto-fix for ${identifier}: ${title}`, attr?.email ? { email: attr.email } : null);
          // Merge INSIDE the updater against the FRESH on-disk prs — not the stale in-memory entry.prs
          // captured at turn start. Otherwise a PR another writer (pipeline/gc) added mid-turn, absent
          // from our stale base and from `detected`, would be silently dropped despite the fresh read.
          const before = JSON.stringify(entry.prs || []);
          const saved = updateIssueEntry(identifier, (e) => ({ ...e, prs: mergePrs(e.prs || [], detected) }));
          if (saved && JSON.stringify(saved.prs || []) !== before) {
            entry.prs = saved.prs;
            log(`turn ${turnId} (${identifier}): PRs now ${(saved.prs || []).map((p) => p.repo).join(', ')}`);
          }
        } catch (e) { log(`turn ${turnId} (${identifier}): PR reconcile failed:`, e.message || e); }
      }
      if (pending.length || newThisTurn) {
        fix = { committed: true, newThisTurn, pushedOk: failed.length === 0, failedRepos: failed, prs: entry.prs || [] };
        emit({ type: 'fix_summary', ...fix });
      }
      // The agent may have edited code the preview builds. If a preview is live for this issue and the
      // change is preview-relevant (backend/portals, not just docs), rebuild it in the background so it
      // stops serving the pre-edit build. Fire-and-forget — drives its own preview/status events.
      if (newThisTurn && previewInfo(identifier).running && touchedPreviewFiles(cwd, headBefore)) {
        refreshPreview(identifier, entry);
      }
    }

    // Background watch (any full-cap chat — standalone OR ENG — babysitting a wait-then-act task like a
    // merge). The agent ended the turn with a marker: [[WATCH_DONE]] (or a MERGE_BLOCKED escalation that
    // now needs a human) clears the wake-up loop; [[WATCH: reason]] arms/re-arms it. `since`/`until` are
    // preserved across re-arms so the 24h safety cap runs from the FIRST watch, not each cycle.
    if (cap === 'full') {
      const txtAll = (out.texts || []).join('\n');
      const w = parseWatch(txtAll);
      const blocked = /\bMERGE_BLOCKED\b/.test(txtAll);
      const hadWatch = !!findEntry(identifier)?.entry?.watch;
      if ((w.done || blocked) && hadWatch) {
        updateIssueEntry(identifier, (e) => { const { watch, ...rest } = e; return rest; });
        emit({ type: 'watch', state: 'done', blocked });
      } else if (w.reason && !w.done && !blocked) {
        const cad = CHAT.watch?.cadenceMs ?? 5 * 60 * 1000, maxMs = CHAT.watch?.maxMs ?? 24 * 60 * 60 * 1000, nextAt = Date.now() + cad;
        updateIssueEntry(identifier, (e) => ({ ...e, watch: { goal: w.reason.slice(0, 300), nextAt, since: e.watch?.since || Date.now(), until: e.watch?.until || (Date.now() + maxMs), at: new Date().toISOString() } }));
        emit({ type: 'watch', state: 'armed', goal: w.reason.slice(0, 300), nextAt });
      }
    }

    if (out.timedOut) emit({ type: 'error', error: `timed out after ${Math.round(m.timeoutMs / 60000)} min (killed)` });
    else if (!out.result && !aborted(identifier, turnId)) emit({ type: 'error', error: `claude exited without a result${out.stderr ? `: ${out.stderr.slice(-300)}` : ''}` });
    else if (out.result?.is_error) emit({ type: 'error', error: `turn ended abnormally (${out.result.subtype || 'error'})${out.result.result ? `: ${String(out.result.result).slice(0, 300)}` : ''}` });

    // A user abort that landed before the agent produced anything leaves an EMPTY turn. Don't persist a
    // "(no reply)" placeholder for it — drop the turn entirely so the UI is a clean redo (the user message
    // keeps its edit/delete, nothing to wait for). Only skip when truly empty; a partial reply is kept.
    const abortedEmpty = aborted(identifier, turnId) && !out.texts.length && !out.tools.length;
    updateChatState(identifier, (cs) => {
      if (!abortedEmpty) cs.messages.push({
        role: 'assistant', cap, at: new Date().toISOString(),
        text: stripWatchMarkers(out.texts.join('\n\n')).slice(0, 50000) || '(no reply)',
        turns: out.result?.num_turns, ms: out.result?.duration_ms,
        cost: out.result?.total_cost_usd ?? null, // per-turn $ for the bubble footer (survives reload)
        tokens: turnTokens(out.result?.usage), // per-turn token totals for the bubble footer (survives reload)
        tools: out.tools.slice(0, 50),
        blocks: out.blocks.slice(0, 400), // chronological text+tool sequence, so the UI can split final answer from working steps
        ...(fix?.committed ? { fix } : {}),
      });
      // #9: the inline reconcile turn ran on this same turn but AFTER the main reply. Persist its
      // narration/marker as its own assistant message so a reload shows what was done to the branch
      // (otherwise the reconcile work vanishes from the stored transcript, though it really happened).
      if (reconcileOut && (reconcileOut.texts.length || reconcileOut.blocks.length)) {
        cs.messages.push({
          role: 'assistant', cap, at: new Date().toISOString(),
          text: reconcileOut.texts.join('\n\n').slice(0, 50000) || '(reconciled the branch)',
          turns: reconcileOut.result?.num_turns, ms: reconcileOut.result?.duration_ms,
          tools: reconcileOut.tools.slice(0, 50),
          blocks: reconcileOut.blocks.slice(0, 400),
        });
      }
      // Snapshot context/cost so /status and /context have real data. usageSnapshot() sizes the window to
      // the FINAL message's model (the same source as contextUsed) — not the most-tokens model, which can be
      // a Haiku Explore subagent that wrongly caps the window at 200K and shows a false >100% (see usage.mjs
      // + test/usage-snapshot.test.mjs). Cost still comes from result (it legitimately accumulates).
      const snap = usageSnapshot(cs.usage, out.lastUsage, out.lastModel, out.result);
      if (snap) {
        cs.usage = { ...snap, at: new Date().toISOString() };
        cs.costTotal = (cs.costTotal || 0) + (out.result?.total_cost_usd || 0);
      }
      return cs;
    });
    logTurnStats('chat-turn', identifier, cap, out.result, loadChatState()[identifier]?.costTotal);
  } catch (e) {
    log(`turn ${turnId} (${identifier}) crashed:`, e);
    emit({ type: 'error', error: String(e.message || e) });
  } finally {
    try { tee?.end(); } catch { /* best-effort */ }
    if (lockPath) { try { unlinkSync(lockPath); } catch { /* already gone */ } }
    activeTurns.delete(identifier);
    emit({ type: 'done' });
  }
  // Agent-initiated close: run AFTER the finally releases the lock + clears activeTurns (closeChat needs
  // both free). Tears down the worktree/branch/state and tells the UI to drop the chat.
  if (closeRequested) {
    const r = closeChat(identifier);
    broadcast(identifier, r.code === 200 ? { type: 'closed' } : { type: 'error', error: r.error || 'could not close the chat' });
  }
}

// After an abort the turn record is replaced/cleared — used to suppress bogus error events.
function aborted(identifier, turnId) {
  const t = activeTurns.get(identifier);
  return !t || t.turnId !== turnId || t.abortedAt;
}

// Keep only attachments that were actually uploaded to THIS issue's attachment dir — a client can't
// hand us an arbitrary path for the agent to read (it has filesystem access, so this matters).
function validateAttachments(identifier, list) {
  if (!Array.isArray(list)) return [];
  const dir = path.join(logsDir, identifier, 'attachments') + path.sep;
  const out = [];
  for (const a of list) {
    const p = a && typeof a.path === 'string' ? path.resolve(a.path) : null;
    if (!p || !p.startsWith(dir) || !existsSync(p)) continue;
    out.push({ name: safeName(a.name || path.basename(p)), path: p });
  }
  return out.slice(0, 10);
}
function startTurn(identifier, body) {
  const message = String(body?.message || '').trim();
  const attachments = validateAttachments(identifier, body?.attachments);
  if (!message && !attachments.length) return { code: 400, error: 'message must be non-empty' };
  const found = findEntry(identifier);
  if (!found) return { code: 404, error: `no autofix record for ${identifier}` };
  if (activeTurns.has(identifier)) return { code: 409, error: 'a turn is already running for this issue' };

  // Auto-title a standalone chat from its FIRST user message (only while it's still the default title,
  // so a manual rename is never clobbered). The updated title shows in the sidebar after this turn.
  if (found.entry.standalone && (!found.entry.title || found.entry.title === 'New chat')) {
    const title = deriveTitle(message);
    updateIssueEntry(identifier, (e) => ({ ...e, title }));
    found.entry.title = title;
  }

  // No user-facing mode: the environment decides what this turn may do.
  const cap = capabilityOf(found.entry).level;
  // Acquire the lock for READ-ONLY turns too (#2): a read-only agent reads the worktree, so gc must
  // not delete it and the poller must not rewrite it mid-turn. Turns are already serialized per issue
  // by activeTurns above, so this only adds cross-process protection.
  const lockPath = acquireFixLock(identifier);
  if (!lockPath) return { code: 409, error: 'another operation holds the lock for this issue' };

  const turnId = `t${Date.now()}-${++turnSeq}`;
  activeTurns.set(identifier, { child: null, cap, turnId, startedAt: new Date().toISOString(), lockPath });
  // Natural-language merge trigger: if this full-cap chat (ENG or standalone) has open PR(s) and the
  // message is an EXPLICIT merge instruction, run the EXACT same mergeMsg the button runs — while still
  // showing the user's own words. Classify async so the 202 stays instant; any classifier failure (or a
  // non-explicit message) just runs a normal turn. See isMergeRequest for the strict no-false-fire gate.
  (async () => {
    let override = null;
    try {
      if (cap === 'full' && CHAT.nlMergeTrigger !== false && (found.entry.prs || []).filter(Boolean).length && message && await isMergeRequest(message)) {
        override = mergeMsg(found.entry);
        log(`turn ${turnId} (${identifier}): explicit merge request → running the merge flow`);
      }
    } catch { /* classifier unavailable → normal turn */ }
    runTurn(identifier, found.entry, cap, message, turnId, lockPath, null, attachments, override);
  })();
  return { code: 202, body: { turnId, cap } };
}

// The main conversation as READ-ONLY context for a /btw side turn: the recent main messages plus, if a
// main turn is streaming right now, its in-progress output — so /btw can answer questions ABOUT what the
// main agent is currently doing. This is injected as text; the side thread never joins the main session.
function mainConvoBlock(identifier, cs) {
  const msgs = (cs.messages || []).filter((m) => m && m.text).slice(-12);
  const body = msgs.map((m) => `${m.role === 'user' ? 'Developer' : 'Main agent'}: ${String(m.text).slice(0, 2000)}`).join('\n\n');
  let block = `\n=== MAIN CONVERSATION (read-only context for you, the side thread — you can see it but must never change or add to it) ===\n${body || '(no messages yet)'}\n`;
  if (activeTurns.has(identifier)) {
    const live = (channelOf(identifier).turnBuffer || []).filter((e) => e.type === 'text' && e.text).map((e) => e.text).join('');
    block += `\n[The main agent is WORKING ON A TURN RIGHT NOW.${live ? ' Its in-progress output so far:\n' + live.slice(-4000) : ''}]\n`;
  }
  return block;
}

// /btw — a "by the way" side thread. A PARALLEL read-only conversation that (1) runs even while the main
// agent is mid-turn (its own `.btw` lock — never the main lock), (2) sees the main conversation + the main
// agent's live in-progress output, and (3) remembers its OWN thread for follow-ups (a separate btw session
// resumed each turn). It is stored under cs.btw / cs.sessions.btw — the main convo's messages and session
// are never touched, so the side thread never pollutes the main context. Returns the answer + full thread.
async function runBtw(identifier, question) {
  const q = String(question || '').trim();
  if (!q) return { code: 400, error: 'ask a question: /btw <question>' };
  const found = findEntry(identifier);
  if (!found) return { code: 404, error: `no autofix record for ${identifier}` };
  // Own lock: serialize btw turns among themselves, but do NOT contend with the main turn — the whole
  // point is to ask while the main agent is busy. Read-only, so concurrent reads of the worktree are safe.
  const lockPath = acquireLock(identifier, { suffix: 'btw' });
  if (!lockPath) return { code: 409, error: 'the side thread is already answering — wait a moment, then ask again' };
  let sid = null;
  try {
    const cs0 = loadChatState()[identifier] || {};
    // Read-only aside: use the worktree if it exists, else the main checkout — never REBUILD it. A
    // rebuild is a heavy write that could race a concurrent main-turn rebuild; resolveCwd (which rebuilds)
    // is only for real turns that hold the main lock. /btw holds only the btw lock, so it must not assemble.
    const WT = path.join(worktreesDir, identifier);
    const cwd = existsSync(WT) ? WT : agentRoot;
    const btwSid = cs0.sessions?.btw || null;
    const mainCtx = mainConvoBlock(identifier, cs0);
    let prompt;
    if (btwSid) {
      // Follow-up: resume the side thread (it remembers earlier /btw Q&A); refresh it on the main convo.
      prompt = `${mainCtx}\n[Continue our side thread. Read-only, standalone, concise. Answer the developer's follow-up.]\n\nSide question: ${q}`;
    } else {
      // First /btw: seed the curated context + the main conversation, framed as an isolated aside.
      const framed = `[You are a "/btw" SIDE THREAD. You can read the main conversation (below) and the codebase, and you'll remember THIS side thread for the developer's follow-ups — but nothing here is added to the main conversation or its context. Read-only: change nothing. Answer concisely and standalone.]\n${mainCtx}\n\nSide question: ${q}`;
      prompt = found.entry.standalone
        ? `You are a READ-ONLY side thread in a standalone chat titled "${found.entry.title || 'New chat'}" (worktree ${cwd}, branch ${found.entry.branch}). Read the code and the main conversation to answer; change nothing.\n${framed}`
        : freshPrompt('readOnly', identifier, found.entry, await fetchLinear(identifier), cwd, framed, '');
    }
    // Read-only tools (from the readOnly cap), but on Sonnet — a side aside doesn't need Opus.
    const out = await runClaudeStream(chatArgs('readOnly', btwSid, CHAT.btwModel), prompt, cwd, CHAT.readOnly?.timeoutMs || 10 * 60 * 1000,
      (e) => { if (e.type === 'init') sid = e.sessionId; }, null, agentEnv(found.entry, null));
    if (out.timedOut) return { code: 504, error: 'the side question timed out' };
    const answer = (out.texts.join('\n\n').trim()) || (out.result?.result || '').trim() || '(no answer)';
    // Persist the side thread SEPARATELY. updateChatState re-reads fresh, so a main turn that finished
    // during our await keeps its messages — we only ever add cs.btw / cs.sessions.btw.
    const at = new Date().toISOString();
    const entry = updateChatState(identifier, (cs) => {
      cs.sessions = cs.sessions || {};
      cs.sessions.btw = sid || btwSid || cs.sessions.btw || null;
      cs.btw = cs.btw || { messages: [] };
      cs.btw.messages.push({ role: 'user', text: q.slice(0, 8000), at }, { role: 'assistant', text: answer.slice(0, 50000), at });
      cs.btw.messages = cs.btw.messages.slice(-200);
      return cs;
    });
    return { code: 200, body: { answer, thread: entry.btw?.messages || [] } };
  } catch (e) {
    return { code: 500, error: String(e?.message || e) };
  } finally {
    releaseLock(lockPath);
  }
}

// Promote a blocked / branch-less chat from read-only to editable: provision a fresh assignee-prefixed
// fix branch + worktree (off origin/main, the same way the pipeline assembles one), then persist
// entry.branch so capabilityOf() flips it to full. Guarded by makeEditableDecision so we never promote a
// chat the pipeline is mid-run on, a standalone (already editable), or one that already has a worktree.
async function makeEditable(identifier) {
  const found = findEntry(identifier);
  if (!found) return { code: 404, error: `no autofix record for ${identifier}` };
  const WT = path.join(worktreesDir, identifier);
  const dec = makeEditableDecision(found.entry, { fixEnabled: fixEnabled(), worktreeExists: existsSync(WT) });
  if (!dec.ok) return { code: 409, error: dec.reason };
  // Serialize against turns/previews for this issue while we build the worktree.
  const lockPath = acquireLock(identifier);
  if (!lockPath) return { code: 409, error: 'busy — an operation holds this chat; try again in a moment' };
  try {
    const identity = resolveAssigneeIdentity(found.entry.assignee);
    const title = found.entry.linearTitle || (await fetchLinear(identifier))?.title || '';
    const branch = buildEditableBranch(identifier, assigneeBranchPrefix(identity, config.branchPrefix), kebab(title));
    const asm = assembleFromBranch(WT, branch); // not-yet-pushed branch → builds from origin/<base> with -B
    if (!asm.ok) return { code: 500, error: `could not create the ${asm.repo} worktree: ${(asm.err || '').slice(0, 500)}` };
    prepareWorktreeDeps(WT);
    if (identity) applyWorktreeIdentity(WT, identity, (m) => log(`make-editable ${identifier}: ${m}`));
    updateIssueEntry(identifier, (e) => ({ ...e, branch, outcome: promotedOutcome(e.outcome) })); // branch → full access; clear "blocked"
    log(`make-editable ${identifier}: provisioned worktree + branch ${branch} — chat is now full-access`);
    return { code: 200, body: { editable: true, branch } };
  } catch (e) {
    return { code: 500, error: String(e?.message || e) };
  } finally {
    releaseLock(lockPath);
  }
}

// Self-authorized message for the inline reconcile turn: fired only when the deterministic reconcile
// (reconcileWithRemote) could not resolve a diverged remote — a true conflict that needs judgment.
// The agent already committed this turn; its job now is to reconcile the branch with the rewritten
// remote WITHOUT losing work or force-clobbering, then push.
const RECONCILE_MSG = (repoKeys) => [
  '**Push reconcile — authorized.** Your changes are committed, but the automatic push to the open PR was',
  `rejected because the remote branch diverged (it was likely rebased server-side — e.g. \`gh pr update-branch\`,`,
  `the merge queue, or a Greptile/CI rebase) for: **${repoKeys.join(', ')}**. The deterministic auto-reconcile`,
  "couldn't resolve it cleanly, so it left your commit exactly as-is and handed it to you.",
  '',
  'For each affected repo (cd into its package/worktree):',
  '1. `git fetch origin <branch>` and inspect the divergence: `git log --oneline HEAD..FETCH_HEAD` (theirs) and `git log --oneline FETCH_HEAD..HEAD` (yours).',
  '2. The **remote is the source of truth** for a PR branch. If your commits are already on the remote by content (check with `git cherry FETCH_HEAD HEAD <base-branch>` — `-` means already there), just fast-forward: `git reset --hard FETCH_HEAD`. Otherwise `git rebase FETCH_HEAD` (or reset to FETCH_HEAD and cherry-pick only your new commits), resolving conflicts per the repo conventions (CLAUDE.md).',
  '3. Verify nothing was dropped (`git log` shows both sides\' work) and the tree is clean, then push: `git push`.',
  '',
  'You ARE authorized to run `git fetch`, `git rebase`, `git cherry-pick`, `git reset`, and `git push` for THIS reconcile — this overrides the usual do-not-push rule. But do NOT use `--force`/`--force-with-lease` (never clobber the remote), and do NOT lose any commit.',
  'End with a line containing only `RECONCILE_DONE` if you pushed successfully, or `RECONCILE_BLOCKED: <short reason>` if a genuine conflict needs the developer to decide.',
].join('\n');

// "Merge PR(s)" button / any full-conviction merge request. Runs autonomously on the issue's own chat
// session (full context, and the merge log stays in the conversation): get every open PR ready — sync
// with base, fix CI, drive Greptile to a pass — and MERGE each the moment its gates are green. There is
// NO confirmation handshake (removed deliberately: it blocked autonomy); the ONLY thing that stops it is
// a genuine decision change (MERGE_BLOCKED). Self-authorizes the gh actions, overriding the standard
// "don't push/merge" note in the session.
// The PR URL(s) this chat opened, from the entry. This chat === these specific PR(s); the merge flow
// must operate ONLY on them and must never discover/merge other repo PRs.
function entryPrUrls(entry) {
  return (entry?.prs || []).filter(Boolean).map((p) => (typeof p === 'string' ? p : p?.url)).filter(Boolean);
}
const prShortRef = (url) => { const m = /\/pull\/(\d+)/.exec(url || ''); return m ? `#${m[1]}` : url; };

// Autonomous merge prompt, scoped to EXACTLY this chat's PR(s). It names the PR URLs explicitly and
// forbids `gh pr list`/any repo-wide discovery, so the agent merges only the current PR(s) — not every
// open PR in the repo. Everything else (rebase → CI → Greptile gate → merge, driven by the [[WATCH]]
// loop) is unchanged.
function mergeMsg(entry) {
  const urls = entryPrUrls(entry);
  const list = urls.map((u) => `- ${u}`).join('\n') || '- (this chat has no recorded PR — do NOT go looking for one; end with MERGE_BLOCKED explaining there is no PR to merge)';
  return [
    '**Merge THIS chat\'s PR(s).** Get the specific PR(s) below mergeable and MERGE — fully autonomously. There is NO confirmation step: the moment a PR\'s gates are green you are authorized to merge it immediately, without asking anyone.',
    '',
    `**Merge gate (ALL FOUR must hold — this is a hard safety boundary).** You may run \`gh pr merge\` ONLY when: (a) you have a standing explicit merge instruction (this turn is one); (b) CI is green; (c) Greptile has passed; and (d) admission is still valid — if this chat is tied to a Linear issue, it must still carry the \`${config.forceLabel}\` label, still be assigned to the same person, and NOT have moved to Done/Canceled/Blocked. If ANY of the four is missing, do NOT merge — end with \`MERGE_BLOCKED: <which gate failed>\`. NEVER use \`gh pr merge --admin\` or any other bypass of branch protection under any circumstance.`,
    '',
    'The ONLY PR(s) you may act on are exactly these (this chat owns them):',
    list,
    '',
    '**Scope — critical:** operate ONLY on the PR(s) listed above, addressing each by its URL. Do NOT run `gh pr list` or otherwise discover, touch, ready, update, or merge ANY other open PR in the repo — even if it looks related. If a command needs a PR argument, pass one of the URLs above.',
    '',
    'For each PR URL above (call it `<pr>`):',
    '1. If it is a draft, mark it ready: `gh pr ready <pr>`.',
    '2. Sync its branch with the base branch: `gh pr update-branch <pr>` (or merge the latest base in), resolving any conflicts.',
    '3. Check CI: `gh pr checks <pr>`. If any check is failing, read the failing logs (`gh run view <run-id> --log-failed`), fix the code, and commit — your commit auto-pushes. Repeat until every check passes.',
    '4. **Greptile review is a required, merge-blocking gate.** Greptile is an automated code reviewer (a bot) that posts a review on every PR; the branch protection keeps the PR **BLOCKED until Greptile gives a passing/approving review**. Inspect it with `gh pr view <pr> --json reviews,statusCheckRollup` (and `gh pr checks <pr>` — Greptile may also surface as a status check). **ALWAYS pull up and read Greptile\'s actual review comments before merging — even if the PR already shows a passing/approving review or every check is green. A Greptile pass routinely still carries inline comments and suggestions; a green status is NOT permission to skip reading them.** Never merge a PR you have not read Greptile\'s comments on. Also check for comments Greptile posts as inline PR review comments, not just the top-level review verdict: `gh pr view <pr> --json reviews` plus `gh api repos/{owner}/{repo}/pulls/<pr>/comments`. When Greptile requests changes OR leaves any comments (blocking or not), read them in full, then **classify each point** so this stays autonomous:',
    '   - **Mechanical / clear-cut fixes** (bugs it caught, missing null checks, typos, obviously-correct suggestions with no judgment call): just fix them yourself, commit (auto-pushes), and let Greptile re-review. Do NOT come back to the developer for these — keep going.',
    '   - **Decision changes** (Greptile is questioning an approach, a product/UX/behavior choice, a tradeoff, or anything where a reasonable person could disagree and the "right" answer needs the developer): do NOT guess. Stop and surface it (see MERGE_BLOCKED below) with a crisp summary of exactly what decision is needed.',
    '   - **Passed WITH optional/non-blocking suggestions** (Greptile approved but still left "nit"/"consider"/"suggestion" comments): its pass already unblocks the merge, so these are NOT required. You cannot apply them for free — ANY new commit re-triggers CI and a fresh Greptile review, and the PR stays blocked until they re-pass, so a code change always costs another full verification cycle. So: apply a suggestion pre-merge ONLY if it is quick, clearly safe, and genuinely worth another CI+Greptile round; otherwise merge as-is and capture the rest as a follow-up (a note in a PR comment, or a new Linear issue). Never delay or loop the merge on optional polish.',
    '   Greptile re-reviews on each new commit; if it stalls, re-trigger it by commenting `@greptile review` on the PR. Repeat the fix→re-review loop until Greptile passes or you hit a decision change.',
    '5. When a PR has all checks green, Greptile has passed, and it is mergeable, **MERGE IT IMMEDIATELY: `gh pr merge <pr> --merge`** — a merge commit; NEVER `--delete-branch`; NEVER `--admin` or any bypass of the block. Do not wait for confirmation; merging is the goal.',
    '6. **Waiting = register a watch, never block.** CI here runs 20+ min and Greptile drips comments one at a time — do NOT sit blocking on `gh pr checks --watch`/`sleep`. Instead, do everything actionable NOW (kick a rebase, fix a failure, answer a mechanical Greptile point, re-trigger a review), then end your reply with `[[WATCH: <one line — e.g. "PR #2084: Backend tests running, will merge when green">]]`. You will be automatically re-invoked in a few minutes to check again and take the next action. Keep looping that way across the whole rebase→CI→Greptile→merge cascade. End with `[[WATCH_DONE]]` once the PR(s) above are merged.',
    '',
    'If the PR(s) above depend on each other, handle them in the right order (merging one advances the base, so the next will fall behind — re-sync it with `gh pr update-branch`, which re-triggers its CI + a fresh Greptile review; that is expected, just ride it out via [[WATCH]] and merge it when it goes green again). You ARE authorized to run `gh pr ready`, `gh pr update-branch`, `gh pr checks`, to comment for a Greptile re-review, to commit, AND to `gh pr merge --merge` for this task — this overrides the earlier note about not pushing/merging.',
    '',
    'Bias hard toward finishing autonomously: pull the developer in ONLY for a genuine decision change — end your reply with `MERGE_BLOCKED: <what decision is needed, and the options>` (summarize Greptile\'s point so the developer can decide without re-reading the PR). Also use MERGE_BLOCKED if a PR simply cannot be made mergeable. When the PR(s) above are merged, report the final state of each.',
  ].join('\n');
}

// Natural-language merge trigger. A typed message runs the EXACT same mergeMsg flow as the button, but
// ONLY on an EXPLICIT merge instruction — no false-fires. A cheap keyword gate skips the model on the vast
// majority of messages; a strict haiku yes/no classifier then confirms (a question about merging, a
// negation, a deferral, or "merge" used in another sense all resolve to NO). Fails safe to NO.
const MERGE_KEYWORD = /\bmerg(e|es|ed|ing)\b|\bship\s+it\b/i;
async function isMergeRequest(text) {
  if (!MERGE_KEYWORD.test(text || '')) return false; // gate: most messages never reach the model
  const instruction = [
    'A developer sent this message in a chat about one or more GitHub pull requests. Decide whether it is an EXPLICIT instruction to MERGE the PR(s). Answer with exactly one word: yes or no.',
    'Answer "yes" ONLY when the developer is clearly telling you to merge — including a conditional "merge it when CI is green" (you will wait, then merge). Examples: "merge it", "go ahead and merge this", "merge the PR", "ship it", "merge when green".',
    'Answer "no" for anything else: a QUESTION about merging ("is it mergeable?", "can we merge?", "why won\'t it merge?"), a NEGATION/hold ("don\'t merge", "not yet", "hold off"), a DEFERRAL/uncertainty ("maybe later", "should we merge?", "I\'ll decide"), or "merge" used in another sense (a "merge conflict", "merge main into the branch", "rebase and merge the base"). When in any doubt, answer no.',
    '',
    'Message: ' + String(text).slice(0, 1000),
  ].join('\n');
  try {
    const r = await claudeApiText(instruction, CHAT.polish?.model || 'claude-haiku-4-5-20251001', 8000, 4);
    return r.ok && /^\s*yes\b/i.test(String(r.text || '').trim());
  } catch { return false; } // classifier unavailable → NOT a merge (never fire on failure)
}

function startMergeTurn(identifier) {
  const found = findEntry(identifier);
  if (!found) return { code: 404, error: `no autofix record for ${identifier}` };
  if (activeTurns.has(identifier)) return { code: 409, error: 'a turn is already running for this issue' };
  if (capabilityOf(found.entry).level !== 'full') return { code: 400, error: 'merging requires a full-access session' };
  if (!(found.entry.prs || []).filter(Boolean).length) return { code: 400, error: 'this issue has no PRs to merge' };
  const lockPath = acquireFixLock(identifier);
  if (!lockPath) return { code: 409, error: 'another fix run holds the lock for this issue' };
  const turnId = `t${Date.now()}-${++turnSeq}`;
  activeTurns.set(identifier, { child: null, cap: 'full', turnId, startedAt: new Date().toISOString(), lockPath });
  // Show a short line naming the PR(s), RUN the scoped mergeMsg (promptOverride) — identical to the NL trigger.
  const disp = entryPrUrls(found.entry).map(prShortRef).join(', ');
  runTurn(identifier, found.entry, 'full', `⛙ Merge ${disp || 'this chat’s PR'}.`, turnId, lockPath, null, [], mergeMsg(found.entry));
  return { code: 202, body: { turnId, cap: 'full' } };
}

// "/compact" — summarize the conversation and drop the big session so future turns run on a tiny
// context. We resume the live session (native full memory) and ask for a thorough hand-off summary,
// then abandon that session: the summary is stashed as `compactSummary`, injected into the next
// fresh turn (see runTurn's session strategy). cs.messages keeps a `compact` marker for the UI.
const COMPACT_MSG = (extra) => [
  'This conversation is being COMPACTED to free up the context window.',
  'Write a thorough hand-off summary of everything that matters so that YOU — resumed later in a FRESH session with no memory of this transcript — can seamlessly keep helping the developer.',
  '',
  'Cover, with specifics (identifiers, file paths, commands, branch/PR names — never be vague):',
  '- What the developer is trying to accomplish, and any explicit constraints or preferences they stated.',
  '- Key decisions made and why.',
  '- Current state: what has been changed/committed, branch and PR/CI status, what is verified vs still pending.',
  '- What is left to do next.',
  '- Any gotchas, dead-ends, or context worth carrying forward.',
  extra ? `\nThe developer specifically asked you to focus the summary on: ${extra}` : '',
  '',
  'Output ONLY the summary as markdown prose. Do NOT run tools, take any action, or ask questions.',
].filter(Boolean).join('\n');

function startCompactTurn(identifier, body) {
  const found = findEntry(identifier);
  if (!found) return { code: 404, error: `no autofix record for ${identifier}` };
  if (activeTurns.has(identifier)) return { code: 409, error: 'a turn is already running for this issue' };
  const cs = loadChatState()[identifier] || {};
  const hasHistory = !!(cs.sessions?.chat) || !!pipelineSessionId(found.entry) || (cs.messages || []).some((x) => x.text);
  if (!hasHistory) return { code: 400, error: 'nothing to compact yet — send a message first' };
  const cap = capabilityOf(found.entry).level;
  // Take the lock even read-only: compaction rewrites session state and prunes forks, so gc must not
  // race it (same rationale as edit/delete).
  const lockPath = acquireFixLock(identifier);
  if (!lockPath) return { code: 409, error: 'another operation holds the lock for this issue' };
  const instructions = String(body?.instructions || '').trim().slice(0, 2000);
  const turnId = `t${Date.now()}-${++turnSeq}`;
  activeTurns.set(identifier, { child: null, cap, turnId, startedAt: new Date().toISOString(), lockPath });
  runCompactTurn(identifier, found.entry, cap, turnId, lockPath, instructions);
  return { code: 202, body: { turnId, cap } };
}

async function runCompactTurn(identifier, entry, cap, turnId, lockPath, instructions) {
  const emit = (e) => broadcast(identifier, { turnId, ...e });
  const m = CHAT[cap] || {};
  let tee = null;
  try {
    emit({ type: 'turn_start', cap, compact: true });
    emit({ type: 'status', text: 'Summarizing the conversation…' });

    const loc = resolveCwd(identifier, entry, emit);
    if (loc.error) { emit({ type: 'error', error: loc.error }); return; }
    const cwd = loc.cwd;

    const cs0 = loadChatState()[identifier] || {};
    const sameCwd = !cs0.cwd || cs0.cwd === cwd;
    const sid = (sameCwd && cs0.sessions?.chat) || pipelineSessionId(entry) || null;
    // With a live session, resume it for native full context; otherwise summarize the display
    // transcript we have (fresh turn with the messages re-injected as text).
    const prompt = sid
      ? COMPACT_MSG(instructions)
      : freshPrompt(cap, identifier, entry, await fetchLinear(identifier), cwd, COMPACT_MSG(instructions), historyBlock(cs0.messages));

    mkdirSync(path.join(logsDir, identifier), { recursive: true });
    tee = createWriteStream(path.join(logsDir, identifier, `compact-${Date.now()}.txt`));
    tee.write(`# compact turn ${turnId} cap=${cap} resume=${sid || 'none'} cwd=${cwd}\n${prompt}\n---\n`);
    const onEvent = (e) => { tee.write(JSON.stringify(e) + '\n'); if (e.type === 'result' && e.isError) return; emit(e); };
    const register = (child) => { const t = activeTurns.get(identifier); if (t) t.child = child; };

    const out = await runClaudeStream(chatArgs(cap, sid), prompt, cwd, m.timeoutMs, onEvent, register, agentEnv(entry, null));
    if (aborted(identifier, turnId)) return;
    if (out.timedOut) { emit({ type: 'error', error: `compaction timed out after ${Math.round(m.timeoutMs / 60000)} min (killed)` }); return; }

    // If the CLI turn errored (usage/session-limit hit, API error, dead resume), its "result" text is
    // the ERROR message, not a summary. Storing it and dropping the live session would DESTROY the
    // conversation (exactly the "You've hit your session limit" corruption). Bail without touching any
    // state — the session stays resumable so the developer can just retry once the limit resets.
    if (out.result?.is_error || (sid && !out.gotInit)) {
      const why = String(out.result?.result || out.stderr || '').trim().slice(0, 300) || out.result?.subtype || 'the model turn errored';
      emit({ type: 'error', error: `compaction failed — ${why}. Nothing was changed; your conversation is intact — retry after the limit resets.` });
      return;
    }

    const summary = (out.texts.join('\n\n').trim()) || String(out.result?.result || '').trim();
    if (!summary) { emit({ type: 'error', error: `compaction produced no summary${out.stderr ? `: ${out.stderr.slice(-200)}` : ''}` }); return; }

    updateChatState(identifier, (cs) => {
      // Abandon the chat session + its forks — the whole point is to stop resuming that big
      // transcript. The next turn starts fresh, seeded with `compactSummary` (see runTurn).
      pruneForks(cwd, cs.forks || [], null);
      delete cs.sessions.chat;
      cs.forks = [];
      cs.compactSummary = summary;
      cs.messages.push({ role: 'compact', text: summary, at: new Date().toISOString() });
      cs.messages = cs.messages.slice(-500);
      // Reflect the freed context immediately so /context isn't stuck showing the pre-compact size:
      // the next turn carries roughly just the summary (~4 chars/token) plus a base for prompt+tools.
      if (cs.usage) cs.usage = { ...cs.usage, contextUsed: Math.round(summary.length / 4) + 3000, at: new Date().toISOString() };
      cs.costTotal = (cs.costTotal || 0) + (out.result?.total_cost_usd || 0);
      return cs;
    });
    logTurnStats('compact', identifier, cap, out.result, loadChatState()[identifier]?.costTotal);
    emit({ type: 'compacted', summary, turns: out.result?.num_turns, ms: out.result?.duration_ms });
  } catch (e) {
    log(`compact ${turnId} (${identifier}) crashed:`, e);
    emit({ type: 'error', error: String(e.message || e) });
  } finally {
    try { tee?.end(); } catch { /* best-effort */ }
    if (lockPath) { try { unlinkSync(lockPath); } catch { /* already gone */ } }
    activeTurns.delete(identifier);
    emit({ type: 'done' });
  }
}

// Edit a previously-sent user message and re-run from there: drop that message + everything below
// it, fork the CLI session's transcript to the cut point (memory preserved), then run the edited
// message as a new turn. `revert` additionally rewinds the branch to before the dropped turns.
function startEditTurn(identifier, body) {
  const message = String(body?.message || '').trim();
  const revert = !!body?.revert;
  if (!message) return { code: 400, error: 'message must be non-empty' };
  const found = findEntry(identifier);
  if (!found) return { code: 404, error: `no autofix record for ${identifier}` };
  if (activeTurns.has(identifier)) return { code: 409, error: 'a turn is already running for this issue' };

  const msgs = (loadChatState()[identifier] || {}).messages || [];
  const index = resolveMsgIndex(msgs, body); // by stable mid (index fallback) — robust to .slice(-500) shifts
  if (index < 0) return { code: 400, error: 'that message is no longer available (it may have scrolled out of history)' };
  if (msgs[index].role !== 'user') return { code: 400, error: 'only user messages can be edited' };

  const cap = capabilityOf(found.entry).level;
  if (revert && cap !== 'full') return { code: 400, error: 'cannot revert code in a read-only session' };
  if (revert && !msgs[index].headBefore) return { code: 400, error: 'no recorded restore point for this message — resend without revert' };
  // Every edit turn takes the lock (even read-only): it forks a session transcript, and the lock
  // is what makes gc skip this issue so the fork can't be deleted out from under a live --resume.
  const lockPath = acquireFixLock(identifier);
  if (!lockPath) return { code: 409, error: 'another operation holds the lock for this issue' };

  const turnId = `t${Date.now()}-${++turnSeq}`;
  activeTurns.set(identifier, { child: null, cap, turnId, startedAt: new Date().toISOString(), lockPath });
  runTurn(identifier, found.entry, cap, message, turnId, lockPath, { index, mid: msgs[index].mid, revert });
  return { code: 202, body: { turnId, cap } };
}

// Delete a user message and everything below it, rewriting the agent's memory to before it — the
// same fork+truncate as edit, but WITHOUT re-running (no new turn). `revert` also rewinds the
// branch. Runs synchronously (only file/git ops, no agent), under the lock so gc won't race it.
function startDeleteHistory(identifier, body) {
  const revert = !!body?.revert;
  const found = findEntry(identifier);
  if (!found) return { code: 404, error: `no autofix record for ${identifier}` };
  if (activeTurns.has(identifier)) return { code: 409, error: 'a turn is running for this issue' };

  const cs0 = loadChatState()[identifier] || {};
  const msgs = cs0.messages || [];
  const index = resolveMsgIndex(msgs, body); // by stable mid (index fallback) — robust to .slice(-500) shifts
  if (index < 0) return { code: 400, error: 'that message is no longer available (it may have scrolled out of history)' };
  if (msgs[index].role !== 'user') return { code: 400, error: 'only user messages can be deleted' };

  const cap = capabilityOf(found.entry).level;
  if (revert && cap !== 'full') return { code: 400, error: 'cannot revert code in a read-only session' };
  if (revert && !msgs[index].headBefore) return { code: 400, error: 'no recorded restore point for this message — delete without revert' };
  const lockPath = acquireFixLock(identifier);
  if (!lockPath) return { code: 409, error: 'another operation holds the lock for this issue' };

  try {
    const cwd = cs0.cwd || resolveCwd(identifier, found.entry, () => {}).cwd;
    const em = msgs[index];
    if (revert && cap === 'full' && em.headBefore) {
      const orig = headShas(cwd);
      const failed = resetTo(cwd, em.headBefore);
      if (failed.length) {
        const restoreFailed = resetTo(cwd, orig);
        return { code: 500, error: restoreFailed.length
          ? `Could not rewind ${failed.join(', ')} and the restore also failed for ${restoreFailed.join(', ')} — resolve manually. Nothing was deleted.`
          : `Could not rewind ${failed.join(', ')} (restore point unavailable); nothing was deleted. Delete without revert.` };
      }
    }
    const forkSid = forkTruncated(cwd, em.sid, em.tLines);
    const prevForks = cs0.forks || [];
    updateChatState(identifier, (cs) => {
      cs.messages = (cs.messages || []).slice(0, index);
      pruneForks(cwd, prevForks, forkSid);
      if (forkSid) { cs.forks = [forkSid]; cs.sessions.chat = forkSid; }
      else { cs.forks = []; delete cs.sessions.chat; }
      return cs;
    });
    return { code: 200, body: { deleted: true, forked: !!forkSid, remaining: index } };
  } finally {
    try { unlinkSync(lockPath); } catch { /* already gone */ }
  }
}

function abortTurn(identifier) {
  const t = activeTurns.get(identifier);
  if (!t) return { code: 404, error: 'no turn is running for this issue' };
  t.abortedAt = new Date().toISOString();
  if (t.child?.pid) { try { process.kill(-t.child.pid, 'SIGKILL'); } catch { try { t.child.kill('SIGKILL'); } catch { /* gone */ } } }
  broadcast(identifier, { turnId: t.turnId, type: 'aborted' });
  return { code: 200, body: { aborted: true } };
}

// ---------------------------------------------------------------------------
// HTTP server (hardening per preview/proxy.mjs)

let uiCache = { mtime: 0, body: '' };
function uiHtml() {
  try {
    const mt = statSync(uiPath).mtimeMs;
    if (mt !== uiCache.mtime) uiCache = { mtime: mt, body: readFileSync(uiPath, 'utf8') };
  } catch { uiCache = { mtime: 0, body: '<h1>ui.html missing</h1>' }; }
  return uiCache.body;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (d) => { data += d; if (data.length > 1e6) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('invalid JSON')); } });
    req.on('error', reject);
  });
}
// Raw binary body (for file uploads) buffered to a size cap. JSON's 1MB limit is too small for media.
function readRawBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []; let len = 0;
    req.on('data', (d) => { len += d.length; if (len > maxBytes) { reject(new Error(`file exceeds ${Math.round(maxBytes / 1048576)}MB limit`)); req.destroy(); return; } chunks.push(d); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
// A safe on-disk basename: strip directory separators and anything odd so an upload can't escape its dir.
const safeName = (s) => (String(s || 'file').replace(/[^\w.\- ]+/g, '_').replace(/^\.+/, '_').slice(0, 120) || 'file');

const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(obj)); };

async function route(req, res) {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;
  if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' }).end(uiHtml());
    return;
  }
  if (req.method === 'GET' && p === '/api/health') {
    json(res, 200, {
      ok: true, fixEnabled: fixEnabled(),
      activeTurns: [...activeTurns.entries()].map(([id, t]) => ({ identifier: id, cap: t.cap, startedAt: t.startedAt })),
    });
    return;
  }
  if (req.method === 'GET' && p === '/api/issues') { json(res, 200, { fixEnabled: fixEnabled(), issues: listIssues() }); return; }
  if (req.method === 'GET' && p === '/api/usage') { json(res, 200, await fetchOauthUsage()); return; }
  if (req.method === 'GET' && p === '/api/members') { json(res, 200, { members: chatMembers() }); return; }
  if (req.method === 'GET' && p === '/api/previews') { json(res, 200, { previews: listPreviews(), cap: config.maxConcurrentPreviews ?? 0 }); return; }
  if (req.method === 'GET' && p === '/api/metrics') {
    const state = loadState();
    const watches = Object.values(state).filter((e) => e && e.identifier && e.watch); // entries with an armed watch
    json(res, 200, computeMetrics(state, watches, config, Date.now()));
    return;
  }
  if (req.method === 'POST' && p === '/api/chats') { const r = createChat((await readBody(req))?.email); json(res, r.code, r.body || { error: r.error }); return; }

  const m = p.match(/^\/api\/issues\/([A-Za-z]+-\d+)(\/events|\/attach|\/chat\/abort|\/chat\/edit|\/chat\/delete|\/chat\/polish|\/chat\/merge|\/chat\/compact|\/chat\/btw|\/chat\/make-editable|\/chat\/rename|\/chat\/owner|\/chat\/close|\/chat|\/preview)?$/);
  if (!m) { json(res, 404, { error: 'not found' }); return; }
  const identifier = m[1].toUpperCase();
  const sub = m[2] || '';

  if (req.method === 'GET' && sub === '/events') { handleEvents(identifier, req, res); return; }

  if (req.method === 'GET' && !sub) {
    const found = findEntry(identifier);
    if (!found) { json(res, 404, { error: `no autofix record for ${identifier}` }); return; }
    const WT = path.join(worktreesDir, identifier);
    const cs = loadChatState()[identifier] || {};
    // Real resume-base context (overrides the last snapshot's contextUsed/window/model when available).
    const rc = resumeContext(identifier, found.entry, cs);
    const usage = rc ? { ...(cs.usage || {}), contextUsed: rc.contextUsed, contextWindow: rc.contextWindow, model: rc.model } : (cs.usage || null);
    // Account limits ride along so the client can warn per-turn at ≥90% (like the context-fill nudge).
    // Non-blocking: serve the cached value and warm it in the background when stale — never await here.
    if (Date.now() - usageCache.at > 5000) fetchOauthUsage().catch(() => { /* best-effort warm */ });
    json(res, 200, {
      issueId: found.uuid, identifier, entry: found.entry,
      worktree: { path: WT, exists: existsSync(WT) },
      capability: capabilityOf(found.entry),
      busy: activeTurns.has(identifier),
      preview: previewInfo(identifier),
      pipeline: buildPipeline(identifier, found.entry),
      linear: await fetchLinear(identifier),
      chat: { sessions: cs.sessions || {}, messages: cs.messages || [] },
      btw: cs.btw?.messages || [], // the /btw side thread (separate from the main conversation)
      usage, costTotal: cs.costTotal || 0, fixEnabled: fixEnabled(),
      accountUsage: usageCache.data?.ok ? usageCache.data.usage : null,
      models: { full: CHAT.full?.model || null, readOnly: CHAT.readOnly?.model || null },
    });
    return;
  }
  if (req.method === 'POST' && sub === '/attach') {
    if (!findEntry(identifier)) { json(res, 404, { error: `no autofix record for ${identifier}` }); return; }
    const name = safeName(u.searchParams.get('name'));
    try {
      const buf = await readRawBody(req, 20 * 1024 * 1024); // 20MB/file
      if (!buf.length) { json(res, 400, { error: 'empty file' }); return; }
      const dir = path.join(logsDir, identifier, 'attachments');
      mkdirSync(dir, { recursive: true });
      const fp = path.join(dir, `${Date.now()}-${name}`);
      writeFileSync(fp, buf);
      json(res, 200, { path: fp, name });
    } catch (e) { json(res, 413, { error: String(e.message || e) }); }
    return;
  }
  if (req.method === 'POST' && sub === '/chat') {
    const r = startTurn(identifier, await readBody(req));
    json(res, r.code, r.body || { error: r.error });
    return;
  }
  if (req.method === 'POST' && sub === '/chat/edit') {
    const r = startEditTurn(identifier, await readBody(req));
    json(res, r.code, r.body || { error: r.error });
    return;
  }
  if (req.method === 'POST' && sub === '/chat/delete') {
    const r = startDeleteHistory(identifier, await readBody(req));
    json(res, r.code, r.body || { error: r.error });
    return;
  }
  if (req.method === 'POST' && sub === '/chat/polish') {
    const r = await polishVoice(identifier, await readBody(req));
    json(res, r.code, r.body);
    return;
  }
  if (req.method === 'POST' && sub === '/chat/merge') {
    const r = startMergeTurn(identifier);
    json(res, r.code, r.body || { error: r.error });
    return;
  }
  if (req.method === 'POST' && sub === '/chat/compact') {
    const r = startCompactTurn(identifier, await readBody(req));
    json(res, r.code, r.body || { error: r.error });
    return;
  }
  if (req.method === 'POST' && sub === '/chat/abort') {
    const r = abortTurn(identifier);
    json(res, r.code, r.body || { error: r.error });
    return;
  }
  if (req.method === 'POST' && sub === '/chat/btw') {
    const r = await runBtw(identifier, (await readBody(req))?.question);
    json(res, r.code, r.body || { error: r.error });
    return;
  }
  if (req.method === 'POST' && sub === '/chat/make-editable') {
    const r = await makeEditable(identifier);
    json(res, r.code, r.body || { error: r.error });
    return;
  }
  if (req.method === 'POST' && sub === '/chat/rename') {
    const r = renameChat(identifier, (await readBody(req))?.title);
    json(res, r.code, r.body || { error: r.error });
    return;
  }
  if (req.method === 'POST' && sub === '/chat/owner') {
    const r = setChatOwner(identifier, (await readBody(req))?.email);
    json(res, r.code, r.body || { error: r.error });
    return;
  }
  if (req.method === 'POST' && sub === '/chat/close') {
    const r = closeChat(identifier);
    json(res, r.code, r.body || { error: r.error });
    return;
  }
  if (req.method === 'POST' && sub === '/preview') {
    const r = startPreviewOp(identifier, await readBody(req));
    json(res, r.code, r.body || { error: r.error });
    return;
  }
  json(res, 405, { error: 'method not allowed' });
}

const server = http.createServer((req, res) => {
  req.on('error', () => {});
  res.on('error', () => {});
  route(req, res).catch((e) => { try { json(res, 500, { error: String(e.message || e) }); } catch { /* closed */ } });
});
server.on('clientError', (_e, socket) => { try { socket.destroy(); } catch { /* gone */ } });

// A stray error must not take the server (and every open chat) down.
process.on('uncaughtException', (e) => console.error('[chat] uncaught:', e));
process.on('unhandledRejection', (e) => console.error('[chat] unhandled rejection:', e));
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    for (const [id, t] of activeTurns) {
      if (t.child?.pid) { try { process.kill(-t.child.pid, 'SIGKILL'); } catch { /* gone */ } }
      if (t.lockPath) { try { unlinkSync(t.lockPath); } catch { /* gone */ } }
      log(`killed in-flight turn for ${id} (${sig})`);
    }
    process.exit(0);
  });
}

// ── Autonomous background watch (config.chat.watch) ──────────────────────────────────────────────────
// A chat with a persisted `watch` (armed by a [[WATCH]] marker) has no free-running process of its own;
// this in-server tick re-invokes it every cadence until it finishes (or hits the cap). Memory-gated and
// strictly one-at-a-time, so N concurrent watched PRs can never stampede the box. Watches live in
// state.json, so a server restart transparently resumes them.
function availMemMB() {
  try { const m = readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+)\s+kB/m); return m ? Math.round(+m[1] / 1024) : null; }
  catch { return null; }
}
const WATCH_CONTINUE_MSG = (goal) => [
  '**Background wake-up.** You earlier registered a watch and are being automatically re-invoked to continue it — this entire conversation is intact, so pick up exactly where you left off.',
  `Your goal / what you are waiting for: ${goal}`,
  'Check the current state NOW — once, do NOT block on `--watch`/`sleep`. If it is ready, take the next action (merge, or the next step). If it is still not ready, end with `[[WATCH: <updated one-line status>]]` and you will be woken again. When the whole task is finished, end with `[[WATCH_DONE]]`. If it now needs a human decision, end with `MERGE_BLOCKED: <what is needed>` (that also stops the wake-ups).',
].join('\n');
function fireWatchTurn(identifier, watch) {
  const found = findEntry(identifier);
  if (!found) return;
  if (activeTurns.has(identifier)) return;                 // a turn is already running for this issue
  if (capabilityOf(found.entry).level !== 'full') return;  // a watch that can't act (no push) is pointless
  const lockPath = acquireFixLock(identifier);
  if (!lockPath) return;                                   // another process (pipeline/gc) holds the lock
  const turnId = `t${Date.now()}-${++turnSeq}`;
  activeTurns.set(identifier, { child: null, cap: 'full', turnId, startedAt: new Date().toISOString(), lockPath });
  log(`watch: waking ${identifier} — ${watch.goal}`);
  runTurn(identifier, found.entry, 'full', WATCH_CONTINUE_MSG(watch.goal), turnId, lockPath);
}
function watchTick() {
  const cfg = CHAT.watch || {};
  if (cfg.enabled === false) return;
  const minMemMB = cfg.minMemMB ?? 3000;
  const memMB = availMemMB();
  if (memMB != null && memMB < minMemMB) { log(`watch: low memory (${memMB}MB < ${minMemMB}) — deferring tick`); return; }
  const now = Date.now();
  let state; try { state = loadState(); } catch { return; }
  for (const entry of Object.values(state)) {
    if (!entry?.watch || !entry.identifier) continue;
    const d = watchDecision(entry.watch, { now, memMB, minMemMB, busy: activeTurns.has(entry.identifier) });
    if (d === 'expired') {
      updateIssueEntry(entry.identifier, (e) => { const { watch, ...rest } = e; return rest; });
      broadcast(entry.identifier, { type: 'watch', state: 'expired' });
      log(`watch: ${entry.identifier} hit the ${Math.round((cfg.maxMs || 0) / 3600000)}h cap — stopped`);
      continue;
    }
    if (d !== 'fire') continue;
    // Pre-advance nextAt so a turn that crashes or forgets to re-arm can't immediately re-fire; a healthy
    // turn re-arms (or clears) the watch itself via its [[WATCH]]/[[WATCH_DONE]] handling.
    updateIssueEntry(entry.identifier, (e) => (e.watch ? { ...e, watch: { ...e.watch, nextAt: now + (cfg.cadenceMs || 5 * 60 * 1000) } } : e));
    fireWatchTurn(entry.identifier, entry.watch);
    return; // ONE per tick — serialize to keep memory/CPU bounded across many watched PRs
  }
}

const CHAT_PORT = CHAT.port || 8790;
const CHAT_BIND = CHAT.bind || '127.0.0.1';

function onListening() {
  log(`listening on http://${CHAT_BIND}:${CHAT_PORT} (fix ${fixEnabled() ? 'ENABLED' : 'disabled'})`);
  log(`tunnel: ssh -L ${CHAT_PORT}:localhost:${CHAT_PORT} ec2-user@<ip>`);
  // Verify the per-assignee GitHub tokens + Linear keys map to the right owner on boot (non-blocking;
  // logs to chat.log). Catches a swapped/expired credential before it silently mis-attributes.
  try { spawn('node', [path.join(BASE, 'check-creds.mjs')], { stdio: 'inherit' }); } catch { /* best-effort */ }
  // Resume/drive background watches (merge-when-green, etc.) — see config.chat.watch.
  if ((CHAT.watch?.enabled) !== false) {
    setInterval(watchTick, CHAT.watch?.tickMs || 60 * 1000);
    log(`watch: tick ${Math.round((CHAT.watch?.tickMs || 60000) / 1000)}s · cadence ${Math.round((CHAT.watch?.cadenceMs || 3e5) / 6e4)}m · cap ${Math.round((CHAT.watch?.maxMs || 864e5) / 36e5)}h`);
  }
}

// EADDRINUSE resilience: on a restart the previous instance's listening socket can take a second or
// two to release (slower under memory pressure). Left unhandled, listen() emits 'error' with no
// listener → it reaches the uncaughtException handler above, which only logs — so the process lingers
// ALIVE but never bound. run-chat.sh's alive() then sees the pid and treats it as up, so run.sh never
// revives it and the tunnel stays dead until a human notices. Instead: retry with backoff for a few
// seconds; if the port truly won't free, exit(1) so the next cron cycle revives us cleanly. Never
// linger not-listening.
let listenAttempt = 0;
const tryListen = () => server.listen(CHAT_PORT, CHAT_BIND);
server.on('listening', onListening);
server.on('error', (e) => {
  if (e.code !== 'EADDRINUSE') { console.error('[chat] fatal server error:', e); process.exit(1); }
  listenAttempt += 1;
  if (listenAttempt > 12) {
    console.error(`[chat] port ${CHAT_PORT} still in use after ${listenAttempt} attempts — exiting so run.sh revives us once it frees`);
    process.exit(1);
  }
  const delay = Math.min(2000, 250 * listenAttempt);
  log(`port ${CHAT_PORT} busy (EADDRINUSE) — retry ${listenAttempt}/12 in ${delay}ms (previous instance's socket releasing)`);
  setTimeout(tryListen, delay); // keep the loop alive across the retry window (do NOT unref)
});
tryListen();
