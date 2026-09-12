# Cycle 247 — a later XFF IAM miss is GitHub-red / prod-green, not an A-019 503

**Date:** 2026-09-12T08:20:00Z
**Question:** `main()` logs “complete and verified”
(`eb-deploy.sh` L895) **then** `ensure_deregistration_delay`
(L897). A denied Describe would fail GitHub **after** the
environment is already Ready on the new version. Is a
later XFF pin therefore GitHub-red / prod-green on IAM
miss, not an A-019 503?
**Answer:** **Yes.** `verify_deployment` already logged
`SUCCESS: environment … is Ready, running version …`
(L740–742) and returned 0. `main()` then logs complete
(L895) and only then calls the pin (L897). `fail()`
(`L155–159`) prints `EB_DEPLOY_FAILED` and `exit 1`. There
is no `abort-environment-update` / rollback in this script
or in `deploy.yml`. The GitHub step is red; the EB
environment stays Ready on the new version; Hermes is
already on that instance. `deploy-failure-alert` fires
when `backend-deploy.result == 'failure'` (`deploy.yml`
L382–386). That page is a live version whose XFF pin did
not run, not an A-019 drain 503. Do **not** add that pin
from A-019. Do not 503 `/health` to “match” a red GitHub
job. Do not un-park A-020. Do not add A-021.

## Evidence

### SUCCESS is committed before the pin runs

```730:742:.github/scripts/eb-deploy.sh
    if [ "${EB_STATUS}" = "Ready" ] && [ "${EB_CURRENT_VERSION}" = "${EB_VERSION_LABEL}" ]; then
      ...
        log "SUCCESS: environment '${EB_ENVIRONMENT_NAME}' is Ready, running version '${EB_VERSION_LABEL}', health=${EB_HEALTH}."
        run_health_probe_dryrun
        return 0
```

```895:898:.github/scripts/eb-deploy.sh
  log "Deployment of '${EB_VERSION_LABEL}' to '${EB_ENVIRONMENT_NAME}' is complete and verified."

  ensure_deregistration_delay
}
```

ENG-823’s denied-Modify test (`eb-deploy.test.sh` L868–877)
uses a fixture that is already `Ready|Green` on the new
version, then expects exit 1. The version was applied. The
comment “rather than reporting the deploy as fully applied
when it was not” means the **pin** did not stick, not that
EB rolled back. Cycle 246: denied Describe fails even earlier
in that function, still after L895.

`rg abort-environment-update` in `.github` is empty. `fail()`
does not swap versions. Hermes’ next `tools/call` hits the
new instance’s `/mcp`. A-019 503 is only when that process
is draining (`!isCronEnabled`). A post-verify IAM miss does
not drain anyone.

### The alert pages a live version

`deploy.yml` L382–386: `backend-deploy.result == 'failure'`
starts `deploy-failure-alert`. An XFF sibling that copied
ENG-823’s after-verify slot would page oncall for
`describe-load-balancer-attributes failed` while
`api.agentweb.pro` already serves the merge. That is ops,
not drain color (cycle 230).

Hermes / Oh My Pi: no GitHub/EB split. AgentWeb’s
cutting-edge SDLC is in-process 503 during overlap; a red
Actions job after Ready is a pin-IAM bug, not a fifth
HTTP service and not A-019.

## First-slice correction (A-019 stays ready; A-020 stays park)

Keep JSON 503 at POST `/mcp` like `runScheduledChats` L13032.
Add:

- Do **not** treat a later XFF pin IAM miss as an A-019 503
  (GitHub-red / prod-green; version already Ready).
- Do **not** 503 `/health` because the deploy job is red.
- Do **not** add `abort-environment-update` from A-019.

Ready status of Q-001 / Q-014 / Q-003 is not falsified. A-006
stays discarded.

## Relation to A-002 / A-007 / A-008

Unchanged. A-019 is still the architecture item after #2+#3.

## Next cycle

File-level only: ENG-823 is after verify because it repairs
the surviving **target group** after Immutable ASG swap.
The ALB ARN itself already exists before `update-environment`
(cycle 242). Could a later XFF pin run **before**
`update-environment` so an IAM miss fails closed without
applying the version — unlike copying ENG-823’s after-verify
slot? Do not add that pin from A-019. Do not un-park A-020
(A-020 is the surviving **ASG** hook after verify). Do not
503 `/health`. Do not add A-021. Do not un-ready Q-001 /
Q-014 / Q-003. Do not revive A-006. Do not mint a timer
unless Kevin asks.
