#!/usr/bin/env node
// .linear-autofix/autofix.mjs
// Fix a single Linear bug: assemble the FULL project (all repos, nested as in your local
// layout) into one worktree -> claude -p -> review gate -> browser verify -> draft PR per
// changed repo -> comment back.
// Usage: node autofix.mjs <LIN-123 | issue-uuid> [--dry-run] [--force]

import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, symlinkSync, copyFileSync, statSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import net from 'node:net';
import path from 'node:path';
import { config } from './config.mjs';
import { resolveIssue, addComment, findStateId, moveIssue, setAutofixLabel, uploadFile } from './linear.mjs';
import { findSessionId, fetchItem, summarizeSession } from './tools/session.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const agentRoot = path.resolve(__dirname, '..'); // the agentweb (main) repo root
const statePath = path.join(__dirname, 'state.json');
const previewScript = path.join(__dirname, 'preview', 'preview.mjs');
const proxyScript = path.join(__dirname, 'preview', 'proxy.mjs');
const previewStatePath = path.join(__dirname, 'preview', 'preview-state.json');
const verifyPromptPath = path.join(__dirname, 'verify-prompt.md');
const verifyPwConfigPath = path.join(__dirname, 'verify-pw-config.json');
const verifyMcpGenPath = path.join(__dirname, '.verify-mcp.generated.json');
const reviewPromptPath = path.join(__dirname, 'review-prompt.md');
const managerPromptPath = path.join(__dirname, 'manager-prompt.md');
const refixPromptPath = path.join(__dirname, 'refix-prompt.md');
const log = (...a) => console.log('[autofix]', ...a);

// Raw per-stage transcripts + metadata (turns, duration, timedOut) — kept for debugging failed
// runs and tuning budgets; the transcripts cost nothing (they were paid for anyway).
const logsDir = path.join(__dirname, 'logs');
let stageLogDir = null;
const stages = {};
export function setStageLogDir(id) { stageLogDir = path.join(logsDir, id); mkdirSync(stageLogDir, { recursive: true }); }

function loadState() { try { return JSON.parse(readFileSync(statePath, 'utf8')); } catch { return {}; } }
function saveState(s) { writeFileSync(statePath, JSON.stringify(s, null, 2)); }
// Read-modify-write against a FRESH read, so concurrent autofix/revise processes (maxConcurrent > 1)
// can't clobber each other's entries with a stale in-memory copy.
function updateState(issueId, entry) { const s = loadState(); s[issueId] = entry; saveState(s); }
function gitIn(cwd, args) { return spawnSync('git', args, { cwd, encoding: 'utf8' }); }
function repoRootOf(repo) { return path.resolve(agentRoot, repo.root); }
function wtPathOf(WT, repo) { return repo.mount === '.' ? WT : path.join(WT, repo.mount); }

export function kebab(s, max = 40) {
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
export function claudeArgs({ model, maxTurns, mcp, skipPermissions = config.skipPermissions }) {
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

// Rebuild the workspace from an ALREADY-PUSHED fix branch (used by revise.mjs when the original
// worktree was cleaned up). Repos the fix never touched fall back to origin/<base>.
export function assembleFromBranch(WT, branch) {
  teardown(WT);
  for (const repo of config.repos) {
    const wt = wtPathOf(WT, repo);
    const root = repoRootOf(repo);
    const hasRemoteBranch = gitIn(root, ['fetch', 'origin', branch]).status === 0;
    gitIn(root, ['fetch', 'origin', repo.base]);
    mkdirSync(path.dirname(wt), { recursive: true });
    const start = hasRemoteBranch ? `origin/${branch}` : `origin/${repo.base}`;
    const add = gitIn(root, ['worktree', 'add', '-B', branch, wt, start]);
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
export function prepareWorktreeDeps(WT) {
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

  // --verify-only: re-run just the deterministic gates (checks + preview + browser verify +
  // media upload) against an ALREADY-FIXED bug's branch, then re-triage. For fixes whose
  // verification was lost to an infrastructure failure — not for changing code.
  if (process.argv.includes('--verify-only')) { await verifyOnlyRun(issue); return; }

  const state = loadState();
  // Non-final outcomes may be re-processed: 'recovered' = the stale sweep reset a crashed run;
  // 'started' = a run that crashed before recording any outcome (or is being retried by hand);
  // 'blocked' = the fixability gate held it — retried once the blocked label is removed
  // (while the label is on, the poller's pickup filter never lists the issue).
  const NON_FINAL = ['recovered', 'started', 'blocked'];
  if (state[issue.id] && !NON_FINAL.includes(state[issue.id].outcome) && !force) { log(`Already processed (${state[issue.id].outcome}). Use --force to redo.`); return; }

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

  // Real fixes run ONLY on the designated runner (the EC2 box sets this in its .env).
  // Dry-runs above stay allowed anywhere. Guards against accidentally burning quota /
  // posting to Linear from a dev laptop.
  if (process.env.AUTOFIX_RUN_ENABLED !== '1') {
    console.error('[autofix] refusing to run: AUTOFIX_RUN_ENABLED != 1 (fixes are EC2-only; set it in .linear-autofix/.env on the designated runner)');
    process.exit(2);
  }

  setStageLogDir(id);

  // --- Fixability gate: BEFORE anything is touched (no state move, no fixer run). A cheap
  // triage pass decides from the issue text whether this is fixable by a code change now, or
  // blocked on an external action (e.g. a disconnected Unipile/Sales-Navigator account waiting
  // on a human to reconnect it — ENG-100's shape). Blocked → label + comment, issue STAYS in
  // Todo/backlog, and the poller skips it until the label is removed.
  const commentsText = (issue.comments?.nodes || []).map((c) => `- ${c.user?.name || 'someone'}: ${c.body}`).join('\n') || '(none)';
  if (config.fixabilityGate?.enabled && !force) {
    const g = config.fixabilityGate;
    const tp = fillTemplate(readFileSync(path.join(__dirname, 'triage-prompt.md'), 'utf8'), {
      IDENTIFIER: id, TITLE: issue.title, DESCRIPTION: issue.description || '(no description)', COMMENTS: commentsText,
    });
    log(`Fixability gate (model=${g.model})...`);
    const tr = extractJson(
      await runClaude(claudeArgs({ model: g.model, maxTurns: g.maxTurns }), tp, agentRoot, g.timeoutMs, 'fixability'),
      'TRIAGE_RESULT', { fixable: true },
    );
    if (tr.fixable === false) {
      log(`Blocked on external action: ${tr.blockedOn || tr.reason || '(unspecified)'} — holding (issue stays in ${issue.state?.name}).`);
      try { await setAutofixLabel(issue, g.blockedLabel); } catch (e) { log('Warn: could not set blocked label:', e.message); }
      await addComment(issue.id, `⏸️ **Auto-fix on hold — blocked on an external action**\n\n${tr.reason || ''}\n\n**Waiting on:** ${tr.blockedOn || '(see reason)'}\n\nNo fix was attempted and the issue was left in **${issue.state?.name || 'its current state'}**. Once the blocker is resolved, remove the \`${g.blockedLabel}\` label and the poller will pick this bug up on its next cycle.`);
      updateState(issue.id, { identifier: id, outcome: 'blocked', blockedOn: tr.blockedOn || '', stages, at: new Date().toISOString() });
      return;
    }
    log('Fixability gate: fixable — proceeding.');
  }

  // Mark the run as STARTED before anything else. This is what lets the stale-In-Progress sweep
  // distinguish "autofix crashed on this issue" from "a human is working on this issue" — the
  // sweep only ever touches issues with a 'started' record. `recoveries` survives a retry so the
  // sweep can stop after one automatic recovery.
  updateState(issue.id, { identifier: id, outcome: 'started', recoveries: state[issue.id]?.recoveries || 0, at: new Date().toISOString() });

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
    updateState(issue.id, { identifier: id, outcome: 'setup_failed', at: new Date().toISOString() });
    return;
  }
  log(`Workspace ready at ${WT} on ${branch} (${config.repos.map((r) => r.key).join(', ')})`);
  prepareWorktreeDeps(WT);

  // Build the fixer prompt.
  const repoLayout = config.repos.map((r) => `- ${r.mount === '.' ? '(workspace root)' : r.mount + '/'} — ${r.key}: ${r.description}`).join('\n');
  const sessionContext = computeSessionContext([issue.description, ...(issue.comments?.nodes || []).map((c) => c.body)].filter(Boolean).join('\n'));
  log(`Session context: ${sessionContext.startsWith('(no session') ? 'none referenced' : 'attached'}`);
  const prompt = fillTemplate(readFileSync(path.join(__dirname, 'prompt.md'), 'utf8'), {
    IDENTIFIER: id, TITLE: issue.title, DESCRIPTION: issue.description || '(no description)',
    COMMENTS: commentsText, URL: issue.url, BRANCH: branch, REPO_LAYOUT: repoLayout, SESSION_CONTEXT: sessionContext,
  });

  // Run claude -p at the workspace root, on your subscription. The fixer only COMMITS; the PR is
  // opened later by this orchestrator, after the review + browser-verify gates.
  log(`Running claude (model=${model}) — this can take up to ${Math.round(config.timeoutMs / 60000)} min...`);
  const result = await runClaude(claudeArgs({ model, maxTurns: config.maxTurns }), prompt, WT, config.timeoutMs, 'fixer');
  let marker = parseMarker(result);
  let changed = detectChangedRepos(WT);

  // Escalate a "heavy" bug (default model finished with no committed change) to Opus, continuing in
  // the SAME workspace to finish. NOTE: dormant while defaultModel === opusModel; it re-activates
  // automatically if defaultModel is set back to a smaller model.
  if (changed.length === 0 && config.escalateToOpus && model !== config.opusModel) {
    log(`No committed change from ${model} — escalating to ${config.opusModel} on the same workspace...`);
    const escalationNote = '\n\n## Escalation pass\nA previous automated attempt with a smaller model may have left UNCOMMITTED changes in this workspace without finishing. Review any existing changes, complete or correct the fix, then COMMIT per the steps above (do NOT push or open a PR — a later stage does that). The work only counts once it is committed. Do not restart from scratch unless the existing changes are wrong.';
    const r2 = await runClaude(claudeArgs({ model: config.opusModel, maxTurns: config.maxTurns }), prompt + escalationNote, WT, config.timeoutMs, 'fixer-escalation');
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
      pushChanged(changed); // durability: re-fix/rework commits shouldn't be stranded by a crash in verify
    }
  }

  if (changed.length > 0) {
    // --- Deterministic checks by the orchestrator (never trust agent-reported "pass" alone) ---
    let checks = runChecks(WT, changed);

    // --- Final test: bring up a full preview and drive a real browser on the reviewed code ---
    let verify = null;
    if (config.verify?.enabled) {
      try { verify = await runVerify(issue, WT); } catch (e) { log('Verify error:', e.message); }
    }

    // A not_fixed verdict gets ONE bounded re-fix (fed the verify failure report) + re-verify.
    if (verify?.verdict === 'not_fixed' && config.verify?.retryNotFixed) {
      log('Browser verify says not_fixed — running one re-fix + re-verify...');
      const before = countCommits(changed);
      const feedback = `1. [browser-verify/high] (root cause) — Automated browser verification reproduced the bug's scenario against the CURRENT code and it is STILL BROKEN. Scenario: ${verify.scenario || '(from the bug report)'}. Observed: ${verify.summary || '(no detail)'} → Re-investigate the root cause and fix it so this exact scenario passes.`;
      const rp = fillTemplate(readFileSync(refixPromptPath, 'utf8'), {
        IDENTIFIER: id, TITLE: issue.title, DESCRIPTION: issue.description || '(no description)', BRANCH: branch, CONFIRMED: feedback,
      });
      await runClaude(claudeArgs({ model: config.review?.refixModel || config.opusModel, maxTurns: config.review?.maxTurns || 60 }), rp, WT, config.review?.timeoutMs || 20 * 60 * 1000, 'verify-refix');
      changed = detectChangedRepos(WT);
      if (countCommits(changed) > before) {
        pushChanged(changed);
        checks = runChecks(WT, changed);
        try { const v2 = await runVerify(issue, WT); if (v2) verify = { ...v2, attempt: 2 }; }
        catch (e) { log('Re-verify error:', e.message); }
      } else {
        log('Re-fix made no new commit — keeping the not_fixed verdict.');
      }
    }

    // --- Triage: the one signal that tells a human what to do with this bug ---
    // green  → skim & merge; manual → run the manual steps first; rework → human takes over.
    const triage = computeTriage({ review, verify, checks, reviewEnabled: !!config.review?.enabled });
    log(`Triage: ${triage}`);

    // --- Open the draft PR(s), now that the code is reviewed + verified ---
    const prTitle = `${triage === 'rework' ? '[needs human] ' : ''}${marker.prTitle || marker.summary || issue.title || 'Automated fix'} (${id})`;
    const checksAllPass = checks.length > 0 && checks.every((c) => c.result === 'pass');
    const gateSummary = [
      review ? `Code review: ${review.manager?.verdict === 'needs_rework' ? '⚠️ needs rework' : '✅ sound'}${review.manager?.confirmed?.length ? ` — ${review.manager.confirmed.length} finding(s) fixed` : ''}` : null,
      checks.length ? `Deterministic checks: ${checksAllPass ? '✅ all passed' : '❌ FAILED — ' + checks.filter((c) => c.result !== 'pass').map((c) => c.cmd).join('; ')}` : null,
      verify ? `Browser verify: ${verify.verdict === 'verified' ? '✅ verified' : verify.verdict === 'not_fixed' ? '❌ not fixed' : verify.verdict === 'env_down' ? '⚠️ environment down (not verified)' : '❓ inconclusive'}` : null,
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

    // Embed the verify run's real visual evidence in the Linear report: the session RECORDING
    // (primary) plus screenshots (fabricated paths are dropped).
    if (verify) {
      try {
        const media = await uploadVerifyMedia(verify);
        verify.screenshotUrls = media.shots;
        verify.videoUrls = media.videos;
      } catch (e) { log('Verify media upload error:', e.message); }
    }

    // --- Label + comments back on Linear: fix -> verification (tests + review) -> manual guide ---
    try { await setAutofixLabel(issue, config.triageLabels?.[triage]); } catch (e) { log('Warn: could not set triage label:', e.message); }
    await addComment(issue.id, fixCommentBody(prs, marker, { triage }));
    const verification = [testReportBody(marker, verify, checks), reviewReportBody(review)].filter(Boolean).join('\n\n---\n\n');
    await addComment(issue.id, verification);
    await addComment(issue.id, manualTestBody(marker, manualOpts));

    if (verify) {
      for (const p of prs) if (p.url) spawnSync('gh', ['pr', 'comment', p.url, '--body', verifyBody(verify)], { encoding: 'utf8' });
    }

    if (triage === 'green') {
      try {
        const sid = await findStateId(issue.team.id, config.reviewState, null);
        if (sid) { await moveIssue(issue.id, sid); log(`Moved ${id} -> ${config.reviewState}`); }
      } catch (e) { log('Warn: could not move to review state:', e.message); }
    } else {
      log(`Triage "${triage}" — leaving ${id} In Progress (label set) for a human.`);
    }
    if (config.cleanupWorktreeOnSuccess) teardown(WT);
    updateState(issue.id, {
      identifier: id, branch, triage,
      outcome: triage === 'green' ? 'fixed' : triage === 'rework' ? 'fixed_needs_human' : 'fixed_needs_manual_test',
      summary: marker.summary || '', prs, review: review || null, verify: verify || null, checks, stages,
      at: new Date().toISOString(),
    });
  } else {
    const revertedByReview = review && marker.status === 'fixed';
    const body = marker.status === 'cannot_fix'
      ? `⚠️ **Automated fix could not complete — needs a human**\n\n${marker.summary || ''}\n\n${marker.investigation ? '**Investigation:**\n' + marker.investigation : ''}`
      : revertedByReview
        ? `⚠️ **Automated fix produced no net change** (the review pass reverted it). Workspace kept at \`${WT}\` for inspection.`
        : `⚠️ **Automated fix run produced no changes.** Workspace kept at \`${WT}\` for inspection.`;
    await addComment(issue.id, body);
    try { await setAutofixLabel(issue, config.triageLabels?.cannotFix); } catch (e) { log('Warn: could not set triage label:', e.message); }
    log(`No PR. Workspace kept at ${WT}.`);
    updateState(issue.id, { identifier: id, branch, outcome: marker.status === 'cannot_fix' ? 'cannot_fix' : 'no_change', stages, at: new Date().toISOString() });
  }
}

export function runClaude(args, prompt, cwd, timeoutMs = config.timeoutMs, stage = null) {
  return new Promise((resolve) => {
    // detached => own process group, so a timeout kill takes claude AND everything it spawned
    // (dev servers, workers, test runners). A plain child.kill orphaned a 3.7GB backend worker
    // for 6 hours on ENG-124 and helped OOM the box.
    const child = spawn('claude', args, { cwd, env: process.env, detached: true });
    let out = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    }, timeoutMs);
    // A spawn failure (e.g. `claude` not on PATH under cron) emits 'error' and would otherwise
    // CRASH the whole run as an unhandled event — resolve with empty output instead.
    child.on('error', (e) => { clearTimeout(timer); log(`claude spawn failed${stage ? ` (stage ${stage})` : ''}: ${e.message}`); resolve({ out, timedOut, spawnError: e.message }); });
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => process.stderr.write(d));
    child.stdin.on('error', () => { /* EPIPE when the child never started */ });
    child.on('close', () => {
      clearTimeout(timer);
      if (stage) {
        if (timedOut) log(`Stage ${stage} hit its ${Math.round(timeoutMs / 60000)}min timeout (SIGKILL) — continuing with partial output.`);
        try {
          if (stageLogDir) writeFileSync(path.join(stageLogDir, `${stage}.txt`), out);
          let meta = {};
          try { const j = JSON.parse(out); meta = { turns: j.num_turns, ms: j.duration_ms, sessionId: j.session_id }; } catch { /* not the CLI JSON envelope */ }
          stages[stage] = { timedOut, ...meta };
        } catch { /* stage logging is best-effort */ }
      }
      resolve({ out, timedOut });
    });
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
export function detectChangedRepos(WT) {
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
export function pushChanged(changed) {
  const failed = [];
  for (const c of changed) {
    const push = gitIn(c.wt, ['push', '-u', 'origin', 'HEAD']);
    if (push.status !== 0) { log(`Push failed for ${c.repo}: ${push.stderr}`); failed.push(c.repo); }
  }
  return failed;
}

// Total commits on the branch across all changed repos — used to detect whether a re-fix pass
// actually committed anything new.
export function countCommits(changed) {
  return changed.reduce((n, c) => {
    const r = gitIn(c.wt, ['rev-list', '--count', `origin/${c.base}..HEAD`]);
    return n + (r.status === 0 ? parseInt((r.stdout || '0').trim(), 10) || 0 : 0);
  }, 0);
}

// All changed files across repos, workspace-relative (nested repos get their mount prefix).
function changedFiles(changed) {
  const files = [];
  for (const c of changed) {
    const mount = (config.repos.find((r) => r.key === c.repo) || {}).mount;
    const names = (gitIn(c.wt, ['diff', '--name-only', `origin/${c.base}...HEAD`]).stdout || '').split('\n').filter(Boolean);
    for (const f of names) files.push(mount && mount !== '.' ? `${mount}/${f}` : f);
  }
  return files;
}

// ---- Deterministic post-fix checks (run by the orchestrator, never trusted from agent output) ----
// Typecheck every changed package; run backend's jest related-tests for the changed files.
// A failure forces triage to `rework`. Full command output lands in the stage log dir.
function checkResult(cmd, r) {
  const pass = r.status === 0 && !r.error;
  return { cmd, result: pass ? 'pass' : 'fail', detail: pass ? '' : (((r.stdout || '') + (r.stderr || '')).slice(-4000) || String(r.error || r.signal || 'failed')) };
}

export function runChecks(WT, changed) {
  if (config.checks?.enabled === false || !changed.length) return [];
  const byPkg = {};
  for (const f of changedFiles(changed)) {
    const pkg = PKG_DIRS.find((d) => f.startsWith(d + '/'));
    if (pkg) (byPkg[pkg] ??= []).push(f.slice(pkg.length + 1));
  }
  const results = [];
  // The backend is too big for node's default ~2GB heap under tsc (proven OOM on ENG-129);
  // match the repo's own dev tooling headroom.
  const env = { ...process.env, NODE_OPTIONS: '--max-old-space-size=4096' };
  // Invoke the package's own binaries DIRECTLY (not through npx): spawnSync's timeout only
  // kills the process it spawned, and killing the npx wrapper orphaned a 4GB tsc grandchild
  // for hours on the runner. With the direct binary, the timeout hits the real process.
  const bin = (dir, name) => {
    const p = path.join(dir, 'node_modules', '.bin', name);
    return existsSync(p) ? { cmd: p, args: [] } : { cmd: 'npx', args: [name] };
  };
  for (const [pkg, files] of Object.entries(byPkg)) {
    const dir = path.join(WT, pkg);
    if (existsSync(path.join(dir, 'tsconfig.json'))) {
      log(`Deterministic check: tsc --noEmit (${pkg})...`);
      const tsc = bin(dir, 'tsc');
      const r = spawnSync(tsc.cmd, [...tsc.args, '--noEmit'], { cwd: dir, env, encoding: 'utf8', timeout: config.checks?.tscTimeoutMs || 300000 });
      results.push(checkResult(`npx tsc --noEmit (${pkg})`, r));
    }
    if (pkg === 'backend') {
      // Run exactly the test files the diff touched/added — the fixer wrote them, so running
      // them deterministically catches fabricated "pass" claims. NOT --findRelatedTests: on a
      // hub file like agentModeService.ts it drags in half the suite, minutes of runtime, and
      // pre-existing failures unrelated to this fix (proven on ENG-129).
      const testFiles = files.filter((f) => /(__tests__\/|\.test\.|\.spec\.)/.test(f) && /\.(ts|tsx|js)$/.test(f) && existsSync(path.join(dir, f)));
      if (testFiles.length) {
        log(`Deterministic check: jest on ${testFiles.length} changed test file(s) (backend)...`);
        const jest = bin(dir, 'jest');
        const r = spawnSync(jest.cmd, [...jest.args, ...testFiles, '--silent'], { cwd: dir, env, encoding: 'utf8', timeout: config.checks?.jestTimeoutMs || 600000 });
        results.push(checkResult(`npx jest ${testFiles.join(' ')} (backend)`, r));
      }
    }
  }
  for (const c of results) log(`Check ${c.result === 'pass' ? 'PASS' : 'FAIL'}: ${c.cmd}`);
  try { if (stageLogDir) writeFileSync(path.join(stageLogDir, 'checks.json'), JSON.stringify(results, null, 2)); } catch { /* best-effort */ }
  return results.map(({ detail, ...rest }) => rest); // keep Linear comments and state.json lean
}

// One triage bucket per fixed bug (drives the label, the Linear state, and the comment header):
//   rework — a gate says the fix is wrong (manager needs_rework, browser not_fixed, failed check)
//   green  — every enabled gate is green AND the fix was verified in a REAL browser
//   manual — everything else (verify inconclusive / env_down / api-only / review errored)
export function computeTriage({ review, verify, checks, reviewEnabled }) {
  const checksFailed = (checks || []).some((c) => c.result === 'fail');
  const managerVerdict = review?.manager?.verdict;
  if (managerVerdict === 'needs_rework' || verify?.verdict === 'not_fixed' || checksFailed) return 'rework';
  const reviewGreen = reviewEnabled ? managerVerdict === 'sound' : true;
  const verifyGreen = verify?.verdict === 'verified' && verify?.method === 'browser';
  return reviewGreen && verifyGreen ? 'green' : 'manual';
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

// Lenses that cannot apply to this diff are skipped (saves runs): security needs code changes;
// tests only applies when backend logic or test files changed (frontend UI is TDD-exempt per CLAUDE.md).
function selectLenses(all, changed) {
  if (config.review?.autoScaleLenses === false) return all;
  const files = changedFiles(changed);
  const nonCode = /\.(md|css|scss|less|svg|png|jpe?g|gif|webp|txt)$/i;
  const hasCode = files.some((f) => !nonCode.test(f));
  const backendTouched = files.some((f) => f.startsWith('backend/'));
  const testsTouched = files.some((f) => /(__tests__\/|\.test\.|\.spec\.)/.test(f));
  return all.filter((lens) => {
    if (lens === 'security' && !hasCode) return false;
    if (lens === 'tests' && !backendTouched && !testsTouched) return false;
    return true;
  });
}

async function runReview(issue, WT, changed, branch, sessionContext = '') {
  const id = issue.identifier;
  const diff = repoDiff(WT, changed);
  const allLenses = [...new Set(config.review.lenses || [])].filter((l) => LENS_FOCUS[l]);
  const lenses = selectLenses(allLenses, changed);
  const skipped = allLenses.filter((l) => !lenses.includes(l));
  if (skipped.length) log(`Lenses skipped for this diff: ${skipped.join(', ')}`);
  if (!lenses.length || !diff) { log('Review skipped (no lenses or empty diff).'); return null; }
  const issueMap = { IDENTIFIER: id, TITLE: issue.title, DESCRIPTION: issue.description || '(no description)', SESSION_CONTEXT: sessionContext || '(none)' };
  const reviewArgs = () => claudeArgs({ model: config.review.model, maxTurns: config.review.maxTurns, skipPermissions: true });

  // 1. Expert reviewers, one per lens. Templated once with the (large) shared diff, then only the
  //    per-lens tokens differ. Parallel by default; config.review.parallel:false runs sequentially.
  const base = fillTemplate(readFileSync(reviewPromptPath, 'utf8'), {
    ...issueMap, REPOS: changed.map((c) => `- ${c.repo}`).join('\n'), DIFF: diff,
  });
  const runLens = (lens) =>
    runClaude(reviewArgs(), fillTemplate(base, { LENS: lens, LENS_FOCUS: LENS_FOCUS[lens] }), WT, config.review.timeoutMs, `review-${lens}`)
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
  const findingsBlock = allFindings.length
    ? allFindings
        .map((f, i) => `${i + 1}. [${f.lens}/${f.severity || 'n/a'}] ${f.file || '?'}${f.line ? ':' + f.line : ''} — ${f.issue || ''} (suggested: ${f.suggestedFix || 'n/a'})`)
        .join('\n')
    : '(no reviewer findings were filed)';
  if (allFindings.length) {
    const mp = fillTemplate(readFileSync(managerPromptPath, 'utf8'), { ...issueMap, DIFF: diff, FINDINGS: findingsBlock });
    log(`Running manager verification (model=${config.review.managerModel})...`);
    const mres = await runClaude(claudeArgs({ model: config.review.managerModel, maxTurns: config.review.maxTurns, skipPermissions: true }), mp, WT, config.review.timeoutMs, 'manager');
    manager = parseManager(mres);
    // A killed manager must never approve: parseManager defaults to 'sound' when no marker
    // was emitted, which a timeout SIGKILL guarantees. Be conservative instead.
    if (mres.timedOut) manager = { ...manager, verdict: 'needs_rework', assessment: manager.assessment || 'Manager verification timed out before reaching a verdict — treat the fix as unapproved.' };
  }
  log(`Manager verdict: ${manager.verdict}; confirmed ${manager.confirmed.length}, rejected ${manager.rejectedCount}.`);

  // 3. Re-fix pass: apply the confirmed findings; on a needs_rework verdict, also rework the fix
  //    itself (the manager's assessment becomes a finding) and have the manager re-check ONCE.
  let refix = null;
  const needsRework = manager.verdict === 'needs_rework';
  const refixModel = config.review.refixModel || config.review.model;
  if (manager.confirmed.length || needsRework) {
    const items = manager.confirmed
      .map((f, i) => `${i + 1}. [${f.lens || '?'}/${f.severity || 'n/a'}] ${f.file || '?'} — ${f.issue || ''} → ${f.fix || ''}`);
    if (needsRework) {
      items.push(`${items.length + 1}. [manager/high] (the fix as a whole) — The review manager judged the current fix UNSOUND: ${manager.assessment || 'it does not correctly address the root cause.'} → Rework the fix so it actually resolves the bug's root cause; keep it minimal.`);
    }
    const rp = fillTemplate(readFileSync(refixPromptPath, 'utf8'), { ...issueMap, BRANCH: branch, CONFIRMED: items.join('\n') });
    log(`${needsRework ? 'Reworking the fix' : 'Re-fixing'} — ${items.length} item(s) (model=${refixModel})...`);
    refix = parseRefix(await runClaude(claudeArgs({ model: refixModel, maxTurns: config.review.maxTurns, skipPermissions: true }), rp, WT, config.review.timeoutMs, 'refix'));
    log(`Re-fix status: ${refix.status}`);

    if (needsRework && config.review.recheckAfterRework !== false) {
      const diff2 = repoDiff(WT, detectChangedRepos(WT));
      const recheckNote = 'NOTE: These findings were filed against an EARLIER revision of this branch; a rework pass has since been applied (the diff above is CURRENT). This is the FINAL gate — return "sound" only if no must-fix defect remains in the current code; otherwise return "needs_rework". Do not assume any further fix pass will run.\n\n';
      const mp2 = fillTemplate(readFileSync(managerPromptPath, 'utf8'), { ...issueMap, DIFF: diff2, FINDINGS: recheckNote + findingsBlock });
      log('Manager re-check after rework...');
      const m2res = await runClaude(claudeArgs({ model: config.review.managerModel, maxTurns: config.review.maxTurns, skipPermissions: true }), mp2, WT, config.review.timeoutMs, 'manager-recheck');
      const m2 = parseManager(m2res);
      // Same conservatism as above: a re-check killed by its timeout cannot clear the fix.
      if (m2res.timedOut) { m2.verdict = 'needs_rework'; m2.assessment = m2.assessment || 'Manager re-check timed out — the rework remains unapproved.'; }
      log(`Manager re-check verdict: ${m2.verdict}.`);
      // Keep the ORIGINAL confirmed list (those were applied); the re-check contributes the
      // final verdict + assessment. initialVerdict records that a rework round happened.
      manager = { verdict: m2.verdict, assessment: m2.assessment, rejectedCount: manager.rejectedCount, confirmed: manager.confirmed, initialVerdict: 'needs_rework' };
    }
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

async function httpUp(url) {
  try { const r = await fetch(url, { signal: AbortSignal.timeout(8000) }); return r.status < 500; }
  catch { return false; }
}
// Deterministic preflight through the proxy URLs the verify agent will actually use — a 502
// (no route / dead upstream) or connection error means the environment is down.
async function previewHealthy(urls) {
  if (!urls.customer || !urls.api) return false;
  return (await httpUp(urls.customer)) && (await httpUp(urls.api));
}

async function runVerify(issue, WT) {
  const id = issue.identifier;
  await ensureProxy();
  log('Bringing up full preview for browser verification...');
  const bringUp = () => spawnSync('node', [previewScript, 'up', id, WT], { stdio: 'inherit', env: process.env });
  const tearDown = () => spawnSync('node', [previewScript, 'down', id], { stdio: 'inherit', env: process.env });
  const readUrls = () => { try { return (JSON.parse(readFileSync(previewStatePath, 'utf8'))[id.toLowerCase()] || {}).urls || {}; } catch { return {}; } };

  bringUp();
  let urls = readUrls();

  // Preflight: never burn a long agent run against a dead environment. One rebuild retry (also
  // self-heals transient port collisions between concurrent bugs), then give up with `env_down`.
  if (!(await previewHealthy(urls))) {
    log('Preview not healthy — retrying bring-up once...');
    tearDown();
    bringUp();
    urls = readUrls();
    if (!(await previewHealthy(urls))) {
      log('Preview environment failed to become healthy — skipping the browser-verify agent (env_down).');
      tearDown(); // don't leave dead processes registered in routes/preview-state
      return {
        verdict: 'env_down', method: '', scenario: '',
        summary: `The per-bug preview environment failed to start (see .linear-autofix/preview/logs/${id.toLowerCase()}-*.log), so automated browser verification was skipped.`,
        screenshots: [], urls,
      };
    }
  }

  // Keep the preview running (URL stays live) only when the worktree is also kept; otherwise the
  // worktree is about to be removed and the running servers would break. Tear it down in `finally`
  // so a throw after `up` (missing prompt, parse error) can't leak the running servers.
  const keepUp = config.keepPreviewUp && !config.cleanupWorktreeOnSuccess;
  try {
    const prompt = fillTemplate(readFileSync(verifyPromptPath, 'utf8'), {
      IDENTIFIER: id, TITLE: issue.title, DESCRIPTION: issue.description || '(no description)',
      CUSTOMER_URL: urls.customer || '(n/a)', PARTNER_URL: urls.partner || '(n/a)', API_URL: urls.api || '(n/a)',
      TEST_EMAIL: config.verify.testEmail, TEST_PASSWORD: config.verify.testPassword,
    });
    // The MCP config is generated per run so the --config path is absolute on any machine;
    // verify-pw-config.json (checked in) turns on session video recording via contextOptions.
    writeFileSync(verifyMcpGenPath, JSON.stringify({
      mcpServers: {
        playwright: {
          type: 'stdio', command: 'npx',
          args: ['-y', '@playwright/mcp@latest', '--config', verifyPwConfigPath, '--output-dir', SCREENSHOT_DIR],
        },
      },
    }, null, 2));
    const args = claudeArgs({ model: config.verify.model, maxTurns: config.verify.maxTurns, mcp: verifyMcpGenPath, skipPermissions: true });
    log(`Running browser verification (model=${config.verify.model})...`);
    const startedAt = Date.now(); // session recordings written after this belong to this verify
    const verdict = parseVerify(await runClaude(args, prompt, WT, config.verify.timeoutMs, 'verify'));
    verdict.urls = urls; // let the caller reuse these without re-reading preview-state
    verdict.mediaSince = startedAt;
    log(`Verify verdict: ${verdict.verdict}`);
    return verdict;
  } finally {
    if (keepUp) log(`Preview kept running for ${id}${urls.customer ? ` — ${urls.customer}` : ''} (gc stops it when the issue is Done)`);
    else tearDown();
  }
}

async function verifyOnlyRun(issue) {
  if (process.env.AUTOFIX_RUN_ENABLED !== '1') {
    console.error('[autofix] refusing to run: AUTOFIX_RUN_ENABLED != 1 (fixes are EC2-only)');
    process.exit(2);
  }
  const id = issue.identifier;
  const entry = loadState()[issue.id];
  if (!entry || !String(entry.outcome || '').startsWith('fixed')) { log(`${id}: no completed fix on record — nothing to re-verify.`); return; }
  const WT = path.resolve(agentRoot, config.worktreesDir, id);
  const branch = entry.branch || `${config.branchPrefix}${id.toLowerCase()}-${kebab(issue.title)}`;
  if (!existsSync(WT)) {
    log('Workspace missing — rebuilding from the pushed branch...');
    const asm = assembleFromBranch(WT, branch);
    if (!asm.ok) { log(`Failed to rebuild ${asm.repo}: ${asm.err}`); return; }
  }
  prepareWorktreeDeps(WT);
  setStageLogDir(id);

  const changed = detectChangedRepos(WT);
  const checks = runChecks(WT, changed);
  let verify = null;
  if (config.verify?.enabled) {
    try { verify = await runVerify(issue, WT); } catch (e) { log('Verify error:', e.message); }
  }
  if (verify) {
    try {
      const media = await uploadVerifyMedia(verify);
      verify.screenshotUrls = media.shots;
      verify.videoUrls = media.videos;
    } catch (e) { log('Verify media upload error:', e.message); }
  }

  const triage = computeTriage({ review: entry.review, verify, checks, reviewEnabled: !!config.review?.enabled });
  log(`Re-verify: checks ${checks.every((c) => c.result === 'pass') ? 'pass' : 'FAIL'}, verdict ${verify?.verdict || 'none'} — triage now: ${triage}`);
  try { await setAutofixLabel(issue, config.triageLabels?.[triage]); } catch (e) { log('Warn: could not set triage label:', e.message); }
  const head = triage === 'green' ? '🟢 green — skim the PR and merge' : triage === 'manual' ? '🟡 needs manual test' : '🔴 needs rework';
  await addComment(issue.id, `🔁 **Deterministic gates re-run** (checks + browser verification on the existing fix)\n\n${testReportBody({ tests: [] }, verify, checks)}\n\n**Triage now: ${head}.**`);
  if (triage === 'green') {
    try {
      const sid = await findStateId(issue.team.id, config.reviewState, null);
      if (sid) { await moveIssue(issue.id, sid); log(`Moved ${id} -> ${config.reviewState}`); }
    } catch (e) { log('Warn: could not move state:', e.message); }
  }
  updateState(issue.id, {
    ...entry, triage, checks, verify: verify || entry.verify || null, stages: { ...(entry.stages || {}), ...stages },
    outcome: triage === 'green' ? 'fixed' : triage === 'rework' ? 'fixed_needs_human' : 'fixed_needs_manual_test',
    at: new Date().toISOString(),
  });
}

function parseVerify(result) {
  return extractJson(result, 'VERIFY_RESULT', { verdict: 'inconclusive', method: '', scenario: '', summary: '(no verdict returned)', screenshots: [] });
}

// Upload the verify run's visual evidence to Linear's file storage for inline embedding.
// Screenshots: resolve the agent-reported paths to files that ACTUALLY exist (on ENG-129 the
// agent reported a path it never wrote) and drop fabrications. Videos: --save-video in
// verify-mcp.json records the whole browser session; the .webm lands in the output dir when
// the agent closes the browser, so pick up recordings written during THIS verify window.
const SCREENSHOT_DIR = '/tmp/playwright-screenshots'; // must match verify-mcp.json --output-dir
const MAX_UPLOAD_BYTES = 45 * 1024 * 1024; // stay under Linear's upload limit

async function uploadVerifyMedia(verify) {
  const shots = [];
  for (const p of (verify.screenshots || []).slice(0, 4)) {
    const tries = p ? [p, path.join(SCREENSHOT_DIR, path.basename(p))] : [];
    const real = tries.find((t) => { try { return statSync(t).isFile(); } catch { return false; } });
    if (!real) { log(`Verify screenshot not found on disk (agent reported "${p}") — dropping it.`); continue; }
    try { shots.push({ name: path.basename(real), url: await uploadFile(real) }); log(`Screenshot uploaded to Linear: ${path.basename(real)}`); }
    catch (e) { log(`Screenshot upload failed for ${real}: ${e.message}`); }
  }

  const videos = [];
  try {
    const since = verify.mediaSince || 0;
    const webms = readdirSync(SCREENSHOT_DIR)
      .filter((f) => f.endsWith('.webm'))
      .map((f) => ({ f, full: path.join(SCREENSHOT_DIR, f), st: statSync(path.join(SCREENSHOT_DIR, f)) }))
      .filter((x) => x.st.mtimeMs >= since)
      .sort((a, b) => b.st.mtimeMs - a.st.mtimeMs)
      .slice(0, 2); // a session normally yields one video per page
    for (const v of webms) {
      // Raw session recordings are mostly loading spinners and think-time between agent
      // actions (a real 5m19s verify had ~90 visual changes) — condense to just the frames
      // where the page actually changed, so a reviewer watches ~1 min of pure activity.
      const c = condenseVideo(v.full);
      const up = c || { path: v.full, name: v.f };
      if (statSync(up.path).size > MAX_UPLOAD_BYTES) { log(`Recording ${up.name} is too big to upload, skipping.`); continue; }
      try { videos.push({ name: up.name, url: await uploadFile(up.path) }); log(`Session recording uploaded to Linear: ${up.name}${c ? ' (condensed)' : ' (raw — ffmpeg unavailable)'}`); }
      catch (e) { log(`Recording upload failed for ${up.name}: ${e.message}`); }
    }
  } catch { /* no output dir — nothing recorded */ }
  return { shots, videos };
}

// Condense a session recording to only the frames where the page visibly changed, played at
// 2fps (each kept moment shown 500ms). Thresholds tuned on a real verify recording:
// hi=2000/lo=800 turned 5m19s into 1m12s while keeping every UI transition readable.
// Returns null when ffmpeg is missing or fails — caller falls back to the raw webm.
function ffmpegBin() {
  for (const p of [path.join(process.env.HOME || '', 'bin', 'ffmpeg'), '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg']) {
    if (existsSync(p)) return p;
  }
  return null;
}
function condenseVideo(full) {
  const ff = ffmpegBin();
  if (!ff) return null;
  const out = full.replace(/\.webm$/, '-condensed.mp4');
  const r = spawnSync(ff, [
    '-y', '-i', full,
    '-vf', 'mpdecimate=hi=2000:lo=800:frac=0.33,setpts=N/(2*TB)',
    '-fps_mode', 'vfr', '-an', '-pix_fmt', 'yuv420p', out,
  ], { encoding: 'utf8', timeout: 5 * 60 * 1000 });
  if (r.status !== 0 || !existsSync(out) || statSync(out).size < 1024) { log('Video condense failed — using the raw recording.'); return null; }
  return { path: out, name: path.basename(out) };
}

// ---- Linear comment bodies (pure functions; unit-tested from the scratchpad harness) ----

// The merge-confidence verdict leads the comment so triage is a one-glance decision.
const TRIAGE_HEADERS = {
  green: {
    head: '🟢 **Automated fix — HIGH confidence** (code review sound + verified in a real browser + checks pass)',
    note: 'Skim the PR and merge — no manual testing needed.',
  },
  manual: {
    head: '🟡 **Automated fix — needs your manual test** (automated browser verification could not confirm the fix)',
    note: 'Run the manual steps in the comment below before merging. The issue stays In Progress.',
  },
  rework: {
    head: '🔴 **Automated fix — needs human rework** (an automated gate failed)',
    note: 'The draft PR is open for reference; see the test report / code review below. The issue stays In Progress.',
  },
};

export function fixCommentBody(prs, marker, opts = {}) {
  const links = (prs || []).length
    ? prs.map((p) => {
        const loc = p.url ? p.url
          : p.pushed ? '(branch pushed; open the PR manually)'
          : '⚠️ (push FAILED — nothing reached the remote)';
        return `- \`${p.repo}\`: ${loc}`;
      }).join('\n')
    : '- (no PR opened)';
  const t = TRIAGE_HEADERS[opts.triage] || { head: '🤖 **Automated fix — draft PR opened**', note: '' };
  return `${t.head}\n\n${t.note ? '> ' + t.note + '\n\n' : ''}${links}\n\n${marker.summary || ''}\n\n_Generated by the Linear auto-fix agent — please review._`;
}

const checkIcon = (r) => (r === 'pass' ? '✅' : r === 'fail' ? '❌' : '▫️');

export function testReportBody(marker, verify, checks) {
  const tests = Array.isArray(marker.tests) ? marker.tests : [];
  const agentChecks = tests.length
    ? tests.map((t) => `${checkIcon(t.result)} \`${t.cmd}\``).join('\n')
    : '_(no automated checks reported)_';
  const orchChecks = (checks || []).length
    ? checks.map((c) => `${checkIcon(c.result)} \`${c.cmd}\``).join('\n')
    : '_(none ran)_';
  let browser;
  if (!verify) browser = '_skipped_';
  else if (verify.verdict === 'env_down') {
    browser = `⚠️ preview environment failed to start — browser verification skipped. ${verify.summary || ''}`;
  } else {
    // Only claim "browser" when the verify pass actually drove a browser; "api" = logic-layer fallback.
    const via = verify.method === 'api' ? ' (via API/logic — not a browser repro)'
      : verify.method === 'browser' ? ' (browser)' : '';
    const attempt = verify.attempt === 2 ? ' — 2nd attempt, after an automated re-fix' : '';
    const icon = verify.verdict === 'verified' ? `✅ verified${via}${attempt}`
      : verify.verdict === 'not_fixed' ? `❌ NOT fixed${via}${attempt}`
      : `❓ inconclusive${attempt}`;
    const scenario = verify.scenario ? `\nScenario: ${verify.scenario}` : '';
    // Embed the session recording (primary evidence) and screenshots inline; if the agent
    // reported screenshot paths but none existed on disk, say so honestly instead of
    // implying evidence that isn't there.
    const videos = verify.videoUrls || [];
    const recording = videos.length
      ? '\n' + videos.map((v) => `🎬 Session recording:\n![${v.name}](${v.url})`).join('\n')
      : '';
    const urls = verify.screenshotUrls || [];
    const shots = urls.length
      ? '\n' + urls.map((s) => `![${s.name}](${s.url})`).join('\n')
      : (verify.screenshots || []).length
        ? '\n_(the verify agent reported a screenshot, but no file was found on the runner)_'
        : '';
    browser = `${icon} — ${verify.summary || ''}${scenario}${recording}${shots}`;
  }
  return `🧪 **Automated test report**\n\n**Agent-run checks (self-reported)**\n${agentChecks}\n\n**Orchestrator checks (deterministic)**\n${orchChecks}\n\n**Browser verification**\n${browser}`;
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
  const rework = m.initialVerdict === 'needs_rework'
    ? `\n\nRework: the initial fix was judged ⚠️ unsound; an automated rework pass was applied and the manager re-checked it → ${m.verdict === 'sound' ? '✅ sound' : '⚠️ still needs rework'}.`
    : '';
  const assess = m.assessment ? `\n\n_${m.assessment}_` : '';
  return `🔎 **Code review — ${lenses.length} expert lens${lenses.length === 1 ? '' : 'es'} + manager verification**\n\nManager verdict: ${verdictIcon}${rejected}\n\n${fixedBlock}${cleanLine}${rework}${assess}`;
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
  // Linear asset URLs need workspace auth, so the PR gets links (not embeds) plus a pointer.
  const media = [...(v.videoUrls || []).map((m) => ({ ...m, kind: 'session recording' })), ...(v.screenshotUrls || []).map((m) => ({ ...m, kind: 'screenshot' }))];
  const shots = media.length
    ? `\n\nEvidence (embedded on the Linear issue; links need Linear access):\n${media.map((m) => `- ${m.kind}: [${m.name}](${m.url})`).join('\n')}`
    : (v.screenshots || []).length
      ? `\n\nScreenshots (local on the runner):\n${v.screenshots.map((s) => `- \`${s}\``).join('\n')}`
      : '';
  return `🔎 **Automated browser verification:** ${v.verdict}\n\n${v.summary || ''}${shots}`;
}

// Only run the pipeline when invoked directly (so the pure helpers above can be imported/tested).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error('[autofix] fatal:', e); process.exit(1); });
}
