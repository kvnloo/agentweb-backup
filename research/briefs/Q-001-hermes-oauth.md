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

**Mostly done.** `backend/docs/HERMES_MCP_OAUTH.md` (2026-09-11) already
has the copy-paste recipe (`hermes mcp add emma --url https://api.agentweb.pro/mcp --auth oauth --connect-timeout 315`, paste the full callback URL, never paste tokens). Do not rewrite it unless the operator smoke finds a lie.

## First slice (Kevin / hermes-agent)

1. Run that recipe on a real Hermes host; report where it still breaks
   (production token was **not** issued in the 2026-09-11 diagnosis).
2. Optional: a Hermes skill in `hermes-agent` / `oss-factory`, **not** a
   new AgentWeb service.
3. After login, Q-014 is what makes `generate_image` appear in `tools/list`.
   Cycle 209: run this smoke **after** kvnloo#2 merges so the list includes it.

## Out of scope

Server-side Slack bridge, changing PKCE, exposing `send_email`.

## Collision

None on the OAuth protocol. Don't restack oauthService.

## Rollback

None for the in-repo runbook (already on `main` via ENG-1869). Operator
skill lives in hermes-agent; delete that commit.
