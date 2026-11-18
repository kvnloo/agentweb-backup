## ENG-3128: Zoma asks "How familiar are you with ads?" after signup (2026-11-16)

- One directed question, asked before any other setup step, on three surfaces: the device-flow
  browser page (`POST /api/zoma/ads-experience`), the setup poll (`next_step: "ads_experience"`,
  answer sent back as `ads_experience` in the poll body), and `zoma_status` (`ads_experience` arg).
- Answers (`AW-Users.zomaAdsExperience` + `zomaAdsExperienceAt`, written via `userDb.updateUser`):
  `runs_ads` -> connect ad accounts -> card -> done; `new_to_ads` -> setup guide (Meta Business
  portfolio, Facebook Page, ad account; Google Ads) then connect; `not_interested` -> thank-you,
  no further steps, no Zoma token from the poll.
- `not_interested` users are listed but excluded from the scoreboard summary
  (`excluded: "not_interested"`) and never due / stalled / needing help in the activation queue.
- `zoma_status` order changed to ad accounts before the card (the device flow already did this).
- Users who signed up before this ship have no answer, so their next `zoma_status` / setup poll
  asks the question once before resuming where they were.
- Not changed: `zoma_status`'s non-device payment link still returns to the portal settings page
  (`/settings?zoma=payment_method_added`); the card requirement is paused by default.
