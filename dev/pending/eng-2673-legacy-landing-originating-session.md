## ENG-2673: flag-off landing generation forwards the originating chat (2026-10-26)

`generateLandingPage`'s legacy branch (`DURABLE_LANDING_GENERATION` != "true") passed a literal `undefined`
where the originating session id belongs, for both the existing-site sub-page and the first-page build.
Pages built with the flag off were therefore never tied to the chat: no completion / still-building
message, `findInFlightJobForSession` could not reconnect to them, and the auto human-eval candidate had no
session. The branch now forwards `opts.originatingSessionId`, as the flag-on branch always has. No new trust
is introduced: the only caller that passes it, `POST /api/landing-pages/v0/generate`, already reduces the
client-supplied `originating_session_id` through `resolveOriginatingSessionId` (session owner or admin;
delegate tokens make `req.user` the target account) and drops anything else. Completion delivery stays
exactly-once via `claimCompletion`.
