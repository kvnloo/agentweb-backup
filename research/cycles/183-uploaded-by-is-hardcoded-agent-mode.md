# Cycle 183 — `uploaded-by` is a hardcoded `agent-mode` constant

**Date:** 2026-09-12T01:40:00Z
**Question:** Cycle 182: late Gemini success S3-uploads
`users/{userId}/files/...` with `'uploaded-by':
'agent-mode'`. Is that stamp a caller argument, or a
lie on the shared helper?

**Answer:** A lie on the shared helper. Both
`uploadFileToS3` L276 **and** `uploadFileToS3WithPath`
L352 hardcode `'uploaded-by': 'agent-mode'`. The
signature has no `uploadedBy` (L230–235: `content`,
`filename`, `userId`, `contentType`). Onboarding ads,
cycle-182 orphans, blog heroes, CRM CSVs, Slack
uploads, video, voiceover, brand logos, and Agent Mode
files are indistinguishable in S3 metadata. Not a
nanoservice. Do not patch S3 metadata.

## Evidence

Signature has four arguments. The fifth value is a
constant:

```230:277:backend/src/utils/s3Utils.ts
export async function uploadFileToS3(
  content: Buffer | string,
  filename: string,
  userId: string,
  contentType: string
): Promise<S3UploadResult> {
  ...
      Metadata: {
        'original-filename': asciiMetadataFilename,
        'uploaded-by': 'agent-mode',
        'upload-timestamp': new Date().toISOString()
      }
```

`uploadFileToS3WithPath` repeats the same three-key
Metadata block at L350–354 (`'uploaded-by': 'agent-mode'`
at L352). Path is an argument; provenance is not.

The one-off that tells the truth is **not** those
helpers. `workPlanThumbnailService.ts` owns a second
`AWS.S3` client (L16–20), its own key, and
`CacheControl: 'public, max-age=31536000, immutable'`.
It **does** set a real caller tag:

```24:42:backend/src/services/workPlanThumbnailService.ts
async function uploadThumbnailBuffer(
  buffer: Buffer,
  key: string,
  contentType: string,
): Promise<string> {
  const result = await s3
    .upload({
      ...
      Metadata: {
        'uploaded-by': 'workplan-thumbnails',
        'upload-timestamp': new Date().toISOString(),
      },
    })
```

Grep of `backend/` for `'uploaded-by'` is **only those
three lines** (`s3Utils.ts` L276, L352;
`workPlanThumbnailService.ts` L37). The shared helper
lies; the thumbnail path is Hermes-shaped (caller
supplies the tag).

`uploadScreenshotToS3` L389–401 is not a third writer.
It wraps `uploadFileToS3` (`screenshot-${Date.now()}.jpg`,
`image/jpeg`) so screenshots inherit `agent-mode`.

Cycle 182’s orphan (`imageGeneration.ts` L582) is one
caller among many: `agentModeService.ts` (HTML, ads,
demos, PDFs), `emmaEmailService.ts` L264,
`brandLogo.ts` L417 (`WithPath`), `videoGeneration.ts`,
`voiceoverService.ts`, `routes/crm.ts` CSVs, `slack.ts`,
`filesController.ts` L379 (HTML forms — the README
example). Root `README.md` L1542 documents
`x-amz-meta-uploaded-by` as “Source of upload (e.g.,
`agent-mode`)”. The example became the only value.

`s3Utils.test.ts` exercises both helpers (L57+, L186+)
and never pins `Metadata['uploaded-by']`. Tests exist;
the constant is unasserted.

Hermes persist stays with the producer (in-process
`image_generate`; MEDIA tags carry the producer-tool
id). Copying that here is one helper argument, not a
fifth HTTP hop. A fifth process would still stamp
`agent-mode` unless the helper grew the argument the
thumbnail path already uses.

## What this is not

Not a product patch. Do not add an `uploadedBy`
argument on a research turn. Do not add A-021.

Not a Q-014 / Q-001 / Q-003 status change. Listing MCP
`generate_image` does not retag S3 objects.

Not A-006. HTTP-splitting the leaf would still upload
through the same constant.

## Relation to A-002 / A-007 / A-008

A-008 leaf (after #2, not instead of Q-014) should
accept a caller tag on the shared helper, or stop
stamping a constant that the thumbnail writer already
proves is caller-owned. Do not HTTP-split S3.

## Next cycle candidate

No production reader filters on `uploaded-by`.
`getS3ObjectMetadata` callers (`agentModeService.ts`
L28645, `filesController.ts` L39 / L307) read
`ContentType` / `ContentLength` only. Grep of
production TS for the tag is the three writers. Write-only
lie, file-level. Do not add A-021.
