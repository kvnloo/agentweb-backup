## ENG-2816: a logged-in owner on their own share link is the owner, not a visitor (2026-11-05)

First of several changes that make the shared-session tool block hold everywhere (voice and scheduled chats are
the other two paths, built in later PRs). This one only teaches the text route who the owner is.

**Why.** A share link (`/ishare/<sessionId>?conversable=<token>`) runs the turn under the OWNER's userId with
`isInteractiveShare=true`, so the server cannot tell the owner from a visitor. The portal also never sent the
viewer's login on that call, so an owner who opened their own link (for example from a scheduled-run email) was
treated as a visitor. The next PRs restrict what visitor-made schedules and visitor voice can do; they must never
restrict the owner, so the owner has to be recognised first.

**What changed.** `generateSharedResponse` (`POST /api/agent-mode/ishare/:shareId/generate` and `/share/:shareId/generate`)
reads an optional `Authorization: Bearer <jwt>` header after the link itself has been validated.
`services/shareViewerIdentity.ts` `isSessionOwnerRequest` (it takes the request itself, so the verifier sees what it sees on every other route) answers true only for a normal user login that
`getUserFromToken` verifies (signature, expiry, session version) and whose user is the session's owner, and that
is not a delegate token (an admin acting as the owner) or a service self-call token. True means the turn runs with
`isInteractiveShare=false` (the same tools as the owner's normal view, admin tools included for an admin owner, no
anonymous-sender stamp). False, which includes every failure, is exactly today's visitor behaviour.

The decision is made last, after every link, lock, usage and model check, and an owner turn logs one line
(`[ENG-2816] share link <sessionId>: the viewer is the session owner; running an owner turn`, no token), because
telemetry then reads `regular` instead of `interactive_share`. The portal does not send a sandbox (evaluation) login
on a share link: the server refuses those on every share route, and such a viewer chats anonymously today.

**Owner turn on a share link, what differs from a visitor turn** (all equal to the owner's normal view of the same
session): no share block list, admin tools for an admin owner, no anonymous-sender stamp, owner step-model handling,
`regular` session type. Delegated (admin-support) access is NOT granted by this.

**What did not change.** Nothing else: no header, no behaviour change (the portal does not send the header yet, so
this is inert until the portal PR lands). The link token, expiry, `isActive`, usage gate, session lock and model
policy checks all run before and independently of this. A login never replaces the link check (a wrong share token
is still a 401), and a bad login never produces an error (it falls back to a visitor turn). No table, index, IAM,
or environment change. CORS already allows the `Authorization` header.

**Not covered here (later PRs, same ticket).** Voice (a `viewerToken` field on the socket and the voice guard), the
schedule marking and run restriction, and the timed-out follow-up turn that drops the flag. Do not ship the voice
guard or the schedule marking before this and the portal PR are live, or an owner on their own link would be
restricted.

**Tests.** `__tests__/shareViewerIdentity.test.ts` (13), `__tests__/shareViewerIdentity.realJwt.test.ts` (11, real signed
tokens: wrong secret, alg none, expired, revoked session version, missing and `deleted_` users, colleague, delegate,
service, garbage) and `__tests__/agentModeController.ishareOwnerRecognition.test.ts` (8, through the real handler,
including that delegated access is not granted and that the trace is logged only for an owner). Mutation checks (break
the code, a test fails): owner never recognised, everyone recognised, delegate or service check removed, owner-id
comparison removed, owner fed into delegated access, trace removed, verifier handed a copy instead of the request.

**Rollback.** Revert this commit; behaviour returns to "every share-link turn is a visitor turn".
