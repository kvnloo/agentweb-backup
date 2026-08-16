// Handoff: a local Claude session on a laptop hands finished work to this box to get it MERGED.
//
// The premise is that everything BEFORE the merge needs the developer and everything after it does not.
// Greptile drips comments one at a time, CI takes 20+ minutes, then a deploy queues and only then can
// anything be verified live — hours of waiting that only occasionally needs a human answer. So the
// laptop opens the PR and writes down everything it knows; the box adopts that branch in its own
// worktree and drives the rest through the existing [[WATCH]] loop, which survives a closed laptop, a
// dropped SSH connection, and a server restart.
//
// This module is the PURE half — what a handoff must contain, and what the agent gets told. The server
// side (state entry, worktree, seeded turn) lives in server.mjs.

// The context document is the entire point of the handoff: it is what lets the agent answer a Greptile
// "why did you do it this way?" without waking the developer. A one-liner would technically work and
// would quietly defeat the feature, so it is refused loudly instead — the skill on the laptop should
// have to write a real one.
export const MIN_CONTEXT_CHARS = 400;

// Branch names flow into `git fetch origin <branch>` and `git worktree add -B <branch>` in
// assembleFromBranch, so they are validated as a whitelist rather than sanitised. A leading dash would
// be read as a git flag; `..` is a path-traversal and also illegal in a ref.
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._\/-]*$/;
// A PR on github.com, in either repo. Anything else means the skill built the URL wrong, and a bad URL
// would send the merge drive at the wrong thing.
const PR_RE = /^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/pull\/\d+(?:[/?#].*)?$/;

const clean = (s) => String(s == null ? '' : s).trim();

// Validate one handoff request against the configured chat members. Returns {ok, value} or {ok, error};
// every rejection names what to fix, because the caller is a skill that can correct itself and retry.
export function validateHandoff(body, members = []) {
  const b = body || {};

  // Owner: decides the git identity, GitHub PAT, and Linear key the agent acts with. An unknown email
  // would produce a chat that cannot push, so it fails here rather than at the first commit.
  const email = clean(b.email).toLowerCase();
  if (!email) return { ok: false, error: `email is required — one of: ${members.map((m) => m.email).join(', ')}` };
  const member = members.find((m) => m.email.toLowerCase() === email);
  if (!member) return { ok: false, error: `unknown owner "${clean(b.email)}" — must be one of: ${members.map((m) => m.email).join(', ')}` };

  // PR(s): mergeMsg() scopes itself to entry.prs and is explicitly forbidden from discovering PRs, so a
  // handoff without one produces a chat that can only ever answer MERGE_BLOCKED.
  const raw = Array.isArray(b.prUrl) ? b.prUrl : (b.prUrl ? [b.prUrl] : []);
  const prUrls = raw.map(clean).filter(Boolean);
  if (!prUrls.length) return { ok: false, error: 'prUrl is required — open the PR first, then hand off (the merge drive never goes looking for one)' };
  const badPr = prUrls.find((u) => !PR_RE.test(u));
  if (badPr) return { ok: false, error: `not a GitHub PR URL: "${badPr}" — expected https://github.com/<owner>/<repo>/pull/<number>` };

  // Branch: the worktree is built from it, so the agent's commits land on the PR.
  const branch = clean(b.branch);
  if (!branch) return { ok: false, error: 'branch is required — the worktree is built from it so commits land on the PR' };
  if (!BRANCH_RE.test(branch) || branch.includes('..')) {
    return { ok: false, error: `invalid branch "${branch}" — letters, digits, . _ / - only, and it may not start with a dash` };
  }
  // Adopting a base branch would point the merge drive's worktree at main itself.
  if (/^(main|master|develop)$/i.test(branch)) return { ok: false, error: `refusing to hand off the base branch "${branch}" — hand off a feature branch with an open PR` };

  const context = clean(b.context);
  if (!context) return { ok: false, error: 'context is required — the handoff document is what lets the agent answer Greptile without you' };
  if (context.length < MIN_CONTEXT_CHARS) {
    return { ok: false, error: `context is too thin (${context.length} chars, need at least ${MIN_CONTEXT_CHARS}) — include what changed and why, the decisions taken and the alternatives rejected, known trade-offs, and what is verified vs assumed` };
  }

  const title = clean(b.title).replace(/\s+/g, ' ').slice(0, 80) || `Merge ${prUrls.map(prRef).join(', ')}`;
  return { ok: true, value: { email: member.email, member, prUrls, branch, title, context } };
}

export const prRef = (url) => { const m = /\/pull\/(\d+)/.exec(url || ''); return m ? `#${m[1]}` : String(url || ''); };

// Is some existing handoff chat already holding this branch? Two chats on one branch means two agents
// driving the same PR to merge — racing commits and duplicate review cycles. Git does stop the second
// worktree ("already used by worktree at …"), but only after the entry is written, and it surfaces as
// an opaque 500. Checked up front instead so the caller is told which chat already owns it.
// Only handoff chats count: a pipeline issue may legitimately sit on a branch a developer later hands off.
export function existingHandoffForBranch(state, branch) {
  const b = String(branch || '').toLowerCase();
  if (!b) return null;
  for (const e of Object.values(state || {})) {
    if (e?.handoff && String(e.branch || '').toLowerCase() === b) return e.identifier || null;
  }
  return null;
}

// The document written to disk. Deliberately a FILE and not just a chat message: a turn's transcript
// gets summarised away by /compact, but a file can be re-read verbatim on turn 40, after a restart, or
// by a fresh session — which is exactly when a Greptile argument about intent shows up.
export function handoffDoc({ title, prUrls = [], branch, author, context, at }) {
  return [
    `# Handoff — ${title}`,
    '',
    `- **Branch:** \`${branch}\``,
    ...prUrls.map((u) => `- **PR:** ${u}`),
    `- **Handed off by:** ${author || 'unknown'}`,
    `- **At:** ${at}`,
    '',
    'This was written by the developer\'s own Claude session at the moment the work was finished, while',
    'the full reasoning was still in context. It is the authoritative record of INTENT for this PR.',
    '',
    '---',
    '',
    context,
    '',
  ].join('\n');
}

// How a standalone chat's workspace and lifetime are described to it. A handoff differs from an
// ordinary chat on both counts:
//
//   - its branch is the DEVELOPER'S branch with their pushed work and an open PR, not a fresh one cut
//     off main, and telling the agent otherwise is simply false;
//   - it must never close itself. [[CLOSE_CHAT]] removes the worktree and `git branch -D`s the branch,
//     which here is the developer's real feature branch — and the chat is also the record of how the
//     merge went, which they may want to read afterwards. Finishing the merge is NOT a reason to tidy
//     up. Deletion is the developer's call, from the UI, whenever they decide.
export function workspaceLines(entry, cwd) {
  if (entry?.handoff) {
    return {
      branchDesc: `\`${entry.branch}\` — the developer's own branch, which you did not create: it already carries their finished, pushed work and an open PR`,
      closeLine: 'This chat and its worktree belong to the developer. Do NOT close it, do NOT delete the workspace, and do NOT delete the branch — not when the PR is merged, not when the deploy is verified, not ever. There is no self-close marker in this chat. The developer removes it from the autofix UI when they are done reading it.',
    };
  }
  return {
    branchDesc: `\`${entry?.branch}\` (a fresh branch off main)`,
    closeLine: 'To CLOSE this chat and delete its workspace when the developer asks, end your reply with a line containing exactly: [[CLOSE_CHAT]]',
  };
}

// The seeded first turn. This runs as a promptOverride PREFIX to the existing mergeMsg, so the proven
// Greptile/CI/merge instructions are untouched — this only establishes whose work it is and why the
// agent is holding it.
export function handoffPrompt({ identifier, title, prUrls = [], branch, handoffPath }) {
  return [
    `**Handoff — you are taking over finished work from another developer.**`,
    '',
    `A developer finished this work in their own Claude session on their laptop and handed it to you to get MERGED. You did NOT write this code. Their session wrote a handoff document capturing every discovery, decision, and nuance while it was all still fresh:`,
    '',
    `**READ IT FIRST, IN FULL, BEFORE ANYTHING ELSE:** \`${handoffPath}\``,
    '',
    `- Chat: ${identifier} — ${title}`,
    `- Branch: \`${branch}\` (already checked out in your worktree; commits here go straight to the PR)`,
    ...prUrls.map((u) => `- PR: ${u}`),
    '',
    'How to treat that document:',
    '- It is **authoritative for intent** — why the approach was chosen, what was deliberately not done, which alternatives were considered and rejected. When Greptile questions an approach, the answer is usually already in there. Use it and keep going rather than escalating.',
    '- It is **not** authoritative for facts about the current code. Verify claims against the actual diff (`gh pr diff`) before repeating them to anyone. If the document and the diff disagree, the diff wins — and say so in your final report.',
    '- It does **not** authorise changing the developer\'s decisions. Fix what Greptile is genuinely right about; do not relitigate a settled trade-off because you would have done it differently.',
    '- The developer is away from their laptop. Anything you can resolve from the document, resolve yourself — that is the entire point of the handoff. Escalate only a real decision that the document does not already answer.',
    '',
    `**\`HANDOFF.md\` is NOT part of this change — never commit it.** It sits in your worktree for you to re-read, but your worktree root IS the repo root, so it shows up as an untracked file. When you commit Greptile fixes, **stage the exact paths you edited** (\`git add <path> …\`) — do NOT use \`git add -A\`, \`git add .\`, or \`git commit -a\`, any of which would sweep this document onto the PR for Greptile to review. If you ever see \`HANDOFF.md\` in \`git status\` staged output, unstage it before committing.`,
    '',
    '---',
    '',
  ].join('\n');
}
