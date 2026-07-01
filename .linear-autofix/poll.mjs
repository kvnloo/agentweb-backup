#!/usr/bin/env node
// .linear-autofix/poll.mjs — find new bugs and fix each one (sequentially).

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { listNewBugs } from './linear.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  if (!process.env.LINEAR_API_KEY) { console.error('[poll] LINEAR_API_KEY not set'); process.exit(2); }
  const bugs = await listNewBugs();
  console.log(`[poll] ${new Date().toISOString()} — ${bugs.length} new bug(s)`);
  for (const b of bugs) {
    console.log(`[poll] -> ${b.identifier}: ${b.title}`);
    const r = spawnSync('node', [path.join(__dirname, 'autofix.mjs'), b.identifier], { stdio: 'inherit', env: process.env });
    if (r.status !== 0) console.error(`[poll] ${b.identifier} exited with ${r.status}`);
  }
}

main().catch((e) => { console.error('[poll] fatal:', e); process.exit(1); });
