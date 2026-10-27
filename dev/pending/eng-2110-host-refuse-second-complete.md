## ENG-2110: the login host refuses a second `login.complete` for a ready attempt (2026-10-27)

- **Problem.** `login.complete` only checked that the attempt existed. A second complete for an attempt that had already taken its code (a client retry, or, once a sign-in can be finished by any backend instance, the same sign-in reaching two instances) handed the spent code to the finished CLI process, which failed, so the host discarded the ready login. The first request's promote then found nothing and the user lost the sign-in after spending the code.
- **Change.** `loginComplete` now answers `ESTATE login_not_pending` (the backend maps it to `login_not_found`) unless the attempt is still `pending`, and touches nothing. The host already serialises requests per connection, so this is atomic.
- **Deploy.** This is a worker change: the signed pipeline deploys it when it merges (blocked while `/etc/aw-login-host/hold` exists). Protocol version unchanged; an older backend is unaffected.
- **Limit.** A `login.cancel` from another instance while a complete is finishing can still discard the ready login; the backend ignores cancel only for completes it is running itself.
