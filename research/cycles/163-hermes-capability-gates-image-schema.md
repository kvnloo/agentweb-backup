# Cycle 163 — Hermes capability-gates `image_generate` tools/list; AgentWeb MCP does not

**Date:** 2026-09-12T00:50:00Z
**Question:** Cycle 162: Hermes schema is `prompt` + `aspect_ratio`.
Does Codex always see `image_url`, or does Hermes hide edit args when
the active model cannot honor them?

**Answer:** Hermes hides them. `_build_dynamic_image_schema` rebuilds
description **and** params from the active backend’s capabilities.
AgentWeb MCP always lists `input_images` / `logo_image` /
`image_model` regardless of `SUPPORTED_MODELS` or the admin default.
That is agentic-dev code quality Hermes already has; copying it is
an in-process schema builder, not a nanoservice.

## Evidence

Live `tools/image_generation_tool.py` L719–720:

> Advertising edit capability up front saves a wasted turn.
> Memoized by config.yaml mtime in `model_tools.get_tool_definitions()`,
> so it rebuilds on switch.

Registry L817–821:

```
registry.register(
    name="image_generate", toolset="image_gen", schema=IMAGE_GENERATE_SCHEMA,
    handler=_handle_image_generate, ...,
    dynamic_schema_overrides=_build_dynamic_image_schema,
)
```

Builder L781–815: start from `prompt` + `aspect_ratio` (L794–795).
Add `image_url` only if `"image" in modalities` (L796–798). Add
`reference_image_urls` only if `max_refs > 1` (L799). Add `upscale`
only if `supports_upscale` (L812). Fail-closed: `_NO_CAPABILITIES`
is text-only (L721); `_active_image_capabilities` L727 “an undeclared
capability is advertised as absent.” Static placeholder comment
L525–527: handler still **accepts** hidden args for replay + teaching
errors.

Tests in live `tests/tools/test_image_generate_schema.py`:
`test_t2i_only_model_hides_edit_args` (`assertNotIn("image_url")`);
`test_static_schema_carries_no_capability_args` (static props are
exactly `aspect_ratio` + `prompt`);
`test_handler_still_rejects_unadvertised_edit_with_teaching_error`
pins `_prepare_fal_request` L367–370.

AgentWeb `apiTools.ts` L2081–2093 is a **literal**. `input_images`,
`logo_image`, and `image_model` are always in `tools/list` once Q-014
drops `internal`. Execute L2102 still forwards `input_images`. Hermes’
comment: a wasted turn. AgentWeb pays that turn on every MCP client
including Hermes-as-client (Q-001).

## What this is not

Not a product patch. Do not add `dynamic_schema_overrides` on this
turn. Optional later, after Q-014 lists the static face: a fail-open
builder that omits `input_images` when the default model is t2i-only.
That is A-007’s file, not a fifth `listen()`.

Not A-011 (Emma vs MCP field set). This is **when** a field appears.
Do not add A-021.

Not a Q-014 / Q-001 / Q-003 status change. Q-014 lists the current
static schema.

## Relation to A-002 / A-007 / A-008

A-007 copies the static object into `infrastructure.ts`. A later
capability-gated builder belongs there, after #2, not instead of
Q-014.

## Next cycle candidate

Does AgentWeb `generateImage` already refuse `input_images` for
t2i-only models (so the wasted turn is a schema lie, not a silent
no-op)? File-level on `agentModeService.ts` generateImage /
`imageGeneration.ts` / `SUPPORTED_MODELS`. Do not un-ready Q-003
(that mapper is fail-open rank, not this refuse).
