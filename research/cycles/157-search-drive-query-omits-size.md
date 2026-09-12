# Cycle 157 — Search Drive query omits `size`; listing, named-read, and materialize request it

**Date:** 2026-09-12T00:42:00Z
**Question:** Cycle 156: search `readGoogleDriveFileContent` has no
byte refuse. Does `queryDriveFilesAcrossFolders` even request
`files(size)` so a search-side refuse is possible, or only
`files(id, name, mimeType, parents)` (`L24093`)?

**Answer:** Search omits `size`. The same helper already returns
`size` for listing, named-read, and materialize. A search-side
byte refuse is a fields-string change at one call site, not a
new process.

## Evidence

Search (`searchKnowledgeBase`):

```24089:24094:backend/src/services/agentModeService.ts
            const { files: driveFilesMap, capped: driveQueryCapped } = await this.queryDriveFilesAcrossFolders(
              drive,
              allFolderIds,
              `fullText contains '${escapeDriveQueryValue(query)}' and trashed = false`,
              'files(id, name, mimeType, parents)',
              limitedMaxResults
            );
```

Listing (`listKnowledgeBaseFiles`):

```24686:24691:backend/src/services/agentModeService.ts
              const { files: filesMap, capped, incomplete: queryIncomplete, failed: queryFailed } = await this.queryDriveFilesAcrossFolders(
                drive,
                folderIds,
                extraClause,
                'files(id, name, mimeType, size, modifiedTime)',
                perBatchTarget,
```

Named-read (`readGoogleDriveSharedFile`):

```25478:25483:backend/src/services/agentModeService.ts
        await this.queryDriveFilesAcrossFolders(
          drive,
          folderIds,
          `name = '${escapeDriveQueryValue(fileName)}' and trashed = false`,
          'files(id, name, mimeType, size, modifiedTime, parents)',
          2
        );
```

Materialize (`materializeKnowledgeBaseAsset`):

```25674:25679:backend/src/services/agentModeService.ts
        await this.queryDriveFilesAcrossFolders(
          drive,
          folderIds,
          `name = '${escapeDriveQueryValue(fileName)}' and trashed = false`,
          'files(id, name, mimeType, size, parents)',
          2
        );
```

The helper interpolates the caller’s string (`L23941`:
`fields: \`nextPageToken, ${fields}\``). Search is the only
caller that drops `size`. Cycle 156’s materialize refuse
(`L25781`) can fire because this string includes it. Search
then `readGoogleDriveFileContent` with `file.id` / `file.mimeType`
only (`L24107–24109`) — `file.size` is never on the object.

## What this is not

Not a product patch. Do not add `size` to the search fields
string on this turn. A later product change: request `size`,
skip or refuse oversized hits **before** `alt: 'media'`, still
bound `buffer.length` (Google Workspace exports often have
empty `size`).

Not A-006. The helper already takes the field list.

Not a Q-014 / Q-001 / Q-003 status change.

## Relation to A-002 / A-007 / A-008

Same as cycle 156. File-level: four call-site strings in
`agentModeService.ts`.

## Next cycle candidate

Google Workspace exports (`application/vnd.google-apps.document`
etc.) often have empty `size`. Does search’s mimeType branch
(`L25198`) hit those types, so a `size` refuse would miss the
exports that pdf-parse never sees but `files.export` still
buffers? File-level.
