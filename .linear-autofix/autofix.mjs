#!/usr/bin/env node
// .linear-autofix/autofix.mjs
// Fix a single Linear bug: assemble the FULL project (all repos, nested as in your local
// layout) into one worktree -> claude -p -> review gate -> browser verify -> draft PR per
// changed repo -> comment back.
// Usage: node autofix.mjs <LIN-123 | issue-uuid> [--dry-run] [--force]

import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, symlinkSync, copyFileSync, statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import net from 'node:net';
import path from 'node:path';
import { config } from './config.mjs';
import { resolveIssue, addComment, findStateId, moveIssue } from './linear.mjs';
import { findSessionId, fetchItem, summarizeSession } from './tools/session.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const agentRoot = path.resolve(__dirname, '..'); // the agentweb (main) repo root
const statePath = path.join(__dirname, 'state.json');
const previewScript = path.join(__dirname, 'preview', 'preview.mjs');
const proxyScript = path.join(__dirname, 'preview', 'proxy.mjs');
const previewStatePath = path.join(__dirname, 'preview', 'preview-state.json');
const verifyPromptPath = path.join(__dirname, 'verify-prompt.md');
const verifyMcpPath = path.join(__dirname, 'verify-mcp.json');
const reviewPromptPath = path.join(__dirname, 'review-prompt.md');
const managerPromptPath = path.join(__dirname, 'manager-prompt.md');
const refixPromptPath = path.join(__dirname, 'refix-prompt.md');
const log = (...a) => console.log('[autofix]', ...a);

function loadState() { try { return JSON.parse(readFileSync(statePath, 'utf8')); } catch { return {}; } }
function saveState(s) { writeFileSync(statePath, JSON.stringify(s, null, 2)); }
function gitIn(cwd, args) { return spawnSync('git', args, { cwd, encoding: 'utf8' }); }
function repoRootOf(repo) { return path.resolve(agentRoot, repo.root); }
function wtPathOf(WT, repo) { return repo.mount === '.' ? WT : path.join(WT, repo.mount); }

function kebab(s, max = 40) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '') || 'bug';
}

// Fill {{TOKEN}} placeholders. Uses the FUNCTION form of replaceAll so `$` sequences in the
// injected value (rife in code diffs: `$&`, `${x}`, `$1`, shell `$'...'`) are inserted literally
// instead of being interpreted as special replacement patterns. Also the single place that owns
// the shared IDENTIFIER/TITLE/DESCRIPTION filling for every prompt.
export function fillTemplate(tmpl, map) {
  let out = tmpl;
  for (const [k, v] of Object.entries(map)) out = out.replaceAll(`{{${k}}}`, () => (v == null ? '' : String(v)));
  return out;
}

// Build claude-CLI args in one place so the fixer, reviewers, manager, re-fix, and verify passes
// stay in sync. `mcp` adds a strict MCP config (browser-verify only).
function claudeArgs({ model, maxTurns, mcp, skipPermissions = config.skipPermissions }) {
  const a = ['-p', '--output-format', 'json', '--model', model, '--max-turns', String(maxTurns)];
  if (mcp) a.push('--mcp-config', mcp, '--strict-mcp-config');
  if (skipPermissions) a.push('--dangerously-skip-permissions');
  else a.push('--permission-mode', 'acceptEdits');
  return a;
}

// Remove a previous workspace: nested repo worktrees first, then the root, then the dir.
function teardown(WT) {
  for (const repo of [...config.repos].reverse()) {
    spawnSync('git', ['-C', repoRootOf(repo), 'worktree', 'remove', '--force', wtPathOf(WT, repo)]);
    spawnSync('git', ['-C', repoRootOf(repo), 'worktree', 'prune']);
  }
  rmSync(WT, { recursive: true, force: true });
}

// Build the full-project workspace: root repo first, then each nested repo on the same branch.
function assemble(WT, branch) {
  teardown(WT);
  for (const repo of config.repos) {
    const wt = wtPathOf(WT, repo);
    gitIn(repoRootOf(repo), ['fetch', 'origin', repo.base]);
    mkdirSync(path.dirname(wt), { recursive: true });
    const add = gitIn(repoRootOf(repo), ['worktree', 'add', '-B', branch, wt, `origin/${repo.base}`]);
    if (add.status !== 0) return { ok: false, repo: repo.key, err: add.stderr };
  }
  return { ok: true };
}

// Make the fresh worktree buildable for the fix run: link node_modules + copy .env from
// the local repos so `npx tsc` / `npm test` work without a slow install.
const PKG_DIRS = ['backend', 'partner-portal', 'customer-portal'];
const _mtime = (p) => { try { return statSync(p).mtimeMs; } catch { return -1; } };
const _depsFresh = (pkg) => _mtime(path.join(pkg, 'node_modules', '.package-lock.json')) >= _mtime(path.join(pkg, 'package.json'));
const _sameDeps = (a, b) => { try { return readFileSync(path.join(a, 'package.json'), 'utf8') === readFileSync(path.join(b, 'package.json'), 'utf8'); } catch { return false; } };
function installDeps(pkgDir, name) {
  log(`Installing deps for ${name} (source missing/stale) — can take a minute...`);
  const r = spawnSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: pkgDir, stdio: 'inherit' });
  if (r.status !== 0) log(`WARNING: npm install failed for ${name}`);
}
function prepareWorktreeDeps(WT) {
  for (const dir of PKG_DIRS) {
    const wtPkg = path.join(WT, dir);
    if (!existsSync(wtPkg)) continue;
    const srcPkg = path.resolve(agentRoot, dir);
    const wtNm = path.join(wtPkg, 'node_modules');
    if (!existsSync(wtNm)) {
      if (existsSync(path.join(srcPkg, 'node_modules')) && _sameDeps(wtPkg, srcPkg) && _depsFresh(srcPkg)) {
        try { symlinkSync(path.join(srcPkg, 'node_modules'), wtNm, 'dir'); log(`Linked ${dir} deps from source`); }
        catch { installDeps(wtPkg, dir); }
      } else {
        installDeps(wtPkg, dir); // source deps missing/mismatched/stale → isolated fresh install
      }
    }
    for (const f of ['.env', '.env.local', '.env.development']) {
      const s = path.join(srcPkg, f), d = path.join(wtPkg, f);
      if (existsSync(s) && !existsSync(d)) { try { copyFileSync(s, d); } catch { /* ignore */ } }
    }
  }
}

async function main() {
  const ref = process.argv[2];
  const dryRun = process.argv.includes('--dry-run');
  const force = process.argv.includes('--force');
  if (!ref) { console.error('Usage: node autofix.mjs <LIN-123|uuid> [--dry-run] [--force]'); process.exit(2); }
  if (!process.env.LINEAR_API_KEY) { console.error('LINEAR_API_KEY is not set'); process.exit(2); }

  const issue = await resolveIssue(ref);
  const id = issue.identifier;
  log(`Issue ${id}: ${issue.title}`);

  const state = loadState();
  if (state[issue.id] && !force) { log(`Already processed (${state[issue.id].outcome}). Use --force to redo.`); return; }

  const labelNames = (issue.labels?.nodes || []).map((l) => l.name.toLowerCase());
  const model = labelNames.some((n) => config.opusLabels.includes(n)) ? config.opusModel : config.defaultModel;
  const branch = `${config.branchPrefix}${id.toLowerCase()}-${kebab(issue.title)}`;
  const WT = path.resolve(agentRoot, config.worktreesDir, id);

  if (dryRun) {
    log(`DRY RUN — model=${model}, branch=${branch}`);
    log(`Workspace: ${WT}`);
    for (const r of config.repos) log(`  repo ${r.key} -> ${wtPathOf(WT, r)} (off origin/${r.base})`);
    return;
  }

  // Guard: move to In Progress so the poller won't pick the issue up again.
  try {
    const sid = await findStateId(issue.team.id, config.inProgressState, 'started');
    if (sid) { await moveIssue(issue.id, sid); log(`Moved ${id} -> ${config.inProgressState}`); }
  } catch (e) { log('Warn: could not move issue state:', e.message); }

  log('Assembling full project workspace...');
  const asm = assemble(WT, branch);
  if (!asm.ok) {
    log(`Failed to set up worktree (${asm.repo}):`, asm.err);
    await addComment(issue.id, `⚠️ Auto-fix could not start: failed to create the \`${asm.repo}\` worktree.\n\n\`\`\`\n${asm.err}\n\`\`\``);
    state[issue.id] = { identifier: id, outcome: 'setup_failed', at: new Date().toISOString() };
    saveState(state);
    return;
  }
  log(`Workspace ready at ${WT} on ${branch} (${config.repos.map((r) => r.key).join(', ')})`);
  prepareWorktreeDeps(WT);

  // Build the fixer prompt.
  const comments = (issue.comments?.nodes || []).map((c) => `- ${c.user?.name || 'someone'}: ${c.body}`).join('\n') || '(none)';
  const repoLayout = config.repos.map((r) => `- ${r.mount === '.' ? '(workspace root)' : r.mount + '/'} — ${r.key}: ${r.description}`).join('\n');
  const sessionContext = computeSessionContext([issue.description, ...(issue.comments?.nodes || []).map((c) => c.body)].filter(Boolean).join('\n'));
  log(`Session context: ${sessionContext.startsWith('(no session') ? 'none referenced' : 'attached'}`);
  const prompt = fillTemplate(readFileSync(path.join(__dirname, 'prompt.md'), 'utf8'), {
    IDENTIFIER: id, TITLE: issue.title, DESCRIPTION: issue.description || '(no description)',
    COMMENTS: comments, URL: issue.url, BRANCH: branch, REPO_LAYOUT: repoLayout, SESSION_CONTEXT: sessionContext,
  });

  // Run claude -p at the workspace root, on your subscription. The fixer only COMMITS; the PR is
  // opened later by this orchestrator, after the review + browser-verify gates.
  log(`Running claude (model=${model}) — this can take up to ${Math.round(config.timeoutMs / 60000)} min...`);
  const result = await runClaude(claudeArgs({ model, maxTurns: config.maxTurns }), prompt, WT);
  let marker = parseMarker(result);
  let changed = detectChangedRepos(WT);

  // Escalate a "heavy" bug (default model finished with no committed change) to Opus, continuing in
  // the SAME workspace to finish. NOTE: dormant while defaultModel === opusModel; it re-activates
  // automatically if defaultModel is set back to a smaller model.
  if (changed.length === 0 && config.escalateToOpus && model !== config.opusModel) {
    log(`No committed change from ${model} — escalating to ${config.opusModel} on the same workspace...`);
    const escalationNote = '\n\n## Escalation pass\nA previous automated attempt with a smaller model may have left UNCOMMITTED changes in this workspace without finishing. Review any existing changes, complete or correct the fix, then COMMIT per the steps above (do NOT push or open a PR — a later stage does that). The work only counts once it is committed. Do not restart from scratch unless the existing changes are wrong.';
    const r2 = await runClaude(claudeArgs({ model: config.opusModel, maxTurns: config.maxTurns }), prompt + escalationNote, WT);
    marker = parseMarker(r2);
    changed = detectChangedRepos(WT);
  }
  log(`Changed repos: ${changed.map((c) => c.repo).join(', ') || 'none'}`);

  // Push the committed fix to the remote NOW (durability): otherwise a crash/timeout during the
  // long review + verify gates would strand the committed work with no push and no PR.
  let review = null;
  if (changed.length > 0) {
    pushChanged(changed);

    // --- Code review gate: experts -> manager -> re-fix (BEFORE the PR and BEFORE browser verify) ---
    if (config.review?.enabled) {
      try { review = await runReview(issue, WT, changed, branch, sessionContext); }
      catch (e) { log('Review error:', e.message); }
      changed = detectChangedRepos(WT); // a re-fix may have added commits (or reverted to none)
    }
  }

  if (changed.length > 0) {
    // --- Final test: bring up a full preview and drive a real browser on the reviewed code ---
    let verify = null;
    if (config.verify?.enabled) {
      try { verify = await runVerify(issue, WT); } catch (e) { log('Verify error:', e.message); }
    }

    // Gate outcome: the draft PR opens regardless (it is a draft), but a failed gate keeps the
    // issue In Progress for a human and is flagged loudly instead of advancing to In Review.
    const managerVerdict = review?.manager?.verdict;
    const gatesFailed = managerVerdict === 'needs_rework' || verify?.verdict === 'not_fixed';

    // --- Open the draft PR(s), now that the code is reviewed + verified ---
    const prTitle = `${gatesFailed ? '[needs human] ' : ''}${marker.prTitle || marker.summary || issue.title || 'Automated fix'} (${id})`;
    const gateSummary = [
      review ? `Code review: ${managerVerdict === 'needs_rework' ? '⚠️ needs rework' : '✅ sound'}${review.manager?.confirmed?.length ? ` — ${review.manager.confirmed.length} finding(s) fixed` : ''}` : null,
      verify ? `Browser verify: ${verify.verdict === 'verified' ? '✅ verified' : verify.verdict === 'not_fixed' ? '❌ not fixed' : '❓ inconclusive'}` : null,
    ].filter(Boolean).join('\n');
    const prBody = `${marker.prBody || marker.summary || ''}\n\n---\n**Automated gates**\n${gateSummary || '(none run)'}\n\nFixes ${id} — ${issue.url || ''}`;
    const prs = openPrs(changed, prTitle, prBody);

    const liveUrl = (config.keepPreviewUp && !config.cleanupWorktreeOnSuccess && verify) ? (verify.urls?.customer || '') : '';
    const manualOpts = {
      liveUrl,
      cleanup: config.cleanupWorktreeOnSuccess,
      previewUpCmd: `node .linear-autofix/preview/preview.mjs up ${id} ${WT}`,
      previewDownCmd: `node .linear-autofix/preview/preview.mjs down ${id}`,
      testEmail: config.verify?.testEmail,
      testPassword: config.verify?.testPassword,
      postCreds: config.verify?.postCredsInComment,
    };

    // --- Comments back on the Linear issue: fix -> verification (test report + code review) -> manual ---
    await addComment(issue.id, fixCommentBody(prs, marker, { gatesFailed }));
    const verification = [testReportBody(marker, verify), reviewReportBody(review)].filter(Boolean).join('\n\n---\n\n');
    await addComment(issue.id, verification);
    await addComment(issue.id, manualTestBody(marker, manualOpts));

    if (verify) {
      for (const p of prs) if (p.url) spawnSync('gh', ['pr', 'comment', p.url, '--body', verifyBody(verify)], { encoding: 'utf8' });
    }

    if (gatesFailed) {
      log(`Gate failed (${[managerVerdict === 'needs_rework' && 'review', verify?.verdict === 'not_fixed' && 'verify'].filter(Boolean).join(', ')}) — leaving ${id} In Progress for a human.`);
    } else {
      try {
        const sid = await findStateId(issue.team.id, config.reviewState, null);
        if (sid) { await moveIssue(issue.id, sid); log(`Moved ${id} -> ${config.reviewState}`); }
      } catch (e) { log('Warn: could not move to review state:', e.message); }
    }
    if (config.cleanupWorktreeOnSuccess) teardown(WT);
    state[issue.id] = { identifier: id, outcome: gatesFailed ? 'fixed_needs_human' : 'fixed', prs, review: review || null, verify: verify || null, at: new Date().toISOString() };
  } else {
    const revertedByReview = review && marker.status === 'fixed';
    const body = marker.status === 'cannot_fix'
      ? `⚠️ **Automated fix could not complete — needs a human**\n\n${marker.summary || ''}\n\n${marker.investigation ? '**Investigation:**\n' + marker.investigation : ''}`
      : revertedByReview
        ? `⚠️ **Automated fix produced no net change** (the review pass reverted it). Workspace kept at \`${WT}\` for inspection.`
        : `⚠️ **Automated fix run produced no changes.** Workspace kept at \`${WT}\` for inspection.`;
    await addComment(issue.id, body);
    log(`No PR. Workspace kept at ${WT}.`);
    state[issue.id] = { identifier: id, outcome: marker.status === 'cannot_fix' ? 'cannot_fix' : 'no_change', at: new Date().toISOString() };
  }
  saveState(state);
}

function runClaude(args, prompt, cwd, timeoutMs = config.timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn('claude', args, { cwd, env: process.env });
    let out = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => process.stderr.write(d));
    child.on('close', () => { clearTimeout(timer); resolve({ out }); });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

// Find the first brace-balanced {...} substring at/after `from`, respecting string literals and
// escapes — so trailing prose containing a `}` can't corrupt the match.
function firstJsonObject(text, from = 0) {
  const s = text.indexOf('{', from);
  if (s < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = s; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return text.slice(s, i + 1); }
  }
  return null;
}

// Pull a `TAG: { ...json... }` marker out of claude's output. Handles the JSON wrapper from
// `--output-format json`, nested objects/arrays, and trailing prose after the JSON; returns
// `fallback` if nothing parses.
export function extractJson(result, tag, fallback) {
  let text = result.out;
  try { const j = JSON.parse(result.out); if (j && typeof j.result === 'string') text = j.result; } catch { /* not JSON */ }
  const i = text.lastIndexOf(tag + ':');
  const starts = i >= 0 ? [i + tag.length + 1, 0] : [0]; // prefer the marker after the LAST tag
  for (const start of starts) {
    const obj = firstJsonObject(text, start);
    if (obj) { try { return JSON.parse(obj); } catch { /* try next start */ } }
  }
  return fallback;
}

const asArray = (x) => (Array.isArray(x) ? x : []);

export function parseMarker(result) { return extractJson(result, 'AUTOFIX_RESULT', { status: 'unknown' }); }

function parseReview(result, lens) {
  const r = extractJson(result, 'REVIEW_RESULT', { lens, findings: [] });
  return { lens, findings: asArray(r.findings) };
}

export function parseManager(result) {
  const r = extractJson(result, 'MANAGER_RESULT', {});
  return {
    verdict: r.verdict === 'needs_rework' ? 'needs_rework' : 'sound',
    confirmed: asArray(r.confirmed),
    rejectedCount: Number(r.rejectedCount) || 0,
    assessment: r.assessment || '',
  };
}

function parseRefix(result) {
  const r = extractJson(result, 'REFIX_RESULT', {});
  return { status: r.status || 'none', addressed: asArray(r.addressed), tests: asArray(r.tests) };
}

function prFromWorktree(cwd) {
  const r = spawnSync('gh', ['pr', 'view', '--json', 'url', '-q', '.url'], { cwd, encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

// If the issue text names a session, pull a read-only summary from prod DynamoDB so the fixer and
// reviewers can confirm the root cause against real data. Best-effort — never throws.
function computeSessionContext(text) {
  const sid = findSessionId(text);
  if (!sid) return '(No session referenced in this issue.)';
  const { item, error } = fetchItem(sid);
  if (error) return `(Referenced session ${sid} — could not fetch: ${error})`;
  return `Session ${sid} (production, read-only):\n${summarizeSession(item)}`;
}

// Which repos actually have local commits on the branch.
function detectChangedRepos(WT) {
  const found = [];
  for (const repo of config.repos) {
    const wt = wtPathOf(WT, repo);
    const cnt = gitIn(wt, ['rev-list', '--count', `origin/${repo.base}..HEAD`]);
    if (cnt.status === 0 && parseInt((cnt.stdout || '0').trim(), 10) > 0) {
      found.push({ repo: repo.key, base: repo.base, wt });
    }
  }
  return found;
}

// Push each changed repo's branch to origin (idempotent). Returns the repos whose push failed.
function pushChanged(changed) {
  const failed = [];
  for (const c of changed) {
    const push = gitIn(c.wt, ['push', '-u', 'origin', 'HEAD']);
    if (push.status !== 0) { log(`Push failed for ${c.repo}: ${push.stderr}`); failed.push(c.repo); }
  }
  return failed;
}

// Push (idempotent) and open a draft PR from inside each changed repo (so `gh` targets the right
// GitHub remote). Each PR body is scoped with that repo's own file list. Best-effort: a push/create
// failure yields {pushed:false}/{url:null} but never throws.
function openPrs(changed, title, body) {
  const out = [];
  for (const c of changed) {
    const push = gitIn(c.wt, ['push', '-u', 'origin', 'HEAD']);
    if (push.status !== 0) { log(`Push failed for ${c.repo}: ${push.stderr}`); out.push({ repo: c.repo, pushed: false, url: null }); continue; }
    const stat = (gitIn(c.wt, ['diff', '--stat', `origin/${c.base}...HEAD`]).stdout || '').trim();
    const repoBody = `${body}\n\n**Files changed in \`${c.repo}\`:**\n\`\`\`\n${stat}\n\`\`\``;
    const create = spawnSync('gh', ['pr', 'create', '--draft', '--base', c.base, '--title', title, '--body', repoBody], { cwd: c.wt, encoding: 'utf8' });
    if (create.status !== 0 && !/already exists/i.test(create.stderr || '')) log(`gh pr create warning for ${c.repo}: ${create.stderr}`);
    // `gh pr create` prints the new PR URL to stdout; fall back to `gh pr view` (e.g. PR existed).
    const url = (create.status === 0 && (create.stdout || '').trim()) || prFromWorktree(c.wt) || null;
    out.push({ repo: c.repo, pushed: true, url });
  }
  return out;
}

// ---- Code review gate (expert reviewers -> manager verification -> re-fix) ----

const LENS_FOCUS = {
  correctness: 'Does the fix actually address the root cause of the bug? Hunt for logic errors, off-by-one mistakes, unhandled null/empty/error cases, race conditions, and regressions in code paths that CALL the changed code.',
  conventions: "Adherence to the changed repo's CLAUDE.md and existing patterns: naming, file/route structure, DynamoDB GSI-vs-scan, frontend token handling (useAuth() not localStorage), commit granularity, and orphaned imports/variables the change left behind.",
  security: 'Injection (SQL/command/XSS), authentication/authorization and delegation correctness, secret and PII handling, and unsafe handling of untrusted input — this fix ships unattended, so be strict.',
  tests: "Test integrity per the repo's TDD rule: do the added/changed tests actually fail before the fix and pass after? Do they cover invalid inputs, boundaries, and error paths — not just the happy path? Are any assertions vacuous?",
};

// Combined, per-repo-labeled diff of the branch vs its base, truncated for prompt size.
function repoDiff(WT, changed) {
  const max = config.review?.maxDiffChars || 60000;
  let out = '';
  for (const c of changed) {
    const d = gitIn(c.wt, ['diff', `origin/${c.base}...HEAD`]);
    out += `\n### repo: ${c.repo}\n${(d.stdout || '').trim()}\n`;
  }
  out = out.trim();
  if (out.length > max) out = out.slice(0, max) + `\n\n... [diff truncated at ${max} chars] ...`;
  return out;
}

async function runReview(issue, WT, changed, branch, sessionContext = '') {
  const id = issue.identifier;
  const diff = repoDiff(WT, changed);
  const lenses = [...new Set(config.review.lenses || [])].filter((l) => LENS_FOCUS[l]);
  if (!lenses.length || !diff) { log('Review skipped (no lenses or empty diff).'); return null; }
  const issueMap = { IDENTIFIER: id, TITLE: issue.title, DESCRIPTION: issue.description || '(no description)', SESSION_CONTEXT: sessionContext || '(none)' };
  const reviewArgs = () => claudeArgs({ model: config.review.model, maxTurns: config.review.maxTurns, skipPermissions: true });

  // 1. Expert reviewers, one per lens. Templated once with the (large) shared diff, then only the
  //    per-lens tokens differ. Parallel by default; config.review.parallel:false runs sequentially.
  const base = fillTemplate(readFileSync(reviewPromptPath, 'utf8'), {
    ...issueMap, REPOS: changed.map((c) => `- ${c.repo}`).join('\n'), DIFF: diff,
  });
  const runLens = (lens) =>
    runClaude(reviewArgs(), fillTemplate(base, { LENS: lens, LENS_FOCUS: LENS_FOCUS[lens] }), WT, config.review.timeoutMs)
      .then((r) => parseReview(r, lens));
  log(`Running ${lenses.length} expert reviewers (model=${config.review.model}${config.review.parallel === false ? ', sequential' : ''}): ${lenses.join(', ')}...`);
  let results;
  if (config.review.parallel === false) {
    results = [];
    for (const lens of lenses) results.push(await runLens(lens));
  } else {
    results = await Promise.all(lenses.map(runLens));
  }
  const allFindings = results.flatMap((r) => r.findings.map((f) => ({ ...f, lens: r.lens })));
  log(`Reviewers filed ${allFindings.length} finding(s) across ${lenses.length} lenses.`);

  // 2. Manager adversarially verifies which findings must actually be fixed.
  let manager = { verdict: 'sound', confirmed: [], rejectedCount: 0, assessment: '' };
  if (allFindings.length) {
    const findingsBlock = allFindings
      .map((f, i) => `${i + 1}. [${f.lens}/${f.severity || 'n/a'}] ${f.file || '?'}${f.line ? ':' + f.line : ''} — ${f.issue || ''} (suggested: ${f.suggestedFix || 'n/a'})`)
      .join('\n');
    const mp = fillTemplate(readFileSync(managerPromptPath, 'utf8'), { ...issueMap, DIFF: diff, FINDINGS: findingsBlock });
    log(`Running manager verification (model=${config.review.managerModel})...`);
    manager = parseManager(await runClaude(claudeArgs({ model: config.review.managerModel, maxTurns: config.review.maxTurns, skipPermissions: true }), mp, WT, config.review.timeoutMs));
  }
  log(`Manager verdict: ${manager.verdict}; confirmed ${manager.confirmed.length}, rejected ${manager.rejectedCount}.`);

  // 3. Re-fix pass for the confirmed findings only.
  let refix = null;
  if (manager.confirmed.length) {
    const confirmedBlock = manager.confirmed
      .map((f, i) => `${i + 1}. [${f.lens || '?'}/${f.severity || 'n/a'}] ${f.file || '?'} — ${f.issue || ''} → ${f.fix || ''}`)
      .join('\n');
    const rp = fillTemplate(readFileSync(refixPromptPath, 'utf8'), { ...issueMap, BRANCH: branch, CONFIRMED: confirmedBlock });
    log(`Re-fixing ${manager.confirmed.length} confirmed finding(s) (model=${config.review.model})...`);
    refix = parseRefix(await runClaude(reviewArgs(), rp, WT, config.review.timeoutMs));
    log(`Re-fix status: ${refix.status}`);
  }
  return { lenses, manager, refix };
}

// ---- Browser verification (Playwright) ----

function portOpen(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const c = net.connect(port, host);
    c.once('connect', () => { c.destroy(); resolve(true); });
    c.once('error', () => { c.destroy(); resolve(false); });
  });
}

async function proxyIsOurs(port) {
  try { const r = await fetch(`http://127.0.0.1:${port}/__preview_health__`); return (await r.text()).trim() === 'preview-proxy-ok'; }
  catch { return false; }
}
async function ensureProxy() {
  // The proxy listens on all previewPorts; the customer port is our health/liveness probe.
  const port = Number((config.previewPorts && config.previewPorts.customer) || 5174);
  if (await portOpen(port)) {
    if (await proxyIsOurs(port)) return;
    throw new Error(`port ${port} is in use by another process (not our preview proxy) — free it or change config.previewPorts`);
  }
  log('Starting preview proxy...');
  const child = spawn('node', [proxyScript], { detached: true, stdio: 'ignore', env: process.env });
  child.unref();
  for (let i = 0; i < 20; i++) { if (await proxyIsOurs(port)) return; await new Promise((r) => setTimeout(r, 500)); }
  throw new Error(`preview proxy did not become healthy on :${port}`);
}

async function runVerify(issue, WT) {
  const id = issue.identifier;
  await ensureProxy();
  log('Bringing up full preview for browser verification...');
  spawnSync('node', [previewScript, 'up', id, WT], { stdio: 'inherit', env: process.env });

  let urls = {};
  try { urls = (JSON.parse(readFileSync(previewStatePath, 'utf8'))[id.toLowerCase()] || {}).urls || {}; } catch { /* no state */ }

  // Keep the preview running (URL stays live) only when the worktree is also kept; otherwise the
  // worktree is about to be removed and the running servers would break. Tear it down in `finally`
  // so a throw after `up` (missing prompt, parse error) can't leak the ~1.5GB of dev servers.
  const keepUp = config.keepPreviewUp && !config.cleanupWorktreeOnSuccess;
  try {
    const prompt = fillTemplate(readFileSync(verifyPromptPath, 'utf8'), {
      IDENTIFIER: id, TITLE: issue.title, DESCRIPTION: issue.description || '(no description)',
      CUSTOMER_URL: urls.customer || '(n/a)', PARTNER_URL: urls.partner || '(n/a)', API_URL: urls.api || '(n/a)',
      TEST_EMAIL: config.verify.testEmail, TEST_PASSWORD: config.verify.testPassword,
    });
    const args = claudeArgs({ model: config.verify.model, maxTurns: config.verify.maxTurns, mcp: verifyMcpPath, skipPermissions: true });
    log(`Running browser verification (model=${config.verify.model})...`);
    const verdict = parseVerify(await runClaude(args, prompt, WT, config.verify.timeoutMs));
    verdict.urls = urls; // let the caller reuse these without re-reading preview-state
    log(`Verify verdict: ${verdict.verdict}`);
    return verdict;
  } finally {
    if (keepUp) log(`Preview kept running for ${id}${urls.customer ? ` — ${urls.customer}` : ''} (gc stops it when the issue is Done)`);
    else spawnSync('node', [previewScript, 'down', id], { stdio: 'inherit', env: process.env });
  }
}

function parseVerify(result) {
  return extractJson(result, 'VERIFY_RESULT', { verdict: 'inconclusive', method: '', scenario: '', summary: '(no verdict returned)', screenshots: [] });
}

// ---- Linear comment bodies (pure functions; unit-tested from the scratchpad harness) ----

export function fixCommentBody(prs, marker, opts = {}) {
  const links = (prs || []).length
    ? prs.map((p) => {
        const loc = p.url ? p.url
          : p.pushed ? '(branch pushed; open the PR manually)'
          : '⚠️ (push FAILED — nothing reached the remote)';
        return `- \`${p.repo}\`: ${loc}`;
      }).join('\n')
    : '- (no PR opened)';
  const header = opts.gatesFailed
    ? '⚠️ **Automated fix — needs a human (an automated gate failed)**'
    : '🤖 **Automated fix — draft PR opened**';
  const warn = opts.gatesFailed
    ? '\n\n> One or more automated gates failed (see the test report / code review below). The draft PR is open but the issue was left **In Progress** for a human.'
    : '';
  return `${header}${warn}\n\n${links}\n\n${marker.summary || ''}\n\n_Generated by the Linear auto-fix agent — please review._`;
}

const checkIcon = (r) => (r === 'pass' ? '✅' : r === 'fail' ? '❌' : '▫️');

export function testReportBody(marker, verify) {
  const tests = Array.isArray(marker.tests) ? marker.tests : [];
  const checks = tests.length
    ? tests.map((t) => `${checkIcon(t.result)} \`${t.cmd}\``).join('\n')
    : '_(no automated checks reported)_';
  let browser;
  if (!verify) browser = '_skipped_';
  else {
    // Only claim "browser" when the verify pass actually drove a browser; "api" = logic-layer fallback.
    const via = verify.method === 'api' ? ' (via API/logic — not a browser repro)'
      : verify.method === 'browser' ? ' (browser)' : '';
    const icon = verify.verdict === 'verified' ? `✅ verified${via}`
      : verify.verdict === 'not_fixed' ? `❌ NOT fixed${via}`
      : '❓ inconclusive';
    const scenario = verify.scenario ? `\nScenario: ${verify.scenario}` : '';
    const shots = (verify.screenshots || []).length ? '\n_(screenshots saved on the runner; see the PR verification comment)_' : '';
    browser = `${icon} — ${verify.summary || ''}${scenario}${shots}`;
  }
  return `🧪 **Automated test report**\n\n**Code checks**\n${checks}\n\n**Verification**\n${browser}`;
}

export function reviewReportBody(review) {
  if (!review) return null;
  const m = review.manager || { verdict: 'sound', confirmed: [], rejectedCount: 0, assessment: '' };
  const lenses = review.lenses || [];
  const confirmed = m.confirmed || [];
  const verdictIcon = m.verdict === 'sound' ? '✅ sound' : '⚠️ needs rework';
  const rejected = m.rejectedCount ? ` (rejected ${m.rejectedCount} lower-value finding${m.rejectedCount === 1 ? '' : 's'})` : '';
  let fixedBlock;
  if (confirmed.length) {
    const status = review.refix?.status;
    const head = status === 'applied' ? 'Fixed after review:'
      : status === 'partial' ? 'Partially fixed after review:'
      : 'Confirmed (re-fix pass did not complete):';
    fixedBlock = `**${head}**\n` + confirmed.map((f) => `- [${f.lens || '?'}] \`${f.file || '?'}\` — ${f.issue || ''}`).join('\n');
  } else {
    fixedBlock = '**No must-fix findings — the fix passed review clean.**';
  }
  // A lens is "clean" only if it had no confirmed finding; missing/blank lens labels count as a
  // finding against every lens (so we never mislabel a lens clean when a finding omits its lens).
  const confirmedLenses = new Set(confirmed.map((f) => f.lens).filter(Boolean));
  const hasUnlabeled = confirmed.some((f) => !f.lens);
  const cleanLenses = hasUnlabeled ? [] : lenses.filter((l) => !confirmedLenses.has(l));
  const cleanLine = cleanLenses.length ? `\n\nReviewed clean: ${cleanLenses.join(', ')}` : '';
  const assess = m.assessment ? `\n\n_${m.assessment}_` : '';
  return `🔎 **Code review — ${lenses.length} expert lens${lenses.length === 1 ? '' : 'es'} + manager verification**\n\nManager verdict: ${verdictIcon}${rejected}\n\n${fixedBlock}${cleanLine}${assess}`;
}

export function manualTestBody(marker, opts = {}) {
  const steps = Array.isArray(marker.manualSteps) ? marker.manualSteps : [];
  const needsLogin = steps.some((s) => s && s.requiresLogin);
  let access;
  if (opts.cleanup) access = "_(the fix's worktree was removed on success — recreate it to preview)_";
  else if (opts.liveUrl) access = `**Live preview** (kept running): ${opts.liveUrl}\nStop it when done: \`${opts.previewDownCmd}\``;
  else access = `**Bring up a live copy** (the fix's worktree is kept):\n\`\`\`bash\n${opts.previewUpCmd}\n# open the printed nip.io URL, then when done:\n${opts.previewDownCmd}\n\`\`\``;
  const login = needsLogin && opts.testEmail
    ? (opts.postCreds
        ? `\n\nLogin (scenarios marked 🔐): \`${opts.testEmail}\` / \`${opts.testPassword}\``
        : `\n\nLogin (scenarios marked 🔐): use the shared test account \`${opts.testEmail}\` (password in the team vault / CLAUDE.md test accounts)`)
    : '';
  const body = steps.length
    ? steps.map((s, i) => {
        const lock = s.requiresLogin ? ' 🔐' : '';
        const lines = (s.steps || []).map((st) => `   - ${st}`).join('\n');
        return `${i + 1}. **${s.scenario || 'Scenario ' + (i + 1)}**${lock}\n${lines}`;
      }).join('\n')
    : '_(no manual steps reported — exercise the scenario from the bug report)_';
  return `🔍 **How to test manually**\n\n${access}${login}\n\n${body}`;
}

function verifyBody(v) {
  const shots = (v.screenshots || []).length
    ? `\n\nScreenshots (local on the runner):\n${v.screenshots.map((s) => `- \`${s}\``).join('\n')}` : '';
  return `🔎 **Automated browser verification:** ${v.verdict}\n\n${v.summary || ''}${shots}`;
}

// Only run the pipeline when invoked directly (so the pure helpers above can be imported/tested).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error('[autofix] fatal:', e); process.exit(1); });
}
