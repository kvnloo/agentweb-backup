## ENG-3012: Read every workspace approval page (2026-11-15)

- Existing per-user approval reader follows UserApprovalsIndex continuation keys, retaining newest-first order and a total explicit limit across pages.
- Empty intermediate pages continue. Workspace member resolution, authorization, table/index/model and writes are unchanged; Slack's existing unlimited reader also receives complete results.
- Regression evidence: four failures/two passes before fix; 31/31 across pagination, undo, workspace and task-query fixtures after; scoped TypeScript passes. No live AWS/provider/browser calls.
- Rollback: revert this code change. Parent ENG-2874 retains full live workspace/creator QA.
