# Cycle 039 — MCP generate_image schema is a thinner HTTP adapter

UTC: 2026-09-11T19:45Z. Architecture track. `coding_unlocked` false. Do not
un-ready Q-001 / Q-014 / Q-003. Do not revive A-006.

## File-level citations

1. **Collision** (20 open PRs). `apiTools.ts` / `imageGeneration.ts` /
   `loops/core` / `routes/emmaApi.ts` still empty. `emma/tools.ts` still
   **#2832 #1076 #689**. A-005 pile unchanged.

2. **Same name, two schemas — Hermes would not have this.**

   | Field | Emma `emma/tools.ts` L4995–5052 | MCP `apiTools.ts` L2075–2094 |
   |---|---|---|
   | input images | `inputImages` | `input_images` |
   | model | `imageModel` + enum | `image_model` (free string) |
   | HITL | `confirm` | **absent** |
   | data-fabrication skip | `metrics_verified` | **absent** |
   | description | logo compositing + metrics rules | one sentence |

   Hermes: one handler table, one schema. AgentWeb’s MCP face is not a
   second copy of Emma’s tool; it is an HTTP adapter over `/api/emma/generate-image`.

3. **`emmaApi.ts` L181 hardcodes `confirm` to `undefined`.**

   ```
   svc.generateImage(..., image_model, logo_image, undefined, category)
   ```

   Policy (`agentModeService.ts` L28893): edits (`inputImages.length > 0`)
   halt unless `confirm === true`. MCP execute (`apiTools.ts` L2096–2107)
   never sends `confirm`. External MCP therefore **cannot** self-approve an
   edit. Text-to-image (empty `input_images`) skips the gate. Q-014’s
   acceptance is listing for generation; do not thread `confirm` in that
   slice (would let Hermes skip the human gate).

4. **Session identity stops at the HTTP body.** `ctx()` (`toolHelpers.ts`
   L10–22) carries `sessionId`. `httpClient.ts` L200–202 puts it on
   `SCHEDULED_SESSION_HEADER` (ENG-827 publish consent). `emmaApi.ts` L177
   reads `session_id` from **body**, defaults to `''`. `generate_image`
   body omits it. `generateImage` then calls `addToolCostToSession('')`
   (`agentModeService.ts` L29065) and `addMessageToSession('')` (L29081).
   Leaf meter / C2PA / CRITICAL LOGO still run on `userId` (cycle 36).
   Empty chat-session bookkeeping is pre-existing for name-callers; listing
   raises volume but does not falsify Q-014. Do **not** write MCP session
   UUIDs into `chatbotDb` as if they were Emma chats.

## DISCARD / rank

New parked item **A-011**: do not expand Q-014 to unify schemas or thread
`confirm` / `metrics_verified` / `session_id`. Product READY unchanged.
A-006 stays discard (the HTTP face already exists; it is thinner, not
missing).

## Mapping evidence

`COMPOSITION.md` schema/HITL table. `briefs/Q-014-generate-image-mcp.md`
out-of-scope. `queue.json` A-011.

## Next

Cycle 40: collision-only unless a cheaper mapping exists. Unsubscribe
after `stop_after` (2026-09-12T06:00Z).
