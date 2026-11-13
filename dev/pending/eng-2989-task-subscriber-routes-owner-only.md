## ENG-2989: adding or removing a task's email subscribers needs the task owner or an admin (2026-11-13)

Three routes only required a login: `DELETE /api/tasks/:taskId/subscribers/:email`, and `POST` and `DELETE /api/auth/tasks/:taskId/subscribers[/:email]`
(legacy duplicates on the auth router; the portals use the tasks-router routes). Any signed-in user could remove a subscriber from, or
add an arbitrary address to (so AgentWeb would email it), someone else's task. Reproduced on the test environment: user B removed A's
subscriber (204) and added an address to A's task through the auth router (201). `POST /api/tasks/:taskId/subscribers` already had the
check and refused B (403).

**Fix:** one shared check, `services/taskSubscriberAccess.ts` (the task's owner or an admin, the rule the tasks-router add route always
had), used by all three routes: 401 without a caller or user record, 404 for an unknown task, 403 for anyone else. The portals' own calls
(task owners, admins in the partner portal) are unaffected. The auth-router routes have no callers in the repos; kept, not deleted.

**Also gated (review):** `GET /api/auth/tasks/:taskId/subscribers` returned the full subscriber records (emails, imported fields, email
history) to any signed-in user; it now needs the task's owner or an admin too.

**Not changed, filed separately (they are public, unauthenticated endpoints, a different kind of fix):** `GET /api/tasks/:taskId/subscribers`
returns the same full records to anyone who has the task id; `POST /:taskId/subscribers/join` adds any address without a task-exists
check, double opt-in or rate limit (and sends a welcome email from the owner's account); `POST /:taskId/resubscribe` undoes an
unsubscribe from just a task id and email.

**Testing:** `taskSubscriberDelete.test.ts` and `authTaskSubscribers.test.ts` (stranger refused on each route, including the subscriber list, and nothing changed, owner
and admin allowed, unknown task, helper cases); the first set fails on the old routes; breakage checks on the helper and each route.

**Rollback:** revert; no data, table or environment change.
