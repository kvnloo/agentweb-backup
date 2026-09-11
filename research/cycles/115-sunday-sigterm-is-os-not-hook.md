# Cycle 115 — Sunday still gets OS SIGTERM; this tree does not keep it alive

**UTC:** 2026-09-11T23:03:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.

## Question

Cycle 114: the guard still drains on IMDS `Terminated` without a
hook; the ASG does not wait. Does EB/OS still send SIGTERM on
Sunday Instance Refresh without our hook, so
`gracefulShutdown('SIGTERM')` starts drain even if IMDS is late?

## Finding

**Yes, SIGTERM is the OS/cgroup path this tree already documents
(ENG-201). It does not depend on our hook.** The hook only
*delays* SIGTERM by parking `Terminating:Wait`. Sunday without
the hook still gets instance-stop SIGTERM. This repo does not
configure how long that process then lives.

`server.ts` L474–475 only **listens**. `.platform/` is four nginx
confs — zero `SIGTERM` / `TimeoutStopSec`. `.ebextensions` has
no stop hook (`chromium.config` is yum Chrome; `06-log-retention`
is logrotate/CloudWatch). No `Procfile`. The only
`TimeoutStopSec` in the repo is `agent-engine/deploy/agent-engine.service`
L82–83 (**30s**, GCP VM) — a different deploy unit.

`workerShutdownGuards.ts` L1–9: the OS delivers SIGTERM to the
whole cgroup on “graceful shutdown or deploy.” That is ENG-201,
not the hook. `asgLifecycleGuard.ts` L18–19: IMDS `Terminated`
is **before** any SIGTERM. L12–15: SIGTERM drain exists and
still does not make the ASG wait.

`runDrain` L378: “EB Timeout: 900 s sits above this so EB never
force-kills first.” That 900s is `rolling.config` L7 **command**
Timeout for Immutable *deploys*. Sunday `InstanceRefreshEnabled`
is not that command (cycle 110). It does not inherit 900s.

Direct SIGTERM (cycle 93): `mcpShutdown` runs **first** and
closes inbound MCP, then `gracefulShutdown` drains and
`process.exit(0)` (L466–471). The ASG path stays alive to answer
the hook (L359–365) and does not call `mcpShutdown` until later
SIGTERM. Sunday without hook is the **direct** path: close Hermes
CallTool, then drain, then whatever systemd default is — not
in this git. `DRAIN_CEILING_MS` 10 min (`shutdownConstants.ts` L8)
is an in-process ceiling, not an OS wait.

Do not add `.platform` systemd overrides from this cycle (ENG-818
shape). Do not copy agent-engine’s 30s onto the backend. Hermes/OMP:
one process, no cgroup. AgentWeb’s cutting-edge SDLC is A-020
(ASG waits) so SIGTERM is late, plus A-019 once `disableCron`
runs. A fifth `listen()` gets this SIGTERM with Node’s default
handler (cycle 74).

## Queue effect

A-020 stays **park**. A-019 stays **park**. A-006 stays
**discard**. Q-001 stays **ready**. Q-014 stays **ready**.

## Next

Cycle 116: cheapest remaining. Candidate: systemd/webapp
`TimeoutStopSec` is not in this tree — does
`06-log-retention.config` journald cap imply a platform unit we
can name, or is Sunday stop-timeout live-AWS-only?
Do not un-ready Q-001 / Q-014 / Q-003. Unsubscribe after
`2026-09-12T06:00:00Z`.
