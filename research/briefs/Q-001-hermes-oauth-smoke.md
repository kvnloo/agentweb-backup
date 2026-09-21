# Q-001 — Hermes MCP OAuth smoke test

**Issue:** [#21](https://github.com/kvnloo/agentweb/issues/21) · **Epic:** [#5](https://github.com/kvnloo/agentweb/issues/5)

## Goal

Verify Hermes can complete native OAuth against AgentWeb MCP **without issuing tokens in CI**. Operator-run smoke against staging/production.

## Prerequisites

| Var | Example | Notes |
|-----|---------|-------|
| `HERMES_SMOKE_BASE_URL` | `https://api.agentweb.pro` | MCP + OAuth host |
| Hermes CLI | `hermes mcp login emma` | Persistent PTY; see `backend/docs/HERMES_MCP_OAUTH.md` |

## Automated checks (no secrets)

```bash
cd backend
HERMES_SMOKE_BASE_URL=https://api.agentweb.pro ./scripts/hermes-mcp-oauth-smoke.sh
```

Validates:
1. `/.well-known/oauth-authorization-server` returns RFC 8414 metadata
2. `POST /oauth/register` accepts a DCR request (ephemeral client)
3. `GET /oauth/authorize` returns 302 to consent UI (no token issued)

## Manual Hermes flow (staging)

1. On Hermes host: `hermes mcp add emma --url $HERMES_SMOKE_BASE_URL/mcp --auth oauth --connect-timeout 315`
2. Relay authorization URL to user; keep process alive
3. User approves in browser; paste **full callback URL** to waiting stdin (not Slack alone)
4. Confirm `tools/list` includes expected Emma tools (`generate_image`, no `post_on_account` for external)

## Failure modes

| Symptom | Likely cause |
|---------|----------------|
| Headless OAuth refused immediately | No cached tokens — expected; use interactive login |
| `invalid_state` after paste | Wrong process / new login started — restart single login |
| 401 on `tools/call` | Token expired or family revoked — re-login |
| `post_on_account` visible in list | External MCP filter regression — check `internalOnly` |

## References

- `backend/docs/HERMES_MCP_OAUTH.md` (ENG-1869 diagnosis)
- Upstream tracking PR: AgentWebPro/agentweb#2972
