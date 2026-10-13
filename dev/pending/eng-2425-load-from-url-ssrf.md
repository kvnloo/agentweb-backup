## ENG-2425: SSRF-guard load-from-url endpoints (2026-10-12)

/api/crm/sequences/load-from-url and /api/admin/announcements/load-from-url now fetch via ssrfGuard.fetchPublicHtml (DNS-pinned, per-hop redirect re-validation, 5MB cap, 15s total timeout); private/loopback/link-local targets return 400.
