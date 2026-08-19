/**
 * Shared Google Ads base tag (gtag.js) injection for generated landing pages (ENG-1328).
 *
 * A third sibling to `gtmInjection.ts` and `pixelInjection.ts`, and deliberately its own
 * module for the same reason they are separate: each injection is independently
 * regex-scoped and provably cannot corrupt or duplicate the other when several are
 * present in one layout.
 *
 * That independence matters most here. GTM and gtag are both Google and both load from
 * googletagmanager.com, so the two blocks are far easier to confuse than Meta's. The
 * delimiter comments below — not a substring search for "googletagmanager" — are what
 * keep them apart.
 *
 * Why this exists at all: RULE 7.5 blocks a launch when it finds no tag on the page,
 * and until now nothing in the backend could install an `AW-` tag. ENG-1182 hit exactly
 * that wall — a correct conversion call fired into a page where `window.gtag` had never
 * been defined, and unblocking one test lander took a hand-written PR from a fork.
 */

/**
 * Same bail-out rationale as its two siblings: a real Next.js layout.tsx is a few KB.
 * There is no legitimate layout this large; bail out before running any regex against
 * it rather than trust an unbounded blob.
 */
const MAX_LAYOUT_SIZE_BYTES = 500_000;

/**
 * Inject (or strip) the Google Ads base tag in a Next.js root layout's source.
 *
 * Pure and idempotent: it ALWAYS strips any existing Google Ads block first, then
 * re-injects only when `conversionId` is non-empty. Safe to run repeatedly (never
 * duplicates), and doubles as the "remove tag" path when `conversionId` is "".
 *
 * Returns the content untouched if it exceeds MAX_LAYOUT_SIZE_BYTES — the caller's
 * verifyGoogleAdsInjection check then naturally reports this as a failed injection
 * (fail loud), same as any other layout shape the insertion cannot handle.
 */
export function injectGoogleAdsIntoLayout(currentContent: string, conversionId: string): string {
  if (currentContent.length > MAX_LAYOUT_SIZE_BYTES) return currentContent;

  const adsSnippet =
    `        {/* Google Ads Tag */}\n` +
    `        <script async src={\`https://www.googletagmanager.com/gtag/js?id=${conversionId}\`} />\n` +
    `        <script dangerouslySetInnerHTML={{ __html: \`window.dataLayer = window.dataLayer || [];\n` +
    `function gtag(){dataLayer.push(arguments);}\n` +
    `gtag('js', new Date());\n` +
    `gtag('config', '${conversionId}');\` }} />\n` +
    `        {/* End Google Ads Tag */}`;

  // Strip any existing block first (always — whether adding, replacing, or removing).
  let updatedContent = currentContent.replace(
    /[ \t]*\{\/\* Google Ads Tag \*\/\}[\s\S]*?\{\/\* End Google Ads Tag \*\/\}\n?/g,
    "",
  );

  // Only re-inject if we have a non-empty conversionId.
  if (conversionId) {
    // Insert inside <head> (or before <body> if the layout has no <head>).
    if (/<head[^>]*>/.test(updatedContent)) {
      updatedContent = updatedContent.replace(/(<head[^>]*>)/, `$1\n${adsSnippet}`);
    } else {
      updatedContent = updatedContent.replace(/(<body[^>]*>)/, `${adsSnippet}\n      $1`);
    }
  }

  return updatedContent;
}

/**
 * Extract the blocks between the Google Ads delimiter comments, or [] if none exist.
 *
 * Scoping to these markers — rather than searching the whole file for "gtag" or
 * "googletagmanager" — means an unrelated match elsewhere can never be mistaken for our
 * own block. Two such matches are genuinely likely here: v0 writes marketing copy, and
 * a GTM block installed by `gtmInjection.ts` loads from the very same domain.
 */
function extractGoogleAdsBlocks(content: string): string[] {
  const pattern = /\{\/\* Google Ads Tag \*\/\}[\s\S]*?\{\/\* End Google Ads Tag \*\/\}/g;
  return content.match(pattern) ?? [];
}

/**
 * Verify that `injectGoogleAdsIntoLayout`'s output actually reflects the requested
 * `conversionId`, rather than trusting that the string-splice succeeded. The insertion
 * silently no-ops when a layout has neither a `<head>` nor a `<body>` to anchor on —
 * without this check the caller would report "tracking installed" for a page that
 * shipped with none, which is the ENG-1182 failure exactly.
 *
 * Both halves are required. A loader without a `config` call defines `gtag` but
 * configures no destination, so no conversion can ever land — yet RULE 7.5 would still
 * see an `AW-` on the page and pass the launch.
 *
 * `conversionId` non-empty => exactly one block, carrying that exact id in both halves.
 * `conversionId` "" (removal) => zero blocks remain.
 */
export function verifyGoogleAdsInjection(content: string, conversionId: string): boolean {
  const blocks = extractGoogleAdsBlocks(content);

  if (!conversionId) {
    return blocks.length === 0;
  }

  return (
    blocks.length === 1 &&
    blocks[0].includes(`googletagmanager.com/gtag/js?id=${conversionId}`) &&
    blocks[0].includes(`gtag('config', '${conversionId}')`)
  );
}

/**
 * Auto-inject the site-level Google Ads base tag into the generated root layout in a
 * files array, BEFORE the initial commit, driven by the site's configured conversion id.
 * Mutates the layout file in place and returns whether a tag was actually injected, so
 * the caller can record an explicit installed / not-installed signal without re-reading
 * the generated code. No id => no injection and NO fallback tag.
 *
 * Fails loud, not silent: if the layout's shape defeats the insertion, the file is left
 * untouched and this reports `false` rather than claiming success on a page that shipped
 * with no tracking at all.
 *
 * Note the contract is deliberately harsher than Meta's here. `pixelInjection` can treat
 * a failed layout install as a degrade to "server-side only", because the CAPI leg still
 * fires from the capture route. Google Ads has no server-side leg yet (ENG-1325), so a
 * failure here is a degrade to no measurement at all — which is why the caller must
 * persist the `false` rather than shrug it off.
 */
export function injectGoogleAdsIntoLayoutFiles(
  files: Array<{ path: string; content: Buffer }>,
  conversionId: string | undefined,
): boolean {
  if (!conversionId) return false;
  const layout = files.find(
    (f) => f.path === "app/layout.tsx" || f.path.endsWith("/app/layout.tsx"),
  );
  if (!layout) return false;

  const updated = injectGoogleAdsIntoLayout(layout.content.toString("utf-8"), conversionId);
  if (!verifyGoogleAdsInjection(updated, conversionId)) {
    console.error(
      `[GOOGLE ADS INJECTION] Verification failed for conversion id ${conversionId} — layout ` +
      `has no <head> or <body> to anchor on. Leaving the file untouched; reporting not-installed.`,
    );
    return false;
  }

  layout.content = Buffer.from(updated, "utf-8");
  return true;
}
