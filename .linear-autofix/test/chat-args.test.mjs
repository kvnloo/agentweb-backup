// Tests for chatArgs — the CLI-arg builder every chat/compact/btw turn is spawned with.
// server.mjs has no exports, so (per this repo's convention, cf. audit-repro.test.mjs) we keep a
// FAITHFUL COPY of chatArgs here and assert its contract. The one that matters most: EVERY chat turn
// denies the reference-heavy skills (config.chat.skillDenylist) via `Skill(<name>)`, so a heavyweight
// skill (e.g. claude-api ~194k tokens) can never auto-load into the resumed session and get re-billed
// on every turn — the bug that silently defeated /compact on ENG-200 — WHILE every other skill stays
// available (the agent is not dumbed down). Run: node test/chat-args.test.mjs
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✅ ${m}`); } else { fail++; console.log(`  ❌ ${m}`); } };

// ── Faithful copy of chat/server.mjs chatArgs + the relevant CHAT config (keep in sync) ──
const CHAT = {
  full: { model: 'sonnet', maxTurns: 100 },
  readOnly: { model: 'sonnet', maxTurns: 30, allowedTools: ['Read', 'Grep', 'Bash(git log:*)'] },
  skillDenylist: ['claude-api', 'deep-research'],
  capabilityPrompt: 'Linear access: ... (persistent capability text)',
  safetyPrompt: 'SAFETY — you are CONFINED to your own assigned repo ... (compaction-proof guard)',
  watchPrompt: 'BACKGROUND WORK — end a waiting turn with [[WATCH: …]] ... (compaction-proof)',
  resourcePrompt: 'RESOURCES — wrap heavy builds in flock + a 4GB heap cap ... (compaction-proof)',
};
function chatArgs(cap, sessionId, modelOverride) {
  const m = CHAT[cap] || {};
  const a = ['-p', '--output-format', 'stream-json', '--verbose', '--model', modelOverride || m.model, '--max-turns', String(m.maxTurns)];
  a.push('--settings', '{"includeCoAuthoredBy":false}'); // no Claude co-author trailer on chat commits/PRs
  if (cap === 'readOnly') a.push('--allowedTools', (m.allowedTools || []).join(','));
  else {
    a.push('--dangerously-skip-permissions');
    const appends = [CHAT.capabilityPrompt, CHAT.safetyPrompt, CHAT.watchPrompt, CHAT.resourcePrompt].filter(Boolean);
    if (appends.length) a.push('--append-system-prompt', appends.join('\n\n'));
  }
  const denied = (CHAT.skillDenylist || []).map((s) => `Skill(${s})`);
  if (denied.length) a.push('--disallowedTools', ...denied);
  if (sessionId) a.push('--resume', sessionId);
  return a;
}
// helpers: the appended system prompt carries BOTH the persistent capability and the safety guard
// (both must survive /compact, so both live on --append-system-prompt).
const appendedText = (a) => { const i = a.indexOf('--append-system-prompt'); return i >= 0 ? a[i + 1] : null; };
const hasCapability = (a) => { const t = appendedText(a); return !!t && t.includes(CHAT.capabilityPrompt); };
const hasSafetyGuard = (a) => { const t = appendedText(a); return !!t && t.includes(CHAT.safetyPrompt); };
const hasWatchGuide = (a) => { const t = appendedText(a); return !!t && t.includes(CHAT.watchPrompt); };
// The Aug-5 OOM lesson: an agent running `tsc`/`vite build` by hand inside a turn bypassed both the
// machine-wide build lock and the 4GB heap cap the pipeline uses, and those unserialized spikes are
// what pushed the chat cgroup into its ceiling. The rule has to survive /compact like the others.
const hasResourceRule = (a) => { const t = appendedText(a); return !!t && t.includes(CHAT.resourcePrompt); };

// helper: are all denylisted skills passed as `Skill(<name>)` after a --disallowedTools flag?
const deniesSkills = (a, names) => {
  const i = a.indexOf('--disallowedTools');
  if (i < 0) return false;
  return names.every((n) => a.includes(`Skill(${n})`));
};
// helper: is a specific skill NOT denied (so it stays usable)?
const allows = (a, name) => !a.includes(`Skill(${name})`);

console.log('chatArgs — heavyweight skills denied, the rest kept');
{
  // happy path: full cap, resumed session — the exact config a normal chat turn uses
  const full = chatArgs('full', 'sess-123');
  ok(deniesSkills(full, ['claude-api', 'deep-research']), 'full cap denies the heavyweight reference skills');
  ok(allows(full, 'code-review') && allows(full, 'verify') && allows(full, 'simplify'), 'small workflow skills stay usable — code-review/verify/simplify (not dumbed down)');
  ok(full.includes('--dangerously-skip-permissions'), 'full cap still has skip-permissions (unchanged)');
  ok(hasCapability(full), 'full cap appends the persistent capability to the system prompt (survives /compact)');
  ok(hasSafetyGuard(full), 'full cap appends the worktree-isolation safety guard (compaction-proof)');
  ok(hasWatchGuide(full), 'full cap appends the background-watch guide (compaction-proof)');
  ok(hasResourceRule(full), 'full cap appends the heavy-build resource rule (compaction-proof)');
  ok(full.filter((x) => x === '--append-system-prompt').length === 1, 'capability + safety + watch + resources share ONE --append-system-prompt flag');
  ok(full.includes('--resume') && full[full.indexOf('--resume') + 1] === 'sess-123', 'resume sid still passed');

  // the denials come as separate values under ONE --disallowedTools, and --resume stays last
  ok(full.filter((x) => x === '--disallowedTools').length === 1, 'a single --disallowedTools flag carries all denials');
  ok(full.indexOf('--disallowedTools') < full.indexOf('--resume'), 'denials precede --resume');

  // read-only cap (also what /btw uses): allowlisted, and STILL denies the heavyweight skills
  const ro = chatArgs('readOnly', 'sess-9');
  ok(deniesSkills(ro, ['claude-api', 'deep-research']), 'readOnly cap denies the heavyweight skills too');
  ok(ro.includes('--allowedTools'), 'readOnly cap keeps its allowedTools guard');
  ok(!ro.includes('--dangerously-skip-permissions'), 'readOnly cap never gets skip-permissions');
  ok(!ro.includes('--append-system-prompt'), 'readOnly cap gets NO capability prompt (its Bash is git-only — cannot curl)');

  // btw-style: readOnly cap + a model override (Haiku, a tier below the conversation's Sonnet) —
  // still denies, and honors the override
  const btw = chatArgs('readOnly', 'btw-sid', 'haiku');
  ok(deniesSkills(btw, ['claude-api', 'deep-research']), 'btw (readOnly + override) denies the heavyweight skills');
  ok(btw[btw.indexOf('--model') + 1] === 'haiku', 'model override is honored');
  ok(btw[btw.indexOf('--model') + 1] !== CHAT.readOnly.model, 'btw runs BELOW the main conversation model');

  // boundary: no sessionId (fresh/first turn or post-compact seed) — still denies, no --resume
  const fresh = chatArgs('full', null);
  ok(deniesSkills(fresh, ['claude-api', 'deep-research']), 'fresh turn (no sid) still denies the heavyweight skills');
  ok(!fresh.includes('--resume'), 'no --resume when sessionId is null');

  // boundary: unknown/empty cap must not crash and must STILL deny (fail-safe default)
  const unknown = chatArgs('bogus', 'x');
  ok(deniesSkills(unknown, ['claude-api', 'deep-research']), 'unknown cap still denies the heavyweight skills (fail-safe)');

  // boundary: empty denylist → no --disallowedTools flag at all (clean no-op, no crash)
  const saved = CHAT.skillDenylist;
  CHAT.skillDenylist = [];
  const none = chatArgs('full', 's');
  ok(!none.includes('--disallowedTools'), 'empty denylist emits no --disallowedTools flag');
  CHAT.skillDenylist = saved;
}

console.log(fail ? `\n❌ ${fail} FAILED — ${pass} passed, ${fail} failed` : `\n✅ ALL PASSED — ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
