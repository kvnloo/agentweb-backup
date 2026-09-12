# Cycle 264 — call XFF from `main()` next to delay; do not copy dryrun’s cannot-fail

**Date:** 2026-09-12T11:10:00Z
**Question:** `run_health_probe_dryrun` runs **inside**
`verify_deployment` after the SUCCESS log (L740–742) and
**cannot** `fail()` the job (header L32–35; INERT L453).
`ensure_deregistration_delay` runs from `main()` after
verify returns (L897) and **does** `fail()`. Should a later
XFF sibling be called from `main()` next to delay, not
from verify next to dryrun?
**Answer:** **Yes. `main()` next to delay. Do not copy
dryrun’s cannot-fail contract.** Cycle 263: new sibling,
not stuffed. Dryrun is observation-only (header L32–35
“cannot change the exit status”; L39 “never fails the
deploy”). Tests pin SUCCESS 0 plus `did not affect this
deploy` (`eb-deploy.test.sh` L897–901). An XFF pin that
copied that contract would make an LB IAM miss
**GitHub-green / prod-wrong** — worse than cycle 247’s
GitHub-red / prod-green. ENG-823 `fail()` after SUCCESS
is the honest pin face (L845, L858). Do **not** add that
pin from A-019. Do not un-park A-020. Do not 503
`/health`. Do not add A-021.

## Evidence

### Two after-success slots, two contracts

```32:39:.github/scripts/eb-deploy.sh
#   EB_HEALTH_PROBE_DRYRUN       '1' exercises the lagging-rollup health probe on
#                                an already-successful deploy and logs what it
#                                saw. Observation only — it runs after the deploy
#                                is confirmed and cannot change the exit status.
...
#                                as INERT; it never fails the deploy.
```

```739:742:.github/scripts/eb-deploy.sh
        log "SUCCESS: environment '${EB_ENVIRONMENT_NAME}' is Ready, running version '${EB_VERSION_LABEL}', health=${EB_HEALTH}."
        run_health_probe_dryrun
        return 0
```

```895:898:.github/scripts/eb-deploy.sh
  log "Deployment of '${EB_VERSION_LABEL}' to '${EB_ENVIRONMENT_NAME}' is complete and verified."

  ensure_deregistration_delay
}
```

Dryrun sits **between** the SUCCESS log and `return 0`.
It still cannot `fail()`: stalled probe is INERT L453
`return 0`; tests L970 / L991 are exit 0. Delay sits
**after** verify returns. Denied TG modify fails the job
(test L868–877). Cycle 247: that fail is after SUCCESS,
no `abort-environment-update`.

A pin’s job is to refuse “fully applied” when the
attribute is wrong (L858). Copying dryrun would log
INERT and exit 0 with XFF still at whatever the console
left — the `.ebextensions` silent-drop class ENG-823
exists to catch.

Hermes / Oh My Pi: no observation-vs-pin after-success
fork. AgentWeb’s cutting-edge SDLC is in-process 503; a
later XFF pin should `fail()` like ENG-823, from
`main()`, not ride verify’s observation hook.

## First-slice correction (A-019 stays ready; A-020 stays park)

Keep JSON 503 at POST `/mcp` like `runScheduledChats` L13032.
Add:

- Do **not** call an XFF pin from `verify_deployment`
  next to dryrun.
- Do **not** copy dryrun’s cannot-fail / INERT contract
  onto XFF.
- Call from `main()` after verify, like delay (L897).
- Do **not** add that pin from A-019.

Ready status of Q-001 / Q-014 / Q-003 is not falsified. A-006
stays discarded.

## Relation to A-002 / A-007 / A-008

Unchanged. A-019 is still the architecture item after #2+#3.

## Next cycle

File-level only: `main()` would then have delay then
XFF, or XFF then delay. Sequential `fail()` (cycle 256)
means the first miss never reaches the second. Calling
XFF **before** delay would let a new LB IAM miss skip
today’s ENG-823 TG pin. Should delay stay first? Do not
reorder delay behind XFF. Do not add that pin from
A-019. Do not un-park A-020. Do not 503 `/health`. Do
not add A-021. Do not un-ready Q-001 / Q-014 / Q-003.
Do not revive A-006. Do not mint a timer unless Kevin
asks.
