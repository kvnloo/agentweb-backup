## ENG-2351: exact-sha jest runner for post-merge verification (2026-10-08)

Added `.github/scripts/sha-jest.sh` (+ test, wired into tests.yml script tests) and `docs/sha-jest.md`: detached worktree at a sha with a lockfile-keyed `npm ci` node_modules cache so the verifier can run `jest <file>` at the merge sha. Proven on #3354 toolDispatch.test.ts (124/124).
