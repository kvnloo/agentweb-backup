## ENG-2555: pure customer sender identity (From/Reply-To) builder (2026-10-19)

Added `backend/src/services/dripSenderIdentity.ts`: builds RFC 5322 From/Reply-To values for customer-domain sends (ENG-2167 Phase 1), rejecting CR/LF/NUL header injection, invalid addresses, overlong names and disallowed domains. Pure, not yet wired.
