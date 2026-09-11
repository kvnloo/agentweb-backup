# Q-001 brief — Emma-via-Hermes operator path

Status: **ready** (docs + Hermes-side skill; no AgentWeb schema).

## Problem

ENG-1869 shipped MCP OAuth 2.1 (DCR, PKCE S256, refresh families).
`backend/docs/HERMES_MCP_OAUTH.md` already describes the native flow.
Remaining friction is **client-side**: headless Hermes refuses OAuth without
cached tokens; Slack cannot finish PKCE; the waiting process needs the full
callback URL on stdin.

After login, Hermes still will not *discover* `generate_image` (Q-014).

## Acceptance

1. A Hermes host can run `hermes mcp add emma --url https://api.agentweb.pro/mcp --auth oauth` (or `hermes mcp login emma`) and complete PKCE without a second login.
2. Runbook covers: persistent PTY, 315s timeout, paste entire callback URL, never paste tokens into Slack.
3. `tools/list` returns the Emma catalogue (whatever Q-014 has listed by then).
4. No new Dynamo tables, no Slack-stdin bridge on the server.

## First slice (this repo)

- Tighten `backend/docs/HERMES_MCP_OAUTH.md` + `AGENT_API.md` with a copy-paste Hermes recipe.
- Optional: a Hermes skill in Kevin's `hermes-agent` / `oss-factory` tree, **not** a new AgentWeb service.

## Out of scope

Server-side Slack bridge, changing PKCE, exposing `send_email`.

## Collision

None on the OAuth protocol. Don't restack oauthService.

## Rollback

Revert the doc commit.
