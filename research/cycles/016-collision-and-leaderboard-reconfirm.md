# Cycle 016 — Collision + DesignArena reconfirm (no rank rewrite)

UTC: 2026-09-11T18:30Z. Timer 18:30Z. ~1h45m to `stop_after`. `coding_unlocked` still false. Collision-only.

## File-level citations (not a QUEUE restatement)

1. **Live DesignArena vs `backend/src/services/imageGeneration.ts` `SUPPORTED_MODELS` (L16–28).**
   POST `https://www.designarena.ai/api/leaderboard` `{"arenaType":"models","category":"image"}` at **2026-09-11T18:30:15Z** (n=81). Intersection with AgentWeb ids is **unchanged vs the cycle-8 / mapping snapshot (17:28Z)**:

   | AgentWeb id | image rank | elo |
   |---|---|---|
   | `gpt-image-2` | **#3** | 1366 |
   | `gemini-3.1-flash-image-preview` → GA `gemini-3.1-flash-image` | #14 | 1271 |
   | `gemini-3-pro-image-preview` (hardcoded default L492 / L1542) | **#22** | 1219 |
   | `gpt-image-1` | #33 | 1194 |
   | `gemini-2.5-flash-image` | #39 | 1181 |

   Not in AgentWeb (still skip first slice): `riverflow-2.5-pro` **#1**, `gpt-image-2.5-sunburst` #2, `gpt-image-2.5-flare` #4. There is no `riverflow-v2-fast-preview` row this fetch.

2. **Logo category** (same endpoint, `category=logo`, timestamp 18:30:16Z, n=80): `gpt-image-2` still **#1 / elo 1366**. Default Gemini still **#40 / elo 1180**. Mapping table still valid; do not rewrite ranks.

3. **`backend/src/mcp/server/registry.ts` L82–86 `getToolDefinitions()`** filters `!t.internal` only. JSDoc says "excludes internal-only tools" but `internalOnly` is **not** in the list filter. Execute refuse is L123 (`internalOnly && context.externalMcp`). Q-014 still lists `generate_image` by dropping `internal` at `apiTools.ts` L2077 (no `internalOnly` today). Q-004 still needs **both** flags on MCP `post_on_account` (`apiTools.ts` L1493 — neither flag set).

4. **Open PRs on `AgentWebPro/agentweb` vs first-slice files.** Cycle 15 filter plus extras that appeared in this fetch (`#2846`, `#2856`). **No open PR file list includes `apiTools.ts` or `imageGeneration.ts`.**

   | PR | Files that matter | Implication |
   |---|---|---|
   | **#2832** | `backend/src/emma/tools.ts` | Q-004 must not edit that file |
   | **#2862** | `toolErrorClassifier.ts` only | Not `callLLM` body |
   | **#2861** | `agentModeService.ts` + `pdfRenderService.ts` | convert_to_pdf; not MCP listing |
   | **#2871** | `agentModeService.ts` (+ work-plan seed) | Don't pick up |
   | **#2271** | WhatsApp Cloud API | Q-011 still park |
   | **#2563** | dead transports | Don't revive |
   | **#2846** (new vs cycle-15 method list) | `routes/landingPageGeneration.ts` | Not MCP list / image models |
   | **#2856** (new) | `.github/workflows/*.yml` dependabot | Ignore |
   | #2875 #2850 #2393 | no first-slice match | contractor / partner-portal |

5. **Q-006 / Q-015 still listed outbound:** `edit_landing_page_file` (`apiTools.ts` L1770, description still tells clients to use missing MCP `coding_agent`); `list_all_clients` L2938, `freeze_user_account` L3408, `manage_user_notes` L3431 — none of these have `internal`/`internalOnly`.

## DISCARD / rank

No DISCARD. No rank change. Do not un-ready Q-001 / Q-014 / Q-003. Q-016 still parked (video 40× image price).

## Mapping evidence

Live 18:30Z fetch matches `research/mappings/designarena-image-models.md` cycle-8 table (elo and ranks identical for every AgentWeb intersection row). Snapshot still valid; table not rewritten.

## Next

Cycle 17: collision-only until 20:15Z. Skip queue rewrite unless a new PR hits `apiTools.ts` or `imageGeneration.ts`. Unsubscribe after `stop_after`.
