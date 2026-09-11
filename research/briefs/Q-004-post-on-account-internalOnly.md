# Q-004 brief — `post_on_account` internalOnly for external MCP

Status: **ready** (two flags + tests; no schema). Hygiene, not the first
three PRs. Land **with or before Q-014** so Hermes does not gain image
gen while live social publish stays listed.

## Problem

ENG-974: outbound actions must be `internalOnly` for `externalMcp`.
`create_blog_article` / `publish_blog_article` / `send_email` /
`install_skills` already are. MCP `post_on_account` is still listed and
executable. It posts to LinkedIn/Instagram/YouTube/X via
`/api/emma/post-on-account`.

In-app Emma uses **`post_on_connected_account`** (approval copy, not on
MCP). Q-004 does not touch `emma/tools.ts` (open PR #2832 edits that
file).

`freeze_user_account` is Q-015 (admin), not this item.

## Acceptance

1. `getToolDefinitions()` omits `post_on_account`.
2. External `execute` with `externalMcp === true` is refused (ENG-974).
3. In-app `post_on_connected_account` unchanged.
4. `manage_*` stays listed (ENG-983).
5. Do not edit `emma/tools.ts`, `callLLM`, or `toolErrorClassifier.ts`.

## First slice

`apiTools.ts` on `post_on_account`: `internal: true`, `internalOnly: true`.
Pin in `security.mcpServer.test.ts`. Same pattern as `send_email`.

## Out of scope

`publish_landing_page_changes` / `generate_landing_page` (also listed
writes; same flags later). WhatsApp #2271. Q-015 admin tools.

## Collision

#2832 (emma/tools.ts). #2862 retry classifier. ENG-983 `manage_*`.

## Rollback

Remove the two flags.
