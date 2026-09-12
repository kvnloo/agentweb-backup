# Cycle 193 — Emma C2PA/background tools advertise S3; tests pin Path C

**Date:** 2026-09-12T02:18:00Z
**Question:** Cycle 192: `removeC2PAFromImage` L29538 and
`removeImageBackground` L29660 are Path C siblings of
blog repair. Same class as Path A/B, or a different
contract?

**Answer:** Same Path C axios, **advertised as S3**.
Emma schema says `image_url` “can be S3 URL, data URL,
or any accessible image URL” (`emma/tools.ts` L4936 /
L4969). Data URL skips axios (tested). HTTP hits Path C.
The C2PA suite has `should handle S3 URLs` and **pins**
`axios.get('https://s3.amazonaws.com/bucket/…')` — Family
A path-style, the spelling `extractS3KeyFromUrl` parses.
Write is `uploadFileToS3` (Family A). REST exists only
for C2PA. MCP still has neither (cycle 174). Not a
nanoservice. Do not add A-021.

## Evidence

Both methods: data URL decode **or** bare axios, then
Family A helper:

```29532:29545:backend/src/services/agentModeService.ts
      if (imageUrl.startsWith('data:image/')) {
        const base64Data = imageUrl.split(',')[1];
        imageBuffer = Buffer.from(base64Data, 'base64');
      } else {
        const response = await axios.get(imageUrl, {
          responseType: 'arraybuffer',
          timeout: 30000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; AgentWeb/1.0)'
          }
        });
```

`removeImageBackground` L29656–29667 is the same
block. Upload L29585 / L29705 is `uploadFileToS3`
with `'image/png'`.

Emma’s tool text names S3 first:

```4934:4937:backend/src/emma/tools.ts
        image_url: {
          type: 'string',
          description: 'URL of the image to process (can be S3 URL, data URL, or any accessible image URL)'
        },
```

The C2PA test **blesses** Path C on a path-style S3
URL (cycle 188’s Family A mock spelling):

```143:163:backend/src/__tests__/agentModeService.removeC2PA.test.ts
    it('should handle S3 URLs', async () => {
      ...
      const result = await (agentModeService as any).removeC2PAFromImage(
        'https://s3.amazonaws.com/bucket/original-image.png',
        'new-image.png',
        'user123'
      );

      expect(mockAxios.default.get).toHaveBeenCalledWith(
        'https://s3.amazonaws.com/bucket/original-image.png',
        expect.any(Object)
      );
```

Grep of that file for `presign` / `isS3Url` /
`extractS3KeyFromUrl` is empty. Background tests use
`https://example.com/logo.jpg` and data URLs only;
upload mock is also `s3.amazonaws.com/bucket/…`.

| Face | Fetch | Listed? |
|---|---|---|
| Emma `remove_c2pa_from_image` | Path C | yes (`emma/tools.ts` L4925) |
| REST `POST /remove-c2pa` | same method | `emmaApi.ts` L216; **metered** (`emmaTokenBudget.ts` L61) |
| Emma `remove_image_background` | Path C | yes (L4952); **no** `emmaApi` route |
| MCP | — | grep `backend/src/mcp` empty (cycle 174, still) |

`executeTool` mock switch has `remove_c2pa_from_image`
(L7848) and **no** `remove_image_background`.

Axios shape is byte-identical to the leaf helper
`processInputImage` (`imageGeneration.ts` L816–823:
30s, same Mozilla UA) — also Path C, no presign.
Path B (`describe_image` L9327) is the exception in
this class, not the image toolbox default.

Cycle 174: C2PA default-on is the **leaf** data-URL
gate. This cycle is the **Emma post-hoc strip
tool**: it re-downloads then `uploadFileToS3`. Do
not list it on MCP (A-011 parks schema spray; cycle
174 already said do not add A-021 for listing).

## What this is not

Not a product patch. Do not change C2PA, fetch, or
schemas on a research turn. Do not add A-021.
Occupied: `emma/tools.ts` #2832; `agentModeService.ts`
pile.

Not a Q-014 / Q-001 / Q-003 status change. MCP
`generate_image` listing does not add `remove_c2pa`.
Leaf C2PA default-on is unchanged.

Not A-006. HTTP-splitting these two tools would copy
Path C. Copying Path B (`isS3Url` + `presignS3Url`)
or Path A (`getS3ObjectStream`) onto both is A-008
persist, after #2, not instead of Q-014.

## Relation to A-002 / A-007 / A-008

A-008 persist should own fetch-own-bucket. Until
then Emma’s “S3 URL” argument is Path C. Do not
HTTP-split. Do not revive A-006.

## Next cycle candidate

`processInputImage` (`imageGeneration.ts` L816) is
the same Path C axios used by Gemini/Runway edits.
Azure skips it (cycle 171). Q-014 `input_images` of
a private S3 object hits this helper. File-level.
Or brandGuide L15132 `includes('.s3.')` is a fourth
matcher. Do not add A-021.
