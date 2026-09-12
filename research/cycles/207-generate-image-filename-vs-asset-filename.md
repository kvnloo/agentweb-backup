# Cycle 207 — `generate_image.filename` is the output name, not the logo token

**Date:** 2026-09-12T03:26:00Z
**Question:** Cycle 206 next: `generate_image.filename`
required (MCP L2093 / Emma L5052) colliding with
cycle 205 `asset.filename` (`logo.png` / `'url'`)?

**Answer:** Same JSON key, two contracts. Cycle 205
prints brand `asset.filename` as the LLM-visible
token (`Primary Logo: logo.png` or `Brand Guide:
url`). `generate_image` **requires** `filename` as
the **output** name of the generated image — MCP
L2085 “Filename for the generated image”, Emma
L5008 “Name for the generated image file (should
include .png extension)”. `logo_image` is the logo
URL and is **not** in `required` (MCP L2093 /
Emma L5052: `prompt`, `filename`, `category`).

The leaf only rejects empty (`imageGeneration.ts`
L1526–1530). `'url'` and `logo.png` both pass.
S3 sanitizer keeps both (`s3Utils.ts` L249–265
`[^a-zA-Z0-9.-]`). HITL interpolates it
(`generateImage` L28895 `save the result as
"${filename}"`). Success persists
`Image generated: ${result.filename}` (L29083)
and `metadata.imageFilename` — the work-plan
identity (`extractGeneratedImageFilenames`
L5883–5889).

ENG-326 already recovers a missing `logo_image`
from persist (`getPersistedBrandLogoUrlForUser`
L28939). Copying the visible token into the
**required** field is the hole the recover does
not cover: the ad is stored as `url` / `logo.png`
and later generations with that name de-dupe as
already done. Hermes native `IMAGE_GENERATE_SCHEMA`
requires `prompt` only (cycle 162). Q-014 lists
this required triple; it does not change it.
A-011 parks Emma camelCase vs MCP snake — not
this homonym. Occupied `emma/tools.ts` `#2832`.
Do not add A-021. Do not un-ready Q-014.

## Evidence

Required triple — filename is output, logo URL
is optional:

```2081:2093:backend/src/mcp/server/apiTools.ts
    description: 'Generate images using AI image generation models.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Detailed description of the image to generate' },
        filename: { type: 'string', description: 'Filename for the generated image' },
        // ...
        logo_image: { type: 'string', description: 'Logo image URL to add' },
      },
      required: ['prompt', 'filename', 'category']
```

```5007:5052:backend/src/emma/tools.ts
        filename: {
          type: 'string',
          description: 'Name for the generated image file (should include .png extension)'
        },
        // ...
        logo_image: {
          type: 'string',
          description: 'URL of a logo image to add ...'
        },
      required: ['prompt', 'filename', 'category']
```

Emma description still tells the model to pass
“the logo URL from their brand guidelines
(read_brand_guidelines tool)” via `logo_image`
(L4999). MCP does **not** list that tool
(`mcp.apiTools.test.ts` L101). Tests pin
`required` contains `category` (L410–411), not
filename — ENG-343 is load-bearing for eval, not
for this homonym.

Leaf — non-empty only:

```1525:1531:backend/src/services/imageGeneration.ts
    // Filename validation - just ensure it's not empty
    if (!params.filename || params.filename.trim() === "") {
      return {
        valid: false,
        error: "Filename is required",
      };
    }
```

S3 key last segment is that string:

```249:265:backend/src/utils/s3Utils.ts
    const sanitizedFilename = normalizedFilename
      .replace(/[^a-zA-Z0-9.-]/g, '_')
      .replace(/\s+/g, '_');
    const key = `users/${userId}/files/${Date.now()}/${randomToken}/${sanitizedFilename}`;
```

HITL and persist use it as the human/work-plan
name:

```28893:28895:backend/src/services/agentModeService.ts
    if (Array.isArray(inputImages) && inputImages.length > 0 && confirm !== true) {
      const thumbs = inputImages.map((url, i) => `![source image ${i + 1}](${url})`).join('\n');
      const summary = `Edit/regenerate ${inputImages.length} existing image(s) and save the result as "${filename}".`;
```

```29081:29089:backend/src/services/agentModeService.ts
          await chatbotDb.addMessageToSession(sessionId, {
            role: 'system',
            content: `Image generated: ${result.filename}`,
            metadata: {
              kind: 'image-generated',
              imageFilename: result.filename,
```

Missing `logo_image` is recovered; a copied
filename is not:

```28933:28943:backend/src/services/agentModeService.ts
      if (
        !logoImage &&
        (!Array.isArray(inputImages) || inputImages.length === 0) &&
        promptRequestsLogo(prompt) &&
        !promptCreatesLogo(prompt)
      ) {
        const persistedLogo = await getPersistedBrandLogoUrlForUser(userId);
        if (!persistedLogo) {
          return missingBrandLogoToolResult();
        }
        logoImage = persistedLogo;
```

MCP execute forwards `args.filename` as-is
(`apiTools.ts` L2100). REST
`POST /generate-image` (`emmaApi.ts` L177–181)
does the same. Occupied `#2832`. Do not patch.

## Relation to A-002 / A-007 / A-008

A-008 persist (after #2) owns one asset handle
printed as a URL (cycle 205) **and** a distinct
output-name field that is not that handle.
Hermes: one `IMAGE_GENERATE_SCHEMA`, required
`prompt` only. Two in-process schemas sharing
the key `filename` is not A-006.

## Next cycle candidate

`extractGeneratedImageFilenames` de-dupes on
that string (`seen.has(filename)` L5889), so two
parallel variants both named `logo.png` count as
one work-plan asset. File-level. Do not add
A-021.
