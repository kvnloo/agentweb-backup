## ENG-2123: a phone repeat that fills nothing is not an update; same-named racers share one separate row (2026-10-19)

Two gaps left open by the fill-blanks change are closed.

**1. A phone-matched repeat that fills nothing is no longer reported as an update.** The attribution refresh (`lastTouch`) is still saved, but `isUpdated` for a phone-matched merge now reflects only what the submission itself changed (standard fields and custom keys). So a visitor who resubmits and adds nothing does not re-run drip enrolment, the CRM push or the owner alert; the response is `lead.unchanged`. The email path is untouched and still counts a new touch as an update (guard test).

**2. A burst of same-named submissions that conflict with the number's first row collapses to one separate row.** The conflicting-name loser used to create an ordinary-id row per request (4 Ana vs a Bob winner left 4 Ana rows). It now takes the same exactly-once create with the id seeded by the normalized first+last name (`phoneUniqueIdSeed`), so same-named racers share one row and a different name gets its own. A loser of that second race adopts the same-name row and only fills blanks. If that winner is stale (it gained an email or its phone changed) it falls back to an ordinary-id row, as before. A third name on the number still gets its own row.

**Still accepted, unchanged:** a filled field's newer value is dropped; anyone who knows a number can fill blanks; the smoke-number adopt branch still overwrites (synthetic numbers only). Real phone-only form traffic is currently ~zero (the production `PhoneKeyIndex` is empty), so none of this is exercised in production today.
