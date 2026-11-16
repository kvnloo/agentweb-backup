## ENG-3052: lead engagement edit/delete no longer writes a stale array (2026-11-16)

- `crmDb.updateLeadEngagement` and `crmDb.deleteLeadEngagement` now share `crmDb.rewriteLeadEngagements`. The write carries a `ConditionExpression`: the lead exists, `updatedAt` equals the value read (or is still absent), and `size(engagements)` equals the count read.
- On `ConditionalCheckFailedException` the lead is re-read and the edit or delete is rebuilt on the fresh array. After 3 lost races the error carries `preconditionFailed`, the same signal `addLeadEngagement` uses.
- `PUT` and `DELETE /api/crm/lists/:listId/leads/:leadId/engagements/:eventId` return 404 for `Lead not found` / `Engagement not found` and 409 for a lost race. They returned 500 before.
- No table, key, index or attribute change. Stored items change only by the edit or delete asked for.
- Any other write to the lead between the read and the write (not only an append) now causes a re-read, because `updatedAt` moved.
