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
 * The only shape a Google Ads conversion id takes, and the same one RULE 7.5's detector
 * looks for — so a tag we install is a tag the pre-flight gate will recognise.
 *
 * This is a security boundary, not a tidiness check. The id is interpolated into a JSX
 * template literal AND into a `dangerouslySetInnerHTML` template literal, so a backtick,
 * `${`, or quote terminates the literal and lands arbitrary code on the customer's
 * deployed page. Reproduced before this guard existed: an id of `AW-1\`); alert(1); //`
 * emitted a layout containing a live alert(1).
 *
 * The manual endpoint validates its input too, but this module is also driven by the
 * generation and sub-page paths straight from the site record, so the guard belongs where
 * the string becomes source code — not only at one caller.
 */
const CONVERSION_ID = /^AW-[0-9]{6,}$/;

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
/**
 * Find Google Ads ids present in the layout OUTSIDE our own delimited block.
 *
 * The drift guard used to look only for `{/* Google Ads Tag *\/}` — our own handiwork —
 * which meant a tag we did not install was invisible. Proven against the real ENG-1182
 * lander, whose gtag was hand-written under a different comment: installing the same id
 * produced two loaders, and installing a DIFFERENT id put two distinct AW ids on one
 * page. That is the ENG-910 double-count this guard exists to prevent, walked straight
 * past because it only ever recognised its own work.
 *
 * Matches the same shape RULE 7.5's detector looks for, so "a tag the gate would see" and
 * "a tag we consider present" cannot disagree.
 */
function foreignGoogleAdsIds(content: string): string[] {
  const withoutOurs = content.replace(
    /\{\/\* Google Ads Tag \*\/\}[\s\S]*?\{\/\* End Google Ads Tag \*\/\}/g,
    '',
  );
  // Scoped to <script> elements, not the whole file. An id in prose is not a tag — v0
  // writes marketing copy, and a page whose body happens to quote a gtag URL must not
  // read as tracked, or RULE 7.5 would pass a page that fires nothing. Conversely a
  // hand-written loader or config call inside a script IS a live tag, whoever wrote it.
  const ids = new Set<string>();
  for (const script of withoutOurs.match(/<script[\s\S]*?(?:\/>|<\/script>)/gi) || []) {
    for (const id of script.match(/\bAW-[0-9]{6,}\b/gi) || []) ids.add(id.toUpperCase());
  }
  return [...ids];
}

export function injectGoogleAdsIntoLayout(currentContent: string, conversionId: string): string {
  if (currentContent.length > MAX_LAYOUT_SIZE_BYTES) return currentContent;

  // Anything that is neither a valid id nor the empty-string removal path is refused
  // outright, BEFORE the strip. Stripping first would tear a working tag out of a live
  // layout and then decline to replace it — silently un-tracking a measured page in the
  // name of rejecting bad input.
  if (conversionId !== '' && !CONVERSION_ID.test(conversionId)) {
    console.error(
      `[GOOGLE ADS INJECTION] Refusing to install conversion id ${JSON.stringify(conversionId)} — `
      + 'not a valid AW-<digits> value. Layout left untouched.',
    );
    return currentContent;
  }

  // A tag someone else put here — hand-written, or installed by another tool — is still a
  // tag, and we cannot safely rewrite markup we did not author.
  if (conversionId !== '') {
    const foreign = foreignGoogleAdsIds(currentContent);
    if (foreign.length > 0) {
      if (foreign.length === 1 && foreign[0] === conversionId.toUpperCase()) {
        // Already carrying exactly the id we were asked to install. The page IS
        // measurable, so leave it alone and let verify report it as installed —
        // refusing would mark a tracked page untracked and have RULE 7.5 block a
        // launch that is perfectly fine.
        return currentContent;
      }
      console.error(
        `[GOOGLE ADS INJECTION] ABORTED for conversion id ${conversionId}: the layout already `
        + `carries Google Ads tag(s) ${foreign.join(', ')} that we did not install. Adding ours `
        + 'would fire two different conversion ids from one page (ENG-910). Layout left untouched.',
      );
      return currentContent;
    }
  }

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

  // An id the injector would refuse can never be installed, so it can never verify.
  // Without this, a hostile id whose payload happened to appear inside an existing block
  // could read as installed.
  if (!CONVERSION_ID.test(conversionId)) return false;

  // A hand-written tag carrying this exact id counts as installed: the question this
  // answers is "will a conversion fire against this id", not "did we write it".
  if (blocks.length === 0) {
    const foreign = foreignGoogleAdsIds(content);
    return foreign.length === 1 && foreign[0] === conversionId.toUpperCase();
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
