## ENG-2986: knowledge-base file delete only deletes a file listed on that task (2026-11-13)

`DELETE /api/tasks/:taskId/knowledge-base/files/:fileKey` used the key from the URL directly. Anyone who could edit one of their own
tasks could delete any object in the knowledge-base storage (GCS or S3) by naming its key, including another account's file.
Reproduced on the test environment: user B called the route on B's own task with user A's file key; A's file was deleted from storage
(it read as "not found") while still listed on A's task.

**Fix:** the key must be one of the files listed on the task named in the URL (matched as Express decoded it, or after one more decode for
older double-encoded clients); the LISTED key is what reaches storage. Anything else is a 404 and nothing is touched. Admins are held to
the same rule. The portal and the `delete_knowledge_base_file` MCP tool only send listed keys, so they are unaffected; deleting the same file
twice now answers 404 the second time (it used to answer 200 and touch storage again). A listed key containing a literal `%` no longer
gets decoded into a different key.

**Sibling route (found by the independent review, reproduced on env1):** `DELETE /api/tasks/:taskId/attachments/:key` only checked that
the caller owns the task, then sent the URL key to S3: user B deleted user A's attachment object through B's own task (A's object
went from 200 to gone). It now requires the key to be listed in that task's `attachments` (404 otherwise).

**Not changed:** the `lead-volume-monitor` and client-health routes decode an already-decoded param, so a client name containing `%`
returns 500 (separate, low severity).

**Testing:** `knowledgeBaseFileDelete.test.ts` (foreign GCS and S3 keys refused, admin held to the rule, listed GCS and S3 files still
deleted under their own key, `%` key, traversal and lookalike keys, double delete, non-editor still 403); the first six fail on the old
route. Existing KB suites pass.

**Rollback:** revert; no data, table or environment change. Orphaned storage objects that were never listed on a task can no longer be
deleted through this route (they were never reachable from the product).
