## ENG-2650: result-endpoint review routes need a reviewer token or admin (2026-10-23)

- `/review/:sessionId` (GET) and `/review/:sessionId/send` (POST), in
  `backend/src/routes/resultEndpoints.ts`, used to trust the session id alone. That id
  is also handed to the anonymous lead (the `/r/:name/trigger` response and the
  `/r/:name/:sessionId` status page), so anyone with it could read the lead email, get
  the conversable iShare link, and send AgentWeb-branded email with any link in it.
- Every review route now runs `requireReviewAccess` first. It accepts either
  - the reviewer capability token in the `X-Review-Token` header. The token is
    `HMAC-SHA256(HMAC(JWT_SECRET, label), sessionId)` in base64url, compared in
    constant time (`services/resultEndpointReview.ts`). It is not stored anywhere.
    `send_for_review` puts it in the review link's URL fragment
    (`/review/<id>#token=...`), and the portal page forwards it in the header; or
  - a real admin JWT (not a delegate token).
  A new route on `reviewRouter` must take `requireReviewAccess` as its first handler.
  `resultEndpointReview.eng2650.test.ts` checks this.
- Review links sent before this deploy have no token, so they now return 401 ("Access
  Denied" on the page). To open one, sign in to the portal as an admin and open the same
  link, or let `send_for_review` run again for that result to get a new link.
  Rotating `JWT_SECRET` also breaks every outstanding review link.
- `/send` only accepts one of the session's collected assets (http(s)), or
  `__inline_html__` when `contentHtml` is set. It needs exactly one valid recipient
  address, escapes everything it puts into the HTML, and allows at most 10 successful
  sends per session per hour. The limiter is in memory, so the limit applies to each
  backend instance separately.
- The portal does not load third-party analytics (GTM, PixelFlow, Clarity) on
  `/review/*`, so the token in the URL and the lead PII on the page are never sent to
  them.
