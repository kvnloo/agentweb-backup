## ENG-3143: capture-drift alerts file one oncall item per site (2026-11-21)

`captureDriftMonitor` now sends `Alert Scope: lp-repo:<owner/repo>` with each alert. Intake dedupes on
`Alert Class` unless a scope narrows it (ENG-2267), so before this every drifted site folded into the
first site's issue (ENG-3140 received all five on 2026-11-17). Other alert classes are unchanged.
