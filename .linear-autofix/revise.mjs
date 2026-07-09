#!/usr/bin/env node
// .linear-autofix/revise.mjs — apply human "revise: ..." Linear comments to a fixed bug's
// existing branch/PR. Normally invoked by poll.mjs; run by hand with: node revise.mjs LIN-123
//
// Flow: find unprocessed revise-comments -> reuse (or rebuild from the pushed branch) the bug's
// workspace -> claude applies the feedback and commits -> push to the open PR(s) -> re-run the
// deterministic checks -> comment the result back on Linear. The full review/browser gates are
// NOT re-run (the human is already in the loop at this point).

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { config } from './config.mjs';
import { resolveIssue, addComment, useAssigneeLinearKey } from './linear.mjs';
import { applyAssigneeIdentity } from './git-identity.mjs';
import {
  fillTemplate, extractJson, claudeArgs, runClaude, setStageLogDir, kebab,
  assembleFromBranch, prepareWorktreeDeps, detectChangedRepos, pushChanged, countCommits, runChecks,
} from './autofix.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const agentRoot = path.resolve(__dirname, '..');
const statePath = path.join(__dirname, 'state.json');
const log = (...a) => console.log('[revise]', ...a);
const loadState = () => { try { return JSON.parse(readFileSync(statePath, 'utf8')); } catch { return {}; } };

// Mark comments as handled even when the pass fails, so a broken request can't loop every cycle.
function markProcessed(issueId, comments, extra = {}) {
  const s = loadState();
  const e = s[issueId] || {};
  e.revisedComments = [...new Set([...(e.revisedComments || []), ...comments.map((c) => c.id)])];
  Object.assign(e, extra);
  s[issueId] = e;
  writeFileSync(statePath, JSON.stringify(s, null, 2));
}

async function main() {
  const ref = process.argv[2];
  if (!ref) { console.error('Usage: node revise.mjs <LIN-123|uuid>'); process.exit(2); }
  if (!process.env.LINEAR_API_KEY) { console.error('LINEAR_API_KEY is not set'); process.exit(2); }
  // Revisions modify code + push, so they run ONLY on the designated runner too.
  if (process.env.AUTOFIX_RUN_ENABLED !== '1') {
    console.error('[revise] refusing to run: AUTOFIX_RUN_ENABLED != 1 (fixes are EC2-only; set it in .linear-autofix/.env on the designated runner)');
    process.exit(2);
  }

  const issue = await resolveIssue(ref);
  const id = issue.identifier;
  // Attribute the revision's commits to the issue's assignee, same as the original fix.
  applyAssigneeIdentity(issue, log);
  useAssigneeLinearKey(issue.assignee, log); // and its Linear comments/status changes

  const entry = loadState()[issue.id];
  if (!entry || !String(entry.outcome || '').startsWith('fixed')) { log(`${id} has no completed fix on record — nothing to revise.`); return; }

  const trigger = (config.revise?.trigger || 'revise:').toLowerCase();
  const done = new Set(entry.revisedComments || []);
  const pending = (issue.comments?.nodes || [])
    .filter((c) => c.id && !done.has(c.id) && (c.body || '').trim().toLowerCase().startsWith(trigger));
  if (!pending.length) { log(`${id}: no new revision requests.`); return; }
  log(`${id}: applying ${pending.length} revision request(s)...`);

  const branch = entry.branch || `${config.branchPrefix}${id.toLowerCase()}-${kebab(issue.title)}`;
  const WT = path.resolve(agentRoot, config.worktreesDir, id);
  if (!existsSync(WT)) {
    log('Workspace missing — rebuilding from the pushed branch...');
    const asm = assembleFromBranch(WT, branch);
    if (!asm.ok) {
      await addComment(issue.id, `⚠️ Could not apply the revision automatically: failed to rebuild the \`${asm.repo}\` worktree from \`${branch}\`.\n\n\`\`\`\n${asm.err}\n\`\`\``);
      markProcessed(issue.id, pending);
      return;
    }
  }
  prepareWorktreeDeps(WT);
  setStageLogDir(id);

  const requests = pending
    .map((c, i) => `${i + 1}. From ${c.user?.name || 'a reviewer'}: ${(c.body || '').trim().replace(/^revise:\s*/i, '')}`)
    .join('\n');
  const prompt = fillTemplate(readFileSync(path.join(__dirname, 'revise-prompt.md'), 'utf8'), {
    IDENTIFIER: id, TITLE: issue.title, DESCRIPTION: issue.description || '(no description)',
    BRANCH: branch, PRIOR_SUMMARY: entry.summary || '(see the open PR diff)', REQUESTS: requests,
  });

  const rv = config.revise || {};
  const pre = countCommits(detectChangedRepos(WT));
  log(`Running claude (model=${rv.model || config.opusModel})...`);
  const result = await runClaude(
    claudeArgs({ model: rv.model || config.opusModel, maxTurns: rv.maxTurns || 100 }),
    prompt, WT, rv.timeoutMs || 30 * 60 * 1000, 'revise',
  );
  const marker = extractJson(result, 'REVISE_RESULT', { status: 'unknown' });

  const changed = detectChangedRepos(WT);
  const committed = countCommits(changed) > pre;
  let checks = [];
  if (committed) {
    pushChanged(changed); // updates the open PR(s) in place
    checks = runChecks(WT, changed);
  }

  const checksLines = checks.length
    ? checks.map((c) => `${c.result === 'pass' ? '✅' : '❌'} \`${c.cmd}\``).join('\n')
    : '_(no deterministic checks ran)_';
  const addressed = (Array.isArray(marker.addressed) ? marker.addressed : []).map((a) => `- ${a}`).join('\n');
  const skipped = (Array.isArray(marker.skipped) && marker.skipped.length)
    ? '\n\nSkipped:\n' + marker.skipped.map((s) => `- ${s}`).join('\n')
    : '';
  const body = !committed
    ? `🔁 **Revision attempted but no change was committed.** ${marker.summary || ''}${skipped}\n\n_If this looks wrong, comment \`${rv.trigger || 'revise:'} ...\` again with more detail._`
    : `🔁 **Revision applied and pushed to the open PR(s).** ${marker.summary || ''}\n\n${addressed}${skipped}\n\n**Checks**\n${checksLines}\n\n_The full review/browser gates were not re-run for this revision — re-check the PR diff._`;
  await addComment(issue.id, body);
  markProcessed(issue.id, pending, { lastReviseAt: new Date().toISOString() });
  log('Done.');
}

main().catch((e) => { console.error('[revise] fatal:', e); process.exit(1); });
