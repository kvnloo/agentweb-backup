# Cycle 049 — Anonymous MCP may list generate_image; cannot run it

UTC: 2026-09-11T20:17Z. Architecture track. `coding_unlocked` true.
Research-only this cycle. Do not un-ready Q-001 / Q-014 / Q-003.
Do not revive A-006.

## File-level citations

1. **Collision.** AgentWebPro still empty on `apiTools.ts`. This fork:
   [kvnloo#2](https://github.com/kvnloo/agentweb/pull/2) Q-014+Q-004,
   [kvnloo#3](https://github.com/kvnloo/agentweb/pull/3) A-002.

2. **Lazy auth lists tools; an empty execute allowlist is the spend
   control.** ENG-984 (`anonymousTransport.ts`):

   | Control | Citation | What it does |
   |---|---|---|
   | Flag | L30–34 `MCP_ANONYMOUS_DISCOVERY === 'true'` | Default **OFF** |
   | Discovery methods | L41–46 includes `tools/list` | Stranger may **see** the catalog |
   | Execute allowlist | L48–58 `ANONYMOUS_TOOLS = empty Set` | Stranger may **run nothing**. Comment: Harsha 2026-08-08, list + one free demo tool **not shipped** |
   | Door | L61–83 `isAnonymouslyPermitted` | `tools/call` only if name ∈ `ANONYMOUS_TOOLS` |
   | Wired at | `mcpServer.ts` L61–65 | Before any handler |

   Cycle 48: `ListTools` = `getToolDefinitions()` (no skill gate). Combined
   with ENG-984: when the flag is on, Q-014’s listed `generate_image`
   appears to **anonymous** `tools/list`. That is the 2026 lazy-auth
   pattern in the file header (L8–12). Hermes OAuth (Q-001) is still
   required to **run** it.

3. **`requiresUserAccount` is not the generate_image gate.**
   `apiTools.ts` `generate_image` (L2076 on this branch) has **no**
   `requiresUserAccount` (grep empty under `apiTools.ts`). Registry
   ENG-822 (L136) only fires when that flag is set. The transport
   allowlist is what stops anonymous `tools/call generate_image`.
   Comment L16–25: relying on per-tool metadata is “how the quota hole
   in ENG-973 happened.” Do **not** add `generate_image` to
   `ANONYMOUS_TOOLS` in Q-014 (would be a spend hole; demo tool is a
   later review). Do **not** add `requiresUserAccount` as a substitute
   for that allowlist.

4. **Hermes / A-006.** Hermes clients list after connect; AgentWeb
   already paid for lazy list. A fifth HTTP image process would need a
   **copy** of `ANONYMOUS_TOOLS` or it would either 401 discovery or
   execute without a user. Keep the allowlist on the MCP transport.

## DISCARD / rank

Park **A-015**: do not put `generate_image` in `ANONYMOUS_TOOLS`.
Q-001 / Q-014 / Q-003 stay **ready** (listing to authenticated Hermes is
still the product; anonymous look-but-not-run is already designed).
A-006 stays discard.

## Mapping evidence

`COMPOSITION.md` anonymous list vs empty execute set. `README.md`
Q-014 “do not”. `queue.json` A-015. Q-014 brief out of scope.

## Next

Cycle 50: collision-only unless a cheaper mapping exists. Do not
un-ready Q-001 / Q-014 / Q-003. Do not revive A-006. Unsubscribe after
`stop_after` (2026-09-12T06:00Z).
