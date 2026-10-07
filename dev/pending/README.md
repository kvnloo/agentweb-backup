# dev/pending — dev.md fragments (ENG-809)

Do not edit `dev.md` directly; CI (`dev.md fragment guard`) rejects it.

Write your investigation note as `dev/pending/<eng-id>-<slug>.md`, e.g.
`dev/pending/eng-809-dev-md-fragments.md`. Line 1 must be the section heading
ending in a date:

    ## ENG-809: what was learned (2026-10-06)

After merge, `.github/workflows/dev-md-fragments.yml` folds pending fragments
into `dev.md` newest first, deletes them, and opens a docs-only PR on
`automation/dev-md-consolidate`. Unique filenames mean concurrent PRs never
conflict, unlike the old line-1 prepend.
