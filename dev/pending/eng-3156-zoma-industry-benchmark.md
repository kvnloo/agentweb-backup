## ENG-3156: zoma_industry_benchmark — sourced CPA benchmarks, N/A instead of estimates (2026-11-18)

- `backend/src/mcp/zomaIndustryBenchmarks.ts` is a static, versioned table (`INDUSTRY_BENCHMARK_TABLE_VERSION`).
  Every row was read from the source page on 2026-11-18 and its table cell is quoted in a comment. Missing
  (industry, platform, kpi) → `getIndustryBenchmark` returns null → the tool says exactly `Industry benchmark: N/A`.
  No interpolation, no nearest category, no lead→purchase mapping.
- All published sources found are **cost-per-lead tables only** (Meta Leads-objective; Google search ads). There is no
  purchase or registration CPA row, so purchase-KPI accounts get N/A until a real published purchase/ROAS-by-industry
  source is added.
- wordstream.com returns 403 (Cloudflare) to automated fetches; its 2025 pages were read through Wayback Machine
  snapshots (URLs in the file header). Rows keep the canonical wordstream.com URL for attribution.
- LocaliQ's "Search Advertising Benchmarks [2026 Data]" was deliberately NOT used: its overall CPL ($66.69) and CPC
  repeat the prior year's figures and several industry cells repeat. Google rows come from WordStream 2025 instead.
- Customer CPA is Meta-only (zoma_ads_report is Meta-only); the table carries Google rows so ENG-3155's
  zoma_measurement_report can call `getIndustryBenchmark(industry, 'google', kpi)` later. ENG-3155 was not on main
  when this shipped, so nothing here depends on it.
- Accounts whose currency is not USD get the benchmark but no % comparison (no exchange-rate guess).
