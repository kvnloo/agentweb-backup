## ENG-2899: registration uniqueness conflict returns an actionable 409 (2026-11-10)

`userDb.createUser` rejects with `ConditionalCheckFailedException` when the email already
occupies the user PK (e.g. a tombstone left by an email change). Register now answers 409
`{ code: "email_unavailable" }` with sign-in / reset / support guidance when no live account
resolves for the email (live-account races keep the existing 400); admin create-from-waitlist
maps the same conflict to 409. Other failures are unchanged (register 503, admin 500).
Shared mapper: `backend/src/utils/createUserError.ts`.
