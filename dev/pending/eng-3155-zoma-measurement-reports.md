## ENG-3155: Zoma proactive measurement reports (2026-11-18)

- `zoma_measurement_report` (mcp/zomaMeasurementReport.ts) reuses `runZomaAdsReport` for campaign metrics and the
  monitor_lead_volume data path (ENG-916 snapshots + `buildLeadVolumeReport`) for CRM leads, scoped to the caller's
  own account so no admin lookup is needed. Breakdowns (top ads, age/gender, placement, device) fail soft: a failed or
  empty read omits the section.
- It renders a Zoma-owned deterministic template rather than the public `multi_campaign_performance_report`: that
  template is a prod `AW-Settings` row filled by an LLM, so adding Conversions/ROAS there would be a prod data write
  and a non-deterministic render. The layout is the same, plus Conversions and ROAS columns.
- Schedules live in the new `AW-ZomaReportSchedules` table (PK userId, SK adAccountId). It must be created
  (`createZomaReportSchedulesTable`) before `ZOMA_MEASUREMENT_REPORTS_ENABLED=true`. Exactly-once is a conditional
  update on `nextReportAt` that claims the slot before the send.
- With the flag on, the ENG-3133 weekly email skips users who have an active measurement schedule.
