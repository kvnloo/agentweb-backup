/**
 * Shared Meta Pixel injection for generated landing pages (ENG-449).
 *
 * Mirrors `gtmInjection.ts` (ENG-334) exactly in shape: a pure, dependency-free util so the
 * auto-inject-at-generation path and the manual-override path emit byte-identical output and
 * share a single source of truth. Kept as a separate module (not merged with gtmInjection) so
 * each injection is independently regex-scoped and provably cannot corrupt or duplicate the
 * other when both are present in the same layout.
 */

/**
 * Same bail-out rationale as gtmInjection.ts: a real Next.js layout.tsx is a few KB. GitHub's
 * Contents API caps single-file writes at 1MB. There's no legitimate layout this large; bail
 * out before running any regex against it rather than trust an unbounded blob.
 */
const MAX_LAYOUT_SIZE_BYTES = 500_000;

/**
 * Inject (or strip) the Meta Pixel base snippet in a Next.js root layout's source.
 *
 * Pure and idempotent: it ALWAYS strips any existing Pixel block first, then re-injects only
 * when `pixelId` is non-empty. Safe to run repeatedly (never duplicates), and doubles as the
 * "remove pixel" path when `pixelId` is "".
 *
 * Returns the content untouched if it exceeds MAX_LAYOUT_SIZE_BYTES — the caller's
 * verifyPixelInjection check then naturally reports this as a failed injection (fail loud),
 * same as any other layout shape the insertion can't handle.
 */
export function injectPixelIntoLayout(currentContent: string, pixelId: string): string {
  if (currentContent.length > MAX_LAYOUT_SIZE_BYTES) return currentContent;

  const pixelSnippet =
    `        {/* Meta Pixel Code */}\n` +
    `        <script dangerouslySetInnerHTML={{ __html: \`!function(f,b,e,v,n,t,s)\n` +
    `{if(f.fbq)return;n=f.fbq=function(){n.callMethod?\n` +
    `n.callMethod.apply(n,arguments):n.queue.push(arguments)};\n` +
    `if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';\n` +
    `n.queue=[];t=b.createElement(e);t.async=!0;\n` +
    `t.src=v;s=b.getElementsByTagName(e)[0];\n` +
    `s.parentNode.insertBefore(t,s)}(window, document,'script',\n` +
    `'https://connect.facebook.net/en_US/fbevents.js');\n` +
    `fbq('init', '${pixelId}');\n` +
    `fbq('track', 'PageView');\` }} />\n` +
    `        <noscript><img height="1" width="1" style={{ display: "none" }}\n` +
    `          src={\`https://www.facebook.com/tr?id=${pixelId}&ev=PageView&noscript=1\`} /></noscript>\n` +
    `        {/* End Meta Pixel Code */}`;

  // Strip any existing Pixel block first (always — whether adding, replacing, or removing).
  let updatedContent = currentContent.replace(
    /[ \t]*\{\/\* Meta Pixel Code \*\/\}[\s\S]*?\{\/\* End Meta Pixel Code \*\/\}\n?/g,
    "",
  );

  // Only re-inject if we have a non-empty pixelId.
  if (pixelId) {
    // Insert inside <head> (or before <body> if the layout has no <head>).
    if (/<head[^>]*>/.test(updatedContent)) {
      updatedContent = updatedContent.replace(/(<head[^>]*>)/, `$1\n${pixelSnippet}`);
    } else {
      updatedContent = updatedContent.replace(/(<body[^>]*>)/, `${pixelSnippet}\n      $1`);
    }
  }

  return updatedContent;
}

/**
 * Extract the (single) block of content between the Meta Pixel delimiter comments, or null if
 * no such block exists. Scoping to these markers — rather than searching the whole file for
 * the fbq/facebook.com substrings — means an unrelated match elsewhere in the file (e.g. v0
 * generates marketing copy that happens to mention "facebook.com/tr?id=...") can never be
 * confused with our own injected block.
 */
function extractPixelBlocks(content: string): string[] {
  const pattern = /\{\/\* Meta Pixel Code \*\/\}[\s\S]*?\{\/\* End Meta Pixel Code \*\/\}/g;
  return content.match(pattern) ?? [];
}

/**
 * Verify that `injectPixelIntoLayout`'s output actually reflects the requested `pixelId`,
 * rather than trusting that the string-splice succeeded. `injectPixelIntoLayout`'s insertion
 * silently no-ops when a layout has neither a `<head>` nor a `<body>` tag to anchor on — without
 * this check, the caller would report "tracking installed" for a page that shipped with none.
 *
 * `pixelId` non-empty => exactly one Pixel block, carrying that exact pixel id (init + noscript
 * img src both reference it).
 * `pixelId` "" (removal) => zero Pixel blocks remain.
 */
export function verifyPixelInjection(content: string, pixelId: string): boolean {
  const blocks = extractPixelBlocks(content);

  if (!pixelId) {
    return blocks.length === 0;
  }

  return (
    blocks.length === 1 &&
    blocks[0].includes(`fbq('init', '${pixelId}')`) &&
    blocks[0].includes(`id=${pixelId}&ev=PageView`)
  );
}

/**
 * Auto-inject the site-level Meta Pixel snippet into the generated root layout in a files
 * array, BEFORE the initial commit, driven by the site's resolved `pixelId`. Mutates the
 * layout file in place and returns whether a pixel was actually injected, so the caller can
 * record an explicit "tracking installed / not installed" signal without re-reading the
 * generated code. No `pixelId` => no injection and NO fallback pixel. Subpages inherit the
 * pixel for free through the shared root layout (they never re-push layout.tsx themselves).
 *
 * Fails loud, not silent: if the layout's shape defeats the insertion (verifyPixelInjection),
 * the file is left untouched and this reports `false` rather than claiming success on a page
 * that actually shipped with no tracking at all.
 */
export function injectPixelIntoLayoutFiles(
  files: Array<{ path: string; content: Buffer }>,
  pixelId: string | undefined,
): boolean {
  if (!pixelId) return false;
  const layout = files.find(
    (f) => f.path === "app/layout.tsx" || f.path.endsWith("/app/layout.tsx"),
  );
  if (!layout) return false;

  const updated = injectPixelIntoLayout(layout.content.toString("utf-8"), pixelId);
  if (!verifyPixelInjection(updated, pixelId)) {
    console.error(
      `[PIXEL INJECTION] Verification failed for pixel ${pixelId} — layout has no ` +
      `<head> or <body> to anchor on. Leaving the file untouched; reporting not-installed.`,
    );
    return false;
  }

  layout.content = Buffer.from(updated, "utf-8");
  return true;
}
