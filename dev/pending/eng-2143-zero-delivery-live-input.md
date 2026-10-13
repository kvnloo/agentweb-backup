## ENG-1913: Feed live Google Ads campaign delivery into the zero-delivery health check (2026-10-10)

- `googleAdsService.getCampaignDelivery` (read-only GAQL: status, budget, start, 7-day impressions/clicks) now feeds `accountHealthClassifierCron` `signals.campaigns`, which was hard-coded `null`.
- A failed/truncated read stays unread (`null`), never zero delivery. No schema/data-plane change; Meta campaigns remain unread.
