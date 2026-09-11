# Cycle 010 — Remotion graph vs HyperFrames / Comfy

**When:** 2026-09-11T17:36Z  
**Focus:** Content-gen graph. Q-007's original "add a lower-third composition"
is already in tree. Contextualize Kevin's video repos without porting them.

## Citations

- `remotion-lambda/src/Root.tsx` — **one** `Composition` id: `BrandedVideo`.
- `remotion-lambda/src/compositions/BrandedVideo.tsx`:
  - `IntroOverlay` (L47) is the lower-third (logo + headline + tagline,
    bottom gradient, ~3s).
  - `OutroOverlay` (L173) is a full-frame opaque end card (brand mark,
    offer, URL button) — "skill Layer 8".
  - Clip concat + 6-frame cross-fade; optional `audioUrl` voiceover.
- `backend/src/services/remotionService.ts` L471 always
  `composition: "BrandedVideo"`. Vendor meter `provider: "remotion"`.
- `emma/tools.ts` L5080 `generate_video` (Seedance → Veo, optional
  `compose=true`) and L5203 `compose_video` (stitch + same Remotion
  overlays). **Neither is registered on `mcpToolRegistry`** (grep of
  `backend/src/mcp` is empty). Cycle 3 already noted absence; still true.
- `videoGeneration.ts` meters per success via `videoGenerationCostUsd`
  (`seedance-2.0` $1.55 / 8s clip vs image `gpt-image-2` $0.04).
- Adjacent repos (pushed today, still no AgentWeb import):
  - `kvnloo/hyperframes` — "Write HTML. Render video." Deterministic
    HTML/CSS → MP4. **Different renderer** from Remotion-on-Veo-clips.
  - `kvnloo/MoneyPrinterTurbo` — LLM one-click short-video pipeline.
    Competes with `generate_video`, not with brand overlay.
  - `kvnloo/open-design` — local-first design (includes HyperFrames).
  - `kvnloo/ComfyUI` — upstream fork, graph GUI. Emma images remain
    one-shot Azure/Gemini/Runway (`imageGeneration.ts`).

## Queue effect

- **Q-007** triage → **park**. The named first slice (lower-third /
  product plate) already ships inside `BrandedVideo`. Extra compositions
  (captions, mid-roll still) need product intent, not a missing
  primitive. Do not port HyperFrames or MoneyPrinterTurbo.
- New **Q-016** (park): MCP `generate_video` / `compose_video` after
  Q-014 proves listing a metered cost tool is acceptable. Video is
  ~40× image price; ENG-973 hid `generate_image` for cost.
- Q-009 Comfy stays park. Remotion is the graph node that already exists.
- Do not un-ready Q-001 / Q-014 / Q-003 / Q-006 / Q-015.

## Mapping artifact

`research/mappings/content-gen-graph.md`
