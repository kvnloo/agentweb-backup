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
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  readFileSync, writeFileSync, existsSync, mkdirSync, statSync, unlinkSync, createWriteStream, readdirSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { config } from '../config.mjs';
import { resolveIssue } from '../linear.mjs';
import { gitIdentityEnv, resolveAssigneeGhToken, resolveAssigneeIdentity } from '../git-identity.mjs';
import {
  assembleFromBranch, prepareWorktreeDeps, detectChangedRepos, pushChanged, unpushedRepos, countCommits, ensureProxy,
  headShas, resetTo,
} from '../autofix.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = path.resolve(__dirname, '..');            // .linear-autofix/
const agentRoot = path.resolve(BASE, '..');            // the agentweb repo root
const statePath = path.join(BASE, 'state.json');
const logsDir = path.join(BASE, 'logs');
const previewScript = path.join(BASE, 'preview', 'preview.mjs');
const previewStatePath = path.join(BASE, 'preview', 'preview-state.json');
const chatStatePath = path.join(__dirname, 'chat-state.json');
const locksDir = path.join(__dirname, 'locks');
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

const fixEnabled = () => process.env.AUTOFIX_RUN_ENABLED === '1';
const loadState = () => { try { return JSON.parse(readFileSync(statePath, 'utf8')); } catch { return {}; } };
const loadChatState = () => { try { return JSON.parse(readFileSync(chatStatePath, 'utf8')); } catch { return {}; } };
// Read-modify-write against a fresh read (same discipline as autofix's updateState).
function updateChatState(identifier, fn) {
  const s = loadChatState();
  s[identifier] = fn(s[identifier] || { identifier, cwd: null, sessions: {}, messages: [] });
  writeFileSync(chatStatePath, JSON.stringify(s, null, 2));
  return s[identifier];
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
        outcome: e.outcome,
        triage: e.triage || null,
        branch: e.branch || null,
        at: e.at || null,
        title: e.title || '',
        summary: e.summary || '',
        prs: e.prs || [],
        hasWorktree,
        active: hasWorktree || ACTIVE_OUTCOMES.includes(e.outcome),
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
    if (a?.email) return { idEnv: gitIdentityEnv(resolveAssigneeIdentity(a)), email: a.email, who: `${a.email} (live)` };
  } catch { /* Linear unreachable — fall back to the pipeline-stored assignee below */ }
  return { idEnv: entry?.assignee ? gitIdentityEnv(entry.assignee) : {}, email: entry?.assigneeEmail || null, who: `${entry?.assigneeEmail || 'none'} (stored)` };
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

async function runPreviewOp(identifier, entry, action) {
  const emit = (e) => broadcast(identifier, e, { buffer: false });
  try {
    if (action === 'up') {
      const loc = resolveCwd(identifier, entry, emit);
      if (loc.error) { emit({ type: 'error', error: loc.error }); return; }
      if (loc.cwd === agentRoot) { emit({ type: 'error', error: 'no worktree/branch to preview for this issue' }); return; }
      await ensureProxy();
      emit({ type: 'status', text: 'Starting preview — builds the portals once, can take a few minutes…' });
      await new Promise((resolve) => {
        const child = spawn('node', [previewScript, 'up', identifier, loc.cwd], { env: process.env });
        const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 15 * 60 * 1000);
        child.stdout.on('data', (d) => process.stdout.write(d));
        child.stderr.on('data', (d) => process.stderr.write(d));
        child.on('error', () => { clearTimeout(timer); resolve(); });
        child.on('close', () => { clearTimeout(timer); resolve(); });
      });
    } else {
      await new Promise((resolve) => {
        const child = spawn('node', [previewScript, 'down', identifier], { env: process.env });
        child.on('error', resolve);
        child.on('close', resolve);
      });
    }
  } catch (e) {
    emit({ type: 'error', error: `preview ${action} failed: ${String(e.message || e)}` });
  } finally {
    previewOps.delete(identifier);
    emit({ type: 'preview', ...previewInfo(identifier) });
  }
}

function startPreviewOp(identifier, body) {
  const action = body?.action;
  if (!['up', 'down'].includes(action)) return { code: 400, error: 'action must be up|down' };
  const found = findEntry(identifier);
  if (!found) return { code: 404, error: `no autofix record for ${identifier}` };
  if (previewOps.has(identifier)) return { code: 409, error: 'a preview operation is already running for this issue' };
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

function chatArgs(cap, sessionId) {
  const m = CHAT[cap] || {};
  const a = ['-p', '--output-format', 'stream-json', '--verbose', '--model', m.model, '--max-turns', String(m.maxTurns)];
  if (cap === 'readOnly') a.push('--allowedTools', (m.allowedTools || []).join(','));
  else a.push('--dangerously-skip-permissions');
  if (sessionId) a.push('--resume', sessionId);
  return a;
}

function runClaudeStream(args, prompt, cwd, timeoutMs, onEvent, register, env = process.env) {
  return new Promise((resolve) => {
    const child = spawn('claude', args, { cwd, env, detached: true });
    if (register) register(child);
    const out = { timedOut: false, gotInit: false, result: null, texts: [], tools: [], stderr: '' };
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
        for (const block of j.message?.content || []) {
          if (block.type === 'text' && block.text) { out.texts.push(block.text); onEvent({ type: 'text', text: block.text }); }
          if (block.type === 'tool_use') {
            const input = JSON.stringify(block.input || {}).slice(0, 1500); // enough for most Bash cmds/paths to stay valid JSON for the UI formatter
            out.tools.push({ name: block.name, input });
            onEvent({ type: 'tool', id: block.id, name: block.name, input });
          }
        }
      } else if (j.type === 'user') {
        for (const block of j.message?.content || []) {
          if (block.type === 'tool_result') onEvent({ type: 'tool_result', id: block.tool_use_id, ok: !block.is_error });
        }
      } else if (j.type === 'result') {
        out.result = j;
        onEvent({ type: 'result', text: j.result || '', turns: j.num_turns, ms: j.duration_ms, sessionId: j.session_id, isError: !!j.is_error, subtype: j.subtype });
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
Raw stage transcripts are in ${path.join(logsDir, identifier)}/<stage>.txt — each is a JSON envelope whose .result field is that agent's final report. Read them if asked about pipeline behavior.
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

function acquireFixLock(identifier) {
  mkdirSync(locksDir, { recursive: true });
  const lockPath = path.join(locksDir, `${identifier}.lock`);
  const staleMs = (CHAT.fix?.timeoutMs || 30 * 60 * 1000) + 5 * 60 * 1000;
  try { if (Date.now() - statSync(lockPath).mtimeMs > staleMs) unlinkSync(lockPath); } catch { /* no lock */ }
  try { writeFileSync(lockPath, String(process.pid), { flag: 'wx' }); return lockPath; }
  catch { return null; }
}

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

async function runTurn(identifier, entry, cap, message, turnId, lockPath, edit = null) {
  const emit = (e) => broadcast(identifier, { turnId, ...e });
  const m = CHAT[cap] || {};
  let tee = null;
  try {
    emit({ type: 'turn_start', cap, message });

    const loc = resolveCwd(identifier, entry, emit);
    if (loc.error) { emit({ type: 'error', error: loc.error }); return; }
    const cwd = loc.cwd;

    // Edit prelude: rewrite history at edit.index. Optionally rewind the code, fork the transcript
    // at the cut point (native memory preserved; null -> fresh fallback), then drop the messages
    // from the edit point down. Mutates `edit` with forkSid + the retained conversation.
    if (edit && edit.index != null && !edit.prepared) {
      const csE = loadChatState()[identifier] || {};
      const msgsE = csE.messages || [];
      const em = msgsE[edit.index] || {};
      edit.retained = msgsE.slice(0, edit.index);

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
        cs.messages = (cs.messages || []).slice(0, edit.index);
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
    let resumeSid;
    let prompt;
    let usedCompact = false;
    if (edit) {
      resumeSid = edit.forkSid || null;
      prompt = resumeSid ? message : freshPrompt(cap, identifier, entry, await fetchLinear(identifier), cwd, message, histText);
    } else {
      const sameCwd = !cs0.cwd || cs0.cwd === cwd;
      resumeSid = (sameCwd && cs0.sessions?.chat) || null;
      if (resumeSid) {
        prompt = message;
      } else if (cs0.compactSummary) {
        // Post-compact: there's no chat session to resume (compaction dropped it on purpose). Start
        // fresh seeded with the compaction summary instead of the pipeline session — that big
        // transcript is exactly the context we just compacted away.
        usedCompact = true;
        prompt = freshPrompt(cap, identifier, entry, await fetchLinear(identifier), cwd, message, compactBlock(cs0.compactSummary));
      } else if (cwd !== agentRoot && pipelineSessionId(entry)) {
        resumeSid = pipelineSessionId(entry);
        prompt = preamble(cap) + message;
      } else {
        prompt = freshPrompt(cap, identifier, entry, await fetchLinear(identifier), cwd, message);
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
    const turnEnv = (() => {
      if (cap !== 'full') return process.env;
      const idEnv = attr.idEnv || {};
      const ghToken = attr.email ? resolveAssigneeGhToken({ email: attr.email }) : null;
      if (!Object.keys(idEnv).length && !ghToken) return process.env;
      return { ...process.env, ...idEnv, ...(ghToken ? { GH_TOKEN: ghToken } : {}) };
    })();

    mkdirSync(path.join(logsDir, identifier), { recursive: true });
    tee = createWriteStream(path.join(logsDir, identifier, `chat-${Date.now()}.txt`));
    tee.write(`# turn ${turnId} cap=${cap} resume=${resumeSid || 'none'}${edit ? ' (edit)' : ''} cwd=${cwd}\n${prompt}\n---\n`);
    const onEvent = (e) => {
      tee.write(JSON.stringify(e) + '\n');
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
      updateChatState(identifier, (cs) => { delete cs.sessions.chat; return cs; });
      prompt = freshPrompt(cap, identifier, entry, await fetchLinear(identifier), cwd, message, histText);
      tee.write(`# retry fresh\n${prompt}\n---\n`);
      out = await runClaudeStream(chatArgs(cap, null), prompt, cwd, m.timeoutMs, onEvent, register, turnEnv);
    }

    let fix = null;
    if (cap === 'full' && cwd !== agentRoot) {
      const changed = detectChangedRepos(cwd);
      const newThisTurn = countCommits(changed) > preCommits;
      // Push whatever is unpushed — commits made THIS turn AND any a prior turn committed but never
      // pushed (e.g. a push that lost a race, or a turn that made no *new* commit and so used to
      // skip the push). The chat server is the ONLY thing that pushes chat commits — nothing picks
      // them up later — so we flush them here instead of stranding them "waiting for the orchestrator".
      const pending = changed.length ? unpushedRepos(changed) : [];
      if (pending.length || newThisTurn) {
        let failed = [];
        if (pending.length) {
          emit({ type: 'status', text: 'Pushing to the open PR(s)…' });
          failed = pushChanged(pending);
        }
        fix = { committed: true, newThisTurn, pushedOk: failed.length === 0, failedRepos: failed, prs: entry.prs || [] };
        emit({ type: 'fix_summary', ...fix });
      }
    }

    if (out.timedOut) emit({ type: 'error', error: `timed out after ${Math.round(m.timeoutMs / 60000)} min (killed)` });
    else if (!out.result && !aborted(identifier, turnId)) emit({ type: 'error', error: `claude exited without a result${out.stderr ? `: ${out.stderr.slice(-300)}` : ''}` });
    else if (out.result?.is_error) emit({ type: 'error', error: `turn ended abnormally (${out.result.subtype || 'error'})${out.result.result ? `: ${String(out.result.result).slice(0, 300)}` : ''}` });

    updateChatState(identifier, (cs) => {
      cs.messages.push({
        role: 'assistant', cap, at: new Date().toISOString(),
        text: out.texts.join('\n\n').slice(0, 50000) || '(no reply)',
        turns: out.result?.num_turns, ms: out.result?.duration_ms,
        tools: out.tools.slice(0, 50),
        ...(fix?.committed ? { fix } : {}),
      });
      // Snapshot context/cost from the CLI result so /status and /context have real data. The last
      // turn's (input + cache_read + cache_creation) ≈ the current context size; cost accumulates.
      const u = out.result?.usage, mu = out.result?.modelUsage;
      // An Opus turn still makes tiny background haiku calls (title/summary) and may spawn subagents on
      // other models, so modelUsage has several keys. Pick the PRIMARY one — the model that did the most
      // work (the user-facing agent) — not just the first key, so /status shows the real model and the
      // context window is sized to it.
      const muTot = (x) => (x ? (x.inputTokens || 0) + (x.outputTokens || 0) + (x.cacheReadInputTokens || 0) + (x.cacheCreationInputTokens || 0) : 0);
      const mk = mu ? Object.keys(mu).sort((a, b) => muTot(mu[b]) - muTot(mu[a]))[0] : null;
      if (u || mk) {
        cs.usage = {
          contextUsed: u ? ((u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)) : (cs.usage?.contextUsed ?? null),
          contextWindow: mk ? mu[mk].contextWindow : (cs.usage?.contextWindow ?? null),
          model: mk || cs.usage?.model || null,
          turns: out.result?.num_turns ?? null,
          at: new Date().toISOString(),
        };
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
}

// After an abort the turn record is replaced/cleared — used to suppress bogus error events.
function aborted(identifier, turnId) {
  const t = activeTurns.get(identifier);
  return !t || t.turnId !== turnId || t.abortedAt;
}

function startTurn(identifier, body) {
  const message = String(body?.message || '').trim();
  if (!message) return { code: 400, error: 'message must be non-empty' };
  const found = findEntry(identifier);
  if (!found) return { code: 404, error: `no autofix record for ${identifier}` };
  if (activeTurns.has(identifier)) return { code: 409, error: 'a turn is already running for this issue' };

  // No user-facing mode: the environment decides what this turn may do.
  const cap = capabilityOf(found.entry).level;
  const lockPath = cap === 'full' ? acquireFixLock(identifier) : null;
  if (cap === 'full' && !lockPath) return { code: 409, error: 'another fix run holds the lock for this issue' };

  const turnId = `t${Date.now()}-${++turnSeq}`;
  activeTurns.set(identifier, { child: null, cap, turnId, startedAt: new Date().toISOString(), lockPath });
  runTurn(identifier, found.entry, cap, message, turnId, lockPath);
  return { code: 202, body: { turnId, cap } };
}

// "Merge PR(s)" button. Runs on the issue's own chat session (full context, and the merge log stays
// in the conversation). Two phases: prep (ready + sync + fix CI + wait green, but DON'T merge, end
// with a MERGE_READY / MERGE_BLOCKED marker) and, after the developer confirms, merge. The message
// self-authorizes the gh actions, overriding the standard "don't push/merge" note in the session.
const MERGE_PREP_MSG = [
  '**Merge PR(s) — preparation.** Get every open PR on this issue ready to merge, but DO NOT merge yet.',
  '',
  'For each open PR on this issue (list them with `gh pr list --state open` in each repo):',
  '1. If it is a draft, mark it ready: `gh pr ready <n>`.',
  '2. Sync its branch with the base branch: `gh pr update-branch <n>` (or merge the latest base in), resolving any conflicts.',
  '3. Check CI: `gh pr checks <n>`. If any check is failing, read the failing logs (`gh run view <run-id> --log-failed`), fix the code, and commit — your commit auto-pushes. Repeat until every check passes.',
  '4. Wait for all checks to go green (`gh pr checks <n> --watch`).',
  '',
  'If the PRs depend on each other, handle them in the right order. You ARE authorized to run `gh pr ready`, `gh pr update-branch`, `gh pr checks`, and to commit for this task — this overrides the earlier note about not pushing. But do NOT run `gh pr merge` in this step.',
  '',
  'When ALL open PRs are green and mergeable, end your reply with a line containing only `MERGE_READY`.',
  'If any PR cannot be made mergeable, end your reply with `MERGE_BLOCKED: <short reason>`.',
].join('\n');
const MERGE_DO_MSG = [
  '**Merge PR(s) — confirmed by the developer.** Merge the PR(s) you just prepared.',
  'For each PR, run `gh pr merge <n> --merge` (do NOT use `--delete-branch`). You are authorized to merge for this task.',
  'If a merge is blocked, say why. Report the final state of each PR.',
].join('\n');
function startMergeTurn(identifier, body) {
  const found = findEntry(identifier);
  if (!found) return { code: 404, error: `no autofix record for ${identifier}` };
  if (activeTurns.has(identifier)) return { code: 409, error: 'a turn is already running for this issue' };
  if (capabilityOf(found.entry).level !== 'full') return { code: 400, error: 'merging requires a full-access session' };
  if (!(found.entry.prs || []).filter(Boolean).length) return { code: 400, error: 'this issue has no PRs to merge' };
  const lockPath = acquireFixLock(identifier);
  if (!lockPath) return { code: 409, error: 'another fix run holds the lock for this issue' };
  const message = body?.confirm ? MERGE_DO_MSG : MERGE_PREP_MSG;
  const turnId = `t${Date.now()}-${++turnSeq}`;
  activeTurns.set(identifier, { child: null, cap: 'full', turnId, startedAt: new Date().toISOString(), lockPath });
  runTurn(identifier, found.entry, 'full', message, turnId, lockPath);
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

    const out = await runClaudeStream(chatArgs(cap, sid), prompt, cwd, m.timeoutMs, onEvent, register);
    if (aborted(identifier, turnId)) return;
    if (out.timedOut) { emit({ type: 'error', error: `compaction timed out after ${Math.round(m.timeoutMs / 60000)} min (killed)` }); return; }

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
  const index = Number.parseInt(body?.index, 10);
  const message = String(body?.message || '').trim();
  const revert = !!body?.revert;
  if (!message) return { code: 400, error: 'message must be non-empty' };
  if (!Number.isInteger(index) || index < 0) return { code: 400, error: 'index must be a non-negative integer' };
  const found = findEntry(identifier);
  if (!found) return { code: 404, error: `no autofix record for ${identifier}` };
  if (activeTurns.has(identifier)) return { code: 409, error: 'a turn is already running for this issue' };

  const msgs = (loadChatState()[identifier] || {}).messages || [];
  if (index >= msgs.length) return { code: 400, error: 'index out of range' };
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
  runTurn(identifier, found.entry, cap, message, turnId, lockPath, { index, revert });
  return { code: 202, body: { turnId, cap } };
}

// Delete a user message and everything below it, rewriting the agent's memory to before it — the
// same fork+truncate as edit, but WITHOUT re-running (no new turn). `revert` also rewinds the
// branch. Runs synchronously (only file/git ops, no agent), under the lock so gc won't race it.
function startDeleteHistory(identifier, body) {
  const index = Number.parseInt(body?.index, 10);
  const revert = !!body?.revert;
  if (!Number.isInteger(index) || index < 0) return { code: 400, error: 'index must be a non-negative integer' };
  const found = findEntry(identifier);
  if (!found) return { code: 404, error: `no autofix record for ${identifier}` };
  if (activeTurns.has(identifier)) return { code: 409, error: 'a turn is running for this issue' };

  const cs0 = loadChatState()[identifier] || {};
  const msgs = cs0.messages || [];
  if (index >= msgs.length) return { code: 400, error: 'index out of range' };
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

  const m = p.match(/^\/api\/issues\/([A-Za-z]+-\d+)(\/events|\/chat\/abort|\/chat\/edit|\/chat\/delete|\/chat\/polish|\/chat\/merge|\/chat\/compact|\/chat|\/preview)?$/);
  if (!m) { json(res, 404, { error: 'not found' }); return; }
  const identifier = m[1].toUpperCase();
  const sub = m[2] || '';

  if (req.method === 'GET' && sub === '/events') { handleEvents(identifier, req, res); return; }

  if (req.method === 'GET' && !sub) {
    const found = findEntry(identifier);
    if (!found) { json(res, 404, { error: `no autofix record for ${identifier}` }); return; }
    const WT = path.join(worktreesDir, identifier);
    const cs = loadChatState()[identifier] || {};
    json(res, 200, {
      issueId: found.uuid, identifier, entry: found.entry,
      worktree: { path: WT, exists: existsSync(WT) },
      capability: capabilityOf(found.entry),
      busy: activeTurns.has(identifier),
      preview: previewInfo(identifier),
      pipeline: buildPipeline(identifier, found.entry),
      linear: await fetchLinear(identifier),
      chat: { sessions: cs.sessions || {}, messages: cs.messages || [] },
      usage: cs.usage || null, costTotal: cs.costTotal || 0, fixEnabled: fixEnabled(),
      models: { full: CHAT.full?.model || null, readOnly: CHAT.readOnly?.model || null },
    });
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
    const r = startMergeTurn(identifier, await readBody(req));
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

server.listen(CHAT.port || 8790, CHAT.bind || '127.0.0.1', () => {
  log(`listening on http://${CHAT.bind || '127.0.0.1'}:${CHAT.port || 8790} (fix ${fixEnabled() ? 'ENABLED' : 'disabled'})`);
  log(`tunnel: ssh -L ${CHAT.port || 8790}:localhost:${CHAT.port || 8790} ec2-user@<ip>`);
  // Verify the per-assignee GitHub tokens + Linear keys map to the right owner on boot (non-blocking;
  // logs to chat.log). Catches a swapped/expired credential before it silently mis-attributes.
  try { spawn('node', [path.join(BASE, 'check-creds.mjs')], { stdio: 'inherit' }); } catch { /* best-effort */ }
});
