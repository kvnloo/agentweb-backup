## ENG-2669: result-endpoint status and trigger stop leaking lead data and the chat link (2026-10-26)

- `GET /r/:name/status/:sessionId` loaded any session by id. It now answers only for a session whose
  `resultEndpointMetadata.resultName` equals `:name`; anything else (missing, another endpoint's
  session, a non-result session) returns the same `404 Session not found`, so the route no longer
  reveals which session ids exist. The session id sits in the lead's page URL, so it is not a credential.
- The response is now `status`, `resultTitle`, `waitingContent` and, once completed, `reportUrl`. It no
  longer returns `leadEmail` or `contentHtml`. The only consumer, the portal's `/r/:name/:sessionId`
  waiting page, reads `status` and `reportUrl` only.
- `POST /r/:name/trigger` no longer returns `ishareUrl`. That link carries the conversable token
  (chat as the session owner) and the portal's `/r/:name/new` page ignored it. The reviewer still gets
  it from `GET /review/:sessionId`, which needs the ENG-2650 reviewer token or an admin. The share is
  still minted at trigger time, as before.
- External callers of `/trigger` that read `ishareUrl` from the response break; none was found in the
  portal, `agentweb-landing-page`, `v0-xc-ures-landing-page`, `mintlify-docs` or `yugo-agent`.
- Not changed: `reportUrl` is still returned as soon as `contentUrl` is set, before a required review
  approves the result (unchanged behaviour).
