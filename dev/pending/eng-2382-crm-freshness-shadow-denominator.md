## ENG-2382: the CRM freshness shadow log can now tell a coincidence from a stale restatement (2026-10-27)

**Why.** The detector (ENG-2263) is log-only and logs only the replies it flags. By 2026-10-27 production had 18 flagged replies from real accounts, 3 of them `echoesEarlier` (the claimed number is among the numbers earlier turns of the session returned), all tiny numbers (14, 0, 5). Two things made them unreadable: there was no denominator (how many CRM replies were checked), and `echoesEarlier` is coincidence-prone, because the session number set holds every array length of every CRM result (up to 64 per message, over the last 120 messages), so in a long session a small integer is in it by chance.

**What changed (log-only; the reply is never touched; kill switch `AGENT_CRM_FRESHNESS_GUARD=off` covers all of it).**
- The existing `[crm-freshness-shadow]` line gains three numbers: `sessionNumberCount` (size of the session number set), `sessionDensity20` (share of the integers 0..20 in it, so a hit on a crowded set reads as chance) and `sessionMessages` (history length at the start of the turn; omitted when unknown).
- A new `[crm-freshness-checked]` line is written for every reply the detector had something to look at (a CRM tool succeeded, a `[verified: ...]` tag, or an inventory total claim), flagged or not: `model`, `flagged`, `findingCount`, `tagsSeen`, `claimsSeen`, `crmToolsSucceeded` (a count), `totalsAbstained`. Counts and a model name only: no reply text, no session id. Replies with nothing CRM-related write nothing. It is the denominator for the flag rate per model.
- `backend/scripts/summarize-crm-freshness-shadow.mjs` reads both: a per-model "CRM replies checked / flagged (%)" line (one decimal below 10%, and shown even for a model with no flagged replies), and for the `echoesEarlier` lines the median and range of `sessionDensity20`.

**Reading it.** Median density near 1 on the echo lines means the matches are expected by chance; a sparse set (say under 0.2) makes a match meaningful. Old lines without the new keys are skipped, not counted as zero.

**Volume.** One short line per CRM-relevant reply. If it is too much, `AGENT_CRM_FRESHNESS_GUARD=off` (Beanstalk env var, needs a restart) stops everything; there is no separate switch for the new line.

**Not done here.** Which tool and field produced a matched number is not logged: that needs extra data in each chat message's persisted metadata, a persistence-format change outside this PR.

**Scope of "checked".** It is the detector's own scope, not proof a reply is about the CRM: the bare "N lists" pattern needs no CRM context, so a reply about "5 lists of ideas" counts as a claim. The flagged line has the same property, so the flag rate and its numerator stay consistent.
