# Cycle 51 — copying the Emma meter is not an anonymous spend door

**UTC:** 2026-09-11T20:32:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not merge:** A-015. **Do not revive:** A-006.

## Question

Cycle 50 showed a leaked MCP `CallTool` dies at `lookupUser` before HTTP.
Is `requireEmmaTokenBudget` a second fail if that lookup were skipped (A-006
copying “the metered route”, or `overrideToken` bypassing mint)? Cycle 40
said quota lives above `generateImage`. This cycle asks **what that quota
does for `anon_*`**.

## Finding

**The Emma meter allow-lists `anon_*`. It was written for ishare/generate
work-plan demos (ENG-1163), not MCP images. Copying it onto a fifth HTTP
image process would not reproduce `lookupUser`.**

### 1. `_svc` JWTs skip the user row

`generateSelfCallToken` (`httpClient.ts` L83–88) always sets `_svc: true`.
`middleware/auth.ts` L155–167: for `_svc`, **trust JWT claims** — no
`getUserById`. A minted (or forged-with-secret) self-call token for
`anon_*` populates `req.user.userId` without a Dynamo user.

### 2. `requireEmmaTokenBudget` then **allows** that id

`emmaTokenBudget.ts` L152–168: 401 only if `!user?.userId`. An `anon_*`
claim has a userId, so it continues.

`tokenUsageService.ts` L174–182 / L293–305 (`checkTokenUsage`):

- strict `userId.startsWith('anon_')` (not the broader `isAnonymousUserId`)
- `allowed: costUsed < ANONYMOUS_SESSION_COST_CAP_USD` where the cap is **$2**
- `costUsed` is `getAnonymousSessionCostUsedUsd` (L191–194): sum of
  `AW-ChatSessions.totalCost` for that id

MCP `generate_image` does not create a chatbot session. An MCP `anon_*`
id typically has **zero** ChatSessions rows → `costUsed = 0` → **allowed**.
The $2 cap never moves.

### 3. The leaf still generates; the cap charge drops

`imageGeneration.ts` L551 `void meterUserUsage(...)`.
`usageRecorderService.ts` L489–531: fire-and-forget; missing userId
records under `"system"`, but a present `anon_*` **does** call
`incrementUserTokenUsage`.

`incrementUserTokenUsage` L567–570: `getUserByIdConsistent` → no row /
no email → `outcome = "no_user"` and **break**. The vendor call already
succeeded. The monthly cap is not incremented. Combined with (2):
**uncapped vendor spend** if door 2 (`lookupUser`) is skipped.

That is why A-006 as “extract imageGeneration behind emmaApi because it is
already metered” is a billing footgun, not a composition win.

## Why this is not Q-014 work

Q-014 lists the **authenticated** MCP face. Authenticated Hermes has a real
`AW-Users` row, so `lookupUser` succeeds, `_svc` is a real user, and the
monthly cost cap applies. Do not add `requiresUserAccount`, do not add the
name to `ANONYMOUS_TOOLS`, do not “fix” anonymous metering in the listing PR.

## Hermes / Oh My Pi

Hermes and Oh My Pi have no `$2` anonymous image allowance inside the image
package. Identity and spend live in the **host**. AgentWeb already paid for
that host check once (`lookupUser`). A nanoservice mesh would have to copy
(1) `ANONYMOUS_TOOLS`, (2) `lookupUser`, (3) the ishare-shaped anon cap,
and (4) a real user row for `meterUserUsage` — four policies for one leaf.

## Collision

Skipped. Mapping is cheaper and falsifies the cycle-50-draft claim that
budget middleware would fail. File-level: `auth.ts` L155–167,
`emmaTokenBudget.ts` L162–168 / L58, `tokenUsageService.ts` L182 / L293–305 /
L567–570, `usageRecorderService.ts` L489–531, `imageGeneration.ts` L551.

## Next

Cycle 52: collision refresh (two mappings in a row). Do not un-ready
Q-001 / Q-014 / Q-003. Do not revive A-006.
