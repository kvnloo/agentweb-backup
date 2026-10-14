## ENG-2299: Pin the `__other_skills__` tool pool to the session (2026-10-14)

**What changed.** A session that has `__other_skills__` installed now records the tool names the pool held the first turn it used it (`otherSkillsToolSnapshot` on the `AW-ChatSessions` item, written once with `attribute_not_exists`). `buildSkillContext` grants snapshot ∪ live pool, so a tool the session already had can no longer disappear because someone published a skill that claims it. New tools entering the pool still appear.

**Why.** The pool is "every registered tool no published skill lists", computed from `getPublishedSkills()`, an untenanted scan of `AW-Skills` (30s per-process cache, two prod hosts). Any publish/edit anywhere shrinks it for every user, mid-session. If it empties, `install_skills(["__other_skills__"])` is refused with "currently unavailable to install" (ENG-1237, ENG-1867).

**Not proven.** No prod incident (ENG-152, ENG-1867, the 2026-10-05 `call_google_ads_api` flip) has been tied to a catalog change yet; the transcripts (`AW-ChatMessages`) and `AW-Skills` were unreadable from the autofix role. Prod logs for 2026-10-05 (prod-3) show no `skill-to-tool-resolution-failed` / `Error filtering tools`, so the entitlement-unresolved fail-closed path did not fire that day. If the next occurrence is not explained by the pool shrinking, look elsewhere.

**Limits.**
- Only the tool-list path is pinned. `install_skills` can still be refused when the live pool is empty; `getSkillsForDisplay` still shows the live pool.
- A tier that loses `__other_skills__` entitlement loses the tools regardless of the snapshot (entitlement is checked first).
- Admin-only tool names are filtered out of the snapshot at read time.
- Sessions that installed `__other_skills__` before this shipped are snapshotted on their next turn, not retroactively.
- Rollback: delete the field read in `buildSkillContext`; the attribute on existing items is inert.

**Review gate.** New persisted attribute on `AW-ChatSessions` (no table/index change): needs Harsha's data-plane sign-off before merge.
