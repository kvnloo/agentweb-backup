## ENG-2566: pure Resend send-error classifier for drip steps (2026-10-19)

- `backend/src/services/dripResendSendError.ts`: maps a failed customer-key Resend send to retry / skip_recipient / pause_sequence. Pure, not wired.
