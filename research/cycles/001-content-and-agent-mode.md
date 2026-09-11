# Cycle 001 — content stack + Agent Mode/MCP

**When:** 2026-09-11  
**Focus:** Image/video/human-eval pipeline; Agent Mode turn; Hermes OAuth; loops.

## Content generation (evidence)

Emma `generate_image` → `agentModeService.generateImage` → `imageService.generateImage`
→ Azure GPT-image / Gemini / Runway → C2PA strip → S3 → chat + `enqueueAutoHumanEval`.

Failover (`getImageGenerationFallbackModel`) is a **static** list
`gpt-image-2 → gemini-3.1-flash-image → gemini-2.5-flash-image` and **does not
run** for explicit model, edits, or logo composites.

Video: Seedance (Higgsfield MCP) → Veo; Remotion `BrandedVideo` for overlays.
Human eval: Matt reviews images/landings in Slack; onboarding has a separate
swipe rater. Neither feeds the router.

**Do not touch:** `meterUserUsage`, C2PA default-on, logo preservation prompt.

## Agent Mode (evidence)

Turns are HTTP + worker + SSE, not the Socket.IO-centric README picture.
Socket.IO is Emma sidebar + some fanout.

`coding_agent` now does **diff edits** via `codingAgentService`. The 2026-03
"Emma can't edit large files" investigation is **stale for landing pages**,
still true vs Claude Code as a general coding environment.

Hermes OAuth protocol is done; operator UX is PTY + paste callback URL.
Loops (`backend/src/loops`) are closed-loop sensors that **propose specs**,
they do not auto-merge code.

## Queue mutations this cycle

- Promoted Q-001, Q-002, Q-003, Q-004 as the top wedge.
- DISCARD Q-012 (Kerdoios duplicate) and Q-013 (god-object rewrite).
- PARK Q-011 behind WhatsApp PR #2271.

## Next cycle

Open PR collision pass + whether `edit_landing_page_file` is still reachable.
