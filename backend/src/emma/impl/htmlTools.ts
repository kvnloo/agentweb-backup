/**
 * ENG-2103 (F2) — HTML/landing-page misc tool cluster, extracted from
 * `AgentModeService`.
 *
 * Moved verbatim (behavior byte-identical) from `AgentModeService.prototype.*`:
 * convertToPdf, extractCSSFromURL, listHtmlTemplates. Fifth domain cluster —
 * a deliberately narrow slice of the "landing pages/HTML" candidate surveyed
 * earlier, not the full candidate list (createHtmlFile, createHtmlTemplate,
 * updateHtmlFile, createHtmlFromTemplate).
 *
 * Why narrower: the other four HTML methods pull in substantially more
 * coupling than these three —
 *  - `createHtmlFromTemplate` calls `this.callLLM` directly (the core LLM
 *    gateway: OpenRouter client, worker fork, model routing) — extracting it
 *    needs its own design decision, not the "promote a pure helper" treatment
 *    every extraction so far has used.
 *  - `createHtmlFile`/`createHtmlTemplate` each pull in several more
 *    cluster-local private helpers (inlinePrivateS3Images,
 *    renderHtmlDraftInSections, deliverDeterministicHtmlFallback,
 *    parameterizeLargeHtml) plus module-level exports
 *    (buildHtmlArtifactFilename, CREATE_HTML_RENDER_CHUNK_MAX_CHARS,
 *    isRenderTimeoutError) that a dedicated test file
 *    (`agentModeService.buildHtmlArtifactFilename.test.ts`) imports directly
 *    from `agentModeService.ts` — moving those needs the same
 *    promote-to-shared-and-reexport treatment as a class method, just for
 *    plain functions instead, and deserves its own pass.
 *  - `updateHtmlFile` already went through a partial extraction in the books
 *    round (`performContentReplacements`/`performDirectReplacement` moved to
 *    `emma/impl/shared/contentReplacements.ts`) but still needs
 *    `fetchFileContent`/`createVersionedFilename`/`extractPathFromS3Url`/
 *    `uploadUpdatedFile`/`updateHtmlFileCss` — more per-method coupling than
 *    the other three here.
 *
 * `AgentModeService.prototype.<name>` now delegates to these functions.
 * `routes/emmaApi.ts` calls `listHtmlTemplates`/`extractCSSFromURL` directly
 * on the class singleton (real callers beyond `emma/tools.ts`, confirmed by
 * grep), and three dedicated test files
 * (`agentModeService.extractCSSFromURL.logo.test.ts`,
 * `publicHtmlTemplates.test.ts`, `agentModeService.convertToPdfSsrf.test.ts` +
 * `agentModeService.convertToPdfFoundation.test.ts`) call all three directly
 * on a real instance — so none of the 3 class methods could be deleted.
 * `formatCSSExtractionResult` (private, used only by `extractCSSFromURL`, zero
 * test references) was deleted from the class after moving.
 *
 * `getTemplatesForUser` is shared with `AgentModeService.prototype.findTemplateById`
 * (used by the deferred `createHtmlFromTemplate`) — promoted to
 * `emma/impl/shared/htmlTemplates.ts`, same treatment as every other
 * cross-cluster helper this effort has found, with `AgentModeService`'s own
 * copy turned into a thin delegating method.
 *
 * `uploadFileToS3` (from `../utils/s3Utils`) constructs a real `AWS.S3` client
 * at module load, but — unlike `settingsService.ts`/`chatbotService.ts`'s
 * DynamoDB clients, which F1's postmortem specifically found broke a
 * deliberately-mock-free test — this is the codebase's already-established,
 * widely-used top-level-import pattern (11+ non-test files already import it
 * this way with no lazy-loading). Followed that existing convention here
 * rather than introducing a new one.
 *
 * No metering/LLM calls exist anywhere in this cluster (grepped for
 * llmService, generateJSONContent, callLLM, meterUserUsage, currentRunFunding,
 * usageContext — zero matches), so there is nothing for the RunFunding/
 * billingUserId audit (F1 rounds 3-5's bug class) to find here.
 */
import { renderHtmlToPdf } from '../../services/pdfRenderService';
import { assertPublicHostname } from '../../utils/ssrfGuard';
import { uploadFileToS3 } from '../../utils/s3Utils';
import { downloadBrandLogoToS3 } from '../../services/agentMode/brandLogo';
import { getTemplatesForUser } from './shared/htmlTemplates';

export async function convertToPdf(
  sourceUrl: string,
  outputFilename: string,
  userId: string,
  options?: { orientation?: 'portrait' | 'landscape' | 'auto'; format?: string }
): Promise<any> {
  try {
    console.log('AgentMode: Converting to PDF:', sourceUrl, 'for user:', userId);

    if (!sourceUrl || typeof sourceUrl !== 'string') {
      throw new Error('source_url is required and must be a string');
    }
    if (!sourceUrl.startsWith('http://') && !sourceUrl.startsWith('https://')) {
      throw new Error('source_url must be an HTTP or HTTPS URL');
    }

    // SSRF guard: convert_to_pdf is a foundation tool reachable by every
    // session by default, and renderHtmlToPdf navigates a real browser to
    // sourceUrl server-side. Without this, a user could point it at an
    // internal address (e.g. the cloud metadata endpoint) and get the
    // response rendered back to them as a downloadable PDF. renderHtmlToPdf
    // also re-validates on every navigation request (including redirect
    // hops), so this call fails fast for the common case without spinning
    // up a browser first.
    await assertPublicHostname(sourceUrl);

    // Shared render path: orientation is auto-detected (16:9 decks print
    // landscape) unless the caller forces it, and wide content is scaled to
    // fit so the right side is never clipped.
    const { buffer, orientation, scale } = await renderHtmlToPdf({
      url: sourceUrl,
      orientation: options?.orientation ?? 'auto',
      format: options?.format,
    });
    console.log(
      `AgentMode: PDF rendered (orientation=${orientation}, scale=${scale.toFixed(2)})`
    );

    const pdfFilename = (outputFilename || 'export')
      .replace(/\.html?$/i, '')
      .replace(/[^a-zA-Z0-9_\-]/g, '_') + '.pdf';

    const uploadResult = await uploadFileToS3(buffer, pdfFilename, userId, 'application/pdf');

    if (!uploadResult.success || !uploadResult.url) {
      throw new Error(uploadResult.error || 'Failed to upload PDF to S3');
    }

    return {
      success: true,
      pdf_url: uploadResult.url,
      filename: pdfFilename,
      orientation,
      message: `PDF created and saved. Download: ${uploadResult.url}`,
    };
  } catch (error) {
    console.error('AgentMode: Error converting to PDF:', error);
    return {
      success: false,
      message: 'Failed to convert to PDF.',
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Format CSS extraction result for LLM consumption
 */
function formatCSSExtractionResult(data: any): string {
  const { url, suggestedBrandTokens, detailedTokens, brandIdentity, darkThemeTokens } = data;

  let formatted = `# CSS Extraction Results\n\n`;
  formatted += `**Source:** ${url}\n\n`;

  // Brand identity section
  if (brandIdentity) {
    formatted += `## Brand Identity\n\n`;
    formatted += `- **Brand Name:** ${brandIdentity.brandName || 'Not detected'}\n`;
    formatted += `- **Logo:** ${brandIdentity.logoUrl || 'Not detected'}\n`;
    formatted += `- **Tagline:** ${brandIdentity.tagline || 'Not detected'}\n\n`;
  }

  // Suggested brand tokens (what should go in brand guidelines)
  formatted += `## Suggested Brand Tokens\n\n`;
  formatted += `These are the recommended tokens to add to your brand guidelines:\n\n`;

  formatted += `### Colors\n`;
  formatted += `- **Primary:** ${suggestedBrandTokens.colors.primary}\n`;
  formatted += `- **Secondary:** ${suggestedBrandTokens.colors.secondary}\n`;
  formatted += `- **Palette:** ${suggestedBrandTokens.colors.palette.join(', ')}\n\n`;

  formatted += `### Typography\n`;
  formatted += `- **Heading Font:** ${suggestedBrandTokens.typography.headingFont}\n`;
  formatted += `- **Body Font:** ${suggestedBrandTokens.typography.bodyFont}\n`;
  formatted += `- **Font Weights:**\n`;
  formatted += `  - Regular: ${suggestedBrandTokens.typography.fontWeights.regular}\n`;
  formatted += `  - Semibold: ${suggestedBrandTokens.typography.fontWeights.semibold}\n`;
  formatted += `  - Bold: ${suggestedBrandTokens.typography.fontWeights.bold}\n\n`;

  formatted += `### Visual Effects\n`;
  formatted += `- **Primary Shadow:** ${suggestedBrandTokens.visualEffects.primaryShadow}\n`;
  formatted += `- **Border Radius:** ${suggestedBrandTokens.visualEffects.borderRadius}\n\n`;

  // Dark color-scheme variant, when the site has one. The tokens above describe
  // what the site serves a no-preference visitor; this is what a dark-mode
  // visitor sees. Which one is "the brand" is a judgement call, so present both
  // rather than silently choosing (ENG-285).
  if (darkThemeTokens) {
    formatted += `## Dark Theme Variant Detected\n\n`;
    formatted += `This site renders a **distinct dark theme** under \`prefers-color-scheme: dark\`. `;
    formatted += `The tokens above are its DEFAULT (light) render; the dark render is:\n\n`;
    formatted += `- **Primary:** ${darkThemeTokens.colors.primary}\n`;
    formatted += `- **Secondary:** ${darkThemeTokens.colors.secondary}\n`;
    formatted += `- **Backgrounds:** ${(darkThemeTokens.backgrounds || []).join(', ') || 'Not detected'}\n`;
    formatted += `- **Text:** ${(darkThemeTokens.text || []).join(', ') || 'Not detected'}\n`;
    formatted += `- **Palette:** ${darkThemeTokens.colors.palette.join(', ')}\n\n`;
    formatted += `⚠️ Confirm with the user which theme represents their brand before applying tokens — `;
    formatted += `a site whose design is dark still serves the light render to visitors whose OS is set to light.\n\n`;
  }

  // Summary of detailed tokens
  formatted += `## Detailed Analysis\n\n`;
  formatted += `- **Total Colors Found:** ${detailedTokens.colors.all.length}\n`;
  formatted += `- **Font Families:** ${detailedTokens.typography.fontFamilies.length}\n`;
  formatted += `- **Font Sizes:** ${detailedTokens.typography.fontSizes.length}\n`;
  formatted += `- **Box Shadows:** ${detailedTokens.visualEffects.boxShadows.length}\n`;
  formatted += `- **Border Radius Values:** ${detailedTokens.visualEffects.borderRadius.length}\n\n`;

  formatted += `### Next Steps\n\n`;
  formatted += `1. **Apply to Brand Guidelines:** Use \`update_brand_guidelines\` with the suggested values above\n`;
  formatted += `2. **Save Detailed Data:** Use \`update_knowledge_base_file\` to save the detailed CSS analysis (detailedTokensJSON) for future reference\n`;

  return formatted;
}

export async function extractCSSFromURL(args: any, userId: string): Promise<any> {
  try {
    const { url, options } = args;

    if (!url) {
      return {
        success: false,
        error: 'URL is required'
      };
    }

    // Import the CSS extractor service
    const { extractCSSFromURL, analyzeDesignTokens, inferBrandTokens } = require('../../services/cssExtractor');

    // Extract CSS from URL
    console.log(`Extracting CSS from ${url}...`);
    const extractedCSS = await extractCSSFromURL(url, options);

    // Analyze design tokens
    console.log('Analyzing design tokens...');
    const detailedTokens = await analyzeDesignTokens(extractedCSS);

    // Log extraction details for debugging
    console.log(`CSS extraction details: ${extractedCSS.stylesheets.length} stylesheets, ` +
      `source=${extractedCSS.stylesheets[0]?.source || 'none'}, ` +
      `computedElements=${extractedCSS.computedElements ? Object.keys(extractedCSS.computedElements).join(',') : 'none'}`);
    console.log(`Design tokens: ${detailedTokens.colors.all.length} colors, ` +
      `${detailedTokens.typography.fontFamilies.length} fonts, ` +
      `top colors: ${detailedTokens.colors.all.slice(0, 5).map((c: any) => `${c.value}(${c.count})`).join(', ')}`);

    // Infer brand tokens
    console.log('Inferring brand tokens...');
    const suggestedBrandTokens = inferBrandTokens(detailedTokens);

    // Process brand identity: download logo and upload to S3. Extracted to
    // services/agentMode/brandLogo.ts (ENG-326); behavior pinned by
    // agentModeService.extractCSSFromURL.logo.test.ts.
    const brandIdentity = extractedCSS.brandIdentity || { logoUrl: null, brandName: null, tagline: null, favicon: null };
    const logoDownload = brandIdentity.logoUrl
      ? await downloadBrandLogoToS3(brandIdentity.logoUrl, userId)
      : null;
    // Non-uploaded outcomes fall back to surfacing the raw discovered URL
    // below (`s3LogoUrl || brandIdentity.logoUrl`) — unchanged extraction
    // behavior; only the deterministic PERSIST path treats them differently.
    const s3LogoUrl: string | null =
      logoDownload?.status === 'uploaded' ? logoDownload.url : null;

    // Format detailed tokens as JSON string for Emma to save to KB if needed
    const detailedTokensJSON = JSON.stringify({
      version: '1.0',
      source: url,
      extractedAt: extractedCSS.extractedAt,
      tokens: detailedTokens,
      metadata: {
        extractionMethod: 'puppeteer-wallace',
        savedBy: 'emma',
        userId
      }
    }, null, 2);

    // A site may render a completely different design under a dark color-scheme
    // preference (ENG-285: rankai.ai is matte black with a purple accent under
    // dark, near-white under light). The tokens above describe the site's
    // DEFAULT render; when a distinct dark render exists, analyze it too and
    // surface both so the caller can pick the intended brand theme.
    let darkThemeTokens: any = null;
    if (extractedCSS.themes?.hasDarkVariant && extractedCSS.themes.dark) {
      try {
        // Analyse the dark render with ITS OWN computed styles AND stylesheets —
        // reusing the light render's stylesheets would blend light colours into
        // the reported dark palette (ENG-285).
        const darkCSS = {
          ...extractedCSS,
          computedElements: extractedCSS.themes.dark.computedElements,
          stylesheets: extractedCSS.themes.dark.stylesheets,
        };
        const darkDetailed = await analyzeDesignTokens(darkCSS);
        darkThemeTokens = {
          ...inferBrandTokens(darkDetailed),
          backgrounds: darkDetailed.colors.backgrounds.slice(0, 3),
          text: darkDetailed.colors.text.slice(0, 3),
        };
        console.log(`Dark color-scheme variant detected for ${url}; extracted its palette too.`);
      } catch (err) {
        console.warn('Dark-variant token analysis failed; reporting default render only:', err);
      }
    }

    // Format summary for LLM
    const formattedSummary = formatCSSExtractionResult({
      url,
      suggestedBrandTokens,
      detailedTokens,
      darkThemeTokens,
      brandIdentity: {
        logoUrl: s3LogoUrl || brandIdentity.logoUrl || null,
        brandName: brandIdentity.brandName || null,
        tagline: brandIdentity.tagline || null,
      },
    });

    // Merge brand identity into suggestedBrandTokens so Emma naturally displays it
    const enrichedBrandTokens = {
      ...suggestedBrandTokens,
      brandName: brandIdentity.brandName || null,
      logoUrl: s3LogoUrl || brandIdentity.logoUrl || null,
      tagline: brandIdentity.tagline || null,
    };

    return {
      success: true,
      url,
      extractedAt: extractedCSS.extractedAt,
      suggestedBrandTokens: enrichedBrandTokens,
      detailedTokens,
      detailedTokensJSON, // Emma can save this to KB using update_knowledge_base_file tool
      hasDarkVariant: !!darkThemeTokens,
      darkThemeTokens, // null unless the site renders a distinct dark theme
      formattedContent: formattedSummary
    };
  } catch (error: any) {
    console.error('AgentMode: Error extracting CSS:', error);
    return {
      success: false,
      error: error.message || 'Failed to extract CSS from URL',
      details: error.stack
    };
  }
}

export async function listHtmlTemplates(userId: string, type?: string): Promise<any> {
  try {
    const { userTemplates, publicTemplates } = await getTemplatesForUser(userId);

    const mapTemplate = (template: any, isPublic: boolean) => ({
      template_id: template.template_id,
      template_name: template.template_name,
      type: template.type || ['email'],
      subject: template.subject,
      variables: template.variables || [],
      arrayVariables: template.arrayVariables || [],
      created_at: template.created_at,
      updated_at: template.updated_at,
      ...(isPublic ? { isPublic: true } : {})
    });

    let merged = [
      ...userTemplates.map((t: any) => mapTemplate(t, false)),
      ...publicTemplates.map((t: any) => mapTemplate(t, true))
    ];

    if (type) {
      merged = merged.filter((t: any) => Array.isArray(t.type) && t.type.includes(type));
    }

    return {
      success: true,
      email_templates: merged
    };
  } catch (error) {
    console.error('Error listing email templates:', error);
    return {
      success: false,
      message: 'Failed to list email templates',
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}
