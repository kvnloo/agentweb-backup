## ENG-0000: Migrate video generation to gemini-omni-1.1-flash (2026-10-08)

**Why:** Google shuts down `veo-3.1-generate-preview`, `veo-3.1-fast-generate-preview`
(and the older `veo-3-generate-preview` / `veo-3.0-generate-preview`) on 2026-10-22.
The replacement is `gemini-omni-1.1-flash`.

**API facts (live-tested 2026-10-08 with the dev key):**
- The model accepts ONLY the Gemini Interactions API. `generateContent` and
  `predictLongRunning` are rejected ("only supports Interactions API").
- `POST https://generativelanguage.googleapis.com/v1beta/interactions?key=KEY` with
  `{model, input, response_format: {type:"video", aspect_ratio:"16:9"|"9:16", resolution:"360p"|"720p"|"1080p"|"4k"}}`.
  `input` is the prompt string, or `[image parts..., {type:"text", text}]`. One image =
  image-to-video; two images (first, then last) = first/last-frame interpolation.
- Synchronous: the response has `status:"completed"` and the clip as base64 in
  `steps[].content[]` (`{type:"video", mime_type:"video/mp4", data}`). No polling,
  no file download. A 360p request took 25s and returned a 10.0s clip.
- Duration (live-verified 2026-10-08): `response_format.duration` is a STRING such as
  `"5s"` (integer 3–10). `{"duration":5}` → 400 Invalid input; `"duration_seconds"` →
  unknown parameter; `{"duration":"5s"}` returned a 5.01s clip. We always send each
  clip's exact length (default 8s). Requests >10s split into <=10s clips that sum to the
  request (14s → 10+4; a <3s remainder borrows from the previous clip: 21s → 10+8+3),
  generated in parallel and stitched in Remotion (`maxClipSeconds: 10`).
- Same secret as Veo: `{dev,prod}/AgentWeb/Google/Video`.

**Pricing:** $17.50/M video output tokens (5,792 tokens/s at 720p ≈ $0.1014/s),
$9/M text output, $1.50/M input. `omniVideoUsageCostUsd` bills the response `usage`;
when absent we estimate $0.1014 x the actual requested seconds. Legacy Veo price entries stay so
historical spend events still re-derive. The price-book version stays `2026-10-08`
(the addition is a new key only; no existing price moved) and the fingerprint pin was
updated.

**Behavior changes:**
- Seedance 2.0 stays the default; its automatic fallback is now gemini-omni-1.1-flash
  (was Veo 3.1). The Veo quota fallback to `veo-3.1-fast-generate-preview` is gone —
  there is one Google model, and a 429 fails clearly with a quota message.
- Retired Veo ids are accepted as input aliases for gemini-omni-1.1-flash everywhere
  (video service, `agent_mode_video_api_default_model` setting, admin dropdown, agent
  engine `video_model`). Read-time only; no stored data is rewritten.
- `VideoService.generateVideo` now returns `model` (the model that actually produced the
  clip, after any fallback) and `costUsd`; Emma's session cost uses them, so a
  Seedance→Omni fallback is no longer costed as the requested model.
- The agent engine's `generate_short_video` default branch calls the Interactions API
  over REST (`requests`) instead of `client.models.generate_videos`.

**Not changed:** `docs/model-roles-inventory.md` is a generated snapshot (its line
references were already stale) and `agent-engine/examples/Get_started_Veo.ipynb` is an
example notebook; neither is a runtime path.
