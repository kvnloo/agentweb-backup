#!/usr/bin/env node
// .linear-autofix/autofix.mjs
// Fix a single Linear bug: assemble the FULL project (all repos, nested as in your local
// layout) into one worktree -> claude -p -> draft PR per changed repo -> comment back.
// Usage: node autofix.mjs <LIN-123 | issue-uuid> [--dry-run] [--force]

import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, symlinkSync, copyFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import path from 'node:path';
import { config } from './config.mjs';
import { resolveIssue, addComment, findStateId, moveIssue } from './linear.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const agentRoot = path.resolve(__dirname, '..'); // the agentweb (main) repo root
const statePath = path.join(__dirname, 'state.json');
const previewScript = path.join(__dirname, 'preview', 'preview.mjs');
const proxyScript = path.join(__dirname, 'preview', 'proxy.mjs');
const previewStatePath = path.join(__dirname, 'preview', 'preview-state.json');
const verifyPromptPath = path.join(__dirname, 'verify-prompt.md');
const verifyMcpPath = path.join(__dirname, 'verify-mcp.json');
const log = (...a) => console.log('[autofix]', ...a);

function loadState() { try { return JSON.parse(readFileSync(statePath, 'utf8')); } catch { return {}; } }
function saveState(s) { writeFileSync(statePath, JSON.stringify(s, null, 2)); }
function gitIn(cwd, args) { return spawnSync('git', args, { cwd, encoding: 'utf8' }); }
function repoRootOf(repo) { return path.resolve(agentRoot, repo.root); }
function wtPathOf(WT, repo) { return repo.mount === '.' ? WT : path.join(WT, repo.mount); }

function kebab(s, max = 40) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '') || 'bug';
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
  const tmpl = readFileSync(path.join(__dirname, 'prompt.md'), 'utf8');
  const comments = (issue.comments?.nodes || []).map((c) => `- ${c.user?.name || 'someone'}: ${c.body}`).join('\n') || '(none)';
  const repoLayout = config.repos.map((r) => `- ${r.mount === '.' ? '(workspace root)' : r.mount + '/'} — ${r.key}: ${r.description}`).join('\n');
  const prompt = tmpl
    .replaceAll('{{IDENTIFIER}}', id)
    .replaceAll('{{TITLE}}', issue.title || '')
    .replaceAll('{{DESCRIPTION}}', issue.description || '(no description)')
    .replaceAll('{{COMMENTS}}', comments)
    .replaceAll('{{URL}}', issue.url || '')
    .replaceAll('{{BRANCH}}', branch)
    .replaceAll('{{REPO_LAYOUT}}', repoLayout);

  // Run claude -p at the workspace root, on your subscription.
  const args = ['-p', '--output-format', 'json', '--model', model, '--max-turns', String(config.maxTurns)];
  if (config.skipPermissions) args.push('--dangerously-skip-permissions');
  else args.push('--permission-mode', 'acceptEdits');

  log(`Running claude (model=${model}) — this can take several minutes...`);
  const result = await runClaude(args, prompt, WT);
  const marker = parseMarker(result);

  // Authoritative: which repos actually got commits, and their PR URLs.
  const prs = [];
  for (const repo of config.repos) {
    const wt = wtPathOf(WT, repo);
    const cnt = gitIn(wt, ['rev-list', '--count', `origin/${repo.base}..HEAD`]);
    const changed = cnt.status === 0 && parseInt((cnt.stdout || '0').trim(), 10) > 0;
    if (changed) prs.push({ repo: repo.key, url: prFromWorktree(wt) });
  }
  log(`Changed repos: ${prs.map((p) => p.repo).join(', ') || 'none'}`);

  if (prs.length > 0) {
    // Browser verification: bring up a full preview and drive a real browser (runs before cleanup).
    let verify = null;
    if (config.verify?.enabled) {
      try { verify = await runVerify(issue, WT); } catch (e) { log('Verify error:', e.message); }
    }

    const links = prs.map((p) => `- \`${p.repo}\`: ${p.url || '(branch pushed; open the PR manually)'}`).join('\n');
    let liveUrl = '';
    if (config.keepPreviewUp && !config.cleanupWorktreeOnSuccess && verify) {
      try { liveUrl = ((JSON.parse(readFileSync(previewStatePath, 'utf8'))[id.toLowerCase()] || {}).urls || {}).customer || ''; } catch { /* no state */ }
    }
    const testHint = config.cleanupWorktreeOnSuccess ? ''
      : liveUrl
        ? `\n\n**Live preview** (kept running): ${liveUrl}\nStop it when done: \`node .linear-autofix/preview/preview.mjs down ${id}\``
        : `\n\n**Test it locally** (the fix's worktree is kept):\n\`\`\`bash\nnode .linear-autofix/preview/preview.mjs up ${id} ${WT}\n# open the printed nip.io URL, then when done:\nnode .linear-autofix/preview/preview.mjs down ${id}\n\`\`\``;
    await addComment(issue.id,
      `🤖 **Automated fix — draft PR opened**\n\n${links}\n\n${marker.summary || ''}${verifyLine(verify)}${testHint}\n\n_Generated by the Linear auto-fix agent — please review._`);
    if (verify) {
      for (const p of prs) if (p.url) spawnSync('gh', ['pr', 'comment', p.url, '--body', verifyBody(verify)], { encoding: 'utf8' });
    }
    try {
      const sid = await findStateId(issue.team.id, config.reviewState, null);
      if (sid) { await moveIssue(issue.id, sid); log(`Moved ${id} -> ${config.reviewState}`); }
    } catch (e) { log('Warn: could not move to review state:', e.message); }
    if (config.cleanupWorktreeOnSuccess) teardown(WT);
    state[issue.id] = { identifier: id, outcome: 'fixed', prs, verify: verify || null, at: new Date().toISOString() };
  } else {
    const body = marker.status === 'cannot_fix'
      ? `⚠️ **Automated fix could not complete — needs a human**\n\n${marker.summary || ''}\n\n${marker.investigation ? '**Investigation:**\n' + marker.investigation : ''}`
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

function parseMarker(result) {
  let text = result.out;
  try { const j = JSON.parse(result.out); if (j && typeof j.result === 'string') text = j.result; } catch { /* not JSON */ }
  const m = /AUTOFIX_RESULT:\s*(\{[\s\S]*?\})\s*$/.exec(text.trim()) || /AUTOFIX_RESULT:\s*(\{[\s\S]*?\})/.exec(text);
  if (m) { try { return JSON.parse(m[1]); } catch { /* unparseable */ } }
  return { status: 'unknown' };
}

function prFromWorktree(cwd) {
  const r = spawnSync('gh', ['pr', 'view', '--json', 'url', '-q', '.url'], { cwd, encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
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

  const prompt = readFileSync(verifyPromptPath, 'utf8')
    .replaceAll('{{IDENTIFIER}}', id)
    .replaceAll('{{TITLE}}', issue.title || '')
    .replaceAll('{{DESCRIPTION}}', issue.description || '(no description)')
    .replaceAll('{{CUSTOMER_URL}}', urls.customer || '(n/a)')
    .replaceAll('{{PARTNER_URL}}', urls.partner || '(n/a)')
    .replaceAll('{{API_URL}}', urls.api || '(n/a)')
    .replaceAll('{{TEST_EMAIL}}', config.verify.testEmail)
    .replaceAll('{{TEST_PASSWORD}}', config.verify.testPassword);

  const args = [
    '-p', '--output-format', 'json', '--model', config.verify.model,
    '--max-turns', String(config.verify.maxTurns),
    '--mcp-config', verifyMcpPath, '--strict-mcp-config', '--dangerously-skip-permissions',
  ];
  log(`Running browser verification (model=${config.verify.model})...`);
  const result = await runClaude(args, prompt, WT, config.verify.timeoutMs);
  const verdict = parseVerify(result);
  // Keep the preview running (URL stays live) only when the worktree is also kept; otherwise
  // the worktree is about to be removed and the running servers would break. gc.mjs stops
  // kept previews once the issue reaches Done/Canceled.
  if (config.keepPreviewUp && !config.cleanupWorktreeOnSuccess) {
    log(`Preview kept running for ${id}${urls.customer ? ` — ${urls.customer}` : ''} (gc stops it when the issue is Done)`);
  } else {
    spawnSync('node', [previewScript, 'down', id], { stdio: 'inherit', env: process.env });
  }
  log(`Verify verdict: ${verdict.verdict}`);
  return verdict;
}

function parseVerify(result) {
  let text = result.out;
  try { const j = JSON.parse(result.out); if (j && typeof j.result === 'string') text = j.result; } catch { /* not JSON */ }
  const m = /VERIFY_RESULT:\s*(\{[\s\S]*?\})\s*$/.exec(text.trim()) || /VERIFY_RESULT:\s*(\{[\s\S]*?\})/.exec(text);
  if (m) { try { return JSON.parse(m[1]); } catch { /* unparseable */ } }
  return { verdict: 'inconclusive', summary: '(no verdict returned)', screenshots: [] };
}

function verifyLine(v) {
  if (!v) return '';
  const icon = v.verdict === 'verified' ? '✅ verified in browser'
    : v.verdict === 'not_fixed' ? '❌ NOT fixed in browser'
    : '❓ inconclusive';
  return `\n\n**Browser verification:** ${icon} — ${v.summary || ''}`;
}

function verifyBody(v) {
  const shots = (v.screenshots || []).length
    ? `\n\nScreenshots (local on the runner):\n${v.screenshots.map((s) => `- \`${s}\``).join('\n')}` : '';
  return `🔎 **Automated browser verification:** ${v.verdict}\n\n${v.summary || ''}${shots}`;
}

main().catch((e) => { console.error('[autofix] fatal:', e); process.exit(1); });
