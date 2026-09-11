# Cycle 136 — customer-portal is a fifth repo (gitignored), not a fifth process on this box

**UTC:** 2026-09-11T23:59:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.

## Question

Cycle 135: agent-engine is a deploy unit with no GitHub job.
`customer-portal/` is in the `NON_BACKEND` fixture (test
L1044–1047). Is it in this tree, or a separate GitHub repo
this Actions graph cannot build? File-level.

## Finding

**Fifth repo, not a fifth process.** This worktree has no
`customer-portal/` directory (not a submodule). `.gitignore`
L121–124: “Separate repositories (now independent)” —
`growth-chat/` and `customer-portal/`. `tests.yml` and
`deploy.yml` grep empty for `customer-portal`.

`research/PROTOCOL.md` L22: KEEP/DISCARD already says this
tree has no customer-portal (separate repo). End-user UI
must not land in `partner-portal/` (L62). CLAUDE.md L155
still says “in this repo at `customer-portal/`”; L894–912
calls it a separate repo at that path. L155 is the stale
sentence. The gitignore and empty tree are the ground truth.

merge-evidence test L1044–1047 treats
`customer-portal/src/main.tsx` as a frontend-only path that
PASSes with the backend suite skipped. That path cannot
appear in a live this-repo PR (gitignored, not tracked).
The fixture is synthetic. Same for L1313
`customer-portal/src/Other.tsx` (ENG-1003 non-overlap).

`test-env/Dockerfile.customer-portal` `COPY customer-portal/`
from the compose context (`docker-compose.yml` L43–47).
That is a **sibling checkout** the cloud test-env expects,
not a path this GitHub repo builds.

Thesis four deploy units are backend EB, partner-portal EB,
agent-engine GCP, remotion-lambda. Customer portal is
`AgentWebPro/agentweb-customer-portal` (dependabot-only-pr
test L136). A-006 would still be a sixth process on the
backend box. Do not add A-021. Do not vendor `/mcp` instead
of Q-014. Hermes/OMP: one repo, in-process packages.

## Queue effect

A-020 stays **park**. A-019 stays **park**. A-006 stays
**discard**. Do not add A-021. Q-001 stays **ready**. Q-014 stays
**ready**.

## Next

Cycle 137: cheapest remaining. Candidate: this repo still
owns the other repo’s IA as data —
`backend/src/services/customerPortalPages.ts` (header
points at `customer-portal/src/App.tsx` routes). Composition
is a typed list in-process, not an HTTP nanoservice. File-level.
Do not un-ready Q-001 / Q-014 / Q-003. Unsubscribe after
`2026-09-12T06:00:00Z`.
