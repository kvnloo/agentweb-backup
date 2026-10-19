## ENG-2543: Pure Calendly booking webhook verifier + stop-on-booking exit decision (2026-10-19)

Added `backend/src/services/calendlyBookingExit.ts`: `verifyCalendlyWebhook` (t/v1 HMAC-SHA256, constant-time, tolerance window, distinct failure reasons), `normalizeCalendlyEvent` (invitee.created/canceled -> booked/canceled, others ignored), `bookingExitDecision` (exit matching active enrollments, idempotent, cancel never re-enrolls). Not wired to a route yet (ENG-2167 slice).
