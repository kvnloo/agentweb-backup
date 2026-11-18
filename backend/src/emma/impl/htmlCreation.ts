/**
 * ENG-2103 (F2) — createHtmlFile/createHtmlTemplate tool cluster, extracted
 * from `AgentModeService`. The ninth domain cluster in this series, and a
 * deliberately narrow slice of the larger "HTML remainder" candidate (which
 * also includes updateHtmlFile and its own helper cluster, and the flagged
 * createHtmlFromTemplate) — same "carve out the tractable slice" approach as
 * round 5's htmlTools.ts, whose own header comment first surveyed this exact
 * split.
 *
 * Moved verbatim (behavior byte-identical) from `AgentModeService.prototype.*`:
 * createHtmlFile, createHtmlTemplate — plus 7 private helpers used ONLY by
 * these two (inlinePrivateS3Images, renderHtmlDraftInSections,
 * deliverDeterministicHtmlFallback, parameterizeLargeHtml, stripBase64ForLlm,
 * applyVariableMap, computeSafeTextRanges — verified by a whole-file grep:
 * zero references anywhere else in agentModeService.ts, zero test spies) —
 * moved as plain module-scope functions rather than promoted to a shared
 * module. Also moves 7 module-SCOPE exports that lived alongside the class in
 * agentModeService.ts (not inside it): CREATE_HTML_RENDER_MAX_DRAFT_CHARS,
 * CREATE_HTML_RENDER_TIMEOUT_RETRY_MAX_DRAFT_CHARS,
 * CREATE_HTML_RENDER_SINGLE_PASS_MAX_DRAFT_CHARS,
 * CREATE_HTML_RENDER_CHUNK_MAX_CHARS, isRenderTimeoutError,
 * isCompleteHtmlDocument, buildHtmlArtifactFilename — round 5's htmlTools.ts
 * flagged these as needing "the same promote-to-shared-and-reexport
 * treatment as a class method, just for plain functions instead" and
 * deferred them; this round does that. `buildHtmlArtifactFilename` had one
 * real external importer (agentModeService.buildHtmlArtifactFilename.test.ts
 * imports it directly from agentModeService.ts) — that test's import is
 * retargeted at this module in the same commit.
 *
 * `AgentModeService.prototype.<name>` now delegates to createHtmlFile/
 * createHtmlTemplate rather than duplicating them: emma/tools.ts is the only
 * real production caller (whole-backend grep), but both have dedicated test
 * files that call them directly on a real instance
 * (agentModeService.createHtmlFile.test.ts,
 * agentModeService.createHtmlFilePassthrough.test.ts,
 * agentModeService.createHtmlTemplate.test.ts) — deleting them would break
 * those suites. The 7 private helpers have zero other callers/spies and are
 * deleted from the class outright.
 *
 * Instance-state notes:
 *  - `this.makeToolUsageCallback` is the ENG-2103-round-1 shared helper
 *    (emma/impl/shared/toolUsageMetering.ts) — imported by name here, same as
 *    every extraction since the books round.
 *  - `this.sleep` is a trivial one-line `setTimeout` wrapper used broadly
 *    across agentModeService.ts (session-pacing, retry backoff — far outside
 *    this cluster), so it stays on the class. Reimplemented here as a plain
 *    local function rather than engineering a shared-module promotion for a
 *    single `await new Promise(r => setTimeout(r, ms))`.
 *
 * Transitive-import notes: none of this cluster's dependencies needed new
 * lazy treatment. `settingsService.ts` (top-level-imports aws-sdk) and
 * `services/db.ts`/`orgShareService.ts` were already lazily `await
 * import()`'d inline in the original source for createHtmlTemplate — kept
 * exactly as-is. `utils/templateParser.ts` (extractVariables) and
 * `utils/agentModeErrors.ts` (isTransientLLMError) have zero imports of
 * their own — safe top-level imports. `randomUUID` is Node's own `crypto`
 * builtin. `utils/s3Utils.ts`, `utils/htmlSanitizer.ts`, `utils/llmService.ts`,
 * `utils/inlineS3Images.ts`, `utils/chunkedHtmlRender.ts`, and
 * `utils/markdownHtmlReport.ts` were already lazily `await import()`'d
 * inline for every one of these methods — kept exactly as-is, same load
 * timing as before.
 *
 * Metering/RunFunding audit: zero matches for currentRunFunding or
 * billingUserId anywhere in the cluster. Both methods reach the LLM only via
 * `llmService.generateHTML`/`generateJsonRobust` (the compatibility-facade
 * path every prior round has found safe to extract — NOT `this.callLLM`
 * directly), with `{ userId, sessionId, feature: 'content_gen' }` as the
 * usage context passed at every call site — `userId` only, no `billingUserId`
 * key, unmodified from the original source.
 */

/**
 * ENG-2103 (F2) DESIGN-DECISION-LIST FOLLOW-UP (round 3, "Pattern A") — adds
 * `createHtmlFromTemplate`, the method this file's own header above flagged
 * as excluded, specifically for its direct `this.callLLM` coupling. Read in
 * full, confirmed to make exactly ONE `this.callLLM` call (the
 * template-variable substitution step). Two more `AgentModeService` instance
 * methods are used to pick which model that call gets: `getDefaultModel`
 * (no model pinned by the caller) and `resolveGenerationModel` (ENG-46: falls
 * a stale/removed model id back to a served one before it reaches
 * `callLLM`). All three are genuine LLM-gateway/routing infrastructure — the
 * same "never a candidate for extraction, same category as callLLM itself"
 * reasoning already applied to `describeImage`/`generateImage` — so, per
 * Pattern A, they are injected as bound function parameters rather than
 * moved or reimplemented:
 *
 *   - `callLLM` — narrowed to `CreateHtmlFromTemplateLlmCall`, a structural
 *     type covering only the one call shape this method actually sends (one
 *     user message; `temperature`/`response_format`/`max_completion_tokens`/
 *     `taskClass`/`usageContext` — 5 of `callLLM`'s real, much larger
 *     `LLMCallOptions` fields). `LLMCallOptions` is a private, unexported
 *     interface in agentModeService.ts, and this module must not import that
 *     file anyway, so this is a deliberately local, narrower type — not a
 *     copy of the whole signature.
 *   - `getDefaultModel` / `resolveGenerationModel` — injected as
 *     `GetDefaultModelFn`/`ResolveGenerationModelFn`, each matching the real
 *     `public` instance method's signature exactly. Both are `public` on the
 *     class (confirmed by reading agentModeService.ts directly), so
 *     `emma/tools.ts` binds them straight off the `agentModeService`
 *     singleton with no class-side delegating wrapper needed in between —
 *     unlike `AccountResolver`/`EmployerSizeFilterResolver`, whose underlying
 *     methods are `private`.
 *
 * `AgentModeService.prototype.findTemplateById` and its private helper
 * `getTemplatesForUser` existed ONLY for this method (whole-backend grep:
 * zero other callers, zero test spies) — moved here as a local, non-exported
 * `findTemplateById`, built on `emma/impl/shared/htmlTemplates.ts`'s
 * `getTemplatesForUser` (the same shared reader `emma/impl/htmlTools.ts`'s
 * `listHtmlTemplates` already uses), and DELETED from the class outright —
 * the "genuinely dead, not kept as an unnecessary stub" treatment this series
 * has used throughout.
 *
 * The five `private static` HTML-escaping delegates on `AgentModeService`
 * (`escapeHtml`/`unescapeHtml`/`deepEscapeHtmlValues`/`escapeRegExp`/
 * `collectRawToEscapedMap` — see `emma/impl/shared/htmlEscaping.ts`'s own
 * header) were shared between this method and `emma/impl/googleDocsSheets.ts`'s
 * markdown pipeline. Four of the five (`unescapeHtml`/`deepEscapeHtmlValues`/
 * `escapeRegExp`/`collectRawToEscapedMap`) had this method as their ONLY
 * caller anywhere in the backend — imported here directly from the shared
 * module instead, and deleted from the class. `escapeHtml` already had zero
 * callers anywhere in agentModeService.ts BEFORE this round (pre-existing,
 * unrelated dead code) — left untouched per the "don't remove pre-existing
 * dead code" rule; only its now-stale doc comment was corrected.
 *
 * `AgentModeService.prototype.createHtmlFromTemplate` stays as a delegating
 * wrapper (not deleted): `routes/emmaApi.ts`'s `POST
 * /create-html-from-template` calls it directly on the class singleton, and
 * `createHtmlFromTemplate.test.ts` calls it directly on a real instance
 * (including `jest.spyOn(agentModeService, 'callLLM')`, still observed since
 * the wrapper reads `this.callLLM` fresh on every call). `emma/tools.ts` was
 * repointed to call this module directly, supplying all three injected
 * functions bound straight off the `agentModeService` singleton.
 *
 * Metering/RunFunding audit: zero matches for currentRunFunding or
 * billingUserId in this method — its one `usageContext` is
 * `{ userId, sessionId, feature: 'html_template' }`, unmodified from the
 * original source.
 */

import { randomUUID } from 'crypto';
import { extractVariables } from '../../utils/templateParser';
import { isTransientLLMError } from '../../utils/agentModeErrors';
import { makeToolUsageCallback } from './shared/toolUsageMetering';
import { getTemplatesForUser } from './shared/htmlTemplates';
import { CALLER_URL_MAX_TEXT_BYTES, fetchCallerUrlText } from '../../utils/callerUrlFetch';
import {
  unescapeHtml,
  deepEscapeHtmlValues,
  escapeRegExp,
  collectRawToEscapedMap,
} from './shared/htmlEscaping';
import type { GatewayTaskClass } from '../../utils/openRouterGatewayContract';
import type { LLMUsageContext } from '../../utils/llmService';

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

// Max size of a NON-HTML content_draft that create_html_file will attempt to
// render into HTML in a single internal LLM call. The render (llmService
// generateHTML) has a hard 5-minute per-call Bedrock timeout, retried 3x — an
// oversized rough draft can't finish inside that budget and burns ~15 min before
// failing (ENG-472). Above this we fail fast with actionable guidance instead.
// Already-complete HTML drafts bypass the render entirely (see
// isCompleteHtmlDocument) and are NOT subject to this cap.
export const CREATE_HTML_RENDER_MAX_DRAFT_CHARS = 60000;

// Above this draft size, a render TIMEOUT is deterministic rather than transient,
// so ENG-203's retry only spends another full 5-minute window arriving at the
// identical failure. Backstop for the streaming render (see the createLLMService
// call in createHTMLFile): streaming is what actually stops the 5-minute
// socket-inactivity timer from firing mid-generation, but if a render still times
// out on a draft this large, the size — not a blip — is why.
//
// The threshold is empirical, from the create_html_file calls in prod:
//   timed out: 45,000 / 42,232 / 37,604 / 31,213 / 25,580-char drafts
//   succeeded: 23,010 / 22,456 / 11,975 / 11,825-char drafts
// so the cliff sat between ~23K and ~25.5K. 20K keeps a margin under the smallest
// observed success, and well below CREATE_HTML_RENDER_MAX_DRAFT_CHARS so ordinary
// drafts — where a timeout really is a one-off blip — keep the retry.
export const CREATE_HTML_RENDER_TIMEOUT_RETRY_MAX_DRAFT_CHARS = 20000;

// Largest draft still rendered by ONE monolithic LLM call. Above it the render
// is all-or-nothing at a size where prod says it does not reliably fit the
// per-call budget (see the observed cliff above), so the draft is rendered
// section by section instead and the fragments are assembled locally. That
// keeps the styled design for exactly the large reports that used to strand —
// degrading to plain built-in styling stays the last resort, not the plan.
export const CREATE_HTML_RENDER_SINGLE_PASS_MAX_DRAFT_CHARS = 24000;

// Target size of one section render. Comfortably inside the smallest draft size
// observed to render successfully in prod (23,010 chars), so no single section
// is anywhere near the per-call budget, and small enough that the 60K ceiling
// splits into a handful of parallel calls rather than dozens.
export const CREATE_HTML_RENDER_CHUNK_MAX_CHARS = 12000;

// Is this render error a per-call TIMEOUT (as opposed to a throttle, 5xx or
// terminal error)? Bedrock surfaces these as TimeoutError/ModelTimeoutException,
// or — for the streaming render — as "Stream timed out because of no activity
// for 300000 ms", which carries no distinguishing name or code.
export function isRenderTimeoutError(error: unknown): boolean {
  if (!error) return false;
  const e = error as any;
  if (e.name === 'TimeoutError' || e.name === 'ModelTimeoutException') return true;
  if (e.code === 'ETIMEDOUT' || e.code === 'ECONNABORTED') return true;
  const message = error instanceof Error ? error.message : String(error);
  return /timed?\s?out|timeout/i.test(message);
}

// A create_html_file content_draft that is already a complete HTML document does
// not need the internal HTML-generation LLM call — re-rendering HTML->HTML is
// wasted cost/latency, risks the model altering the user's content, and is the
// exact case that deterministically times out on large drafts (ENG-472). Detect
// a self-contained document: an opening doctype/<html> AND a closing </html>.
export function isCompleteHtmlDocument(draft: string): boolean {
  if (typeof draft !== 'string') return false;
  const s = draft.trim().toLowerCase();
  const hasOpen = s.startsWith('<!doctype html') || s.startsWith('<html') || s.includes('<html');
  const hasClose = s.includes('</html>');
  return hasOpen && hasClose;
}

// ENG-2679 — the single-pass render can come back cut off (upstream stream ends
// early, or finish_reason=length) while still containing the opening of a valid
// document. sanitize-html then auto-closes every open tag, so the stub uploads as
// a "complete" file and create_html_file reports success — a 3-person brief
// shipped with only the first person's header. Reject such renders BEFORE
// sanitizing so the retry/deterministic-fallback paths (ENG-203/ENG-873) run.
export class IncompleteHtmlRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IncompleteHtmlRenderError';
  }
}

/** Visible text of an HTML (or markdown-ish) string, whitespace-collapsed. */
function visibleTextLength(s: string): number {
  return s
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[#*_`>|-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim().length;
}

// The render prompt tells the model to carry every fact from the draft over
// verbatim, so a finished document's visible text is never a small fraction of
// the draft's. Generous floor: styling may tighten wording, truncation drops
// whole sections (the ENG-2679 file kept ~17% of its draft's text).
export const CREATE_HTML_MIN_TEXT_COVERAGE = 0.4;
// Tiny drafts legitimately expand or reshape; only apply the coverage check
// where losing a whole section is possible.
export const CREATE_HTML_COVERAGE_MIN_DRAFT_CHARS = 1500;

export function assertCompleteHtmlRender(html: string, contentDraft: string): void {
  if (!/<\/html\s*>/i.test(html)) {
    throw new IncompleteHtmlRenderError('HTML render is incomplete: missing closing </html> (output truncated)');
  }
  const draftLen = visibleTextLength(contentDraft);
  if (draftLen >= CREATE_HTML_COVERAGE_MIN_DRAFT_CHARS) {
    const outLen = visibleTextLength(html);
    if (outLen < draftLen * CREATE_HTML_MIN_TEXT_COVERAGE) {
      throw new IncompleteHtmlRenderError(
        `HTML render is incomplete: ${outLen} visible chars for a ${draftLen}-char draft (content dropped)`,
      );
    }
  }
}

export function isIncompleteHtmlRenderError(error: unknown): boolean {
  return (error as any)?.name === 'IncompleteHtmlRenderError';
}

/**
 * ENG-1685: build the S3-safe filename for a generated HTML artifact from its
 * (human-written, arbitrary-content) title.
 *
 * Kraftersland/Helen reported "Download failed" on an HTML report artifact whose
 * displayed filename was truncated mid-word: `..._Weekly_Performance_Repor.html`
 * (missing the final "t"). Root cause: the sanitize-then-truncate order was
 * backwards everywhere this ran — `title.replace(...).substring(0, 50)` blindly
 * cut the ALREADY-underscore-joined string at a fixed 50-char boundary with no
 * regard for word breaks, so any title whose sanitized form crossed that
 * boundary lost a fragment of its last word. The 50-char cap itself had no
 * documented reason: S3 keys allow up to 1024 bytes and this key already has a
 * userId + timestamp + random token prefix, leaving hundreds of characters of
 * real headroom — the low, undocumented number was never load-bearing.
 *
 * The truncated filename was NOT independently confirmed to be the cause of the
 * download failure itself (a live repro of the exact reported file's presign +
 * S3 fetch succeeded end-to-end against production), but it is a real, visible
 * bug in the same code path and worth fixing regardless — and downloadAsset.ts's
 * error handling was hardened separately (ENG-1685) to stop collapsing every
 * failure class into one indistinguishable "Download failed" toast, which is
 * what made this report undiagnosable from the client side in the first place.
 */
export function buildHtmlArtifactFilename(title: string, now: number = Date.now()): string {
  const HTML_ARTIFACT_FILENAME_TITLE_MAX = 150;
  const sanitized = (title || '').replace(/[^a-z0-9]/gi, '_').substring(0, HTML_ARTIFACT_FILENAME_TITLE_MAX);
  return `html_${now}_${sanitized}.html`;
}

export async function createHtmlFile(
    title: string,
    contentDraft: string,
    formatRequirements: string,
    userId: string,
    sessionId: string,
    documentType: 'document' | 'email' = 'document'
  ): Promise<any> {
    try {
      if (!title || typeof title !== 'string') {
        throw new Error('title is required and must be a non-empty string');
      }
      if (!contentDraft || typeof contentDraft !== 'string') {
        throw new Error('content_draft is required and must be a non-empty string');
      }

      const isEmail = documentType === 'email';

      // ENG-472 #1 — Passthrough: when the draft is already a complete HTML
      // document, skip the internal render LLM call and upload it verbatim.
      // Re-rendering HTML->HTML wastes an expensive call, risks the model
      // altering the content, and is exactly what times out on large drafts.
      // Email is excluded: the email render applies email-client-safety
      // transforms (table layout, inline styles) that a generic HTML document
      // may lack, so emails always go through the render path.
      if (!isEmail && isCompleteHtmlDocument(contentDraft)) {
        console.log('AgentMode: create_html_file — draft is already complete HTML, uploading directly (skipping render)');
        const { uploadFileToS3 } = await import('../../utils/s3Utils');
        const { sanitizeGeneratedHtml } = await import('../../utils/htmlSanitizer');
        const filename = buildHtmlArtifactFilename(title);
        // ENG-1997 — the passthrough uploads the model's own draft verbatim with no
        // render step in between, so if it faithfully reproduced markup from
        // untrusted quoted content (a CRM note, a client quote), nothing else in
        // this path would ever catch it. Sanitize before it ever reaches S3.
        const sanitizedContent = sanitizeGeneratedHtml(contentDraft);
        const uploadableHtml = await inlinePrivateS3Images(sanitizedContent, documentType, userId);
        const uploadResult = await uploadFileToS3(uploadableHtml, filename, userId, 'text/html');
        if (!uploadResult.success || !uploadResult.url) {
          const uploadErr: any = new Error(uploadResult.error || 'Failed to upload HTML file to S3');
          uploadErr.status = uploadResult.statusCode;
          throw uploadErr;
        }
        return {
          success: true,
          s3_url: uploadResult.url,
          filename,
          title,
          document_type: documentType,
          rendered: false,
          message: 'HTML file created successfully'
        };
      }

      // ENG-472 #2 — Fail fast: a draft that must be rendered but is larger than
      // the render step can finish inside its 5-minute per-call budget would burn
      // ~15 minutes across retries before failing. Return actionable guidance
      // immediately instead. (Complete-HTML drafts already returned above and are
      // not size-limited.)
      if (contentDraft.length > CREATE_HTML_RENDER_MAX_DRAFT_CHARS) {
        console.warn(`AgentMode: create_html_file — draft too large for an LLM render (${contentDraft.length} chars > ${CREATE_HTML_RENDER_MAX_DRAFT_CHARS}); delivering it deterministically instead`);
        // ENG-873: keep ENG-472's "spend nothing on a render that cannot finish"
        // rule, but not its "return nothing" outcome — that is the same way the
        // 40-competitor report was stranded, only at a larger size. The
        // deterministic renderer has no size ceiling and costs no LLM call, so
        // the completed work is still delivered as the requested HTML file.
        return await deliverDeterministicHtmlFallback(
          title, contentDraft, userId, documentType,
          new Error(`content_draft is too large for the styled render (${contentDraft.length} characters, limit ${CREATE_HTML_RENDER_MAX_DRAFT_CHARS}) — split it into smaller sections, or send a complete self-contained HTML document, which is saved verbatim with no size limit`),
        );
      }

      // Use Claude model by default (check for Claude in model name)
      const defaultClaudeModel = 'anthropic.claude-sonnet-4-6';

      // Import LLMService
      const { createLLMService } = await import('../../utils/llmService');
      // Use high token limit for HTML generation — reports like GTM audits can be large.
      // ENG-873: stream the render. A 64K-token document routinely takes longer than
      // the Bedrock client's 5-minute socket-inactivity timeout to generate, and a
      // NON-streaming call puts nothing on the socket until it is completely done —
      // so every large report timed out deterministically. Streaming keeps bytes
      // flowing, so the inactivity timer never fires mid-generation.
      const llmService = createLLMService(defaultClaudeModel, 0.8, 64000, { streaming: true });

      // Email mode produces a one-off newsletter/marketing email rendered in
      // HTML that is safe across email clients (Gmail, Outlook, Apple Mail).
      // This is a finished email, NOT a reusable {{variable}} template.
      const emailSystemPrompt = `You are an expert HTML email designer. Your task is to create a complete, polished, ready-to-send marketing/newsletter email in HTML from the provided subject/title and content draft.

EMAIL-CLIENT COMPATIBILITY (CRITICAL — emails are not web pages):
- Use a table-based layout (<table role="presentation" ...>) for ALL structure — do NOT rely on flexbox, grid, float, or position
- Use INLINE styles on every element (style="..."). Email clients strip or ignore <style> blocks and external CSS
- Center the email in a 600px-wide container table (max-width: 600px); use a full-width outer wrapper table with a light background color
- Use only web-safe fonts (Arial, Helvetica, Georgia, sans-serif) with explicit font-family fallbacks
- Use absolute https:// URLs for all images, and always include width, alt text, and display:block
- Use VML-free, JavaScript-free markup — NO <script>, NO external <link>, NO web fonts, NO charts/canvas
- Specify explicit colors as hex (e.g. #1a1a1a) and set bgcolor on table cells where relevant
- Make buttons as bulletproof anchor "buttons": an <a> with inline padding, background-color, border-radius, and color
- Add a viewport meta tag and set body { margin:0; padding:0; } for consistent rendering
- Keep total width responsive: the container should gracefully shrink on mobile (use width:100% with max-width:600px)

EMAIL STRUCTURE:
- Begin with a clear header (brand name or logo area) and a strong headline derived from the subject/title
- Organize the content draft into scannable sections with headings, short paragraphs, and bullet lists where helpful
- Include a clear call-to-action button if the content implies one
- End with a simple footer (sender/company line and an unsubscribe placeholder link)

DATA ACCURACY RULES (CRITICAL):
- NEVER invent, estimate, approximate, or round numeric values
- Use ONLY the exact numbers, names, dates, and links provided in the content draft — copy them verbatim
- If a value is not present in the content draft, omit it rather than guessing
${formatRequirements ? `\nAdditional Format Requirements:\n${formatRequirements}` : ''}

Return ONLY the complete HTML email document (DOCTYPE through </html>), production-ready and well-formatted. Do NOT use {{variable}} placeholders — fill in the actual content. This is a finished, one-off email, not a reusable template.`;

      // Build system prompt for HTML generation
      const documentSystemPrompt = `You are an expert web developer and HTML designer. Your task is to create a well-formatted, professional HTML document from the provided title and content draft.

Requirements:
- Create a complete, valid HTML5 document with proper DOCTYPE, html, head, and body tags
- Include appropriate meta tags for charset, viewport, and SEO
- Add modern, clean CSS styling (embedded in <style> tag or inline as appropriate)
- Ensure the HTML is responsive and works well on different screen sizes
- Use semantic HTML5 elements where appropriate
- Make the design professional and visually appealing
- Ensure proper typography, spacing, and color scheme
- Include the title in an appropriate heading element
- Format the content draft into well-structured HTML with proper paragraphs, headings, lists, etc. as needed
${formatRequirements ? `\nAdditional Format Requirements:\n${formatRequirements}` : ''}

DATA ACCURACY RULES (CRITICAL):
- NEVER invent, estimate, approximate, or round numeric values for charts or tables
- Use ONLY the exact numbers provided in the content draft — copy them verbatim
- NEVER use placeholder labels like "Ad Variant 1", "Campaign A", "Label 1" etc. — use the actual names from the data
- If a value is not present in the content draft, omit that data point entirely rather than guessing
- Chart data arrays must contain exactly the values provided, in the correct order

CHART RULES (if the document includes charts):
Option A — QuickChart (server-side, preferred for simple charts):
  - Use https://quickchart.io/chart?v=2.9.4&c=<URL-encoded JSON config> as <img> src
  - The chart config JSON MUST be 100% valid JSON with all strings properly quoted (double or single, but ALWAYS closed)
  - COMMON BUG TO AVOID: every string value must have BOTH an opening AND closing quote. e.g. "position:'right'" not "position:'right"
  - Before URL-encoding, mentally verify every string literal in the JSON has matching open/close quotes
  - QuickChart uses Chart.js v2 syntax: scales use "xAxes"/"yAxes" arrays, legend/title at root level
  - The "horizontalBar" type is supported by QuickChart
  - Always URL-encode the full chart config JSON
Option B — Inline Chart.js (for interactive charts):
  - ALWAYS load Chart.js v4 from CDN: <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js"></script>
  - Use ONLY Chart.js v4 configuration syntax:
    - Scales: { x: {...}, y: {...} } NOT xAxes/yAxes arrays
    - Legend: options.plugins.legend (NOT options.legend)
    - Title: options.plugins.title (NOT options.title)
    - Tooltips: options.plugins.tooltip (NOT options.tooltips)
    - "horizontalBar" does NOT exist in v4 — use type: "bar" with indexAxis: "y" instead
  - Every canvas must have a unique id; wrap Chart() calls in DOMContentLoaded or place at end of body
- Do NOT mix Chart.js v2 and v4 syntax — pick one approach and use it consistently throughout the document

The HTML should be production-ready and well-formatted.`;

      const systemPrompt = isEmail ? emailSystemPrompt : documentSystemPrompt;

      // Build user prompt
      const userPrompt = isEmail
        ? `Create a complete, ready-to-send HTML email with the following:

Subject / Title: ${title}

Content Draft:
${contentDraft}

${formatRequirements ? `\nFormat Requirements:\n${formatRequirements}` : ''}

Please generate a complete, email-client-safe HTML email that presents this content as a polished newsletter/marketing email.`
        : `Create a well-formatted HTML document with the following:

Title: ${title}

Content Draft:
${contentDraft}

${formatRequirements ? `\nFormat Requirements:\n${formatRequirements}` : ''}

Please generate a complete, professional HTML document that properly formats and presents this content.`;

      // Generate HTML using LLMService.
      // The final render is a single long-running LLM call; on Bedrock it can hit
      // the 5-minute requestTimeout and throw. Without a retry, one transient
      // timeout discards ALL completed upstream work (steps 1-3), which is exactly
      // the systemic failure reported in ENG-203. Retry the render step with
      // exponential backoff on transient errors (timeouts / 5xx / network) so a
      // single blip no longer loses the report. Terminal errors (invalid args,
      // auth, content-filter) are not retried — an identical call would just fail
      // again.
      console.log(`AgentMode: Generating HTML ${isEmail ? 'email' : 'file'} with LLMService (Claude model)`);
      const maxRenderAttempts = 3;
      let htmlContent = '';
      let renderFailure: unknown = null;
      // ENG-873: above this draft size a render TIMEOUT is a property of the
      // payload, not a blip — the same monolithic render cannot fit in the same
      // per-call budget on a second attempt, so a retry just spends another five
      // minutes reaching the identical failure. Below it, ENG-203's retry still
      // applies: a small draft that times out really did hit a one-off blip.
      const timeoutIsDeterministic = contentDraft.length > CREATE_HTML_RENDER_TIMEOUT_RETRY_MAX_DRAFT_CHARS;

      // ENG-873: a draft too big for one render is not rendered in one call at
      // all. Emails are excluded — an email is a single assembled table layout
      // that cannot be stitched together from independently designed pieces.
      const renderInSections =
        !isEmail && contentDraft.length > CREATE_HTML_RENDER_SINGLE_PASS_MAX_DRAFT_CHARS;
      if (renderInSections) {
        try {
          htmlContent = await renderHtmlDraftInSections(
            title, contentDraft, formatRequirements, userId, sessionId, llmService,
          );
        } catch (sectionError) {
          console.error(`AgentMode: sectioned HTML render failed on a ${contentDraft.length}-char draft (session ${sessionId}):`, sectionError instanceof Error ? sectionError.message : sectionError);
          renderFailure = sectionError;
        }
      }
      // Sectioned drafts have already been rendered (or failed) above.
      const singlePassAttempts = renderInSections ? 0 : maxRenderAttempts;
      for (let attempt = 1; attempt <= singlePassAttempts; attempt++) {
        try {
          const rendered = await llmService.generateHTML(systemPrompt, userPrompt, makeToolUsageCallback(sessionId, 'createHTMLFile'), { userId, sessionId, feature: 'content_gen' });
          // ENG-2679: never accept a truncated render as the deliverable.
          if (!isEmail && rendered && rendered.trim()) assertCompleteHtmlRender(rendered, contentDraft);
          htmlContent = rendered;
          break;
        } catch (renderError) {
          const isLastAttempt = attempt === maxRenderAttempts;
          const isTransient = isTransientLLMError(renderError) || isIncompleteHtmlRenderError(renderError);
          if (isIncompleteHtmlRenderError(renderError)) {
            console.warn(`AgentMode: ENG-2679 incomplete HTML render (attempt ${attempt}/${maxRenderAttempts}, session ${sessionId}): ${(renderError as Error).message}`);
          }
          const renderErrorText = renderError instanceof Error ? renderError.message : renderError;
          if (timeoutIsDeterministic && isRenderTimeoutError(renderError)) {
            console.error(`AgentMode: HTML render timed out on a ${contentDraft.length}-char draft (session ${sessionId}) — too large to re-render inside the per-call budget, degrading instead of retrying:`, renderErrorText);
            renderFailure = renderError;
            break;
          }
          if (isLastAttempt || !isTransient) {
            // Distinguish exhaustion from a terminal error. If every attempt hit a
            // transient timeout, the render likely can't finish inside the per-call
            // budget deterministically (e.g. an oversized report) — retrying the same
            // call won't help, and this is the signal that would justify streaming/
            // chunking the render (ENG-203 follow-up). Log it distinctly so these are
            // greppable and separable from one-off blips and terminal errors.
            if (isLastAttempt && isTransient) {
              console.error(`AgentMode: HTML render exhausted all ${maxRenderAttempts} attempts on a transient error (session ${sessionId}); render may be deterministically over the per-call timeout:`, renderErrorText);
            }
            renderFailure = renderError;
            break;
          }
          const backoffMs = 1000 * Math.pow(2, attempt - 1);
          console.warn(`AgentMode: HTML render attempt ${attempt}/${maxRenderAttempts} failed with a transient error, retrying in ${backoffMs}ms:`, renderErrorText);
          await sleep(backoffMs);
        }
      }

      if (!renderFailure && (!htmlContent || htmlContent.trim().length === 0)) {
        renderFailure = new Error('LLM did not generate HTML content');
      }

      // ENG-873: the styled render is a FORMATTING step at the very end of a run
      // that may have cost an hour of research. Losing it must never lose the
      // work: render the draft deterministically and deliver that instead of
      // returning nothing (which is what stranded a completed 40-competitor
      // report — two monolithic renders, two timeouts, no deliverable at all).
      if (renderFailure) {
        return await deliverDeterministicHtmlFallback(
          title, contentDraft, userId, documentType, renderFailure,
        );
      }

      // Upload to S3
      const { uploadFileToS3 } = await import('../../utils/s3Utils');
      const { sanitizeGeneratedHtml } = await import('../../utils/htmlSanitizer');
      const filename = buildHtmlArtifactFilename(title);
      // ENG-1997 — the render step has no {{variable}} boundary to escape values
      // into (unlike createHtmlFromTemplate/ENG-1877): it's told to copy names,
      // quotes, and numbers from the draft verbatim, so any markup embedded in
      // untrusted quoted content can survive the render unchanged. Sanitize the
      // finished document before it reaches S3.
      const sanitizedHtmlContent = sanitizeGeneratedHtml(htmlContent);
      const uploadableHtml = await inlinePrivateS3Images(sanitizedHtmlContent, documentType, userId);
      const uploadResult = await uploadFileToS3(uploadableHtml, filename, userId, 'text/html');

      if (!uploadResult.success || !uploadResult.url) {
        const uploadErr: any = new Error(uploadResult.error || 'Failed to upload HTML file to S3');
        uploadErr.status = uploadResult.statusCode;
        throw uploadErr;
      }

      const s3Url = uploadResult.url;
      console.log('AgentMode: HTML file created and uploaded successfully to:', s3Url);

      return {
        success: true,
        s3_url: s3Url,
        filename: filename,
        title: title,
        document_type: documentType,
        message: isEmail ? 'HTML email created successfully' : 'HTML file created successfully'
      };
    } catch (error) {
      console.error('Error creating HTML file:', error);
      return {
        success: false,
        message: 'Failed to create HTML file',
        error: error instanceof Error ? error.message : 'Unknown error',
        // ENG-1300: real HTTP status from the S3 upload, when that's what failed.
        code: (error as any)?.status
      };
    }
  }

  /**
   * Embed private, same-bucket S3 images in downloadable HTML documents. The
   * image fetcher intentionally ignores all other URLs, and the inliner fully
   * validates byte limits before returning HTML so callers can never upload a
   * partially transformed document. Email keeps absolute image URLs because
   * email clients have materially different payload constraints.
   */
async function inlinePrivateS3Images(
    html: string,
    documentType: 'document' | 'email',
    userId: string,
  ): Promise<string> {
    if (documentType === 'email') return html;
    const { createDefaultS3ImageFetcher, inlineS3ImagesAsDataUris } =
      await import('../../utils/inlineS3Images');
    const result = await inlineS3ImagesAsDataUris(html, createDefaultS3ImageFetcher(userId));
    return result.html;
  }

  /**
   * ENG-873 — render a draft that is too large for one call as N section
   * renders, then assemble the fragments into a single document under one
   * stylesheet (supplied by chunkedHtmlRender, not by the model, so sections
   * cannot drift apart visually).
   *
   * Sections render concurrently: each is well inside the per-call budget, so
   * the wall-clock cost is roughly one render rather than N. A section that
   * fails transiently is retried once — losing an hour of research to one blip
   * on one section of the report is exactly the failure being fixed here. If a
   * section still cannot render, this throws and the caller degrades to the
   * deterministic document, which never loses content.
   */
async function renderHtmlDraftInSections(
    title: string,
    contentDraft: string,
    formatRequirements: string,
    userId: string,
    sessionId: string,
    llmService: {
      generateHTML: (
        systemPrompt: string,
        userPrompt: string,
        onUsage: any,
        context: any,
      ) => Promise<string>;
    },
  ): Promise<string> {
    const { splitDraftIntoRenderChunks, extractHtmlFragment, assembleChunkedHtmlDocument } =
      await import('../../utils/chunkedHtmlRender');

    const chunks = splitDraftIntoRenderChunks(contentDraft, CREATE_HTML_RENDER_CHUNK_MAX_CHARS);
    if (chunks.length === 0) {
      throw new Error('content_draft contains no renderable content');
    }
    console.log(`AgentMode: create_html_file — rendering a ${contentDraft.length}-char draft as ${chunks.length} sections (session ${sessionId})`);

    const systemPrompt = `You are an expert web developer rendering ONE SECTION of a larger HTML report. Convert the section of the content draft you are given into clean, professional HTML.

Return ONLY the HTML body fragment for this section:
- No document-level markup at all — no doctype, no html/head/body tags, no stylesheet block and no scripts. The surrounding document and its stylesheet already exist.
- Use semantic tags (h2, h3, p, ul, ol, table/thead/tbody/tr/th/td, blockquote). They are already styled by the document's stylesheet, so do NOT add CSS, class names or style attributes.
- Present the section's content faithfully and completely — every entity, row and figure in it must appear in your output.
- Do not add an introduction, conclusion, or navigation for the report as a whole: other sections are rendered separately and assembled around yours.

DATA ACCURACY RULES (CRITICAL):
- NEVER invent, estimate, approximate, or round numeric values
- Use ONLY the exact numbers, names, dates and links provided — copy them verbatim
- NEVER use placeholder labels like "Competitor A" or "Label 1" — use the actual names
- If a value is not present in the section, omit it rather than guessing

CHARTS (if the section's data calls for one):
- Use a QuickChart image only: https://quickchart.io/chart?v=2.9.4&c=<URL-encoded Chart.js v2 JSON config> as the src of an <img>
- Every string in the chart config JSON must have BOTH an opening and a closing quote, and the whole config must be URL-encoded
- Do not use inline Chart.js or any other script: sections are assembled into one page, so scripts and canvas ids would collide${formatRequirements ? `\n\nAdditional Format Requirements:\n${formatRequirements}` : ''}`;

    const renderSection = async (chunk: string, index: number): Promise<string> => {
      const userPrompt = `Report title: ${title}

This is section ${index + 1} of ${chunks.length} of the report.${index === 0 ? ' Open it with the report title in an <h1>, then use <h2> for the sections below it.' : ' Do not repeat the report title — the first section already carries it in an <h1>. Start at <h2>.'}

Section content:
${chunk}

Return the HTML body fragment for this section only.`;
      const maxSectionAttempts = 2;
      for (let attempt = 1; attempt <= maxSectionAttempts; attempt++) {
        try {
          const rendered = await llmService.generateHTML(
            systemPrompt,
            userPrompt,
            makeToolUsageCallback(sessionId, 'createHTMLFile'),
            { userId, sessionId, feature: 'content_gen' },
          );
          const fragment = extractHtmlFragment(rendered);
          if (!fragment) {
            throw new Error(`section ${index + 1} of ${chunks.length} rendered empty`);
          }
          return fragment;
        } catch (sectionError) {
          // A streamed render timeout arrives as a bare "Stream timed out
          // because of no activity for 300000 ms" with no name or code, so
          // isTransientLLMError alone does not recognise it — but on a section
          // this small a timeout really is a blip, so it is worth one retry.
          const isTransient = isTransientLLMError(sectionError) || isRenderTimeoutError(sectionError) || isIncompleteHtmlRenderError(sectionError);
          if (attempt === maxSectionAttempts || !isTransient) throw sectionError;
          console.warn(`AgentMode: section ${index + 1}/${chunks.length} render failed transiently, retrying once:`, sectionError instanceof Error ? sectionError.message : sectionError);
          await sleep(1000);
        }
      }
      // Unreachable: the loop either returns a fragment or throws.
      throw new Error(`section ${index + 1} of ${chunks.length} could not be rendered`);
    };

    const fragments = await Promise.all(chunks.map(renderSection));
    return assembleChunkedHtmlDocument(title, fragments);
  }

  /**
   * ENG-873 — graceful degradation for create_html_file. When the styled render
   * cannot run, convert the draft to HTML deterministically (no LLM, no network,
   * no size ceiling) and deliver THAT, so a downstream formatting failure can
   * never discard the upstream work that produced the draft.
   *
   * Throws the original render failure if the fallback itself cannot be
   * delivered — the caller's catch then reports the real error, as before.
   */
async function deliverDeterministicHtmlFallback(
    title: string,
    contentDraft: string,
    userId: string,
    documentType: 'document' | 'email',
    renderFailure: unknown,
  ): Promise<any> {
    const reason = renderFailure instanceof Error ? renderFailure.message : String(renderFailure);
    let uploadResult: { success: boolean; url?: string; error?: string };
    try {
      const { renderMarkdownReportDocumentAsync } = await import('../../utils/markdownHtmlReport');
      const { uploadFileToS3 } = await import('../../utils/s3Utils');
      const { sanitizeGeneratedHtml } = await import('../../utils/htmlSanitizer');
      const fallbackHtml = await renderMarkdownReportDocumentAsync(title, contentDraft);
      // ENG-1997 — renderMarkdownReportDocumentAsync already escapes text nodes,
      // but sanitize defensively here too so this path never silently becomes the
      // odd one out if that changes.
      const sanitizedFallbackHtml = sanitizeGeneratedHtml(fallbackHtml);
      const uploadableHtml = await inlinePrivateS3Images(sanitizedFallbackHtml, documentType, userId);
      const filename = buildHtmlArtifactFilename(title);
      uploadResult = await uploadFileToS3(uploadableHtml, filename, userId, 'text/html');
      if (!uploadResult.success || !uploadResult.url) {
        throw new Error(uploadResult.error || 'Failed to upload HTML file to S3');
      }
      console.warn(`AgentMode: create_html_file — styled render failed (${reason}); delivered a deterministically rendered fallback document instead:`, uploadResult.url);
      return {
        success: true,
        s3_url: uploadResult.url,
        filename,
        title,
        document_type: documentType,
        rendered: false,
        degraded: true,
        degraded_reason: reason,
        message: `HTML file created, but with basic built-in styling: the styled render step failed (${reason}), so the draft was converted to HTML directly. The full content is intact — nothing was lost. Do NOT call create_html_file again with the same draft; it will fail the same way. Give the user this file and mention the simpler styling. If they want the richer design, send a complete self-contained HTML document as content_draft (that is saved verbatim, with no size limit) or split the report into smaller sections.`,
      };
    } catch (fallbackError) {
      console.error('AgentMode: create_html_file — deterministic fallback also failed:', fallbackError);
      if ((fallbackError as { code?: string })?.code === 'INLINE_S3_IMAGE_ERROR') {
        throw fallbackError;
      }
      throw renderFailure;
    }
  }

  // Create HTML template from existing HTML file (upload to email templates)
export async function createHtmlTemplate(
    htmlSource: string,
    templateId: string | undefined,
    templateName: string,
    subject: string,
    additionalInstructions: string,
    userId: string,
    sessionId: string,
    types?: string[]
  ): Promise<any> {
    try {
      // Validate html_source up front so a missing/non-string value returns a
      // clean error instead of throwing "Cannot read properties of undefined
      // (reading 'startsWith')" below.
      if (typeof htmlSource !== 'string' || htmlSource.trim().length === 0) {
        return {
          success: false,
          message: 'Failed to create HTML template',
          error: 'html_source is required and must be a non-empty string (raw HTML content or an S3/HTTPS URL).'
        };
      }

      // Org-level create gating: only org owner or listed htmlTemplates editor
      const { userDb, orgDb } = await import('../../services/db');
      const { canManageOrgFeature } = await import('../../services/orgShareService');
      const caller = await userDb.getUserById(userId);
      if (caller?.orgId) {
        const org = await orgDb.getOrgById(caller.orgId);
        const allowed = canManageOrgFeature(
          { userId, orgId: caller.orgId, orgRole: caller.orgRole as 'owner' | 'member' | undefined },
          org,
          'htmlTemplates',
        );
        if (!allowed) {
          return {
            success: false,
            message: 'Templates are managed by your org admin',
            error: 'Permission denied'
          };
        }
      }

      // Read HTML content from source (either S3 URL or direct HTML content)
      let htmlContent = htmlSource;

      // If htmlSource looks like a URL, fetch it
      if (htmlSource.startsWith('http://') || htmlSource.startsWith('https://')) {
        console.log('AgentMode: Fetching HTML from URL:', htmlSource);
        // A URL the caller chose is fetched only through the guarded fetch (public addresses only, redirects re-checked, size and
        // time bounded): the body becomes a saved template, so the server's own network position must not be reachable through it.
        try {
          htmlContent = await fetchCallerUrlText(htmlSource, { tool: 'create_html_template', userId, maxBytes: CALLER_URL_MAX_TEXT_BYTES });
        } catch (fetchError) {
          throw new Error(`Failed to fetch HTML from URL: ${fetchError instanceof Error ? fetchError.message : 'Unknown error'}`);
        }
      }

      // Documents large enough to risk truncation by the 16K output cap must NOT
      // be round-tripped through generateHTML — it would drop base64 images and
      // print CSS and regenerate a mangled doc. For those we ask the model for a
      // small variable-map and apply it deterministically to the pristine source,
      // preserving every byte. Small docs keep the existing full-rewrite path.
      // ~50K chars ≈ the 16K output-token ceiling for HTML.
      const LLM_REWRITE_MAX_CHARS = 50000;

      let enhancedHtml: string;
      let largeDocNote: string | undefined;

      if (htmlContent.length > LLM_REWRITE_MAX_CHARS) {
        const large = await parameterizeLargeHtml(
          htmlContent,
          subject,
          additionalInstructions,
          userId,
          sessionId,
        );
        enhancedHtml = large.html;
        largeDocNote = large.note;
      } else {
      // Use Claude model to process/enhance the HTML based on instructions
      const defaultClaudeModel = 'anthropic.claude-sonnet-4-6';

      const { createLLMService } = await import('../../utils/llmService');
      // Use 16K tokens for HTML template generation to avoid truncation.
      // Streamed for the same reason as the create_html_file render above
      // (ENG-873) — a 16K-token template can also outrun the 5-minute
      // socket-inactivity timeout when the call returns nothing until it ends.
      const llmService = createLLMService(defaultClaudeModel, 0.8, 16384, { streaming: true });

      // Build system prompt for HTML template creation
      const systemPrompt = `You are an expert web developer and HTML email template designer. Your task is to create or enhance an HTML email template based on the provided HTML content and instructions.

Requirements:
- Create a well-formatted, professional HTML email template
- Ensure the HTML is valid and follows email best practices (inline styles, table-based layouts if needed)
- Make the template reusable by identifying dynamic content that should be replaced with variables
- Use the {{variable_name}} syntax for all dynamic placeholders (e.g., {{user_name}}, {{company_name}})

CRITICAL - Array Variable Pattern for Repeating Sections:
For ANY repeating sections (lists, products, features, items, etc.), you MUST use this EXACT three-part pattern:
  {{property_1_field}} - First item
  {{property_2_field}} - Second item
  {{property_n_field}} - Array pattern

Example for a feature list with title and description:
<div class="feature">
  <h3>{{features_1_title}}</h3>
  <p>{{features_1_description}}</p>
</div>
<div class="feature">
  <h3>{{features_2_title}}</h3>
  <p>{{features_2_description}}</p>
</div>
<div class="feature">
  <h3>{{features_n_title}}</h3>
  <p>{{features_n_description}}</p>
</div>

REQUIRED: You MUST include ALL THREE (_1, _2, _n) for EACH property in repeating sections.
FORBIDDEN: Do NOT use _3, _4, _5, etc. Only _1, _2, and _n are valid.

Other Requirements:
- Ensure the template is responsive and works well across email clients
- Include appropriate styling that works in email contexts (inline CSS preferred)
- Keep the original intent and structure but enhance as needed based on instructions
- Make sure all images use absolute URLs
- Ensure proper HTML structure with appropriate tags

The HTML template should be production-ready, well-formatted, and suitable for use as an email template.`;

      // Build user prompt
      const userPrompt = `Create an email template with the following details:

Template Name: ${templateName}
Subject Line: ${subject}

Base HTML Content:
${htmlContent}

Additional Instructions:
${additionalInstructions || 'None - please process the HTML and identify appropriate variables for dynamic content.'}

Please:
1. Process the HTML content and enhance it for email template usage
2. Identify dynamic content and replace with {{variable_name}} placeholders
3. For repeating sections, use the REQUIRED three-part pattern: {{items_1_property}}, {{items_2_property}}, {{items_n_property}}
   - MUST include all three: _1, _2, and _n
   - Do NOT use _3, _4, _5, etc.
4. Ensure email compatibility (inline styles, proper structure)
5. Keep the subject line and enhance it with variables if needed
6. Return ONLY the final HTML content (no explanations)`;

      // Generate enhanced HTML template using LLMService
      console.log('AgentMode: Generating HTML email template with Claude model');
      enhancedHtml = await llmService.generateHTML(systemPrompt, userPrompt, makeToolUsageCallback(sessionId, 'createHtmlTemplate'), { userId, sessionId, feature: 'content_gen' });

      if (!enhancedHtml || enhancedHtml.trim().length === 0) {
        throw new Error('LLM did not generate HTML content');
      }
      }

      // Extract variables from the enhanced HTML and subject
      const { variables, arrayVariables } = extractVariables(enhancedHtml, subject);

      console.log('AgentMode: Extracted variables:', { variables, arrayVariables });

      // Save template to DynamoDB settings (new key)
      const { settingsService } = await import('../../services/settingsService');
      const settingName = `templates_${userId}`;
      const existingSetting = await settingsService.getSetting(settingName);

      let templates = [];
      if (existingSetting) {
        try {
          templates = JSON.parse(existingSetting.settingValue);
        } catch (error) {
          console.error('Error parsing existing templates:', error);
          templates = [];
        }
      }

      const templateTypes = types && types.length > 0 ? types : ['email'];
      const now = new Date().toISOString();

      let targetIndex = -1;
      let resolvedTemplateId = templateId || randomUUID();
      let createdAt = now;

      if (templateId) {
        targetIndex = templates.findIndex((t: any) => t.template_id === templateId);
        if (targetIndex < 0) {
          return {
            success: false,
            message: 'Template not found',
            error: `Template with id "${templateId}" not found`
          };
        }
        const existing = templates[targetIndex];
        resolvedTemplateId = existing.template_id || resolvedTemplateId;
        createdAt = existing.created_at || createdAt;
      } else {
        const matchingTemplates = templates.filter((t: any) => t.template_name === templateName);
        if (matchingTemplates.length === 1) {
          targetIndex = templates.findIndex((t: any) => t.template_name === templateName);
          const existing = templates[targetIndex];
          resolvedTemplateId = existing.template_id || resolvedTemplateId;
          createdAt = existing.created_at || createdAt;
        }
      }

      const newTemplate = {
        template_id: resolvedTemplateId,
        template_name: templateName,
        type: templateTypes,
        subject: subject,
        html_content: enhancedHtml,
        variables: variables,
        arrayVariables: arrayVariables,
        created_at: createdAt,
        updated_at: now
      };

      if (targetIndex >= 0) {
        templates[targetIndex] = newTemplate;
      } else {
        templates.push(newTemplate);
      }

      await settingsService.setSetting(
        settingName,
        JSON.stringify(templates),
        'User templates',
        userId
      );

      console.log('AgentMode: HTML template created successfully:', templateName);

      return {
        success: true,
        template_id: resolvedTemplateId,
        template_name: templateName,
        type: templateTypes,
        subject: subject,
        variables: variables,
        arrayVariables: arrayVariables,
        message: `Template "${templateName}" created successfully with ${variables.length} variables and ${arrayVariables.length} array variables`,
        preview_note: largeDocNote
          ? `${largeDocNote} Template is now available in Templates section for editing and preview.`
          : 'Template is now available in Templates section for editing and preview'
      };
    } catch (error) {
      console.error('Error creating HTML template:', error);
      return {
        success: false,
        message: 'Failed to create HTML template',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Build a small {{variable}} map for an HTML document that is too large to
   * safely round-trip through generateHTML (the 16K output cap would truncate it
   * and drop base64 images / print CSS). The model only returns variable names
   * and exact source anchors; the substitution is applied deterministically to
   * the original bytes so fidelity is fully preserved.
   */
async function parameterizeLargeHtml(
    htmlContent: string,
    subject: string,
    additionalInstructions: string,
    userId: string,
    sessionId: string,
  ): Promise<{ html: string; note: string }> {
    const { createLLMService } = await import('../../utils/llmService');
    // Output is a compact JSON map, so a small token budget is plenty.
    const llmService = createLLMService('anthropic.claude-sonnet-4-6', 0.2, 4096);

    const strippedHtml = stripBase64ForLlm(htmlContent);

    const systemPrompt = `You are an expert email-template engineer. You will be given an HTML document that is already complete and correctly styled. Do NOT rewrite, reformat, or return the HTML.

Your ONLY job is to identify the dynamic content that should become reusable {{variable}} placeholders, and return them as JSON.

Return a JSON object of this exact shape:
{
  "variables": [
    { "name": "snake_case_variable_name", "anchor": "EXACT substring copied verbatim from the HTML that should be replaced", "isArray": false }
  ]
}

Rules:
- "anchor" MUST be an exact, contiguous substring copied character-for-character from the provided HTML (so it can be found and replaced programmatically). Never paraphrase it.
- Pick anchors specific enough to be unambiguous (prefer the full value, e.g. a person's name, a date, a headline).
- Use snake_case names (e.g. user_name, company_name, issue_date).
- For repeating sections use the array pattern names: items_1_title, items_2_title, items_n_title (only _1, _2 and _n). Set "isArray": true for those.
- Do NOT invent content. Only parameterize values that actually appear in the HTML.
- Return ONLY the JSON object, no prose, no HTML.`;

    const userPrompt = `Subject line: ${subject || '(none)'}

Additional instructions: ${additionalInstructions || 'Identify the obvious dynamic fields (names, dates, titles, company info, repeating items).'}

HTML document (base64 image data has been replaced with __BASE64_STRIPPED__ markers — ignore those):
${strippedHtml}`;

    let suggestions: Array<{ name?: string; anchor?: string; isArray?: boolean }> = [];
    try {
      const parsed = await llmService.generateJsonRobust<{ variables?: Array<{ name?: string; anchor?: string; isArray?: boolean }> }>(
        systemPrompt,
        userPrompt,
        makeToolUsageCallback(sessionId, 'createHtmlTemplate'),
        { userId, sessionId, feature: 'content_gen' },
      );
      if (parsed && Array.isArray(parsed.variables)) {
        suggestions = parsed.variables;
      }
    } catch (error) {
      // Suggestion generation is best-effort. On any failure we still store the
      // document verbatim — fidelity matters more than auto-parameterization.
      console.warn('AgentMode: parameterizeLargeHtml suggestion call failed, storing verbatim:', error);
    }

    const { html, applied, skipped } = await applyVariableMap(htmlContent, suggestions);
    const note = `Large document (${htmlContent.length.toLocaleString()} chars) stored with full fidelity; ${applied} variable(s) auto-detected${skipped > 0 ? `, ${skipped} suggestion(s) skipped (anchor not found in body text, ambiguous, or invalid name)` : ''}.`;
    return { html, note };
  }

  /**
   * Replace base64 data-URI payloads with a short marker so the model is not
   * billed for (and cannot corrupt) embedded image blobs. Only the payload is
   * stripped; the surrounding markup is untouched.
   */
function stripBase64ForLlm(html: string): string {
    return html.replace(
      /(data:[\w.+-]+\/[\w.+-]+;base64,)[A-Za-z0-9+/=\s]+/gi,
      '$1__BASE64_STRIPPED__',
    );
  }

  /**
   * Apply a variable map to the original HTML deterministically.
   *
   * Substitution is restricted to renderable text nodes (see
   * computeSafeTextRanges): EVERY occurrence of an anchor that lies wholly
   * inside body text and does not overlap an already-claimed range is replaced
   * with {{name}}, so a repeated value (brand name, date) is parameterized
   * consistently. Occurrences inside tags, attributes, <style>, <script>,
   * <title> or comments are never touched, and the original bytes are spliced
   * (no DOM reserialization), so fidelity is preserved.
   *
   * Safety guards: variable names must match /^[A-Za-z0-9_]+$/ (so {{name}} is
   * always well-formed), and an anchor that matches nothing inside safe text is
   * skipped rather than guessed.
   *
   * KNOWN COVERAGE LIMITS (intentional, fidelity-first — values matching these
   * are left literal, not auto-parameterized):
   *   - values living in attributes (e.g. href, alt, <meta content>),
   *   - values split across element boundaries (e.g. "<b>John</b> Smith"),
   *   - anchors that differ from the source by HTML entities or collapsed
   *     whitespace,
   *   - the subject line (parameterized only if it already contains {{...}}).
   */
async function applyVariableMap(
    html: string,
    suggestions: Array<{ name?: string; anchor?: string; isArray?: boolean }>,
  ): Promise<{ html: string; applied: number; skipped: number }> {
    const safeRanges = await computeSafeTextRanges(html);
    const isInsideSafeText = (start: number, end: number): boolean =>
      safeRanges.some((r) => start >= r.start && end <= r.end);

    const claimed: Array<{ start: number; end: number; name: string }> = [];
    let applied = 0;
    let skipped = 0;

    for (const suggestion of suggestions) {
      const name = (suggestion?.name || '').trim();
      const anchor = typeof suggestion?.anchor === 'string' ? suggestion.anchor : '';

      // Reject malformed variable names and empty anchors outright.
      if (!/^[A-Za-z0-9_]+$/.test(name) || anchor.length === 0) {
        skipped++;
        continue;
      }

      // Replace every safe, non-overlapping occurrence (consistent repeats).
      let matchedHere = 0;
      let from = 0;
      while (from <= html.length) {
        const idx = html.indexOf(anchor, from);
        if (idx === -1) break;
        const end = idx + anchor.length;
        const overlaps = claimed.some((c) => idx < c.end && end > c.start);
        if (!overlaps && isInsideSafeText(idx, end)) {
          claimed.push({ start: idx, end, name });
          matchedHere++;
        }
        from = idx + 1;
      }

      if (matchedHere > 0) applied++;
      else skipped++;
    }

    // Apply right-to-left so earlier indices stay valid while splicing.
    claimed.sort((a, b) => b.start - a.start);
    let out = html;
    for (const c of claimed) {
      out = out.slice(0, c.start) + `{{${c.name}}}` + out.slice(c.end);
    }
    return { html: out, applied, skipped };
  }

  /**
   * Parse the HTML once and return the source-offset ranges of renderable text
   * nodes, excluding <style>, <script>, <title>, comments, tags and attribute
   * values. Restricting substitution to these ranges lets us replace ALL
   * occurrences of a repeated value without corrupting CSS, scripts, attributes
   * or markup. Offsets index the original string, so callers splice the
   * original bytes and fidelity is preserved.
   */
async function computeSafeTextRanges(html: string): Promise<Array<{ start: number; end: number }>> {
    const { Parser } = await import('htmlparser2');
    const ranges: Array<{ start: number; end: number }> = [];
    const SKIP_TAGS = new Set(['style', 'script', 'title']);
    let skipDepth = 0;
    const parser = new Parser(
      {
        onopentag: (name: string) => {
          if (SKIP_TAGS.has(name)) skipDepth++;
        },
        onclosetag: (name: string) => {
          if (SKIP_TAGS.has(name) && skipDepth > 0) skipDepth--;
        },
        ontext: () => {
          // htmlparser2 endIndex is inclusive; +1 for an exclusive slice end.
          if (skipDepth === 0 && parser.startIndex >= 0 && parser.endIndex >= parser.startIndex) {
            ranges.push({ start: parser.startIndex, end: parser.endIndex + 1 });
          }
        },
      },
      // withStartIndices/withEndIndices are honored at runtime but missing from
      // htmlparser2's ParserOptions type, hence the cast.
      { withStartIndices: true, withEndIndices: true } as any,
    );
    parser.write(html);
    parser.end();
    return ranges;
  }

/**
 * Find a template by id, searching the user's own templates first, then
 * public ones. Moved verbatim from `AgentModeService.prototype.
 * findTemplateById` — its only caller anywhere in the backend was
 * `createHtmlFromTemplate` (confirmed by a whole-backend grep), so it's a
 * local, non-exported helper here rather than a public export.
 */
async function findTemplateById(templateId: string, userId: string): Promise<{ template: any | null, isPublic: boolean, available: Array<{ template_id: string, template_name?: string }> }> {
  const { userTemplates, publicTemplates } = await getTemplatesForUser(userId);
  // ENG-1888: on a miss the caller returns these so the model can self-correct
  // instead of retrying an invalid id (the dominant prod failure class).
  const available = [...userTemplates, ...publicTemplates]
    .filter((t: any) => t && typeof t.template_id === 'string')
    .slice(0, MAX_AVAILABLE_TEMPLATES_IN_ERROR)
    .map((t: any) => ({ template_id: t.template_id, template_name: t.template_name }));

  const userMatch = userTemplates.find((t: any) => t.template_id === templateId);
  if (userMatch) {
    return { template: userMatch, isPublic: false, available };
  }

  const publicMatch = publicTemplates.find((t: any) => t.template_id === templateId);
  if (publicMatch) {
    return { template: publicMatch, isPublic: true, available };
  }

  return { template: null, isPublic: false, available };
}

const MAX_AVAILABLE_TEMPLATES_IN_ERROR = 25;

/**
 * ENG-46: structured, greppable, observability-only signal for a model
 * fallback (see `ResolveGenerationModelFn` below). Reimplemented here as a
 * trivial local console.warn wrapper — same "not worth a shared-module
 * promotion for one function" treatment this file already gives `sleep`
 * above — rather than exporting agentModeService.ts's own (non-exported)
 * module-scope helper of the same name, which still has its own, unrelated
 * caller left on the class.
 */
function recordCreateHtmlFromTemplateModelFallback(
  runId: string,
  sessionId: string,
  requestedModel: string,
  resolvedModel: string,
): void {
  try {
    console.warn('[agent-mode] model fallback', {
      runId,
      sessionId,
      requestedModel: requestedModel || '(none)',
      resolvedModel,
    });
  } catch (err) {
    console.error('[agent-mode] model-fallback telemetry failed (swallowed):', err);
  }
}

/**
 * Narrow structural type for the ONE `this.callLLM` call this method makes
 * (the template-variable substitution step) — not
 * `AgentModeService.prototype.callLLM`'s full signature, which has many more
 * options fields this call site never passes. `LLMCallOptions` itself is a
 * private, unexported interface in agentModeService.ts, and this module must
 * not import that file anyway (the whole point of the extraction), so this
 * type is deliberately local: it covers exactly the 5 options fields sent
 * below (`temperature`, `response_format`, `max_completion_tokens`,
 * `taskClass`, `usageContext`) and the 2 response fields read
 * (`choices[0].finish_reason`, `choices[0].message.content`).
 */
export type CreateHtmlFromTemplateLlmCall = (
  model: string,
  messages: Array<{ role: 'user'; content: string }>,
  options: {
    temperature: number;
    response_format: { type: 'json_object' };
    max_completion_tokens: number;
    taskClass: GatewayTaskClass;
    usageContext: LLMUsageContext;
  },
) => Promise<{
  choices: Array<{ finish_reason: string; message: { content: string | null } }>;
}>;

/** Matches `AgentModeService.prototype.getDefaultModel`'s real signature exactly. */
export type GetDefaultModelFn = () => Promise<string>;

/** Matches `AgentModeService.prototype.resolveGenerationModel`'s real signature exactly. */
export type ResolveGenerationModelFn = (
  model: string,
) => { model: string; fellBack: boolean; requestedModel: string };

/**
 * ENG-1960: detect probable rich-text markup in template VARIABLE VALUES without
 * rewriting customer data. The upstream tool description asks the model to provide
 * plain text, but prompt-only enforcement can regress silently.
 *
 * This deliberately requires real markup structure: an HTML tag, fenced code,
 * Markdown heading/list, bold pair, or link. A lone "*" in a name/value is not
 * enough. Only paths are reported; raw values can contain customer/CRM data and
 * must not be copied into logs.
 */
function collectTemplateValueMarkup(
  value: any,
  path: string,
  stats: { count: number; paths: string[] },
  nested = false,
): void {
  if (typeof value === 'string') {
    const looksLikeMarkup =
      /<\/?[a-z][^>]*>/i.test(value) ||
      /(^|\n)\s{0,3}(?:#{1,6}\s+|[-+*]\s+|\d+[.)]\s+|>\s+)/m.test(value) ||
      /```/.test(value) ||
      /`[^`\n]+`/.test(value) ||
      /\*\*[^*\n]+\*\*/.test(value) ||
      /__[^_\n]+__/.test(value) ||
      /(^|[^*])\*[^*\n]+\*(?!\*)/.test(value) ||
      /(^|[\s([{>"'])_[^_\n]+_(?=$|[\s)\]}.!,?:;"'])/.test(value) ||
      /\[[^\]\n]+\]\([^)\n]+\)/.test(value);
    if (looksLikeMarkup) {
      stats.count += 1;
      if (stats.paths.length < 20) stats.paths.push(path);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      collectTemplateValueMarkup(item, `${path}[${index}]`, stats, nested)
    );
    return;
  }
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach((item) =>
      collectTemplateValueMarkup(item, `${path}.<field>`, stats, true)
    );
  }
}

// Create HTML from template with variable substitution
export async function createHtmlFromTemplate(
    llmModel: string,
    templateId: string,
    variableValues: Record<string, string> | undefined,
    arrayVariableValues: Record<string, string[]> | undefined,
    userId: string,
    sessionId: string,
    callLLM: CreateHtmlFromTemplateLlmCall,
    getDefaultModel: GetDefaultModelFn,
    resolveGenerationModel: ResolveGenerationModelFn,
  ): Promise<any> {
    try {
      // Get the template from user or public store
      const { template, available } = await findTemplateById(templateId, userId);

      if (!template) {
        // ENG-1888: structured, actionable not_found instead of a bare message.
        return {
          success: false,
          errorClass: 'not_found',
          error_code: 'TEMPLATE_NOT_FOUND',
          missing_template_id: templateId,
          available_templates: available,
          message: `Template '${templateId}' not found. Call list_html_templates and retry with one of the available template_id values${available.length ? ` (e.g. ${available.slice(0, 5).map((t) => t.template_id).join(', ')})` : '; no templates are available for this user'}.`
        };
      }

      // Validate template structure first
      if (!template.html_content || !template.subject) {
        return {
          success: false,
          // ENG-1888: a stored template with no body/subject is a template
          // configuration defect, not a tool bug — the caller must pick another template.
          errorClass: 'not_found',
          error_code: 'TEMPLATE_INVALID',
          message: `Invalid template structure: missing html_content or subject (template '${templateId}'). Call list_html_templates and choose a different template_id.`
        };
      }
      if (!llmModel) {
        llmModel = await getDefaultModel();
      } else {
        // ENG-46 sibling path: this method is reached with the SESSION's model
        // (emma create_html_from_template tool / route), so a stale/removed id
        // (e.g. gpt-5.1) would otherwise throw an opaque "Invalid model" inside
        // callLLM here too. Resolve it up front so template substitution falls
        // back to a served model instead of failing.
        const templateModelResolution = resolveGenerationModel(llmModel);
        if (templateModelResolution.fellBack) {
          recordCreateHtmlFromTemplateModelFallback('create-html-from-template', sessionId || '', llmModel, templateModelResolution.model);
        }
        llmModel = templateModelResolution.model;
      }
      // Validate that all required variables are provided
      const templateVariables = template.variables || [];
      const templateArrayVariables = template.arrayVariables || [];

      // Parameters are already objects
      const variableValuesObj = variableValues || {};
      const arrayVariableValuesObj = arrayVariableValues || {};

      // Check for missing regular variables
      const missingVariables = templateVariables.filter((variable: string) =>
        !(variable in variableValuesObj)
      );

      // Check for missing array variables
      const missingArrayVariables = templateArrayVariables.filter((variable: string) =>
        !(variable in arrayVariableValuesObj)
      );

      // Check for extra variables that aren't in the template
      const extraVariables = Object.keys(variableValuesObj).filter(variable =>
        !templateVariables.includes(variable)
      );

      const extraArrayVariables = Object.keys(arrayVariableValuesObj).filter(variable =>
        !templateArrayVariables.includes(variable)
      );

      // Build validation error message
      const validationErrors = [];

      if (missingVariables.length > 0) {
        validationErrors.push(`Missing required variables: ${missingVariables.join(', ')}`);
      }

      if (missingArrayVariables.length > 0) {
        validationErrors.push(`Missing required array variables: ${missingArrayVariables.join(', ')}`);
      }

      if (extraVariables.length > 0) {
        validationErrors.push(`Extra variables provided: ${extraVariables.join(', ')}`);
      }

      if (extraArrayVariables.length > 0) {
        validationErrors.push(`Extra array variables provided: ${extraArrayVariables.join(', ')}`);
      }

      // Validate array variable values are actually arrays
      const invalidArrayVariables = Object.entries(arrayVariableValuesObj).filter(([key, value]) =>
        !Array.isArray(value)
      );

      if (invalidArrayVariables.length > 0) {
        validationErrors.push(`Array variable items must be an array: ${invalidArrayVariables.map(([key]) => key).join(', ')}`);
      }

      if (validationErrors.length > 0) {
        return {
          success: false,
          // ENG-1888: caller-supplied variables did not match the template — an
          // argument error the model fixes by retrying, never a tool bug.
          errorClass: 'invalid_args',
          message: validationErrors.join('; '),
          errors: validationErrors,
          template_variables: templateVariables,
          template_array_variables: templateArrayVariables
        };
      }

      // ENG-1960: make prompt-only plain-text guidance observable. Detection is
      // intentionally non-mutating: some customer values legitimately contain punctuation
      // that resembles Markdown, and changing them here would be a data-integrity regression.
      const markupStats = { count: 0, paths: [] as string[] };
      for (const [key, value] of Object.entries(variableValuesObj)) {
        collectTemplateValueMarkup(value, `variable_values.${key}`, markupStats);
      }
      for (const [key, value] of Object.entries(arrayVariableValuesObj)) {
        collectTemplateValueMarkup(value, `array_variable_values.${key}`, markupStats);
      }
      if (markupStats.count > 0) {
        console.warn('[ENG-1960] create_html_from_template received markup-like variable values', {
          count: markupStats.count,
          paths: markupStats.paths,
          paths_truncated: markupStats.count > markupStats.paths.length,
        });
      }

      // ENG-1877: variable values come from campaign names, CRM data, and other
      // caller-supplied strings — none of it trusted HTML. The LLM is instructed below
      // to copy values through verbatim ("EXACT REPLACEMENT"), so an unescaped `<script>`
      // or `<img onerror=...>` in a value reaches the rendered report unchanged. Escaping
      // here (not on the LLM's output afterward) is the only point where "this came from
      // a value" and "this is the template's own static markup" are still distinguishable
      // — post-hoc sanitizing final_html can't tell the two apart.
      const escapedVariableValuesObj = Object.fromEntries(
        Object.entries(variableValuesObj).map(([key, value]) => [key, deepEscapeHtmlValues(value)])
      );
      const escapedArrayVariableValuesObj = Object.fromEntries(
        Object.entries(arrayVariableValuesObj).map(([key, values]) => [
          key,
          deepEscapeHtmlValues(values),
        ])
      );

      // Raw (pre-escape) values that actually contained a dangerous character, mapped to
      // their escaped form — used to CORRECT the LLM's OUTPUT below if it resurfaces.
      // Escaping the prompt only proves the request was safe; it does not prove the
      // model didn't decode an entity back to raw HTML.
      const rawToEscapedMap = new Map<string, string>();
      collectRawToEscapedMap(variableValuesObj, rawToEscapedMap);
      collectRawToEscapedMap(arrayVariableValuesObj, rawToEscapedMap);

      // Use LLM to handle variable substitution
      const substitutionPrompt = `You are a template engine. Your task is to replace variables in HTML templates with provided values while preserving the exact same format and structure.

TEMPLATE HTML:
${template.html_content}

TEMPLATE SUBJECT:
${template.subject}

VARIABLE VALUES:
${JSON.stringify(escapedVariableValuesObj, null, 2)}

ARRAY VARIABLE VALUES:
${JSON.stringify(escapedArrayVariableValuesObj, null, 2)}

CRITICAL INSTRUCTIONS:
1. PRESERVE THE EXACT FORMAT: Keep the same HTML structure, tags, classes, and styling as the original template
2. REPLACE VARIABLES: Replace all {{variable_name}} placeholders with corresponding values
3. ARRAY VARIABLES: For array variables, repeat the surrounding HTML structure for each array item
   - If {{array_var}} is inside a <li> tag, repeat the <li> tag for each array item
   - If {{array_var}} is inside a <div> tag, repeat the <div> tag for each array item
   - Maintain the exact same HTML structure around the array variable
4. VALID HTML: Ensure the final HTML is valid and well-formatted
5. NO STRUCTURAL CHANGES: Do not add new HTML elements, change classes, or modify the template structure (except for empty array handling as described below)
6. EMPTY ARRAY VARIABLES: If an array variable has an empty array (no data), you must add text within that section to indicate there is no data, remove the array variables from the HTML structure and keep the rest of the HTML structure intact. For example, for array variable "features_n", if there is no data, all variables "features_1", "features_2", etc. must be removed from the HTML structure as they together indicate the array variable.
7. EXACT REPLACEMENT: Only replace {{}} placeholders, keep everything else identical

RESPONSE FORMAT:
You must return a valid JSON object with exactly these two fields:
{
  "final_html": "final HTML content with variables replaced but structure preserved",
  "final_subject": "final subject with variables replaced"
}

IMPORTANT: Return ONLY the JSON object, no additional text or explanations.`;

      // Try with increasing token limits — large HTML templates need room for the full output
      const tokenLimits = [32768, 65536];
      let substitutionData: any = null;

      for (const maxTokens of tokenLimits) {
        const substitutionResponse = await callLLM(llmModel, [
          {
            role: 'user',
            content: substitutionPrompt
          }
        ], {
          temperature: 0.1,
          response_format: { type: 'json_object' },
          max_completion_tokens: maxTokens,
          taskClass: 'content_generation',
          // ENG-1858: the user's template work — attribute it to them, not "system".
          usageContext: { userId, sessionId, feature: 'html_template' },
        });

        const finishReason = substitutionResponse.choices[0].finish_reason;
        const substitutionResult = substitutionResponse.choices[0].message.content;

        if (!substitutionResult) {
          throw new Error('LLM did not return substitution result');
        }

        // If the response was truncated (length = hit token limit), retry with more tokens
        if (finishReason === 'length') {
          console.warn(`createHtmlFromTemplate: Response truncated at ${maxTokens} tokens, retrying with more...`);
          continue;
        }

        try {
          substitutionData = JSON.parse(substitutionResult);
        } catch (parseError) {
          // Some models (e.g. Gemini) wrap JSON in markdown code blocks — strip and retry
          const codeBlockMatch = substitutionResult.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
          if (codeBlockMatch) {
            try {
              substitutionData = JSON.parse(codeBlockMatch[1].trim());
            } catch (innerParseError) {
              console.error('createHtmlFromTemplate: Failed to parse JSON even after stripping code block wrapper. Raw response (first 500 chars):', substitutionResult.substring(0, 500));
              // If we have more token limits to try, continue; otherwise throw
              if (maxTokens < tokenLimits[tokenLimits.length - 1]) continue;
              throw new Error('LLM returned invalid JSON for variable substitution');
            }
          } else {
            console.error('createHtmlFromTemplate: Failed to parse LLM response as JSON. Raw response (first 500 chars):', substitutionResult.substring(0, 500));
            if (maxTokens < tokenLimits[tokenLimits.length - 1]) continue;
            throw new Error('LLM returned invalid JSON for variable substitution');
          }
        }

        // Successfully parsed — break out of retry loop
        if (substitutionData) break;
      }

      if (!substitutionData || !substitutionData.final_html || !substitutionData.final_subject) {
        throw new Error('LLM substitution result missing final_html or final_subject fields');
      }

      let finalHtml = substitutionData.final_html;
      let finalSubject = substitutionData.final_subject;

      // ENG-1877: correct the output if the model reproduced a value's RAW, unescaped
      // form instead of the escaped one we sent it — escaping the prompt only proves the
      // REQUEST was safe, not that the model preserved it through generation. Auto-
      // correcting (rather than rejecting outright) means a model that imperfectly
      // handles escaping on some OTHER template degrades to "silently corrected", not
      // "report generation hard-fails" — this function is shared by ~35 existing
      // templates across the platform, most never tested against this change, and a
      // reject-on-detect design would turn any of their LLM's occasional imperfect
      // escaping into a customer-visible outage for reasons unrelated to security.
      //
      // Applied to finalHtml ONLY, never finalSubject — per docs/html-templates.md,
      // `subject` is a real email subject line (round-4 review finding), never rendered
      // as HTML, so it has no injection surface to correct in the first place; escaping
      // it at all just corrupts a real customer-visible field with literal entity text.
      //
      // Two more round-4 findings fixed here: (1) longest-value-first ordering — when one
      // flagged value is a literal substring of another (plausible with real HTML-snippet
      // data), correcting the shorter one first destroys the exact string the longer one's
      // pattern needs, silently no-oping its own correction. (2) a replacer FUNCTION, not
      // a plain string — `String.replace` treats `$&`, `$$`, etc. in a plain replacement
      // string as special patterns; an escaped value that happens to contain `$` next to
      // certain characters could reinject the raw matched text, un-doing the very
      // escaping this loop exists to enforce. A function's return value is used literally,
      // with no `$`-pattern interpretation.
      //
      // Case-insensitive: a model reproducing `<SCRIPT>` instead of `<script>` is still a
      // browser-executable tag — an exact-case match would let that trivial reformatting
      // evade correction entirely. A false correction is possible if a raw dangerous
      // substring coincidentally already existed in the template's own static markup, but
      // replacing that one occurrence with its escaped form is a far safer failure mode
      // than either a silently reopened injection or a hard failure.
      const correctionsByLengthDesc = [...rawToEscapedMap.entries()].sort(
        ([a], [b]) => b.length - a.length
      );
      for (const [rawValue, escapedValue] of correctionsByLengthDesc) {
        const pattern = new RegExp(escapeRegExp(rawValue), 'gi');
        finalHtml = finalHtml.replace(pattern, () => escapedValue);
      }

      // finalSubject is plain text (never HTML-rendered), so any HTML entity that leaked
      // through from the escaped prompt values doesn't protect anything — it just shows
      // literal "&amp;"/"&#39;" etc. in a real customer's email subject. Decode them back.
      finalSubject = unescapeHtml(finalSubject);

      // Verify the substitution was correct
      const remainingPlaceholders = finalHtml.match(/\{\{[^}]+\}\}/g) || [];
      const remainingSubjectPlaceholders = finalSubject.match(/\{\{[^}]+\}\}/g) || [];

      if (remainingPlaceholders.length > 0 || remainingSubjectPlaceholders.length > 0) {
        console.warn('Warning: Some variables were not substituted:', {
          htmlPlaceholders: remainingPlaceholders,
          subjectPlaceholders: remainingSubjectPlaceholders
        });
      }

      // Verify HTML structure is preserved (basic check)
      const originalTagCount = (template.html_content.match(/<[^>]+>/g) || []).length;
      const finalTagCount = (finalHtml.match(/<[^>]+>/g) || []).length;

      // Allow for some variation due to array repetition, but flag significant changes
      const tagDifference = Math.abs(originalTagCount - finalTagCount);
      if (tagDifference > originalTagCount * 0.5) { // More than 50% change in tag count
        console.warn('Warning: Significant HTML structure change detected:', {
          originalTagCount,
          finalTagCount,
          difference: tagDifference
        });
      }

      // Upload to S3
      const { uploadFileToS3 } = await import('../../utils/s3Utils');
      const rawName = (template.template_name || 'template').toLowerCase();
      const slug = rawName.replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'template';
      const idSuffix = (template.template_id || templateId || '').slice(0, 8);
      const suffix = idSuffix ? `_${idSuffix}` : '';
      const filename = `html_${slug}${suffix}.html`;
      const uploadResult = await uploadFileToS3(finalHtml, filename, userId, 'text/html');

      if (!uploadResult.success || !uploadResult.url) {
        throw new Error(uploadResult.error || 'Failed to upload to S3');
      }

      const s3Url = uploadResult.url;

      return {
        success: true,
        s3_url: s3Url,
        final_subject: finalSubject,
        template_id: template.template_id,
        template_name: template.template_name,
        filename: filename
      };
    } catch (error) {
      console.error('Error creating email HTML from template:', error);

      // Return specific error messages based on the error type
      if (error instanceof Error) {
        if (error.message.includes('Failed to process template with LLM') || error.message.includes('OpenAI API error')) {
          return {
            success: false,
            message: 'Failed to process template with LLM',
            error: error.message
          };
        } else if (error.message.includes('LLM returned invalid JSON')) {
          return {
            success: false,
            errorClass: 'invalid_output',
            message: 'Failed to parse LLM response',
            error: error.message
          };
        } else if (error.message.includes('LLM did not return substitution result')) {
          return {
            success: false,
            errorClass: 'invalid_output',
            message: 'LLM returned empty substitution result',
            error: error.message
          };
        } else if (error.message.includes('missing final_html or final_subject')) {
          return {
            success: false,
            errorClass: 'invalid_output',
            message: 'LLM response missing final_html',
            error: error.message
          };
        } else if (error.message.includes('Failed to upload to S3') || error.message.includes('S3 upload failed')) {
          return {
            success: false,
            message: 'Failed to upload to S3',
            error: error.message
          };
        }
      }

      return {
        success: false,
        message: 'Failed to create email HTML from template',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }
