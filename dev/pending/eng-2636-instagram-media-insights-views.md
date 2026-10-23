## ENG-2636: Instagram get_post_analytics requested retired impressions/plays (2026-10-23)

`get_post_analytics` failed with "The Media Insights API does not support the impressions metric for this media product type" (prod log 2026-10-22 18:03 UTC). Meta replaced `impressions` / `plays` with `views`, and one unsupported metric fails the whole media-insights request.

`InstagramService.getInstagramMediaInsights` now asks for `views` (the adapter still reports it as `impressions`; it also counts replays, so it will not match historical impressions). When Meta names one metric a media type does not support, only that metric is dropped and the request retried (bounded by the list length); any other error still fails loudly. When no views row comes back, the post carries a `metricErrors` entry so a 0 is not read as a measured value.

**Not verified against live Instagram:** no Instagram Direct Login account with a valid token was available (dev tokens are fixtures, the prod test account has none). Whether `views` is accepted per media product type, and whether `navigation` / `profile_visits` are valid for Reels, is from Meta's documentation, not a live call. The retry only handles the "does not support the X metric" wording, not "must be one of ..." errors.
