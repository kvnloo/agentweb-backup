## ENG-2539: pure inbound-reply classifier for drip exit-on-reply (2026-10-19)

- `backend/src/services/dripInboundReplyClassifier.ts`: classifies inbound replies as human_reply / auto_reply / out_of_office / bounce / unknown; only human_reply exits a sequence. Pure, not yet wired.
