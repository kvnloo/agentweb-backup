## ENG-2544: Pure Resend webhook -> drip stop-event mapper (2026-10-19)

Added `backend/src/services/dripResendStopEvents.ts`: maps hard bounces to `bounced` and complaints to `unsubscribed` SequenceEvents; soft bounces, other events and invalid timestamps return null. Child of ENG-2167.
