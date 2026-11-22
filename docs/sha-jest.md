# Running backend jest at an exact commit (ENG-2351)

Post-merge verification needs "test X passes at merge sha S". A bare detached
worktree has no `backend/node_modules`, and the shared checkout's
node_modules may lack dev deps (`Preset ts-jest not found`). Use:

    bash .github/scripts/sha-jest.sh <sha> <backend-relative test path>...
    # e.g.
    bash .github/scripts/sha-jest.sh 65292331 src/services/agentMode/core/__tests__/toolDispatch.test.ts

- Creates a detached worktree under `~/.cache/agentweb-sha-jest/`, removed on exit
  (`KEEP_WORKTREE=1` to keep it).
- `backend/node_modules` is a symlink to a cache keyed by the sha256 of that
  commit's `backend/package-lock.json`; `npm ci --include=dev --ignore-scripts`
  runs only on a new lockfile (cold ~5-7 min, warm seconds).
- Runs `jest --runInBand` (single process; Atem memory) and exits with jest's code.
- Refuses an empty/flag test argument (would run the whole suite), paths with
  `..`, files absent at the sha, and unknown shas (exit 2). `git fetch` first.
- Prune old caches with `rm -rf ~/.cache/agentweb-sha-jest/nm-*` when the disk is tight.

Proof: at #3354's merge sha `65292331`, toolDispatch.test.ts — 1 suite, 124/124 passed.
