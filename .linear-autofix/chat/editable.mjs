// chat/editable.mjs — decide whether a read-only chat can be promoted to editable, and assemble the fix
// branch name for the on-demand worktree. Pure and dependency-free so it's unit-testable; the git side
// effects (worktree assembly, state write) live in the server endpoint.
//
// capabilityOf() grants full (editable) access only once a fix branch OR a worktrees/<id> folder exists.
// The pipeline creates both when it fixes an issue — but a BLOCKED issue never got a branch, so its chat
// is stuck read-only. "Make editable" provisions a fresh branch + worktree so the developer can write the
// fix through the chat agent. Mirrors capabilityOf's blockers so we never promote a chat it would refuse.

export function makeEditableDecision(entry, { fixEnabled, worktreeExists } = {}) {
  if (!fixEnabled) return { ok: false, reason: 'this machine cannot push fixes (AUTOFIX_RUN_ENABLED != 1)' };
  if (!entry) return { ok: false, reason: 'no autofix record for this issue' };
  if (entry.standalone) return { ok: false, reason: 'standalone chats are already editable' };
  if (['started', 'recovered'].includes(entry.outcome)) return { ok: false, reason: 'the pipeline is currently working on this issue — wait for it to finish' };
  if (entry.branch || worktreeExists) return { ok: false, reason: 'this chat is already editable' };
  return { ok: true, reason: null };
}

// Assemble the branch name from parts the caller computed (prefix via assigneeBranchPrefix, slug via
// kebab) — matching the pipeline's `${prefix}${id}-${slug}` shape. Kept git-helper-free so it stays pure;
// no trailing dash when there's no title slug.
export function buildEditableBranch(identifier, prefix, titleSlug) {
  const id = String(identifier || '').toLowerCase();
  const slug = (titleSlug || '').trim();
  return `${prefix}${id}${slug ? `-${slug}` : ''}`;
}

// Promoting a chat to editable means a developer is taking it over, so a "blocked" pipeline outcome no
// longer describes it — clear it to "editing" (its own sidebar badge). Any other outcome is left as-is
// (e.g. a "fixed"/"cannot_fix" chat someone reopens keeps its real history).
export function promotedOutcome(prevOutcome) {
  return prevOutcome === 'blocked' ? 'editing' : prevOutcome;
}
