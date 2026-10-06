## ENG-809: dev.md notes become fragments, because append collides exactly like prepend (2026-10-06)

Every PR used to prepend to dev.md line 1, so any two open PRs conflicted, and a conflicted PR cannot
schedule a workflow run (ENG-757 blind window). Appending would not help: two EOF additions touch the
same hunk. Notes now go in `dev/pending/<eng-id>-<slug>.md`; `dev-md-consolidate.sh` folds them in
newest first after merge and refuses to delete any fragment whose lines are not verifiably in the new
dev.md. The guard runs from the base ref so a PR cannot weaken the check judging it, and the
consolidation branch is exempt only when it solely edits dev.md and removes fragments.
