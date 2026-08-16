// Tests for claudeArgs + triageCwd — the two seams that decide how much STATIC context every pipeline
// stage pays for on every single API call.
//
// Why these exist (measured 2026-08-16 across 14 completed fix runs):
//   - 64% of a bug's 15.1M tokens is a fixed ~60k preamble re-sent on all 161 calls.
//   - 2,368 of that preamble is MCP tool schemas from the repo's .mcp.json (playwright/notion/okareo).
//     Across every bug ever run, the pipeline stages made ZERO MCP tool calls — only the browser-verify
//     stage (which passes its OWN --mcp-config) uses them. So every non-verify stage was loading three
//     MCP servers it never called.
//   - The fixability gate is a ONE-turn text classification whose prompt explicitly forbids opening
//     files or running commands, yet it ran from the repo root and paid 59,066 tokens — 99% of it
//     context it never reads. A bare cwd outside the checkout costs ~33k.
//
// Run: node test/claude-args.test.mjs
import path from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { claudeArgs, triageCwd } from '../autofix.mjs';
import { config } from '../config.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✅ ${m}`); } else { fail++; console.log(`  ❌ ${m}`); } };
const count = (a, v) => a.filter((x) => x === v).length;

console.log('\n— claudeArgs: MCP isolation —');
{
  // The core fix: a stage with no --mcp-config must still be isolated from the repo's .mcp.json.
  // `--strict-mcp-config` alone means "use ONLY servers from --mcp-config" → with none passed, none load.
  const a = claudeArgs({ model: 'sonnet', maxTurns: 40 });
  ok(a.includes('--strict-mcp-config'), 'a stage with no mcp config is still MCP-isolated');
  ok(!a.includes('--mcp-config'), 'no --mcp-config flag is invented when none was asked for');
  ok(count(a, '--strict-mcp-config') === 1, 'the isolation flag appears exactly once');
}
{
  // The verify stage passes its own Playwright-only config — it must keep both flags, and the
  // strict flag must not be duplicated now that it is also added unconditionally.
  const a = claudeArgs({ model: 'sonnet', maxTurns: 40, mcp: '/tmp/verify-mcp.json' });
  ok(a.includes('--mcp-config'), 'an explicit mcp config is still passed through');
  ok(a[a.indexOf('--mcp-config') + 1] === '/tmp/verify-mcp.json', 'the mcp config path is preserved');
  ok(count(a, '--strict-mcp-config') === 1, 'strict flag is not duplicated when a config IS supplied');
}

console.log('\n— claudeArgs: existing contract is untouched —');
{
  const a = claudeArgs({ model: 'sonnet', maxTurns: 60 });
  ok(a[0] === '-p', 'headless -p mode');
  ok(a[a.indexOf('--model') + 1] === 'sonnet', 'model is passed through');
  ok(a[a.indexOf('--max-turns') + 1] === '60', 'max-turns is passed through as a string');
  ok(a[a.indexOf('--output-format') + 1] === 'json', 'json envelope (the per-stage token record depends on it)');
  const s = a[a.indexOf('--settings') + 1];
  ok(s && JSON.parse(s).includeCoAuthoredBy === false, 'no Claude co-author trailer — fixes are attributed to the assignee');
}
{
  const skip = claudeArgs({ model: 'sonnet', maxTurns: 10, skipPermissions: true });
  const noSkip = claudeArgs({ model: 'sonnet', maxTurns: 10, skipPermissions: false });
  ok(skip.includes('--dangerously-skip-permissions'), 'unattended stages keep skip-permissions');
  ok(!noSkip.includes('--dangerously-skip-permissions'), 'skipPermissions:false never gets the bypass');
  ok(noSkip[noSkip.indexOf('--permission-mode') + 1] === 'acceptEdits', 'and falls back to acceptEdits');
  ok(noSkip.includes('--strict-mcp-config'), 'MCP isolation applies regardless of permission mode');
}

console.log('\n— triageCwd: the fixability gate must not run inside a repo —');
{
  const d = triageCwd();
  ok(typeof d === 'string' && d.length > 0, 'returns a path');
  ok(existsSync(d) && statSync(d).isDirectory(), 'the directory exists (created on demand)');
  ok(!existsSync(path.join(d, 'CLAUDE.md')), 'no CLAUDE.md sits in it');

  // The important one: Claude Code walks UP from cwd to collect CLAUDE.md files, so a dir anywhere
  // under the checkout would still pull in the repo's 39KB CLAUDE.md. It must be outside the tree.
  const agentRoot = path.resolve(config.agentRoot || path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..'));
  const rel = path.relative(agentRoot, d);
  ok(rel.startsWith('..') || path.isAbsolute(rel), `outside the repo tree so no parent CLAUDE.md is inherited (${d})`);

  ok(triageCwd() === d, 'stable across calls (idempotent, safe to call per run)');
}

console.log(`\n${fail ? '❌' : '✅'} ${fail ? 'FAILURES' : 'ALL PASSED'} — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
