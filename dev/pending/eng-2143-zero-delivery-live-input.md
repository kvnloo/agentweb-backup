## ENG-2143: Feed live Google Ads campaign delivery into the zero-delivery health check (2026-10-13)

- `googleAdsService.getCampaignDelivery` (read-only GAQL: status, budget, start/end, 7-day impressions/clicks, recent `change_event`s) now feeds `accountHealthClassifierCron` `signals.campaigns`, which was hard-coded `null`.
- Go-live is the later of `campaign.start_date_time` and the latest campaign `change_event` in the 7-day window (the API has no "enabled since" field), so a re-enabled campaign gets a fresh 24h grace. A passed `campaign.end_date_time` reports `ENDED`, which the classifier excludes. Account-timezone date-times are read as UTC and skewed toward abstaining.
- A failed/truncated read (including 429, no retry) stays unread (`null`), never zero delivery; one failing Google account leaves that user unread. No schema/data-plane change; Meta campaigns remain unread; no flag changes.
- `--dry-run` of the cron still makes live (read-only) Google Ads calls and consumes API quota.
