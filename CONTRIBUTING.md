# Contributing

## Pre-push hook

`backend`'s `npm ci` / `npm install` installs a pre-push git hook (`.githooks/pre-push`,
`core.hooksPath` set repo-wide) that runs `tsc --noEmit` plus targeted `jest` (changed test files
and tests related to changed source files) whenever a push touches `backend/**` or the backend CI
path, and skips instantly otherwise — see ENG-1277. It exists to catch what CI would catch anyway,
in seconds instead of a ~31-runner-minute pair. It fails loud and blocks the push on a real problem;
bypass it with `git push --no-verify` or `AGENTWEB_SKIP_PREPUSH=1 git push` if you need to push
through it (CI is always the backstop — nothing merges without passing there too).
