/**
 * ENG-2103 (F2) — updateHtmlFile tool cluster, extracted from
 * `AgentModeService`. The tenth domain cluster in this series, and the
 * second (final) slice of the "HTML remainder" candidate first surveyed in
 * round 5's htmlTools.ts and split further in round 9's htmlCreation.ts.
 *
 * Moved verbatim (behavior byte-identical) from `AgentModeService.prototype.*`:
 * updateHtmlFile, fetchFileContent, uploadUpdatedFile, updateHtmlFileCss,
 * extractPathFromS3Url, createVersionedFilename.
 *
 * NOT moved: `performDirectReplacement`. It sits physically between
 * fetchFileContent and extractPathFromS3Url in the source, but it is NOT
 * called by anything in this cluster — updateHtmlFile calls
 * `sharedPerformContentReplacements` (the round-1 shared module function)
 * directly, never `this.performDirectReplacement`. It stays on the class,
 * untouched, exactly as round 1 left it (delegating to
 * emma/impl/shared/contentReplacements.ts's performDirectReplacement,
 * because updateHtmlFile.test.ts and updateHtmlFile.cssSelector.test.ts spy
 * on `(agentModeService as any).performDirectReplacement` directly — those
 * spies are effectively inert today since nothing calls through them
 * anymore, a pre-existing condition from round 1, not something this round
 * introduces or needs to fix per the "don't clean up pre-existing dead code"
 * rule).
 *
 * `AgentModeService.prototype.<name>` now delegates to updateHtmlFile,
 * fetchFileContent, uploadUpdatedFile, extractPathFromS3Url, and
 * createVersionedFilename rather than duplicating them: emma/tools.ts is the
 * only real production caller of updateHtmlFile (whole-backend grep) — the
 * other four have NO direct tools.ts callers at all (pure internal helpers,
 * two left `public`, two `private`, for test access) — but all five have
 * dedicated test files that call/spy on them directly on a real instance
 * (updateHtmlFile.test.ts, updateHtmlFile.cssSelector.test.ts,
 * agentModeService.uploadUpdatedFile.test.ts). A first pass at this
 * extraction assumed extractPathFromS3Url/createVersionedFilename were safe
 * to delete outright because a `spyOn(...)`-only grep found nothing — that
 * missed updateHtmlFile.test.ts's `describe('createVersionedFilename', ...)`
 * / `describe('extractPathFromS3Url', ...)` blocks, which call
 * `(agentModeService as any).<method>(...)` DIRECTLY (no spy) to unit-test
 * their pure logic in isolation. Caught by running the test file itself
 * (`TypeError: agentModeService.createVersionedFilename is not a function`),
 * not by the grep — both are exported and delegated like the rest.
 * updateHtmlFileCss is private and reached only through updateHtmlFile's own
 * updateType==='css' branch in every test that exercises it, so it has no
 * separate delegate — deleted outright.
 *
 * KNOWN test-spy retargeting required (same class of fix as rounds 3/4/6/9):
 * updateHtmlFile.test.ts (7 fetchFileContent spies, 1 uploadUpdatedFile spy)
 * and updateHtmlFile.cssSelector.test.ts (2 fetchFileContent spies, 1
 * uploadUpdatedFile spy) all spy on the class singleton — since
 * updateHtmlFile/updateHtmlFileCss now call the plain fetchFileContent/
 * uploadUpdatedFile functions in THIS module instead of `this.<method>`,
 * those spies no longer intercept anything and are retargeted at this
 * module in the same commit as the fix.
 *
 * Transitive-import notes: `sharedPerformContentReplacements` (round 1's
 * emma/impl/shared/contentReplacements.ts) is imported by name, same as
 * every extraction since the books round. `utils/s3Utils.ts` (already
 * established exception — top-level-imports AWS.S3 but is the codebase's own
 * convention for this module) and `utils/htmlSanitizer.ts` were already
 * lazily `await import()`'d inline in the original source for
 * uploadUpdatedFile — kept exactly as-is. `cheerio` (a pure HTML-parsing
 * library, no module-scope construction of anything) was already lazily
 * `await import()`'d inline for updateHtmlFileCss — kept exactly as-is.
 *
 * Metering/RunFunding audit: zero matches for llmService, generateJSONContent,
 * callLLM, meterUserUsage, currentRunFunding, billingUserId, or any
 * LLM-provider name anywhere in this cluster — updateHtmlFile is a pure
 * deterministic content-splice tool with no LLM call of any kind.
 */

import { createHash } from 'crypto';
import { performContentReplacements as sharedPerformContentReplacements } from './shared/contentReplacements';
// Self-import (resolves to this same module's live `module.exports`, via
// Node's require cache — safe because it is only ever read inside function
// bodies, at call time, never at module-evaluation time). updateHtmlFile.test.ts
// and updateHtmlFile.cssSelector.test.ts jest.spyOn() fetchFileContent/
// uploadUpdatedFile on the imported module namespace; a bare in-module call
// to a sibling `export function` does NOT go through that namespace object
// (TS/CommonJS compiles it to a direct reference to the local function, not
// `exports.<name>`), so those spies would silently stop being observed
// without this indirection — same failure shape as every other
// mock-stops-being-exercised regression this series has hit, just one level
// deeper (same-module, not cross-module).
import * as self from './htmlUpdate';
import { CALLER_URL_MAX_TEXT_BYTES, fetchCallerUrlText } from '../../utils/callerUrlFetch';

/**
 * Where the edited copy of `fileUrl` will be written, and whether the caller may write exactly there.
 *
 * The directory comes from the CALLER's own URL (`extractPathFromS3Url`), and the upload runs with the server's credentials, so without
 * this check any user could put an edited copy into another tenant's folder (or anywhere in the bucket) by naming that path. Only the
 * owner writes, as on `/api/files/html`. The key that is authorised is the key that is written: the same directory and the same file
 * name after the upload's own rewriting. Done before anything is fetched, so a URL that is not the caller's costs no network call.
 * Loaded lazily: the rule reaches the database layer and `chatbotService`, which this module must not load when merely required.
 */
async function authorizeUpdatedFileWrite(
  fileUrl: string,
  userId: string,
): Promise<{ versionedFilename: string; originalPath: string } | { refusal: any }> {
  const versionedFilename = createVersionedFilename(fileUrl);
  const { sanitizeS3Filename, extractS3KeyFromUrl } = await import('../../utils/s3Utils');
  // The directory of the object the URL names. For one of OUR bucket's URLs, in either S3 link style (virtual-hosted
  // `<bucket>.s3.<region>.amazonaws.com/<key>` or path-style `s3.<region>.amazonaws.com/<bucket>/<key>`), that is the key's own directory, so the
  // same page is the same object whichever link names it (the file lookup accepts both). For any other URL it is the URL's path, as before.
  const bucketKey = extractS3KeyFromUrl(fileUrl);
  const originalPath = bucketKey !== null ? bucketKey.slice(0, Math.max(bucketKey.lastIndexOf('/'), 0)) : extractPathFromS3Url(fileUrl);
  const {
    TOOL_FILE_READ_ONLY_MESSAGE,
    TOOL_FILE_REFUSAL_MESSAGE,
    TOOL_FILE_UNAVAILABLE_MESSAGE,
    createToolFileAccess,
  } = await import('./toolStorageAccess');
  const decision = await createToolFileAccess('update_html_file', userId).checkWrite(originalPath, sanitizeS3Filename(versionedFilename));
  if (decision === 'allow') return { versionedFilename, originalPath };
  if (decision === 'unavailable') {
    // The check itself could not run (a lookup failed): not a verdict on the caller, so the model may try again.
    return { refusal: { success: false, message: TOOL_FILE_UNAVAILABLE_MESSAGE, error: 'File access check unavailable', errorClass: 'upstream_5xx' } };
  }
  if (decision === 'read_only') {
    return { refusal: { success: false, message: TOOL_FILE_READ_ONLY_MESSAGE, error: 'File is read-only for you', errorClass: 'invalid_args' } };
  }
  // One message for "not there", "not yours" and "not placeable", so a refusal cannot be used to probe for files.
  return { refusal: { success: false, message: TOOL_FILE_REFUSAL_MESSAGE, error: 'File not accessible', errorClass: 'invalid_args' } };
}

  // Update HTML file with direct content replacement
export async function updateHtmlFile(
    fileUrl: string,
    updateType: string,
    replacementInstructions: any,
    userId: string,
    sessionId: string
  ): Promise<any> {
    try {
      // Handle CSS-selector-based operations
      if (updateType === 'css') {
        return await updateHtmlFileCss(fileUrl, replacementInstructions, userId, sessionId);
      }

      // Validate update_type first (before fetching file)
      if (!updateType || !['part', 'full'].includes(updateType)) {
        return {
          success: false,
          message: 'update_type must be either "part" or "full"'
        };
      }

      // Validate replacement instructions (before fetching file)
      // This is a quick validation to catch errors early
      if (!Array.isArray(replacementInstructions)) {
        return {
          success: false,
          message: 'replacement_json must be an array of replacement instructions'
        };
      }

      if (replacementInstructions.length === 0) {
        return {
          success: false,
          message: 'At least one replacement instruction is required'
        };
      }

      // Only the owner may write the edited copy (checked on the exact key that will be written, before anything is fetched).
      const target = await authorizeUpdatedFileWrite(fileUrl, userId);
      if ('refusal' in target) return target.refusal;

      // Fetch current file content
      const currentContent = await self.fetchFileContent(fileUrl, userId);
      console.log(`AgentMode: Fetched file content, length: ${currentContent.length} characters`);

      // Compute hash of current content for verification
      const currentContentHash = createHash('sha256').update(currentContent).digest('hex');
      console.log(`AgentMode: Computed current content hash: ${currentContentHash}`);

      // Use common replacement function (ENG-2103 F2 pilot: promoted to
      // emma/impl/shared/contentReplacements.ts, shared with update_book_content).
      const replacementResult = sharedPerformContentReplacements(
        currentContent,
        currentContentHash,
        updateType,
        replacementInstructions
      );

      if (!replacementResult.success) {
        // Map error messages to match expected format for HTML files
        let errorMessage = replacementResult.error?.message || 'Failed to perform replacements';

        // Replace generic messages with HTML-specific ones for backward compatibility
        if (replacementResult.error?.isHashMismatch || errorMessage.includes('Content hash mismatch')) {
          errorMessage = errorMessage.replace('Content hash mismatch', 'File hash mismatch');
        }

        return {
          success: false,
          message: errorMessage,
          suggestion: replacementResult.error?.suggestion
        };
      }

      // Upload the updated content under the name and directory that were authorised above
      const { versionedFilename, originalPath } = target;
      console.log(`AgentMode: Original file URL: ${fileUrl}`);
      console.log(`AgentMode: Generated versioned filename: ${versionedFilename}`);
      console.log(`AgentMode: Original path: ${originalPath}`);
      const uploadResult = await self.uploadUpdatedFile(replacementResult.updatedContent!, versionedFilename, originalPath);

      return {
        success: true,
        s3_url: uploadResult.url,
        message: `File updated successfully with ${replacementResult.replacementResults!.length} replacements`,
        method: 'mixed_replacement',
        replacements: replacementResult.replacementResults,
        versioned_filename: versionedFilename
      };

    } catch (error) {
      console.error('Error updating HTML file:', error);
      return {
        success: false,
        message: 'Failed to update HTML file',
        error: error instanceof Error ? error.message : 'Unknown error',
        suggestion: 'For entire file replacement, use old_content_hash from read_file_content. For partial replacement, use old_content with the exact text to replace'
      };
    }
  }

  // Fetch file content from URL
export async function fetchFileContent(fileUrl: string, userId?: string): Promise<string> {
    try {
      // A URL the caller chose is fetched only through the guarded fetch (public addresses only, redirects re-checked, size and time
      // bounded); the body is edited and written back as a file, so the server's own network position must not be reachable through it.
      return await fetchCallerUrlText(fileUrl, { tool: 'update_html_file', userId, maxBytes: CALLER_URL_MAX_TEXT_BYTES });
    } catch (error) {
      console.error('Error fetching file content:', error);
      throw new Error(`Failed to fetch file content: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  // Extract path from S3 URL
export function extractPathFromS3Url(s3Url: string): string {
    try {
      // Parse the S3 URL to extract the key
      const url = new URL(s3Url);
      const key = url.pathname.substring(1); // Remove leading slash

      // Extract path by removing the filename
      const lastSlashIndex = key.lastIndexOf('/');
      if (lastSlashIndex === -1) {
        return ''; // No path, just filename
      }

      return key.substring(0, lastSlashIndex);
    } catch (error) {
      console.error('Error extracting path from S3 URL:', error);
      return '';
    }
  }

  // Create versioned filename
export function createVersionedFilename(originalUrl: string): string {
    try {
      // Extract filename from original URL
      const urlParts = originalUrl.split('/');
      const filename = urlParts[urlParts.length - 1];
      console.log(`AgentMode: Extracted filename: ${filename}`);

      // Split filename into name and extension
      const lastDotIndex = filename.lastIndexOf('.');
      if (lastDotIndex === -1) {
        // No extension, just add version
        console.log(`AgentMode: No extension found, adding _v2`);
        return `${filename}_v2`;
      }

      const nameWithoutExt = filename.substring(0, lastDotIndex);
      const extension = filename.substring(lastDotIndex);
      console.log(`AgentMode: Name without ext: ${nameWithoutExt}, extension: ${extension}`);

      // Check if filename already has a version pattern (_v followed by digits)
      const versionMatch = nameWithoutExt.match(/^(.+)_v(\d+)$/);
      console.log(`AgentMode: Version match result:`, versionMatch);

      if (versionMatch) {
        // Extract base name and current version number
        const baseName = versionMatch[1];
        const currentVersion = parseInt(versionMatch[2], 10);
        const newVersion = currentVersion + 1;
        console.log(`AgentMode: Found existing version ${currentVersion}, incrementing to ${newVersion}`);
        return `${baseName}_v${newVersion}${extension}`;
      } else {
        // No existing version, add _v2
        console.log(`AgentMode: No existing version found, adding _v2`);
        return `${nameWithoutExt}_v2${extension}`;
      }
    } catch (error) {
      console.error('Error creating versioned filename:', error);
      // Fallback: add timestamp to avoid conflicts
      const timestamp = Date.now();
      const urlParts = originalUrl.split('/');
      const filename = urlParts[urlParts.length - 1];
      const lastDotIndex = filename.lastIndexOf('.');

      if (lastDotIndex === -1) {
        return `${filename}_v2_${timestamp}`;
      } else {
        const nameWithoutExt = filename.substring(0, lastDotIndex);
        const extension = filename.substring(lastDotIndex);
        return `${nameWithoutExt}_v2_${timestamp}${extension}`;
      }
    }
  }

  // Upload updated file content
export async function uploadUpdatedFile(
    content: string,
    filename: string,
    path: string
  ): Promise<{ url: string }> {
    try {
      // Upload to S3 with the same path as the original file
      const { uploadFileToS3WithPath } = await import('../../utils/s3Utils');
      const { sanitizeGeneratedHtml } = await import('../../utils/htmlSanitizer');
      // ENG-1997 — this is the shared upload sink for BOTH updateHtmlFile's
      // part/full replacements and updateHtmlFileCss's selector-based edits.
      // The latter's `setAttribute` operation lets the model set an arbitrary
      // attribute name/value pair directly (e.g. onerror/onclick), and its
      // replace/append/etc. actions splice raw HTML with no escaping — same
      // "LLM-authored HTML reaches a public S3 file unsanitized" trust gap
      // createHtmlFile had, one step more direct since there's no need to even
      // reproduce untrusted quoted text, the tool call arguments ARE the payload.
      const sanitizedContent = sanitizeGeneratedHtml(content);
      const uploadResult = await uploadFileToS3WithPath(sanitizedContent, filename, 'text/html', path);

      if (!uploadResult.success || !uploadResult.url) {
        throw new Error(uploadResult.error || 'Failed to upload updated file');
      }

      return { url: uploadResult.url };
    } catch (error) {
      console.error('Error uploading updated file:', error);
      throw new Error(`Failed to upload updated file: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  // CSS-selector-based HTML file editing
async function updateHtmlFileCss(
    fileUrl: string,
    operations: any[],
    userId: string,
    sessionId: string
  ): Promise<any> {
    try {
      // Validate operations
      if (!Array.isArray(operations) || operations.length === 0) {
        return { success: false, message: 'At least one operation is required' };
      }

      const validActions = ['remove', 'replace', 'replaceInner', 'append', 'prepend', 'insertBefore', 'insertAfter', 'setAttribute', 'removeAttribute'];
      const actionsNeedingHtml = ['replace', 'replaceInner', 'append', 'prepend', 'insertBefore', 'insertAfter'];

      for (let i = 0; i < operations.length; i++) {
        const op = operations[i];
        if (!op.action || !validActions.includes(op.action)) {
          return { success: false, message: `Operation ${i + 1}: Invalid action "${op.action}". Valid actions: ${validActions.join(', ')}` };
        }
        if (!op.selector) {
          return { success: false, message: `Operation ${i + 1}: selector is required` };
        }
        if (actionsNeedingHtml.includes(op.action) && (op.html === undefined || op.html === null)) {
          return { success: false, message: `Operation ${i + 1}: html is required for action "${op.action}"` };
        }
        if (op.action === 'setAttribute' && (!op.attribute || op.value === undefined)) {
          return { success: false, message: `Operation ${i + 1}: attribute and value are required for setAttribute` };
        }
        if (op.action === 'removeAttribute' && !op.attribute) {
          return { success: false, message: `Operation ${i + 1}: attribute is required for removeAttribute` };
        }
      }

      // Only the owner may write the edited copy (checked on the exact key that will be written, before anything is fetched).
      const target = await authorizeUpdatedFileWrite(fileUrl, userId);
      if ('refusal' in target) return target.refusal;

      // Fetch current file content
      const currentContent = await self.fetchFileContent(fileUrl, userId);
      console.log(`AgentMode: CSS edit - fetched file, length: ${currentContent.length}`);

      // Load into cheerio
      const cheerio = await import('cheerio');
      const $ = cheerio.load(currentContent, { xml: false } as any);

      // Apply operations sequentially, collecting results for each
      let operationsApplied = 0;
      const operationResults: { index: number; action: string; selector: string; success: boolean; error?: string }[] = [];
      for (let i = 0; i < operations.length; i++) {
        const op = operations[i];
        const matched = $(op.selector);

        if (matched.length === 0) {
          console.warn(`AgentMode: CSS edit op ${i + 1}: no match for "${op.selector}"`);
          operationResults.push({ index: i + 1, action: op.action, selector: op.selector, success: false, error: `No elements matched selector "${op.selector}"` });
          continue;
        }

        console.log(`AgentMode: CSS edit op ${i + 1}: ${op.action} on "${op.selector}" (${matched.length} matches)`);

        switch (op.action) {
          case 'remove':
            matched.remove();
            break;
          case 'replace':
            matched.replaceWith(op.html);
            break;
          case 'replaceInner':
            matched.html(op.html);
            break;
          case 'append':
            matched.append(op.html);
            break;
          case 'prepend':
            matched.prepend(op.html);
            break;
          case 'insertBefore':
            matched.before(op.html);
            break;
          case 'insertAfter':
            matched.after(op.html);
            break;
          case 'setAttribute':
            matched.attr(op.attribute, op.value);
            break;
          case 'removeAttribute':
            matched.removeAttr(op.attribute);
            break;
        }
        operationsApplied++;
        operationResults.push({ index: i + 1, action: op.action, selector: op.selector, success: true });
      }

      // If nothing was applied, return failure
      if (operationsApplied === 0) {
        return {
          success: false,
          message: `All ${operations.length} operations failed: no selectors matched`,
          operations: operationResults,
          suggestion: 'Use read_file_content to inspect the current HTML structure. Use :eq(n) (0-indexed) to select by position within matched set, e.g. ".step-block:eq(1)" for the 2nd .step-block.'
        };
      }

      // Serialize back to HTML
      const updatedContent = $.html();
      const failedOps = operationResults.filter(r => !r.success);
      console.log(`AgentMode: CSS edit complete, ${operationsApplied}/${operations.length} operations applied, new length: ${updatedContent.length}`);

      // Upload under the name and directory that were authorised above
      const { versionedFilename, originalPath } = target;
      const uploadResult = await self.uploadUpdatedFile(updatedContent, versionedFilename, originalPath);

      return {
        success: true,
        s3_url: uploadResult.url,
        message: failedOps.length > 0
          ? `File updated with ${operationsApplied}/${operations.length} operations (${failedOps.length} failed: ${failedOps.map(f => `op ${f.index} selector "${f.selector}"`).join(', ')})`
          : `File updated successfully with ${operationsApplied} CSS-selector operations`,
        method: 'css_selector',
        operations_applied: operationsApplied,
        operations: operationResults,
        updatedContent,
        versioned_filename: versionedFilename
      };
    } catch (error) {
      console.error('Error in CSS-selector HTML update:', error);
      return {
        success: false,
        message: 'Failed to update HTML file',
        error: error instanceof Error ? error.message : 'Unknown error',
        suggestion: 'Check your CSS selectors and HTML content. Use read_file_content to inspect the current file structure.'
      };
    }
  }
