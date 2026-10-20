## ENG-2560: pure customer Resend API key shape validator + display mask (2026-10-19)

Added `backend/src/services/resendApiKeyShape.ts` (ENG-2167 Phase 1 slice): `validateResendApiKey` returns enum rejection reasons that never echo the input; `maskResendApiKey` shows only the last 4 chars. Pure, not wired into any send path yet.
