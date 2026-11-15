## ENG-3038: consolidate PRs had no CI because GITHUB_TOKEN events start no workflows (2026-11-15)

- Cause: `dev-md-fragments.yml` opens and force-updates the `automation/dev-md-consolidate` PR with the workflow's own `GITHUB_TOKEN`. GitHub starts no workflow for an event made by that token, so every `pull_request` run on that PR (actor `github-actions[bot]`) has zero jobs: `failure` on the opened pair (43755763117 / 43755763155), `action_required` on later updates (43761230507 / 43761230577).
- The 11 checks on #4075 came from a manual close and reopen by a user token (runs 43756441782 / 43756441791), not from the workflow.
- Fix: `workflow_dispatch` is an event `GITHUB_TOKEN` may start. After the consolidate job creates or updates the PR it dispatches `dev-md-fragments.yml` (guard) and `tests.yml` (Build) on the automation branch. Check runs are keyed on the commit, so `merge-evidence.sh` reads them at the PR head.
- The dispatched guard looks the PR up by branch and fails unless the PR head equals the run's commit. Build honours a dispatch only on `automation/dev-md-consolidate`; on any other ref `Detect changed projects` fails.
- Manual `workflow_dispatch` of `dev-md-fragments.yml` on `main` still consolidates; on the automation branch it now runs the guard instead.
- Not provable before merge: the first consolidate PR opened after this lands is the proof.
