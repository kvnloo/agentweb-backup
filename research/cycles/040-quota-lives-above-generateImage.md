# Cycle 040 — Quota lives above generateImage, not in it

UTC: 2026-09-11T19:48Z. Architecture track. `coding_unlocked` false. Do not
un-ready Q-001 / Q-014 / Q-003. Do not revive A-006.

## File-level citations

1. **Collision** (20 open PRs). `apiTools.ts` / `imageGeneration.ts` /
   `loops/core` / `emmaApi.ts` / `emmaTokenBudget.ts` still empty.

2. **`generateImage` does not check monthly quota.** The gate is
   `checkTokenUsage` in the **faces above** the service:

   | Face | Where the quota runs | How it was attached |
   |---|---|---|
   | In-app chat | `controllers/chatbot.ts` L156; `agentModeController` (e.g. L5647, L9033) | Original web path, one layer **above** `agentModeService` |
   | External MCP | `emmaApi.ts` L16–21 `router.use(requireEmmaTokenBudget)` | Added because MCP’s HTTP hop **skipped** the controller (`emmaTokenBudget.ts` L4–10) |
   | Media auto-continuation | `agentModeController.ts` L1327–1334 | A **third** entry that bypassed `generateSessionResponse`; they copied the check again |

   `POST /generate-image` is classified **`metered`**
   (`emmaTokenBudget.ts` L58). `_svc` self-call JWTs (`httpClient.ts`
   L86, `auth.ts` L155–167) still populate `req.user.userId`; the
   middleware meters that id. No `_svc` bypass of ENG-973.

3. **This is why HTTP-per-tool stays discarded.** The file’s own comment:
   *“everything goes through agentModeService delivered the tool logic
   while skipping the guardrail.”* A fifth image process would be a
   **fourth** copy of `checkTokenUsage`, or it would restore the ENG-973
   hole. Q-014 lists an existing face that already has the middleware. It
   does not add a hop.

4. **Leaf cost meter is a different layer** (cycle 36):
   `imageGeneration.ts` records vendor spend. Quota (this cycle) is
   the monthly allowance. Do not collapse them into a nanoservice, and
   do not move quota into the leaf to “copy OMP.”

## DISCARD / rank

No rank change. A-006 stays discard (new citation: quota is per-face,
not in `generateImage`). Product READY unchanged. Q-014 stays ready:
listing still hits `POST /generate-image` `metered`.

## Mapping evidence

`COMPOSITION.md` quota-faces table. `queue.json` A-006 why. Product
`QUEUE.md` SDLC order corrected to A-002 → A-007 → A-008 (was stale
A-002 then A-005).

## Next

Cycle 41: collision-only unless a cheaper mapping exists. Unsubscribe
after `stop_after` (2026-09-12T06:00Z).
