## ENG-3062: consolidation PR title no longer names an issue (2026-11-16)

The dev.md consolidation workflow titled every PR `... (ENG-809)`. Linear links
a PR to an issue id in its title, so each run moved ENG-809 to In Progress and
then Merged, long after it was verified. The title and body now carry no issue
id; the body still names the workflow file. Do not put an issue id in the title
or body of any recurring bot PR.
