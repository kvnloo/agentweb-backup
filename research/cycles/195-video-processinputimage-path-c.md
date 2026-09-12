# Cycle 195 — Video `processInputImage` is a second Path C; Seedance default never calls it

**Date:** 2026-09-12T02:35:00Z
**Question:** Cycle 194: leaf `processInputImage` is Path C.
Is `videoGeneration.ts` L236 a second copy (no UA, no
SVG)? Q-016 parked.

**Answer:** Yes. Same private name, Path C, **thinner**.
30s `axios.get`, **no** User-Agent, **no** SVG→PNG, MIME
from `content-type` else hardcoded `image/png`. **No**
`isS3Url` / `presignS3Url` / `getS3ObjectStream`. **No**
`data:` skip. Callers are **only** Veo `startFrame` L393
and `endFrame` L418. Default model is `seedance-2.0`
(L46): Higgsfield `media_import_url` passes the raw URL
to the vendor (L827–838). Seedance→Veo fallback (L994–
1000) re-enters `generateVideo` with the **same** frames,
so a failed Seedance then Path-C GETs locally. Tests pin
Higgsfield import of `example.com`; they **spy**
`generateWithVeo31` on fallback. `__tests__` grep
`processInputImage` is empty. Not a nanoservice. Do not
add A-021. Do not un-park Q-016. Do not un-ready Q-014.

## Evidence

The video helper (thinner than the image leaf):

```236:253:backend/src/services/videoGeneration.ts
  private async processInputImage(imageUrl: string): Promise<{ buffer: Buffer; mimeType: string }> {
    try {
      // Download the image from URL
      const response = await axios.get(imageUrl, {
        responseType: 'arraybuffer',
        timeout: 30000,
      });
      
      const imageBuffer = Buffer.from(response.data as ArrayBuffer);
      
      // Try to determine MIME type from response headers
      let mimeType: string = 'image/png'; // Default to PNG
      const contentType = response.headers['content-type'];
      if (contentType && contentType.startsWith('image/')) {
        mimeType = contentType;
      }
```

Image leaf (`imageGeneration.ts` L816–835) has Mozilla
UA, `getImageMimeType` (URL-extension sniff including
`.svg`), and SVG→PNG after the GET. Azure edit L654 is
thinner still (no timeout). `classifyBrandLogoUrl` L492
is a 15s probe with the image UA.

| Site | timeout | UA | SVG | MIME |
|---|---|---|---|---|
| Image helper L816 | 30s | AgentWeb/1.0 | yes | `getImageMimeType` |
| Video helper L236 | 30s | **none** | **no** | header or `image/png` |
| Azure edit L654 | **none** | none | no | FormData PNG lie |
| Logo probe L492 | 15s | AgentWeb/1.0 | n/a | probe only |

Veo callers (no `data:` skip):

```391:418:backend/src/services/videoGeneration.ts
      if (params.startFrame) {
        try {
          const processedImage = await this.processInputImage(params.startFrame);
          // ...
      if (params.endFrame) {
        try {
          const processedImage = await this.processInputImage(params.endFrame);
```

Default never hits that helper:

```46:46:backend/src/services/videoGeneration.ts
const DEFAULT_VIDEO_MODEL = "seedance-2.0";
```

```709:714:backend/src/services/videoGeneration.ts
        if (params.startFrame) {
          medias.push({ value: await this.importHiggsfieldMedia(callTool, params.startFrame), role: "start_image" });
        }
        if (params.endFrame) {
          medias.push({ value: await this.importHiggsfieldMedia(callTool, params.endFrame), role: "end_image" });
        }
```

```827:831:backend/src/services/videoGeneration.ts
  private async importHiggsfieldMedia(
    callTool: (toolName: string, args: Record<string, any>, opts?: { timeoutMs?: number }) => Promise<any>,
    url: string
  ): Promise<string> {
    const raw = await callTool("media_import_url", { url, type: "image" }, { timeoutMs: 120000 });
```

Fallback re-uses the same URL:

```994:1000:backend/src/services/videoGeneration.ts
          if (!result.success) {
            // Automatic fallback: if Seedance fails (auth/credits/job error/timeout),
            // regenerate with Veo 3.1 so video generation still succeeds.
            console.warn(
              `VideoService: Seedance generation failed (${result.error}); falling back to Veo 3.1`
            );
            return await this.generateVideo({ ...params, videoModel: "veo-3.1-generate-preview" });
```

Tests: Higgsfield L211–219 pins `media_import_url` with
`https://example.com/frame.png`. Fallback L288–298 /
L327–331 / L526–538 **mock** `generateWithVeo31`. Direct
Veo L550 is a past-deadline case with **no** frames.
Grep `processInputImage` in `backend/src/__tests__` is
empty.

Emma already advertises those URLs. `generate_video`
(`emma/tools.ts` L5080 / L5108–5114) and character
tools (L5385 / L5401) tell the model to pass
`referenceImageUrl` as `startFrame`. REST
`POST /generate-video` (`emmaApi.ts` L192) forwards
`start_frame`. MCP grep of `generate_video` is still
empty (cycle 86). Q-016 stays **park**.

## Keep / discard

KEEP the mapping. Same `startFrame` URL is Path D
(Higgsfield MCP `media_import_url`) on the default and
Path C (local axios) on Veo / Veo fallback. Copying
Path A/B onto the Veo helper is A-008 persist after #2,
not a fifth `listen()`. Do not HTTP-split video to
“prepare” Q-016. Do not list `generate_video` on MCP
from this cycle.

## Relation to A-002 / A-007 / A-008

A-008 persist should own fetch-own-bucket for the image
helper, Azure L654, **and** this Veo copy. Higgsfield
already composes via MCP (vendor fetches). After #2.
Do not HTTP-split. Do not revive A-006.

## Next cycle candidate

Veo multi-clip `generateKeyframes` (`videoGeneration.ts`
L875) persists via `imageService.generateImage` then
those Family A URLs become `startFrame`/`endFrame`
(L1032) → Path C GET. Or brand-guide matcher L15132
`includes('.s3.')`. File-level. Q-016 parked. Do not
add A-021.
