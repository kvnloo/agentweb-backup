# Cycle 205 — `read_brand_guidelines` shows `filename`, not the URL `generate_image` asks for

**Date:** 2026-09-12T03:25:00Z
**Question:** Cycle 204 next: Emma `read_brand_guidelines`
L27884 `filename`?

**Answer:** `formatBrandGuidelines` is the LLM-facing
string (`readBrandGuidelines` L10704 comment: “for
LLM consumption”). Logo & Assets prints
`asset.filename` as the label (L27884 logos, L27893
brand guides). It never interpolates
`brandData.logoUrl`. The URL exists only as an
`<a href>`. The update ack
(`formatBrandGuidelinesUpdate` L27940) prints
filename **only** — no href.

Auto-pin (cycle 199) then stores
`filename = outcome.url.split('/').pop()` (L15196)
while the upload name is `logo.${ext}`
(`brandLogo.ts` L415) and `key` is
`auto-logo-${Date.now()}`. Brand-guide Family A miss
(cycle 198) stamps `filename: 'url'` (L15137). Emma
therefore sees **Primary Logo: logo.png** or
**Brand Guide: url**.

Sibling formatter on the **same class**:
`formatCSSExtractionResult` L15631 prints
`- **Logo:** ${brandIdentity.logoUrl}`. Discovery
shows a URL; persist-read shows a filename.
`generate_image` (`emma/tools.ts` L4999) tells Emma
to pass “the logo URL from their brand guidelines
(read_brand_guidelines tool)”. MCP does **not** list
`read_brand_guidelines` (`mcp.apiTools.test.ts` L101).
Occupied: `agentModeService.ts` pile + `emma/tools.ts`
`#2832`. Not a fifth HTTP service. Do not add A-021.
Do not un-ready Q-014 (listing does not change this
formatter).

## Evidence

Read face — filename as the visible token; no
`logoUrl` field:

```27875:27885:backend/src/services/agentModeService.ts
    formattedSummary += `<strong>🖼️ Logo & Assets</strong><br>`;
    // ...
          formattedSummary += `• <strong>${logoType}:</strong> ${asset.filename}<br>`;
          formattedSummary += `  🔗 <a href="${asset.url}" target="_blank">View ${logoType}</a><br>`;
```

```27891:27894:backend/src/services/agentModeService.ts
        brandGuideAssets.forEach((asset: any) => {
          formattedSummary += `• <strong>Brand Guide:</strong> ${asset.filename}<br>`;
          formattedSummary += `  🔗 <a href="${asset.url}" target="_blank">View Brand Guide</a><br>`;
```

Update ack — filename only:

```27933:27941:backend/src/services/agentModeService.ts
          if (field === 'brandAssets' && Array.isArray(value) && value.length > 0) {
            formattedSummary += `• <strong>Brand Assets:</strong> Updated ${value.length} asset(s)<br>`;
            value.forEach((asset: any) => {
              // ...
              formattedSummary += `  - ${assetType}: ${asset.filename}<br>`;
            });
```

What those filenames are:

```15136:15201:backend/src/services/agentModeService.ts
            filename: 'url',
            key: asset.key || `url-brandguide-${Date.now()}`,
        // ...
            const filename = outcome.url.split('/').filter(Boolean).pop() || 'logo.png';
            autoLogoAsset = {
              type: 'logo',
              url: outcome.url,
              filename,
              key: `auto-logo-${Date.now()}`,
            };
```

Discovery formatter on the same class already
prints the URL:

```15621:15631:backend/src/services/agentModeService.ts
  private formatCSSExtractionResult(data: any): string {
    // ...
      formatted += `- **Logo:** ${brandIdentity.logoUrl || 'Not detected'}\n`;
```

Do not call again (so a wrong label sticks):

```27904:27904:backend/src/services/agentModeService.ts
    formattedSummary += `<br><br><strong>⚠️ Note:</strong> This brand guidelines data is current and complete. Please do not call read_brand_guidelines again in this conversation as it will return the same information.`;
```

Grep of `__tests__` for `formatBrandGuidelines` /
`Primary Logo` is empty. Occupied
`agentModeService.ts`. Do not patch. Do not write a
reproduction.

## Relation to A-002 / A-007 / A-008

A-008 persist (after #2) owns one asset handle: URL
+ real key (cycle 199) + one formatter that prints
that URL the way `formatCSSExtractionResult` already
does. Two in-process HTML/markdown shapes is not
A-006. Hermes: one tool result, one handle.

## Next cycle candidate

Pin/probe missing `Referer` (Chrome scrape sends it
on subresources; axios pin/probe do not). Or
`generate_image.filename` required field colliding
with asset.filename `'url'`. File-level. Do not add
A-021.
