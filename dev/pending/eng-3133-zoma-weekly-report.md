## ENG-3133: weekly Zoma ad-performance email, dark behind ZOMA_WEEKLY_REPORT_ENABLED (2026-11-17)

- **What users get:** once a week, a short email with last-7-days Meta ad performance
  (`zoma_ads_report` account summary), the confirmed changes Zoma made for them, and their
  successful call count. No email when there is nothing to report. Copy needs Harsha's review
  before the flag is turned on (`weeklyReportEmail` in `mcp/zomaWeeklyReport.ts`).
- **Who:** Zoma users (scoreboard list) who are not internal/test/admin accounts or "pal" leads,
  have not unsubscribed, made at least one successful call in the window, and have ad delivery or
  a confirmed change to report.
- **When:** an hourly job (`ZomaWeeklyReport`, first pass 11 minutes after boot) that acts only
  inside the send window: `ZOMA_WEEKLY_REPORT_WEEKDAY` (default 1 = Monday, UTC) from
  `ZOMA_WEEKLY_REPORT_HOUR` (default 15, UTC) to the end of that day. A no-op unless
  `ZOMA_WEEKLY_REPORT_ENABLED=true`. `ZOMA_WEEKLY_REPORT_MAX_PER_PASS` (default 200) caps one pass.
- **Exactly once per user per ISO week, across instances:** a conditional write claims
  (user, ISO week) BEFORE the send. A failed send is logged and not retried that week.
- **Opt-out, scoped to this email only:** a signed link (HMAC of the user id with the JWT secret,
  never expires). `GET /api/zoma/weekly-report/unsubscribe?t=...` shows a confirm button and
  changes nothing; `POST` records the opt-out. It does not touch Emma, outreach or any other mail.
- **No new table, column or index.** The claim, sent and opt-out rows are `zoma_billing_funnel`
  rows in the existing MCP usage-event table with new `step` values (`weekly_report_claimed`,
  `weekly_report_sent`, `weekly_report_opt_out`). The opt-out is read with one exact-key GetItem
  (new optional `get` on the event store). Harsha to confirm this counts as outside the
  data-plane gate.
- **Rollback:** leave `ZOMA_WEEKLY_REPORT_ENABLED` unset.
