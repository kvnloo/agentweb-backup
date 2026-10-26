## ENG-2667: LP consent banner + Google Consent Mode v2 util (2026-10-26)

- New pure `backend/src/utils/consentInjection.ts`: for sites in attributionCookies `consent` mode, prepends gtag consent default=denied before any tag, defers our Meta Pixel init behind `aw_consent=granted`, drops the ungateable noscript beacon, and appends a neutral Accept/Reject banner that writes `aw_consent`. `on`/`off` layouts are byte-identical.
- Not yet called by generation: there is no persisted per-site mode (persisting it is data-plane, gated). Banner copy is placeholder pending Harsha review.
