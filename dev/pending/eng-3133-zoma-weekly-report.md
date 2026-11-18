## ENG-3133: weekly Zoma ad-performance email, dark behind ZOMA_WEEKLY_REPORT_ENABLED (2026-11-17)

- **What users get:** once a week, an email with each connected ad platform's last 7 complete days
  (ending yesterday, never a half-finished day) set against the 7 days before: spend, conversions, cost
  per conversion, clicks, click rate and cost per click (plus return on ad spend where Meta reports a
  value), each with its change versus last week; a daily-spend bar chart with a most-conversions /
  quiet-days line (a tie is never turned into a winner);
  the top 3 campaigns by spend, each with its cost per conversion and a cheapest-vs-dearest line; up to
  three plain "worth a look" flags (spend with no conversions all week, spend that stopped for the last
  2+ days, a top campaign that spent with no conversions; Meta flags name the one conversion event the
  account counts, and say nothing about single campaigns when that event is mixed); and one
  deterministic sentence about the
  week (only when last week gives a baseline). Nothing is guessed: no benchmarks, no causes. A note says
  recent conversions can still go up (platforms credit them for days after a click). Charts are plain HTML table cells, so
  they render with images off and need no hosting; the text part carries the same numbers. Platforms
  are never added together (currencies can differ). Then what Zoma did: changes made, each with its
  read-back verdict, and the successful call count. A connected account with no delivery says so; one
  that cannot be read, or whose connection expired, says so (never "no delivery", never "not
  connected"); a user with no connected ad account is told how to connect one. Copy needs Harsha's
  review before the flag is turned on (`weeklyReportEmail` in `mcp/zomaWeeklyReport.ts`).
- **Data sources:** Meta: one account-level daily insights read over 14 days (`runZomaAdsDaily`,
  additive in `mcp/zomaAdsReport.ts`; the tool surface is unchanged) plus a campaign-level report for
  the ranking. Google Ads: a daily GAQL on `customer` and a top-3 GAQL on `campaign`, cost micros
  converted to currency units. Both platforms omit days with no delivery, so missing days are
  zero-filled. A failed campaign ranking drops only that block. Every usable ad account of a platform
  (up to 5, each stored account read once) is read, because Zoma itself picks one by spend (Meta) or
  refuses as ambiguous (Google): accounts in the same currency are added together (return on ad spend
  is then dropped), the currency with most accounts is shown, and the rest are counted in a "Not
  included here" line. "No delivery" is only said when every account was read and none delivered;
  accounts beyond the limit are "not checked" and never turn a result into "could not read". The Google section appears only while
  `ZOMA_GOOGLE_ADS_ENABLED` is on (the same flag as the Google toolkit).
- **Who:** every Zoma user (scoreboard list) who is not an internal/test/admin account or a "pal" lead,
  has not unsubscribed, and made at least one successful call to the Zoma toolkit in the last 7 days
  (Emma's own MCP calls, which share the event type, are filtered out by `product`). Nobody else.
  `ZOMA_WEEKLY_REPORT_ONLY_USER_IDS` (comma list) restricts a pass to named users: use it for the first
  send.
- **When:** an hourly job (`ZomaWeeklyReport`, first pass 11 minutes after boot) that acts only inside
  the send window: `ZOMA_WEEKLY_REPORT_WEEKDAY` (default 1 = Monday, UTC) from
  `ZOMA_WEEKLY_REPORT_HOUR` (default 15, UTC) to the end of that day. A no-op unless
  `ZOMA_WEEKLY_REPORT_ENABLED=true`. The hour cannot be set earlier than 12:00 UTC (by then every ad
  account time zone has finished the Sunday the report ends on). `ZOMA_WEEKLY_REPORT_MAX_PER_PASS`
  (default 200) caps one pass and logs when it is hit. A pass stops after 3 sends in a row fail, so a
  mail outage cannot burn the week for everyone. Usage for all users is ONE range query per pass, grouped in memory.
- **Exactly once per user per ISO week, across instances:** a conditional write claims
  (user, ISO week) BEFORE the send; the email is built before the claim so a build failure cannot burn
  the week. A failed send is logged and not retried that week. A transient failure reading an ad
  account skips the user for that pass (nothing claimed, retried next hour); on the last hourly tick of
  the window (23:00 UTC) it is reported as "could not read" instead. Expired or revoked connections are
  reported right away.
- **The claim row is environment-scoped.** It lives in the loop-events table, whose name is the same
  in every environment while non-production users are clones of production (same user ids), so a
  non-production claim carries a `nonprod#` prefix and can never block production's send.
- **Opt-out, scoped to this email only:** `User.zomaWeeklyReportOptOutAt` (new optional attribute, like
  `dripUnsubscribed` and `slackShipNotifyDisabled`). The users table has point-in-time recovery, the
  attribute is already on the row the job scans, and it travels with the account. The job checks the scan
  row, then re-reads the user consistently right before the claim and sends to the address read then;
  an account that cannot be resolved is not emailed. The link (a token derived from the JWT
  secret) is opaque: AES-256-GCM over the user id, so no internal id is visible in the link and any
  change is rejected; `GET /api/zoma/weekly-report/unsubscribe?t=...` shows a
  confirm button and changes nothing, `POST` sets the attribute with a partial update of that one user
  (an unknown user creates nothing). The email also carries `List-Unsubscribe` and
  `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (new optional `headers` argument on
  `emailService.sendEmail`), and the POST accepts the token from the query string for that one-click
  request. It does not touch Emma, outreach or any other mail.
- **Data:** one new optional attribute on the user record; the week claim is a `zoma_billing_funnel`
  row in the existing MCP usage-event table (new `step` value `weekly_report_claimed`, read with an
  exact-key consistent GetItem via a new optional `get` on the event store; a new optional
  `queryByLoopIdTsRangeAll` does the one all-users range read). No new table, index or key. Harsha to
  confirm this is outside the data-plane gate (the user-record attribute is a model change).
- **Known limits:** a user who deletes the account and signs up again loses the opt-out (an
  email-keyed suppression table would fix that; it is a new table, so out of scope here). The candidate
  list is the scoreboard's Zoma-user list, so a caller whose `products.zoma` flag was never written is
  not emailed. A write whose own bookkeeping failed is not in the changes count, so the wording says
  "recorded", not "made". If the mail provider is down for the first three sends of a pass, those three
  users' week is spent (a missed weekly email was judged cheaper than a duplicate).
- **Rollback:** leave `ZOMA_WEEKLY_REPORT_ENABLED` unset.
