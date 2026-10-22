## ENG-2546: Pure ATO segment write-back payload builder (2026-10-19)

`backend/src/services/dripAtoSegmentWriteback.ts` maps drip outcomes (no_response/replied/booked/unsubscribed/bounced) to a config-driven, idempotent ATO tag diff. Pure; no ATO calls or wiring yet.
