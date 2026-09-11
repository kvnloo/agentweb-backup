# Cycle 121 — a `/mcp` location is instance-only; ENG-836 allows it alone

**UTC:** 2026-09-11T23:22:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.

## Question

Cycle 120: git never chooses among 3001 / 8080 / 5000. Would a
`/mcp` `location` (copy `websocket.conf`, still hardcoded 8080) be
the git pin — and does ENG-836 treat that `.platform` edit as
instance config that cannot ship with a resource `.ebextensions`
change in the same PR?

## Finding

**Yes it is instance config; the gate allows it alone, and
forbids it next to ALB/ASG `.ebextensions`.** It still would not
name the platform nginx.conf. It would be a second hardcoded 8080.

`eb-config-conflict.sh` L7–18: Immutable refuses resource +
instance in one `update-environment` (PR #2237, ~29h). L190–193:
**every** `*.platform/*` is instance — content not parsed.
L196–197: anything else (`eb-deploy.sh`, `server.ts`) is skipped.
L188–192 of the test: instance-only nginx **passes** (“deploy 2
of 2”). L124–130: `timeout.config` + `.platform/nginx` is
`EB_CONFIG_CONFLICT`. L56–58: resource-only also **passes** the
gate and can still be rejected in prod.

`tests.yml` L61–65: the job runs on `**/.platform/**` (and
`.ebextensions`, the conflict script, `tests.yml`). It does
**not** list `eb-deploy.sh`. L246 has **no** draft skip (unlike
backend-build L70). A `/mcp` location would run the job and pass
if it is the only classified file. A-020 (`eb-deploy.sh`) would
not even start this job; pairing them is invisible to ENG-836.

A new `elasticbeanstalk/mcp.conf` `location /mcp/` would pin the
path in git and still hardcode 8080 like `websocket.conf` L6 —
the same unbound bet as cycle 120. It would not substitute `$PORT`
(nginx does not). Do not add A-021. Do not vendor it instead of
Q-014. Hermes/OMP: no instance/resource split; one listen.

## Queue effect

A-020 stays **park**. A-019 stays **park**. A-006 stays
**discard**. Do not add A-021. Q-001 stays **ready**. Q-014 stays
**ready**.

## Next

Cycle 122: cheapest remaining. Candidate: `tests.yml` L70
draft-skips backend-build but L246 does not skip the conflict job
— is that the SDLC ratchet that would catch a `/mcp` location on
a draft architecture PR, and does a pass still refuse
deployability (`eb-config-conflict.test.sh` L200–201)?
Do not un-ready Q-001 / Q-014 / Q-003. Unsubscribe after
`2026-09-12T06:00:00Z`.
