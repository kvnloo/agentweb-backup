## ENG-3149: email the account owner when a share-link visitor first marks one of their schedules (2026-11-18)

A share-link visitor acts under the owner's userId, so the schedules they write look like the owner's own. ENG-2816 marks them (`provenance`) and the portal shows an amber "Visitor-edited" badge, but an owner who does not open the schedule never sees it. This sends the owner one email the first time a visitor marks a schedule.

- **When:** only after a visitor write succeeded, and only when it is the schedule's first mark. A visitor create, or a create from a template (born marked), alerts. A visitor update or variable write alerts only if it adds a mark and the consistent read it was diffed against had none. Already-marked schedules, no-op writes, owner writes, self-calls without the claim and the public emailed-variables link never alert.
- **Never in the way:** the send is detached (not awaited, fire and forget). Any failure is only logged with a `[ENG-3149]` prefix; the visitor's request, status and body are unchanged.
- **To whom:** the account owner only (the email on the request, else a lookup by `userId`; none means skip silently). Never the visitor, never the schedule's notification list.
- **How many:** at most 5 per owner per rolling hour, in process (`utils/shareScheduleAlertThrottle.ts`, pruned map). Beyond that the email is skipped and the cap is logged once; the badge still shows. A restart or a second instance can let a few extra through, which is fine for a notification.
- **The mail:** `emailService.sendVisitorScheduleAlertEmail`. Fixed subject with no schedule name. The schedule name is the only visitor-written text in it: whitespace collapsed, cut to 100 characters, HTML-escaped. No prompt text, token, IP or recipients.
- **No** new table, attribute, index or IAM change.
