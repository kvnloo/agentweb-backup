## ENG-2684: Stripe billing signals to hireemma.ai session list (2026-10-26)

Stripe webhook + checkout creation emit checkout_started, payment_completed/failed, refund_issued, subscription_started/renewed/plan_changed/cancelled as custom tracker events onto one `acct-<userId>` row in session list `HIREEMMA_SIGNAL_LIST_ID` (default list_1793037224311_9umtchng7) via the existing ingest path. Fire-and-forget; no schema change. Internal telemetry only.
