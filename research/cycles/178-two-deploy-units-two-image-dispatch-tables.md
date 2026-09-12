# Cycle 178 — two deploy units, two image dispatch tables

**Date:** 2026-09-12T01:26:00Z
**Question:** Cycle 177 named agent-engine’s live
`OPENAI_IMAGE_API_KEY`. Are the Python worker’s image ids
the same table as backend `SUPPORTED_MODELS`?

**Answer:** No. **Intersection is two ids.** Unspecified
Emma/blog hits Gemini 3 (cycle 170 / 177). Unspecified
browser task hits `"openai-image-1"` and the OpenAI else
(`web_agent.py` L3295–3301). Q-003’s `gpt-image-2` is
Azure on the leaf and **OpenAI-else on the worker**. Not
a nanoservice. Q-003 already parks `image-models.ts` L11
as out of scope — do not un-ready it.

## Evidence

Python named branches (`web_agent.py` L3249–3301):

| id | Worker | Leaf `SUPPORTED_MODELS` L16–28 |
|---|---|---|
| `FLUX.1-Kontext-pro` | Azure | **absent** |
| `gemini-2.5-flash-image` | Google | Google |
| `gpt-image-1` | Azure | Azure |
| `openai-image-1` (default L3240) | OpenAI else | **absent** |
| anything else, incl. `gpt-image-2` | OpenAI else | Azure (`gpt-image-2`) |
| `gemini-3-*` / Runway | (else → OpenAI) | named Google / Runway |

`task_monitor.py` L1239–1242 copies the same default when
the Dynamo task has no `imageModel`. CLI help L4216 still
names only `openai-image-1` or `FLUX.1-Kontext-pro` —
omitting the live Gemini and `gpt-image-1` branches.

Partner **task** seed (`ImageModelsSettings.tsx` L71–89)
writes Dynamo `supported_image_models` as openai-image-1
+ FLUX + `gemini-2.5-flash-image`. Agent Mode dropdown
(`AdminDashboard.tsx` L8563 / `IMAGE_API_MODELS`) is the
six-id Emma catalog (cycle 166). Two admin UIs, two
deploy units.

`image-models.ts` L11 fallback `'openai-image-1'` is the
HTTP face of that worker default. Q-003 brief item 7
already parks it. Cycle 8 noted the string; this cycle is
the **dispatch mismatch** when a task stores a leaf id.

Hermes `FAL_MODELS` is one table. A-006 would HTTP-split
the Node leaf and leave `task_monitor.py` on the GCP VM
with a second table.

## What this is not

Not a product patch. Do not edit `web_agent.py` on a
research turn. Do not add A-021. Do not expand Q-003 to
seed FLUX.

Not a Q-014 / Q-001 / Q-003 status change. Listing MCP
`generate_image` does not change the browser-task CLI.
Matt-gated default flip still only reorders the **leaf**.

Not A-006. The four deploy units already exist (finding 1).
They already disagree. A fifth process would be a third
table unless it imported both.

## Relation to A-002 / A-007 / A-008

A-008 is the Node capability table. The Python worker is
a separate deploy unit (cycle 135: no GitHub build job).
Sharing ids is a documented mapping, not an HTTP hop.
After #2, not instead of Q-014.

## Next cycle candidate

`ImageModelsSettings.tsx` L71–89 seeds `openai-image-1`
but **not** `gpt-image-1`, even though the worker has a
named Azure branch for `gpt-image-1` (L3281). Admin seed
vs live if-chain. File-level. Do not add A-021.
