# Cycle 197 — Character `referenceImageUrl` is Path D on the Seedance default

**Date:** 2026-09-12T02:50:00Z
**Question:** Cycle 196: keyframe persist-then-Path-C is
Veo-only. Does Emma’s character portrait (`create_character`
→ `startFrame`) Path-D fetch Family A on the **default**
Seedance path?

**Answer:** Yes. `create_character` (`emma/tools.ts`
L5422–5436) requires the S3 URL `generate_image` returned.
`list_characters` / `get_character` (L5385 / L5401) tell
Emma to pass that URL as `generate_video` `startFrame`.
Default model is `seedance-2.0` → Higgsfield
`media_import_url` (L827–838) — **vendor** fetches the
URL. Cycle 173 persist is Family A `uploadFileToS3`, no
ACL (`db.ts` L2994). Execute L5451 hardcodes
`referenceImageKey: ''`. REST upload (`characters.ts` L51)
does store the key; Emma’s path does not. MCP grep of
`list_characters` / `create_character` / `generate_video`
is empty. Tests pin `media_import_url` of `example.com`,
not S3. Not a nanoservice. Do not add A-021. Do not
un-park Q-016. Do not un-ready Q-014. Occupied:
`emma/tools.ts` #2832 — do not edit.

## Evidence

Emma writes a generate_image URL, not bytes:

```5434:5451:backend/src/emma/tools.ts
        reference_image_url: {
          type: 'string',
          description: 'S3 URL of the character portrait image, returned by generate_image'
        },
      required: ['name', 'description', 'reference_image_url']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.createVideoCharacter(context?.userId, {
      name: args.name,
      description: args.description,
      referenceImageUrl: args.reference_image_url,
      referenceImageKey: '',
```

`characterDb.createCharacter` stores that string opaque
(L64). No `extractS3KeyFromUrl`. Delete (`characters.ts`
L93) only `deleteObject`s when `referenceImageKey` is
set — Emma-created portraits are S3 orphans on delete.
REST upload L51 is `uploadFileToS3` (Family A) and
**does** return `key`.

Then the default video path is Path D:

```709:710:backend/src/services/videoGeneration.ts
        if (params.startFrame) {
          medias.push({ value: await this.importHiggsfieldMedia(callTool, params.startFrame), role: "start_image" });
```

```827:831:backend/src/services/videoGeneration.ts
  private async importHiggsfieldMedia(
    callTool: (toolName: string, args: Record<string, any>, opts?: { timeoutMs?: number }) => Promise<any>,
    url: string
  ): Promise<string> {
    const raw = await callTool("media_import_url", { url, type: "image" }, { timeoutMs: 120000 });
```

Cycle 195: Veo fallback Path-C GETs the **same** URL.
Character portraits therefore: billed Gemini 3 persist
(private object) → Seedance vendor GET → or Veo axios
GET. Path A (`getS3ObjectStream`) already exists on the
same host (`read_file_content` L28631) and is unused
here. Higgsfield cannot SDK-stream; it needs a fetchable
URL. A-008 persist after #2 should own
`publicOrPresignedUrl` for vendor hops (Path B), not a
fifth `listen()`.

Tests: `videoGeneration.test.ts` L211–219 pins
`media_import_url` of `https://example.com/frame.png`.
`characters.test.ts` L91 stores `s3.example.com`.
Grep of `referenceImageUrl` + `startFrame` together in
`__tests__` is empty. Attachment hint
(`attachmentFormatting.ts` L24–25) is a sibling Path D
source (uploaded image URL → `startFrame`).

MCP: still no `generate_video` (cycle 86). No character
tools either. Q-016 stays **park**.

## Keep / discard

KEEP the mapping. In-process character table + video
leaf is the right modular-monolith edge. The defect is
persist-then-HTTP of own-bucket URLs on the **default**
path (unlike cycle 196, which is Veo-only). Copying
Path B (presign) onto `importHiggsfieldMedia` is A-008
after #2, not instead of Q-014. Do not HTTP-split
Higgsfield — it is already the vendor MCP nanoservice.
Do not list characters or video on parent MCP from this
cycle.

## Relation to A-002 / A-007 / A-008

A-008 persist owns fetch-own-bucket **and** a presign
for vendor Path D. Image helper / Azure L654 / Veo
helper are Path C (local GET). Higgsfield is Path D
(vendor GET). After #2. Do not HTTP-split. Do not
revive A-006. Do not edit `emma/tools.ts` (#2832).

## Next cycle candidate

Brand-guide matcher `agentModeService.ts` L15132
`includes('.s3.') && includes('amazonaws.com')`.
`'s3.amazonaws.com'.includes('.s3.')` is **false** —
Family A path-style Location (cycle 188 tests) would
be classified `filename: 'url'`. Wider than CORS,
different from repair. File-level. Occupied:
`agentModeService.ts` pile. Do not add A-021.
