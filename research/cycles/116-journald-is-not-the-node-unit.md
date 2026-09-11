# Cycle 116 — log-retention names `systemd-journald`, not the Node unit

**UTC:** 2026-09-11T23:06:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.

## Question

Cycle 115: Sunday SIGTERM is OS/cgroup; this tree has no backend
`TimeoutStopSec`. Does `06-log-retention.config` journald cap
imply a platform unit we can name, or is Sunday stop-timeout
live-AWS-only?

## Finding

**It names `systemd-journald`, not the app.** Sunday Node
`TimeoutStopSec` is live-AWS-only. The drop-in proves this tree
*can* talk to systemd from `.ebextensions`; it chose a log cap,
not a stop timeout, and never wrote the Node unit’s name.

`06-log-retention.config` L9 / L32–43 writes
`/etc/systemd/journald.conf.d/10-agentweb-cap.conf`
(`SystemMaxUse=200M`) and `systemctl restart systemd-journald`
(`|| true`). That is the journal daemon. Comment L9: “mirror of
stdout.” It does not mention `TimeoutStopSec`, `web.service`,
`webapp`, or `KillMode`.

`.platform/` has **no** `hooks/` (four nginx confs only).
`client_max_body_size.conf` L8–11 names **nginx**’s systemd
`/var/tmp` namespace — still not Node. CLAUDE.md L544 /
`linkedInOutreachService.ts` L95 name `web.stdout.log` as the
Node **log file**, not a `systemctl` unit.

ENG-818 (cycle 113) is the ASG lifecycle hook: an environment
resource that Immutable discards. A journald drop-in is
**instance-local** and already rides Immutable (new instances run
`container_commands`). That pattern could set `TimeoutStopSec` *if*
we knew the unit. We do not, from git. Copying agent-engine’s
**30s** (`agent-engine.service` L82) onto the backend would SIGKILL
inside `DRAIN_CEILING_MS` 10 min — worse than today’s unknown
default. Do not add that drop-in from this cycle. A-020 (ASG
wait) is still the wait that is not a guess at the unit name.

Hermes/OMP: one process, no journald. AgentWeb’s cutting-edge
SDLC is A-020 on the surviving ASG, not a fifth `listen()` with
its own unknown systemd stop.

## Queue effect

A-020 stays **park**. A-019 stays **park**. A-006 stays
**discard**. Q-001 stays **ready**. Q-014 stays **ready**.

## Next

Cycle 117: cheapest remaining. Candidate: inbound Hermes hits
nginx first (cycle 107). On Sunday stop, does the **nginx**
systemd unit (named in `client_max_body_size.conf`) go down
before Node, so Hermes 502s while `runDrain` still holds PORT?
Do not un-ready Q-001 / Q-014 / Q-003. Unsubscribe after
`2026-09-12T06:00:00Z`.
