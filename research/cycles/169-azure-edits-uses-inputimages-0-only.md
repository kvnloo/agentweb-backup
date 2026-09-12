# Cycle 169 — Azure `/images/edits` uses `inputImages[0]` only; logo-at-end drops

**Date:** 2026-09-12T00:56:00Z
**Question:** Cycle 168: Runway sends the **mutated** array as
`referenceImages`. Does Azure `/images/edits` do the same, or keep
only `inputImages[0]`?

**Answer:** Only `[0]`. L651. Logo is `push`ed **last** (cycle 165
L477–485). An edit + `logo_image` on `gpt-image-1` / `gpt-image-2`
sends the **source** to `/images/edits` and **drops the logo bytes**.
The CRITICAL LOGO sentence still prepends to the prompt. Hermes
raises rather than silently dropping sources. Not a nanoservice.

## Evidence

```649:669:backend/src/services/imageGeneration.ts
    if (hasInputImages) {
      const inputImageUrl = params.inputImages![0];
      const imageResponse = await axios.get(inputImageUrl, { responseType: 'arraybuffer' });
      // ...
      formData.append('image', imageBuffer, { filename: 'input.png', contentType: 'image/png' });
      formData.append('prompt', params.prompt);
      const url = `${azureEndpoint}/openai/deployments/${deploymentName}/images/edits`;
```

One FormData `image`. No loop. No `logoImage` field.

After cycle 165’s mutate:

| Caller | `inputImages` after push | Azure sends |
|---|---|---|
| logo only | `[logo]` | logo (works as edit-of-logo) |
| `[src]` + logo | `[src, logo]` | **src only**; logo dropped |
| `[a, b]` + logo | `[a, b, logo]` | **a only**; b and logo dropped |

Gemini 3 (L1232–1240) and Runway (L1363–1390) iterate the whole
array. The logo test (`imageGeneration.test.ts` L1284–1326) is
**Gemini 3** and asserts two `axios.get`s. There is no Azure N>1
assertion. The default comment at L492 already knows this:
“`gemini-3-pro-image-preview` as default (supports multiple input
images).”

Hermes live `_prepare_fal_request` L365–370: “Fail clearly rather than
silently dropping sources.” AgentWeb Azure drops.

Q-014 lists both `input_images` and `logo_image`. After listing,
Hermes-as-client can pass both with `image_model=gpt-image-2`.
Do not un-ready Q-014 (listing) or Q-003 (mapper; default flip is
already Matt-gated). Cycle 170: that cheaper default would make
this the **unspecified** path.

## What this is not

Not a product patch. Do not reorder `push` so logo is `[0]` (that
would drop the **source**). Optional later, in A-008: refuse N>1 on
Azure, or send logo as a second part if the vendor grows one.
Do not add A-021.

Not A-006. Three vendor shapes is why the leaf stays in-process.

Not a Q-014 / Q-001 / Q-003 status change.

## Relation to A-002 / A-007 / A-008

A-008 owns the mutate + Azure `[0]`. A capability table
(`gpt-image-*: max_refs=1`) is the Hermes `max_reference_images`
analog. A-007 can advertise `input_images.maxItems` from that
table after #2.

## Next cycle candidate

L492 already picked Gemini 3 as default **because** it supports
multiple inputs. Q-003’s cheaper `gpt-image-2` default (Matt)
would move the unspecified path onto this `[0]` drop. File-level
on L492 vs Q-003 do-not. Do not un-ready Q-003.
