## ENG-3095: daily domain check now probes landing-page hosts that have no domain record (2026-11-16)

`backend/src/cron/domainReachabilityCron.ts` only probed hosts that have an `AW-CustomDomains`
row. A deployed page whose stored `agentwebforms.com` host has no row was never probed, and
`reconcileUnregisteredDomains` deliberately does not create one. Two such pages served an
expired certificate from August to November 2026 unnoticed.

- `selectRowlessManagedHosts` finds deployed pages whose managed host has no row.
  `probeRowlessManagedHosts` probes each with the monitor's own `probeDomain`. A failing host is
  probed a second time in the same run; only two failures in a row count as failing.
- One new log line per run:
  `[DomainReachability] rowless-managed-hosts=N failing=M :: page=<id> host=<host> result=ok(200) ; page=<id> host=<host> result=FAILED(suspect CERT_HAS_EXPIRED)`
- When at least one host fails, one `emailService.sendOncallAlert` per run lists the failing
  hosts. Internal oncall list only, production only (the helper suppresses it elsewhere).
- Nothing is written for these hosts: no row, no field, no page change. That also means there is
  no memory between runs, so a host that stays broken is alerted once every day until its record
  is fixed.
- `SweepSummary` gains `rowlessManagedHosts` and `rowlessManagedFailing`.
- Tests: `backend/src/__tests__/cron.domainReachabilityRowless.test.ts`.
