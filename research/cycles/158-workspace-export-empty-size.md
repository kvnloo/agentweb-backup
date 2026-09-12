# Cycle 158 — Google Workspace exports have empty `size`; named-read already falls back after download

**Date:** 2026-09-12T00:45:00Z
**Question:** Cycle 157: search omits `size`. Would adding it let
search refuse before download, or do Google Workspace exports
(`L25198`) have empty `size` so `files.export` still buffers?

**Answer:** Empty `size` is already handled on named-read — **after**
the export. Materialize treats missing size as 0 and still
downloads. A search-side `size` refuse would miss Docs / Sheets /
Slides; those are the `files.export` branches, not `alt: 'media'`.

## Evidence

Search helper’s first three branches are Workspace exports, no
size check:

```25197:25206:backend/src/services/agentModeService.ts
    if (mimeType === 'application/vnd.google-apps.document') {
      const res = await drive.files.export({ fileId, mimeType: 'text/plain' }, { responseType: 'arraybuffer' });
      content = Buffer.from(res.data);
    } else if (mimeType === 'application/vnd.google-apps.spreadsheet') {
      const res = await drive.files.export({ fileId, mimeType: 'text/csv' }, { responseType: 'arraybuffer' });
      content = Buffer.from(res.data);
    } else if (mimeType === 'application/vnd.google-apps.presentation') {
      const res = await drive.files.export({ fileId, mimeType: 'text/plain' }, { responseType: 'arraybuffer' });
      content = Buffer.from(res.data);
```

Named-read, after that same helper returns:

```25606:25606:backend/src/services/agentModeService.ts
        size: file.size ? parseInt(file.size, 10) : contentStr.length,
```

That fallback is `contentStr.length` — the export already ran.
`maxContentLength = 1_000_000` at `L25593` is also after the
buffer.

Materialize’s pre-download refuse:

```25781:25782:backend/src/services/agentModeService.ts
      const size = file.size ? parseInt(file.size, 10) : 0;
      if (size > AgentModeService.MATERIALIZE_ASSET_MAX_BYTES) {
```

Missing `size` → 0 → does not refuse. The comment at `L25795–25798`
says Drive `size` can be missing/stale; `buffer.length` is the real
gate, **after** `alt: 'media'`. Materialize also skips Workspace
text types (`L25774` image/video only), so this gap is binary
assets. Search’s Workspace gap is the opposite: Docs/Sheets/Slides
are the common KB hit, and they never have a useful `size`.

## What this is not

Not a product patch. Cycle 157’s fields-string change is still
the first slice for **binary** Drive files. Workspace exports need
a **post-download** char/byte bound on the helper (named-read’s
1M, or search’s 5000 applied before parse), not metadata refuse.

Not A-006. Same helper, two bound shapes.

Not a Q-014 / Q-001 / Q-003 status change.

## Relation to A-002 / A-007 / A-008

Same as cycle 157. File-level: L25198 vs L25606 vs L25781.

## Next cycle candidate

Refresh Oh My Pi / Hermes live GitHub versions vs
`research/sdlc/COMPARISON.md` snapshot 2026-09-11 (OMP v0.85.1
cycle 88). File-level + public repo. Continuous-research thesis
check, not another KB slice.
