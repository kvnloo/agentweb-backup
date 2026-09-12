# Cycle 162 — Hermes `image_generate` schema is not AgentWeb MCP `generate_image`

**Date:** 2026-09-12T00:48:00Z
**Question:** Cycle 161: Codex-facing Hermes MCP lists `image_generate`
via in-process `handle_function_call`. Does that JSON schema match
AgentWeb MCP `generate_image` (`apiTools.ts` L2075)?

**Answer:** No. Different **name**, required set, size contract, and
product fields. A-011 already parks unifying Emma vs MCP. Do not add
A-021 to also unify Hermes. Q-014 lists the AgentWeb adapter as-is.

## Evidence

Live `tools/image_generation_tool.py` `IMAGE_GENERATE_SCHEMA` L522–554
(fetched `NousResearch/hermes-agent` main 2026-09-12T00:45Z; 833 lines).
Static placeholder is `prompt` + `aspect_ratio` only (L549: edit args
are never static). `required: ["prompt"]` (L552).

| | Hermes `image_generate` | AgentWeb MCP `generate_image` | Emma in-app |
|---|---|---|---|
| Name | `image_generate` | `generate_image` | `generate_image` |
| Required | `prompt` only (L552) | `prompt`, `filename`, `category` (L2093) | `prompt`, `filename`, `category` (L5052) |
| Size | `aspect_ratio` enum landscape/portrait/square (L543–547) | `size` string `1024x1024` / `auto` (L2086) | `size` with per-provider formats (L5011–5014) |
| Model | out-of-band `image_gen.model` (`hermes tools`) | `image_model` arg (L2090) | `imageModel` camelCase (L5033) |
| Edit | `image_url` **dynamic** (cycle 163) | `input_images` always listed (L2088); execute forwards it (L2102) | `inputImages` camelCase (L5022); execute L5067 |
| Logo | absent | `logo_image` (L2089) | `logo_image` (L5029) |
| HITL | none | no `confirm`; route passes `undefined` (`emmaApi.ts` L181) | `confirm` (L5038) |
| Eval | none | `category` required | `category` + `metrics_verified` |

`filename` and `category` are AgentWeb product (S3 key + human-eval
queue). Hermes has neither. Copying Hermes’ required-set onto MCP
would drop the eval queue Q-003/Q-014 depend on. Copying MCP onto
Hermes would force Codex to invent an AgentWeb category.

Cycle 39 / A-011 already recorded Emma vs MCP. This cycle adds the
**third** origin: Hermes’ own leaf, listed on stdio without HTTP.

## What this is not

Not a product patch. Do not rewrite `apiTools.ts` L2075 to
`prompt`-only. Do not rename MCP `generate_image` to `image_generate`.
A-011 stays **park**. Do not add A-021.

Not A-006. Schema drift is why the adapter stays in-process.

Not a Q-014 / Q-001 / Q-003 status change. Q-014 lists this thinner
AgentWeb face, not Hermes’.

## Relation to A-002 / A-007 / A-008

A-007 moves the **same** MCP schema into `tools/infrastructure.ts`.
Do not “fix” it toward Hermes while splitting.

## Next cycle candidate

Hermes `_build_dynamic_image_schema` (L781–815,
`dynamic_schema_overrides=` L821) omits `image_url` when the active
model is text-to-image only. AgentWeb MCP always advertises
`input_images`. File-level: static superset vs capability-gated
tools/list.
