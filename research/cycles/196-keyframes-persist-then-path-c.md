# Cycle 196 — `generateKeyframes` persist-then-Path-C is Veo-only; Seedance ignores `useKeyframes`

**Date:** 2026-09-12T02:45:00Z
**Question:** Cycle 195: video `processInputImage` is Path C
on Veo frames. Do Veo multi-clip keyframes persist via
`imageService.generateImage` then Path-C GET those URLs?

**Answer:** Yes, and only there. `generateKeyframes`
(L851–897) calls the image leaf with **no** `imageModel`
→ Gemini 3 default (L492, $0.134/frame). Returned
`imageUrl`s are Family A persist. Veo multi-clip then
sets them as `startFrame`/`endFrame` (L1032–1033) →
cycle 195 Path C. `useKeyframes` is read **once**, inside
`modelToUse === "veo-3.1-generate-preview"` **and**
`clipCount > 1` (duration > 8s). Default `seedance-2.0`
never reads it. Emma schema L5104–5106 does not say
Veo-only. Seedance→Veo fallback L1000 spreads `...params`
including `useKeyframes`, so a failed 9–15s Seedance
suddenly bills N+1 Gemini 3 images then Path-C GETs
private S3. `__tests__` grep `useKeyframes` /
`generateKeyframes` is empty. REST `POST /generate-video`
does not pass the flag. Not a nanoservice. Do not add
A-021. Do not un-park Q-016. Do not un-ready Q-014.

## Evidence

The only read of the flag:

```1010:1033:backend/src/services/videoGeneration.ts
        } else if (modelToUse === "veo-3.1-generate-preview") {
          if (clipCount === 1) {
            result = await this.generateWithVeo31({ ...params, durationSeconds: veoGenerateDuration });
            // ...
          } else {
            const filenameBase = params.filename.replace(/\.mp4$/i, '');
            let keyframes: string[] | null = null;
            if (params.useKeyframes) {
              keyframes = await this.generateKeyframes(params.prompt, clipCount, filenameBase, params.userId);
            }
            const clipResults = await Promise.all(
              Array.from({ length: clipCount }, (_, i) =>
                this.generateWithVeo31({
                  ...params,
                  startFrame: keyframes ? keyframes[i] : params.startFrame,
                  endFrame: keyframes ? keyframes[i + 1] : params.endFrame,
```

Higgsfield `generateWithHiggsfield` grep of `useKeyframes`
is empty. Default model L46 is `seedance-2.0` (single
clip 4–15s). Emma still advertises:

```5104:5106:backend/src/emma/tools.ts
        useKeyframes: {
          type: 'boolean',
          description: 'Optional: When true and durationSeconds > 8 (multiple clips), automatically generate AI keyframe images (f0, f1, ... fN) to guide each clip. Clip i gets startFrame=f[i] and endFrame=f[i+1], so Veo interpolates between visually coherent waypoints. This greatly improves visual continuity across clip boundaries. Recommended for multi-clip videos. Defaults to false.'
```

Execute L5195 forwards it. REST `emmaApi.ts` L192
forwards `start_frame` / `end_frame` only — **no**
`useKeyframes`. `user-release.ts` L2875–2878 documents
the flag on `generate_video` without saying Seedance
is a no-op.

Persist then Path C:

```873:891:backend/src/services/videoGeneration.ts
      const results = await Promise.all(
        framePrompts.map((fp, i) =>
          imageService.generateImage({
            prompt: fp,
            filename: `${filenameBase}_kf${i + 1}.png`,
            size: "16:9",
            userId,
          })
        )
      );
      // ...
      const urls = results.map((r) => r.imageUrl!);
```

No `imageModel` → leaf L492 Gemini 3. No `category` /
HITL / `logoImage` — video calls the **leaf**, not
`agentModeService.generateImage`. Cycle 173 persist is
Family A `uploadFileToS3` (`image/png`, no ACL). Those
URLs then hit video `processInputImage` L236 (cycle
195 Path C). Cycles 192–194: Path C fails when the
object is private. `db.ts` L2994 uploads without ACL.
Keyframe-guided Veo can pay N+1 Gemini 3 images then
throw `Failed to process start frame` on its own S3.

Fallback carries the flag:

```994:1000:backend/src/services/videoGeneration.ts
          if (!result.success) {
            console.warn(
              `VideoService: Seedance generation failed (${result.error}); falling back to Veo 3.1`
            );
            return await this.generateVideo({ ...params, videoModel: "veo-3.1-generate-preview" });
```

Duration 9–15s → Veo `clipCount` 2 → 3 keyframe images
if `useKeyframes` was set. Seedance success: zero
keyframes, flag ignored. Tests never pin either arm.

## Keep / discard

KEEP the mapping. In-process image-leaf call is the
right modular-monolith edge (not A-006). The defect
is persist-then-HTTP of own-bucket URLs. A-008 persist
`fetch-own-bucket` after #2 should skip Path C for
Family A Location. Do not HTTP-split video. Do not
list `generate_video` on MCP from this cycle.

## Relation to A-002 / A-007 / A-008

A-008 persist owns fetch-own-bucket for image helper,
Azure L654, Veo `processInputImage`, **and** these
self-generated keyframe URLs. After #2. Do not HTTP-
split. Do not revive A-006.

## Next cycle candidate

Brand-guide matcher `agentModeService.ts` L15132
`includes('.s3.')` is a fourth host matcher (wider than
repair). Or Higgsfield `media_import_url` of character
`referenceImageUrl` as `startFrame` (Emma L5385) —
Path D vendor fetch of Family A. File-level. Q-016
parked. Do not add A-021.
