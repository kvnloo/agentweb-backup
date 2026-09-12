# Cycle 208 — Work-plan identity de-dupes on `filename`, not URL

**Date:** 2026-09-12T03:30:00Z
**Question:** Cycle 207 next:
`extractGeneratedImageFilenames` de-dupes on
that string (L5889) so two variants named
`logo.png` count as one?

**Answer:** Yes, and a test already pins it.
`extractGeneratedImageFilenames` L5889
`seen.has(filename)` skips the second marker.
`buildWorkPlanContext.test.ts` L268–274:
`a.png`, `b.png`, `a.png` → `['a.png',
'b.png']`. That list is the continue-turn
identity: `buildGeneratedAssetsAwarenessText`
L5909 interpolates the **length** and L5910
lists each name once, with “DO NOT regenerate
them”. Callers L6074 (work plan) and L6083
(plain multi-image, ENG-510 “multiple
ad-illustration variants”).

S3 keys are unique per upload (`s3Utils.ts`
L244–265 timestamp + token + filename). The
persist marker carries `imageUrl` and says
“De-duped by URL” (L29093).
`scanMessagesForAssets` tests pin URL de-dupe
(L127–141): two markers, same URL, one asset.
Work-plan continue uses **filename**, so N
billed S3 objects named `logo.png` (cycle 207
homonym) surface as **one** already-made
asset. Emma `generate_image` L4999 tells the
model to emit N parallel variant calls; it
never says filenames must be unique. MCP’s
one-line description has no variants paragraph
at all.

The completion **gate** is a different counter:
without `expectedAssetCountTools`,
`Math.max(filenameCount, extractProducedAssetCount)`
(L33657 / L34126). Tool-call successes can
still see N. Occupied `agentModeService.ts`
pile. Not a fifth HTTP service. Do not add
A-021. Do not un-ready Q-014.

## Evidence

De-dupe is on the string, documented and
tested:

```5874:5895:backend/src/services/agentModeService.ts
  public static extractGeneratedImageFilenames(sessionHistory?: any[], sinceIso?: string): string[] {
    // ...
      if (!filename || seen.has(filename)) continue;
      // ...
      seen.add(filename);
      filenames.push(filename);
```

```268:274:backend/src/__tests__/agentModeService.buildWorkPlanContext.test.ts
    it('de-duplicates repeated filenames preserving first-seen order', () => {
      const history = [
        { role: 'system', content: 'Image generated: a.png' },
        { role: 'system', content: 'Image generated: b.png' },
        { role: 'system', content: 'Image generated: a.png' },
      ];
      expect(AgentModeService.extractGeneratedImageFilenames(history)).toEqual(['a.png', 'b.png']);
```

Continue-turn prompt uses that length as
“already exist”:

```5907:5911:backend/src/services/agentModeService.ts
  public static buildGeneratedAssetsAwarenessText(generatedImageFilenames?: string[]): string {
    if (!Array.isArray(generatedImageFilenames) || generatedImageFilenames.length === 0) return '';
    let text = `⚠️ ALREADY-GENERATED ASSETS (${generatedImageFilenames.length}): these images already exist in this session and are saved — DO NOT regenerate them UNLESS the user explicitly asks to regenerate, restart, redo, or change them. Otherwise only generate the images that are still missing.\n`;
    for (const filename of generatedImageFilenames) {
```

Plain multi-image (no work plan) is the same
helper — ENG-510 comment names variants:

```6077:6084:backend/src/services/agentModeService.ts
      // ENG-510: even WITHOUT a work plan (plain multi-image requests — the reported
      // scenario), a run that timed out mid-batch leaves already-generated images in
      // history. On the "continue" turn the model must be told which images already
      // exist so it regenerates ONLY the missing ones
      const generatedImageFilenames = AgentModeService.extractGeneratedImageFilenames(sessionHistory);
      const assetAwarenessText = AgentModeService.buildGeneratedAssetsAwarenessText(generatedImageFilenames);
```

Persist stores a unique URL; comment says URL
de-dupe for the **asset scan**, not this
counter:

```29081:29094:backend/src/services/agentModeService.ts
          await chatbotDb.addMessageToSession(sessionId, {
            role: 'system',
            content: `Image generated: ${result.filename}`,
            metadata: {
              kind: 'image-generated',
              imageFilename: result.filename,
              // ENG-510: ... De-duped by URL.
              imageUrl: result.imageUrl
```

S3 uniqueness is per upload, not filename:

```244:265:backend/src/utils/s3Utils.ts
    const randomToken = Array.from(crypto.getRandomValues(new Uint8Array(16)))
    // ...
    const key = `users/${userId}/files/${Date.now()}/${randomToken}/${sanitizedFilename}`;
```

Work-plan tests that exercise the 18-image
resume path mint **unique** names
(`hook_${i}.png`, `matrix_1.png` in
`agentModeService.workPlan.test.ts` L679 /
L1030–1034). They never collide. Occupied
`agentModeService.ts`. Do not patch.

## Relation to A-002 / A-007 / A-008

A-008 persist (after #2) owns one handle per
result: the URL `scanMessagesForAssets` already
de-dupes on. Filename is a label, not the
identity. Two in-process counters (filename
vs URL vs tool-call) is not A-006. Hermes: one
result, one URL.

## Next cycle candidate

Work-plan gate `Math.max(filenameCount,
extractProducedAssetCount)` (L33657 / L34126)
can still see N tool successes while the
continue prompt lists 1. File-level. Do not
add A-021.
