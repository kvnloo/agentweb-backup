## ENG-2898: get_conversion_summary own-account MCP tool (2026-11-10)

New read-only MCP tool `get_conversion_summary` (aw_ tools:read callable): for the key owner only, over a YYYY-MM-DD range (default last 30 days, max 366), returns per-landing-page unique leads + form-submission conversions, per-lead-list leads added, and totals. Counts/ids/names only; org-member lists/pages excluded; client_id/user_id rejected. Uses existing own-scoped routes, bounded scan of 10k leads with `truncated` flag; no schema/index change.
