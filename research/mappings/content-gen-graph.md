# Content-gen graph (Emma vs Kevin's video/design repos)

Snapshot: 2026-09-11. Research only.

## What Emma already is

```
prompt
  ├─ generate_image → Azure GPT-image | Gemini | Runway gen4
  │     C2PA strip → S3 → meter per image → Slack human-eval (Matt)
  │
  └─ generate_video → Seedance 2.0 (Higgsfield) → Veo fallback
        optional compose=true
           └─ remotionService.compose
                 composition id: BrandedVideo ONLY
                 IntroOverlay (lower-third) + clip concat + OutroOverlay
                 + optional voiceover
                 vendor meter: remotion / branded_video
```

`compose_video` is the same Remotion path without a new generation.
`mux_video_with_audio` is a separate ffmpeg-style mux, not a second
composition.

Hermes cannot see any of the video tools (not on `mcpToolRegistry`).
Image is hidden (`internal: true`) until Q-014.

## What is *not* missing

| Idea | Status in this tree |
|---|---|
| Lower-third intro | `IntroOverlay` in `BrandedVideo.tsx` |
| Product / CTA end card | `OutroOverlay` (opaque slate, Layer 8) |
| Multi-clip stitch | `extraClipUrls` + cross-fade |
| Brand colors / logo | `primaryColor`, `secondaryColor`, `logoUrl` |
| Voiceover on the branded cut | `audioUrl` on compose |

Q-007's bootstrap slice ("second composition for lower-third") is
**done**. A new `Composition` id is optional product work, not a gap.

## Adjacent repos — adapter vs port

| Repo | Renderer | AgentWeb move |
|---|---|---|
| `hyperframes` | HTML/CSS → MP4 | Do **not** replace Remotion Lambda. Optional later: an Emma *skill* that tells in-app coding_agent to emit HyperFrames HTML is a different product (and lives in customer-visible landing/video, not this clone's first PR). |
| `MoneyPrinterTurbo` | LLM → stock/B-roll short video | Duplicate of `generate_video`. DISCARD as a port. |
| `open-design` | local design systems + HyperFrames | Operator laptop, not Emma metering. |
| `ComfyUI` | diffusion node graph | Optional image *backend* (Q-009, park). Do not put a GPU GUI in EB. |
| `mcp-bench-router` | DesignArena → OpenRouter **chat** | Cycle 8: use the `image` leaderboard IDs, not this MCP, for Q-003. |

## Video on MCP (Q-016)

Do not bundle with Q-014. `generate_image` is $0.04–$0.134;
`seedance-2.0` is $1.55 per 8s clip. Listing video before we have
product intent (and Q-014 metering tests) repeats ENG-973's cost
scare at 40×. Park until Q-014 has shipped and Kevin/Matt want Hermes
ads-video.

## Fail-open / invariants

Remotion failure must not skip `meterUserUsage` on a successful Seedance
clip. Logo on the end card is `logoUrl` (brand), same preservation
spirit as image `logoImage`. Do not add a Dynamo table for compositions.
