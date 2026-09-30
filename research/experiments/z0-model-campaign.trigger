# Full authored model campaign trigger

The full 30-report + 40-stop paired campaign is intentionally disabled by default.

To run it on this lab branch, set this file's final line to exactly:

RUN_FULL_AUTHORED_MODEL_CAMPAIGN=1

After evidence is captured, remove or reset the trigger so later pushes cannot
repeat model spend accidentally.

RUN_FULL_AUTHORED_MODEL_CAMPAIGN=0
