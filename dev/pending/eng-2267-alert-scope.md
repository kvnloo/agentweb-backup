## ENG-2267: Meta tracking alerts file one canonical per ad account (2026-10-08)

Per-account Meta tracking-monitor alerts now carry `Alert Scope: meta-ad-account:<id>`; intake clusters on class AND scope, so different customers' accounts no longer fold onto one Linear issue. Unscoped alert classes are unchanged.
