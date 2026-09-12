# Cycle 156 — Search Drive/ClickUp reads have no download cap; named-read and materialize do

**Date:** 2026-09-12T00:35:00Z
**Question:** Cycle 155: Drive post-query file reads are sequential
like ClickUp docs. Does `readGoogleDriveFileContent` have a
per-file size/time cap that `readClickUpDocContent` lacks?

**Answer:** Neither search helper has a download size or time
cap. The 1M-char truncate and the 200MB byte cap live on
**other** faces. Search pays for the whole object, then
truncates to 5000 chars.

## Evidence

Search Drive helper — export/get the whole file into a Buffer,
then parse (pdf-parse / xlsx / mammoth) with no `size` field
check and no deadline:

```25194:25211:backend/src/services/agentModeService.ts
  private async readGoogleDriveFileContent(drive: any, fileId: string, fileName: string, mimeType: string): Promise<string> {
    let content: Buffer;
    // ...
      const res = await drive.files.get({ fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'arraybuffer' });
      content = Buffer.from(res.data);
```

The helper returns the full string. The search face then keeps
5000 chars (`L24113`). Cycle 154’s `DRIVE_LIST_WALK_MAX_MS`
bounds the **folder walk**, not this download.

Same file, **materialize** path, before the same `alt: 'media'`
get:

```25781:25787:backend/src/services/agentModeService.ts
      const size = file.size ? parseInt(file.size, 10) : 0;
      if (size > AgentModeService.MATERIALIZE_ASSET_MAX_BYTES) {
        return {
          success: false,
          message: `"${fileName}" is ${Math.round(size / (1024 * 1024))}MB, over the ${AgentModeService.MATERIALIZE_ASSET_MAX_BYTES / (1024 * 1024)}MB limit for asset materialization`
        };
      }
```

`MATERIALIZE_ASSET_MAX_BYTES = 200 * 1024 * 1024` (`L25626`),
re-checked on `buffer.length` (`L25798`). Search never calls that
gate.

GCS named-read truncates **after** download to 1_000_000 chars
(`L25393–25395`). ClickUp named-read does the same after
`readClickUpDocContent` (`L25870–25873`). Search ClickUp uses
that same helper (`L24156`) with **no** 1M wrap — only the
5000-char face truncate (`L24161`).

`clickupService.ts` `readDocContent` (`L134–175`): axios with
headers only; grep of the file for `timeout` / `maxContentLength`
is empty (cycle 154). Concatenate every page, return the lot.

## What this is not

Not a product patch. Do not add a byte cap on this research
turn. Copy the materialize **shape** (refuse before download
when `size` is known; still bound `buffer.length`) onto the
search helper in-process, plus a deadline the list walk already
has.

Not A-006. HTTP-splitting the helper would still download the
PDF in whichever process owned it.

Not a Q-014 / Q-001 / Q-003 status change.

## Relation to A-002 / A-007 / A-008

Same as cycle 154. File-level: `agentModeService.ts` L25194 vs
L25781 vs L25393; `clickupService.ts` L134.

## Next cycle candidate

Does `queryDriveFilesAcrossFolders` request `files(size)` so
a search-side byte refuse is even possible, or only
`files(id, name, mimeType, parents)` (`L24093`)? File-level.
