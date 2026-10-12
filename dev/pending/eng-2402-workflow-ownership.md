## ENG-2402: Workflow run/rerun ownership checks (2026-10-12)

`POST /api/workflows/:id/run` now 403s non-owners and referenced tasks not owned by the caller (400 if missing); task rerun 403s non-owners and 404s when the execution belongs to another workflow. Removed the dead, unrouted `runWorkflow` controller so one run path remains.
