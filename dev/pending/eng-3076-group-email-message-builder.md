## ENG-3076: group-email send builds each recipient message in one place (2026-11-16)

- `buildGroupEmailRecipientMessage` in `backend/src/routes/crm.ts` now builds subject, html, text and List-Unsubscribe headers for both the background mailbox run and the in-request loop. Behavior unchanged; a characterization test asserts both paths produce the identical message.
