## ENG-3133: weekly Zoma ad-performance email, dark behind ZOMA_WEEKLY_REPORT_ENABLED (2026-11-17)

- **What users get:** once a week, a short email with the last 7 days of ad performance for each
  connected ad account (Meta via `zoma_ads_report` totals; Google Ads via an exact-window GAQL on the
  `customer` resource, cost micros converted to currency units): spend, impressions, clicks,
  conversions, and return on ad spend where there is one. Plus the confirmed changes Zoma made and the
  successful call count. A connected account with no delivery says so; one that cannot be read says so
  (never "no delivery"); a user with no connected ad account is told how to connect one. Copy needs
  Harsha's review before the flag is turned on (`weeklyReportEmail` in `mcp/zomaWeeklyReport.ts`).
- **Who:** every Zoma user (scoreboard list) who is not an internal/test/admin account or a "pal" lead,
  has not unsubscribed, and made at least one successful Zoma call in the last 7 days. Nobody else.
- **When:** an hourly job (`ZomaWeeklyReport`, first pass 11 minutes after boot) that acts only inside
  the send window: `ZOMA_WEEKLY_REPORT_WEEKDAY` (default 1 = Monday, UTC) from
  `ZOMA_WEEKLY_REPORT_HOUR` (default 15, UTC) to the end of that day. A no-op unless
  `ZOMA_WEEKLY_REPORT_ENABLED=true`. `ZOMA_WEEKLY_REPORT_MAX_PER_PASS` (default 200) caps one pass.
- **Exactly once per user per ISO week, across instances:** a conditional write claims
  (user, ISO week) BEFORE the send. A failed send is logged and not retried that week. A failure to
  read the ad accounts skips the user for that pass (nothing claimed, retried next hour).
- **Opt-out, scoped to this email only:** `User.zomaWeeklyReportOptOutAt` (new optional attribute, like
  `dripUnsubscribed` and `slackShipNotifyDisabled`). The users table has point-in-time recovery, the
  attribute is already on the row the job scans, and it travels with the account. The job checks the scan
  row, then re-reads the user consistently right before the claim. The link is signed (HMAC of the user id
  with the JWT secret, like the CRM unsubscribe links); `GET /api/zoma/weekly-report/unsubscribe?t=...`
  shows a confirm button and changes nothing, `POST` sets the attribute with a partial update of that one
  user (an unknown user creates nothing). It does not touch Emma, outreach or any other mail.
- **Data:** one new optional attribute on the user record; the week claim and sent rows are
  `zoma_billing_funnel` rows in the existing MCP usage-event table (new `step` values
  `weekly_report_claimed`, `weekly_report_sent`, read with an exact-key consistent GetItem via a new
  optional `get` on the event store). No new table, index or key. Harsha to confirm this is outside
  the data-plane gate (the user-record attribute is a model change).
- **Rollback:** leave `ZOMA_WEEKLY_REPORT_ENABLED` unset.
