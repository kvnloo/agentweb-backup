## ENG-2906: product-aware signup + Zoma journey capture, backend PR1 (2026-11-10)

- One shared account; product (`zoma` | `emma_mcp` | `emma_web` | `unknown`) is attribution only,
  never an authorization input. Unknown is always allowed. Full contract: `backend/docs/journey-tracking.md`.
- The portal OAuth consent form posts back only the standard fields, so `/oauth/authorize` stores
  `resource`/`ref` as a `pending#<sha256(client_id, code_challenge)>` row in `AW-MCPOAuthCodes`
  (no `used` attribute → never redeemable). Product then rides code → token → every refresh.
- AW-Users: write-once `signup*` set, `products.<p>.{firstAt,lastAt}` (hourly), forward-only
  `zomaStage` via `zomaStage IN (<earlier stages>)` — all single conditional UpdateItems with
  `attribute_exists(email)`, no read-modify-write. No backfill; pre-ENG-2906 rows and events have
  no product (read as "not tracked", not `unknown`). Row/person `attributionConfidence` is
  `tracked | inferred | verified` (internal `explicit` → `tracked`; `unknown` omitted).
- OAuth signups are attributed only for rows register stamped `signupSource = "mcp"` (consent
  page), never by account age. `first_read`/`first_write` have their own write-once fields, so
  either order emits both once.
- `?ref=` on the MCP URL reaches `/oauth/authorize` because the 401 challenge and the
  protected-resource metadata echo it into `resource` (SDK clients send that, not their URL).
- Known gaps: a Google sign-up that starts from the MCP consent flow (via the portal login page)
  is attributed `webapp` (confidence `inferred`) — Google OAuth state does not carry the source,
  and fixing it needs a portal change. A client that ignores both the challenge URL and the
  server URL's query on discovery still loses `ref` at authorize; it is still recorded on `/mcp`
  connection and toolkit usage events. `ad_live` is a documented stub; `abandoned` is not emitted.
