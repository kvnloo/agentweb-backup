## ENG-2264: reconnecting a Meta account no longer leaves a duplicate behind (2026-11-20)

- **Symptom:** a user whose Meta account is stored under the old platform name `facebook` got a brand-new `meta` entry every time they reconnected, and the old entry stayed behind as an orphan. None of the old entry's fields (shared-with-org setting, engagement memory, original creation time) carried over to the new one.
- **Cause:** `createAccount` only matched an existing entry on the exact platform string. Every connect flow now writes `meta`; the readers all accept both `meta` and `facebook`, but the write path did not.
- **Fix:** `createAccount` now treats a `facebook` row as the same connection as `meta` (same `account_id`). On reconnect it updates that row in place, relabels it `meta`, and keeps its own fields. An exact `meta` match still wins, so a user who already has both rows gets the `meta` row updated and nothing is merged or deleted. Only `facebook` to `meta` is aliased.
- **Not done:** no clean-up of duplicates that already exist. They are left as they are.
