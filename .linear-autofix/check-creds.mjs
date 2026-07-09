#!/usr/bin/env node
// .linear-autofix/check-creds.mjs — verify each configured per-assignee GitHub token and Linear API
// key still authenticates as the RIGHT person. A swapped/expired credential otherwise mis-attributes
// commits, PRs, and card status SILENTLY (exactly the GH_TOKEN_MVARMA<->GH_TOKEN_ASETH swap we hit).
// Run standalone (`node check-creds.mjs`), at chat-server startup, and hourly from run.sh.
//   ✅ = maps to the expected owner   ❌ = wrong account / invalid (mismatch)   ⚠ = not configured (falls back)
import { config } from './config.mjs';

const log = (...a) => console.log('[credcheck]', ...a);

async function githubLogin(token) {
  try {
    const r = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'autofix-credcheck', Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return { error: `HTTP ${r.status}` };
    return { login: (await r.json()).login };
  } catch (e) { return { error: String(e.name === 'TimeoutError' ? 'timed out' : (e.message || e)) }; }
}

async function linearViewer(key) {
  try {
    const r = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: key },
      body: JSON.stringify({ query: '{ viewer { name email } }' }),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return { error: `HTTP ${r.status}` };
    const j = await r.json();
    if (j.errors) return { error: 'auth error' };
    return { email: j.data?.viewer?.email, name: j.data?.viewer?.name };
  } catch (e) { return { error: String(e.name === 'TimeoutError' ? 'timed out' : (e.message || e)) }; }
}

async function main() {
  let problems = 0;

  // GitHub: the token's login must equal the expected login for that email.
  const ghMap = config.assigneeGhTokenEnv || {};
  const ghExpect = config.assigneeGithubLogin || {};
  for (const [email, envName] of Object.entries(ghMap)) {
    const token = (process.env[envName] || '').trim();
    const expected = ghExpect[email];
    if (!token) { log(`⚠ GH   ${email} (${envName}): not set — PRs fall back to the box gh account`); continue; }
    if (!expected) { log(`?  GH   ${email} (${envName}): no expected login in config.assigneeGithubLogin — cannot verify`); continue; }
    const res = await githubLogin(token);
    if (res.error) { log(`❌ GH   ${email} (${envName}): token invalid (${res.error})`); problems++; }
    else if (res.login !== expected) { log(`❌ GH   ${email} (${envName}): authenticates as "${res.login}", expected "${expected}" — MISMATCH`); problems++; }
    else log(`✅ GH   ${email} (${envName}) -> ${res.login}`);
  }

  // Linear: the key's own viewer.email must equal the email it's mapped to.
  const linMap = config.assigneeLinearKeyEnv || {};
  for (const [email, envName] of Object.entries(linMap)) {
    const key = (process.env[envName] || '').trim();
    if (!key) { log(`⚠ LIN  ${email} (${envName}): not set — status/comments fall back to the default Linear key`); continue; }
    const res = await linearViewer(key);
    if (res.error) { log(`❌ LIN  ${email} (${envName}): key invalid (${res.error})`); problems++; }
    else if ((res.email || '').toLowerCase() !== email.toLowerCase()) { log(`❌ LIN  ${email} (${envName}): key belongs to "${res.email}" (${res.name}), expected "${email}" — MISMATCH`); problems++; }
    else log(`✅ LIN  ${email} (${envName}) -> ${res.email}`);
  }

  if (problems) { log(`FAIL: ${problems} credential problem(s) — fix before they mis-attribute commits/PRs/status.`); process.exitCode = 1; }
  else log('OK: all configured GitHub tokens and Linear keys map to their expected owner.');
}

main();
