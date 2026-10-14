## DRAMABREAK: observed channel beats link tag; Nova paid channel (2026-10-14)

Classifier 2.2.0. Decided by Harsha 2026-10-14 (DramaBreak attribution decision queue, all recommendations):
- Channel = in-app browser UA, then referrer, then utm_source, then click id, then fallback. Agency and paid links keep the link's platform.
- New row fields `linkChannel` (what the link claims) and `detectedChannel` (what we observed), reported side by side.
- New channels: `nova` (NewsBreak Ads, Paid by construction) and `newsbreak` (newsbreak.com referral).
- Not backfilled: only new sessions use 2.2.0 (rows carry classifierVersion). A backfill is a data-plane change and needs separate approval.
