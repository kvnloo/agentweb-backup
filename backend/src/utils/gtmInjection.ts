/**
 * Shared Google Tag Manager injection for generated landing pages (ENG-334).
 *
 * This is the head+noscript logic previously inlined in `saveGtmForPage`
 * (routes/landingPageGeneration.ts). It is extracted here so BOTH paths that install GTM —
 * the manual "Add GTM" endpoint and the auto-inject-at-generation push path in v0Service —
 * emit byte-identical output and share a single source of truth.
 *
 * Kept in its own module (not on v0Service) so it carries no heavy service-side dependencies
 * and is trivially unit-testable / importable from either side without loading the world.
 */

/**
 * Inject (or strip) the GTM head + noscript snippets in a Next.js root layout's source.
 *
 * Pure and idempotent: it ALWAYS strips any existing GTM block first, then re-injects only
 * when `containerId` is non-empty. That makes it safe to run repeatedly (never duplicates —
 * ENG-334 criterion 5) and doubles as the "remove GTM" path when `containerId` is "".
 */
export function injectGtmIntoLayout(currentContent: string, containerId: string): string {
  const gtmHeadSnippet =
    `        {/* Google Tag Manager */}\n` +
    `        <script dangerouslySetInnerHTML={{ __html: \`(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer','${containerId}');\` }} />\n` +
    `        {/* End Google Tag Manager */}`;

  const gtmBodySnippet =
    `        {/* Google Tag Manager (noscript) */}\n` +
    `        <noscript dangerouslySetInnerHTML={{ __html: \`<iframe src="https://www.googletagmanager.com/ns.html?id=${containerId}" height="0" width="0" style="display:none;visibility:hidden"></iframe>\` }} />\n` +
    `        {/* End Google Tag Manager (noscript) */}`;

  // Strip any existing GTM blocks first (always — whether adding, replacing, or removing).
  let updatedContent = currentContent
    .replace(/[ \t]*\{\/\* Google Tag Manager \*\/\}[\s\S]*?\{\/\* End Google Tag Manager \*\/\}\n?/g, "")
    .replace(/[ \t]*\{\/\* Google Tag Manager \(noscript\) \*\/\}[\s\S]*?\{\/\* End Google Tag Manager \(noscript\) \*\/\}\n?/g, "");

  // Only re-inject if we have a non-empty containerId.
  if (containerId) {
    // Insert head snippet inside <head> (or before <body> if the layout has no <head>).
    if (/<head[^>]*>/.test(updatedContent)) {
      updatedContent = updatedContent.replace(/(<head[^>]*>)/, `$1\n${gtmHeadSnippet}`);
    } else {
      updatedContent = updatedContent.replace(/(<body[^>]*>)/, `${gtmHeadSnippet}\n      $1`);
    }

    // Insert noscript snippet immediately after <body ...>.
    if (/<body[^>]*>/.test(updatedContent)) {
      updatedContent = updatedContent.replace(/(<body[^>]*>)/, `$1\n${gtmBodySnippet}`);
    }
  }

  return updatedContent;
}

/**
 * Auto-inject the site-level GTM snippet into the generated root layout in a files array,
 * BEFORE the initial commit, driven by the site's saved `gtmContainerId`. Mutates the layout
 * file in place and returns whether a container was actually injected, so the caller can
 * record an explicit "tracking installed / not installed" signal (ENG-334 criterion 4)
 * without re-reading the generated code. No `gtmContainerId` => no injection and NO fallback
 * to AgentWeb's platform GA4 property. Subpages inherit the container for free through the
 * shared root layout.
 */
export function injectGtmIntoLayoutFiles(
  files: Array<{ path: string; content: Buffer }>,
  containerId: string | undefined,
): boolean {
  if (!containerId) return false;
  const layout = files.find(
    (f) => f.path === "app/layout.tsx" || f.path.endsWith("/app/layout.tsx"),
  );
  if (!layout) return false;
  layout.content = Buffer.from(
    injectGtmIntoLayout(layout.content.toString("utf-8"), containerId),
    "utf-8",
  );
  return true;
}
